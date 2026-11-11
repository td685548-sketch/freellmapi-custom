import { randomBytes } from 'node:crypto';
import type { ChatToolCall } from '@freellmapi/shared/types.js';

type Emit = (event: string, data: unknown) => void;
interface ToolState { index: number; outputIndex: number; itemId: string; call: ChatToolCall }

/** Translate parallel Chat Completions tool fragments without losing call identity. */
export class ProtocolToolStream {
  private readonly tools = new Map<number, ToolState>();
  private reason: string | null = null;
  constructor(private readonly protocol: 'messages' | 'responses', private readonly emit: Emit) {}

  process(chunk: { choices?: Array<{ delta?: { tool_calls?: Array<ChatToolCall & { index?: number }> }; finish_reason?: string | null }> }): void {
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) this.reason = choice.finish_reason;
    for (const delta of choice?.delta?.tool_calls ?? []) {
      const index = delta.index ?? 0;
      let state = this.tools.get(index);
      if (!state) {
        if (!delta.id || !delta.function?.name) throw new Error('Upstream tool call omitted its identity.');
        state = { index, outputIndex: this.tools.size + 1, itemId: `fc_${randomBytes(12).toString('hex')}`,
          call: { id: delta.id, type: 'function', function: { name: delta.function.name, arguments: '' } } };
        this.tools.set(index, state);
        if (this.protocol === 'messages') this.emit('content_block_start', { type: 'content_block_start', index: state.outputIndex,
          content_block: { type: 'tool_use', id: state.call.id, name: state.call.function.name, input: {} } });
        else this.emit('response.output_item.added', { type: 'response.output_item.added', output_index: state.outputIndex,
          item: { id: state.itemId, type: 'function_call', call_id: state.call.id, name: state.call.function.name, arguments: '', status: 'in_progress' } });
      }
      const args = delta.function?.arguments;
      if (args) {
        state.call.function.arguments += args;
        if (this.protocol === 'messages') this.emit('content_block_delta', { type: 'content_block_delta', index: state.outputIndex, delta: { type: 'input_json_delta', partial_json: args } });
        else this.emit('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: state.itemId, output_index: state.outputIndex, delta: args });
      }
    }
  }
  get calls(): ChatToolCall[] { return [...this.tools.values()].map(state => state.call); }
  get anthropicStopReason(): string { return this.reason === 'length' ? 'max_tokens' : this.tools.size ? 'tool_use' : 'end_turn'; }
  finish(): void {
    for (const state of this.tools.values()) {
      if (this.protocol === 'messages') this.emit('content_block_stop', { type: 'content_block_stop', index: state.outputIndex });
      else {
        this.emit('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: state.itemId, output_index: state.outputIndex, arguments: state.call.function.arguments });
        this.emit('response.output_item.done', { type: 'response.output_item.done', output_index: state.outputIndex,
          item: { id: state.itemId, type: 'function_call', call_id: state.call.id, name: state.call.function.name, arguments: state.call.function.arguments, status: 'completed' } });
      }
    }
  }
  finalizeResponse<T extends { status: string; output: Array<Record<string, unknown>> }>(response: T): T {
    for (const item of response.output) {
      if (item.type !== 'function_call') continue;
      const state = [...this.tools.values()].find(state => state.call.id === item.call_id);
      if (state) item.id = state.itemId;
    }
    if (this.reason === 'length') {
      response.status = 'incomplete';
      Object.assign(response, { incomplete_details: { reason: 'max_output_tokens' } });
    }
    return response;
  }
}
