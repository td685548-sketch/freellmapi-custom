import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage, ChatToolCall, Platform, TokenUsage } from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions, type KeyValidationResult } from '../../providers/base.js';
import { parseOAuthCredential } from './oauth-credentials.js';
import { kiroRegion } from './kiro-auth.js';
import { kiroBody, kiroFrames } from './kiro-wire.js';

export class KiroProvider extends BaseProvider {
  readonly platform: Platform = 'custom';
  readonly name = 'Kiro AI';
  override async *streamChatCompletion(credential: string, messages: ChatMessage[], model: string, options?: CompletionOptions): AsyncGenerator<ChatCompletionChunk> {
    const auth = parseOAuthCredential(credential);
    if (!auth || auth.kind !== 'kiro') throw new Error('Kiro requires a structured OAuth credential.');
    const region = kiroRegion(auth.region);
    const body = kiroBody(messages, model, options);
    if (auth.profileArn) body.profileArn = auth.profileArn;
    const response = await this.fetchWithTimeout(`https://codewhisperer.${region}.amazonaws.com/generateAssistantResponse`, {
      method: 'POST', redirect: 'error', headers: {
        'Content-Type': 'application/json', Accept: 'application/vnd.amazon.eventstream', Authorization: `Bearer ${auth.accessToken}`,
        'X-Amz-Target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
        'User-Agent': 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0', 'x-amz-sso-bearer': auth.accessToken,
        'x-amzn-kiro-agent-mode': 'spec', ...(auth.profileArn ? { 'x-amzn-codewhisperer-profile-arn': auth.profileArn } : {}),
      }, body: JSON.stringify(body),
    }, options?.timeoutMs ?? 120_000, { signal: options?.signal });
    if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response, `Kiro inference failed (HTTP ${response.status}).`, ''); }
    const id = this.makeId(); const created = Math.floor(Date.now() / 1000);
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: TokenUsage): ChatCompletionChunk => ({ id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) });
    const tools = new Map<string, { index: number; name: string; stopped: boolean }>();
    let emitted = false; let usage: TokenUsage | undefined; let finish = 'stop';
    for await (const { headers, payload } of kiroFrames(response, options?.timeoutMs ?? 120_000)) {
      const type = headers[':event-type'] ?? '';
      if (headers[':message-type'] === 'exception' || headers[':message-type'] === 'error' || type.endsWith('Exception')) throw new Error('Kiro reported an upstream stream failure.');
      if (type === 'assistantResponseEvent' && typeof payload.content === 'string' && payload.content) { emitted = true; yield chunk({ content: payload.content }); }
      if (type === 'reasoningContentEvent') {
        const text = payload.text ?? payload.content;
        if (typeof text === 'string' && text) yield chunk({ reasoning_content: text });
      }
      if (type === 'toolUseEvent') {
        const toolId = payload.toolUseId;
        if (typeof toolId !== 'string' || !toolId) throw new Error('Kiro returned a tool call without an ID.');
        let tool = tools.get(toolId);
        if (!tool) {
          if (typeof payload.name !== 'string' || !payload.name) throw new Error('Kiro returned an unnamed tool call.');
          tool = { index: tools.size, name: payload.name, stopped: false }; tools.set(toolId, tool);
          yield chunk({ tool_calls: [{ index: tool.index, id: toolId, type: 'function', function: { name: tool.name, arguments: '' } }] });
        }
        const args = typeof payload.input === 'string' ? payload.input : payload.input !== undefined ? JSON.stringify(payload.input) : '';
        if (args) yield chunk({ tool_calls: [{ index: tool.index, id: toolId, type: 'function', function: { name: tool.name, arguments: args } }] });
        if (payload.stop === true) tool.stopped = true;
        emitted = true;
      }
      if (type === 'messageStopEvent') {
        const reason = payload.stopReason;
        if (reason === 'max_tokens') finish = 'length';
        else if (reason && !['end_turn', 'tool_use', 'stop'].includes(reason)) throw new Error('Kiro returned an incomplete or refused response.');
      }
      const raw = payload.usage ?? payload.tokenUsage;
      if (raw && Number.isFinite(raw.inputTokens) && Number.isFinite(raw.outputTokens)) usage = { prompt_tokens: raw.inputTokens, completion_tokens: raw.outputTokens, total_tokens: raw.inputTokens + raw.outputTokens };
    }
    if (!emitted || [...tools.values()].some(tool => !tool.stopped)) throw new Error('Kiro returned an incomplete response.');
    yield chunk({}, tools.size ? 'tool_calls' : finish, usage);
  }
  override async chatCompletion(credential: string, messages: ChatMessage[], model: string, options?: CompletionOptions): Promise<ChatCompletionResponse> {
    let content = ''; const tools: ChatToolCall[] = []; let finish = 'stop'; let usage: TokenUsage | undefined;
    for await (const item of this.streamChatCompletion(credential, messages, model, options)) {
      const choice = item.choices[0]; content += choice?.delta.content ?? '';
      for (const call of choice?.delta.tool_calls ?? []) {
        const index = (call as ChatToolCall & { index?: number }).index ?? 0;
        const target = tools[index] ??= { id: call.id ?? '', type: 'function', function: { name: call.function?.name ?? '', arguments: '' } };
        target.function.arguments += call.function?.arguments ?? '';
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (item.usage) usage = item.usage;
    }
    return { id: this.makeId(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content, ...(tools.length ? { tool_calls: tools } : {}) }, finish_reason: finish }],
      usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  }
  override async validateKey(credential: string): Promise<KeyValidationResult> {
    // An explicit operator health check uses a real, small inference request.
    await this.chatCompletion(credential, [{ role: 'user', content: 'Reply OK.' }], 'claude-sonnet-4.5', { max_tokens: 8, timeoutMs: 20_000 });
    return true;
  }
}
