import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  TokenUsage,
} from '@freellmapi/shared/types.js';
import type { CompletionOptions } from '../../providers/base.js';

export const DEFAULT_STREAM_STALL_MS = Number(process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS) || 90_000;

function textFromParts(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string') return p.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function parseDataUri(url: string): { mimeType: string; data: string } | null {
  const m = url.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

function safeJsonParse(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return {};
  }
}

export function clampResponsesCallId(callId: unknown): string {
  const str = typeof callId === 'string' && callId.trim() ? callId.trim() : `call_${Date.now()}`;
  return str.length > 64 ? str.slice(0, 64) : str;
}

export function chatToResponsesRequest(
  model: string,
  messages: ChatMessage[],
  options?: CompletionOptions,
  extra?: { maxOutputTokens?: number },
): Record<string, unknown> {
  const systemParts: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'system') {
      const text = textFromParts(m.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: clampResponsesCallId(m.tool_call_id),
        output: typeof m.content === 'string' ? m.content : textFromParts(m.content),
      });
      continue;
    }
    if (m.role === 'assistant') {
      const text = textFromParts(m.content);
      if (text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const name = tc.function?.name?.trim();
          if (!name) continue;
          input.push({
            type: 'function_call',
            call_id: clampResponsesCallId(tc.id),
            name: name.slice(0, 128),
            arguments: typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {}),
          });
        }
      }
      continue;
    }
    // User / fallback
    const parts: Array<Record<string, unknown>> = [];
    if (typeof m.content === 'string') {
      parts.push({ type: 'input_text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          parts.push({ type: 'input_text', text: part.text });
        } else if (part.type === 'image_url') {
          const url = typeof part.image_url === 'string'
            ? part.image_url
            : (part.image_url as { url?: string } | undefined)?.url;
          if (url) parts.push({ type: 'input_image', image_url: url });
        }
      }
    }
    if (parts.length === 0) parts.push({ type: 'input_text', text: '' });
    input.push({ type: 'message', role: 'user', content: parts });
  }

  if (input.length === 0) {
    input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] });
  }

  const body: Record<string, unknown> = {
    model,
    input,
    stream: true,
    store: false,
  };
  if (systemParts.length > 0) body.instructions = systemParts.join('\n\n');
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.top_p !== undefined) body.top_p = options.top_p;
  if (options?.max_tokens !== undefined) body.max_output_tokens = options.max_tokens;
  else if (extra?.maxOutputTokens !== undefined) body.max_output_tokens = extra.maxOutputTokens;

  if (options?.reasoning_effort && String(options.reasoning_effort) !== 'auto') {
    body.reasoning = { effort: options.reasoning_effort.toLowerCase().trim(), summary: 'auto' };
  }

  if (Array.isArray(options?.tools) && options.tools.length > 0) {
    const flatTools: Array<Record<string, unknown>> = [];
    for (const t of options.tools) {
      if (!t || typeof t !== 'object') continue;
      const fn = t.function;
      const name = (fn?.name ?? (t as unknown as { name?: string }).name ?? '').trim();
      if (!name) continue;
      const params = (fn?.parameters ?? (t as unknown as { parameters?: Record<string, unknown> }).parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>;
      const normalizedParams = params.type === 'object' && !params.properties
        ? { ...params, properties: {} }
        : params;
      flatTools.push({
        type: 'function',
        name: name.slice(0, 128),
        ...(fn?.description ? { description: fn.description } : {}),
        parameters: normalizedParams,
      });
    }
    if (flatTools.length > 0) body.tools = flatTools;
  }

  if (options?.tool_choice !== undefined) {
    if (typeof options.tool_choice === 'string') {
      body.tool_choice = options.tool_choice;
    } else if (options.tool_choice?.type === 'function' && options.tool_choice.function?.name) {
      body.tool_choice = { type: 'function', name: options.tool_choice.function.name };
    }
  }

  return body;
}

export interface ResponsesStreamState {
  id: string;
  created: number;
  model: string;
  toolIndexByItemId: Map<string, number>;
  nextToolIndex: number;
  sawToolCalls: boolean;
  emittedRole: boolean;
  emittedFinish: boolean;
}

export function createResponsesStreamState(model: string): ResponsesStreamState {
  return {
    id: `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    created: Math.floor(Date.now() / 1000),
    model,
    toolIndexByItemId: new Map(),
    nextToolIndex: 0,
    sawToolCalls: false,
    emittedRole: false,
    emittedFinish: false,
  };
}

export function parseResponsesSseEvent(
  payload: Record<string, any>,
  state: ResponsesStreamState,
): ChatCompletionChunk[] {
  const type = String(payload?.type ?? '');
  const out: ChatCompletionChunk[] = [];
  const make = (delta: Record<string, unknown>, finishReason: string | null = null, usage?: TokenUsage): ChatCompletionChunk => ({
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{
      index: 0,
      delta: delta as ChatCompletionChunk['choices'][0]['delta'],
      finish_reason: finishReason,
    }],
    ...(usage ? { usage } : {}),
  });

  if (type === 'response.created' && payload.response) {
    if (typeof payload.response.id === 'string') state.id = payload.response.id;
    if (typeof payload.response.model === 'string') state.model = payload.response.model;
    return out;
  }

  if (type === 'response.output_text.delta' && typeof payload.delta === 'string' && payload.delta) {
    const delta: Record<string, unknown> = state.emittedRole
      ? { content: payload.delta }
      : { role: 'assistant', content: payload.delta };
    state.emittedRole = true;
    out.push(make(delta));
    return out;
  }

  if (
    (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta' || type === 'response.reasoning.delta')
    && typeof payload.delta === 'string'
    && payload.delta
  ) {
    const delta: Record<string, unknown> = state.emittedRole
      ? { reasoning_content: payload.delta }
      : { role: 'assistant', reasoning_content: payload.delta };
    state.emittedRole = true;
    out.push(make(delta));
    return out;
  }

  if (type === 'response.output_item.added' && payload.item?.type === 'function_call') {
    const itemId = String(payload.item.id || payload.output_index || state.nextToolIndex);
    const idx = state.nextToolIndex++;
    state.toolIndexByItemId.set(itemId, idx);
    state.sawToolCalls = true;
    const callId = String(payload.item.call_id || payload.item.id || `call_${idx}`);
    const name = String(payload.item.name || '');
    const delta: Record<string, unknown> = {
      ...(state.emittedRole ? {} : { role: 'assistant' }),
      tool_calls: [{ index: idx, id: callId, type: 'function', function: { name, arguments: '' } }],
    };
    state.emittedRole = true;
    out.push(make(delta));
    return out;
  }

  if (type === 'response.function_call_arguments.delta' && typeof payload.delta === 'string') {
    const key = String(payload.item_id ?? payload.output_index ?? '');
    let idx = state.toolIndexByItemId.get(key);
    if (idx === undefined) {
      idx = state.nextToolIndex++;
      state.toolIndexByItemId.set(key, idx);
    }
    state.sawToolCalls = true;
    out.push(make({ tool_calls: [{ index: idx, function: { arguments: payload.delta } }] }));
    return out;
  }

  if (type === 'response.output_item.done' && payload.item?.type === 'function_call') {
    const key = String(payload.item.id || payload.output_index || '');
    if (!state.toolIndexByItemId.has(key)) {
      const idx = state.nextToolIndex++;
      state.toolIndexByItemId.set(key, idx);
      state.sawToolCalls = true;
      const callId = String(payload.item.call_id || payload.item.id || `call_${idx}`);
      const args = typeof payload.item.arguments === 'string'
        ? payload.item.arguments
        : JSON.stringify(payload.item.arguments ?? {});
      const delta: Record<string, unknown> = {
        ...(state.emittedRole ? {} : { role: 'assistant' }),
        tool_calls: [{ index: idx, id: callId, type: 'function', function: { name: String(payload.item.name || ''), arguments: args } }],
      };
      state.emittedRole = true;
      out.push(make(delta));
    }
    return out;
  }

  if (type === 'response.completed' || type === 'response.done' || type === 'response.incomplete') {
    state.emittedFinish = true;
    const u = payload.response?.usage;
    const usage: TokenUsage | undefined = u ? {
      prompt_tokens: Number(u.input_tokens ?? u.prompt_tokens ?? 0),
      completion_tokens: Number(u.output_tokens ?? u.completion_tokens ?? 0),
      total_tokens: Number(u.total_tokens ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0))),
    } : undefined;
    const reason = state.sawToolCalls
      ? 'tool_calls'
      : type === 'response.incomplete' ? 'length' : 'stop';
    out.push(make({}, reason, usage));
    return out;
  }

  if (type === 'response.failed' || type === 'error') {
    const msg = payload.response?.error?.message || payload.error?.message || payload.message || 'Upstream Responses stream failed';
    throw new Error(String(msg));
  }

  return out;
}

export function chatToAnthropicRequest(
  model: string,
  messages: ChatMessage[],
  options?: CompletionOptions,
  opts?: {
    includeModel?: boolean;
    includeStream?: boolean;
    anthropicVersion?: string;
    defaultMaxTokens?: number;
  },
): Record<string, unknown> {
  const systemTexts: string[] = [];
  const rawAnthropicMsgs: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];

  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'system') {
      const t = textFromParts(m.content);
      if (t) systemTexts.push(t);
      continue;
    }
    if (m.role === 'tool') {
      rawAnthropicMsgs.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id || 'tool_0',
          content: typeof m.content === 'string' ? m.content : textFromParts(m.content),
        }],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = [];
      const text = textFromParts(m.content);
      if (text) blocks.push({ type: 'text', text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id || `toolu_${blocks.length}`,
            name: tc.function?.name || 'tool',
            input: safeJsonParse(tc.function?.arguments),
          });
        }
      }
      if (blocks.length > 0) rawAnthropicMsgs.push({ role: 'assistant', content: blocks });
      continue;
    }

    const blocks: Array<Record<string, unknown>> = [];
    if (typeof m.content === 'string') {
      if (m.content) blocks.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string' && part.text) {
          blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          const url = typeof part.image_url === 'string'
            ? part.image_url
            : (part.image_url as { url?: string } | undefined)?.url;
          if (url) {
            const dataUri = parseDataUri(url);
            if (dataUri) {
              blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: dataUri.mimeType, data: dataUri.data },
              });
            } else {
              blocks.push({ type: 'image', source: { type: 'url', url } });
            }
          }
        }
      }
    }
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
    rawAnthropicMsgs.push({ role: 'user', content: blocks });
  }

  // Merge consecutive same-role messages (Anthropic requires alternating user/assistant)
  const merged: typeof rawAnthropicMsgs = [];
  for (const msg of rawAnthropicMsgs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content.push(...msg.content);
    } else {
      merged.push({ role: msg.role, content: [...msg.content] });
    }
  }

  const body: Record<string, unknown> = {
    messages: merged,
    max_tokens: options?.max_tokens ?? opts?.defaultMaxTokens ?? 8192,
  };
  if (opts?.includeModel !== false) body.model = model;
  if (opts?.includeStream) body.stream = true;
  if (opts?.anthropicVersion) body.anthropic_version = opts.anthropicVersion;
  if (systemTexts.length > 0) body.system = systemTexts.join('\n\n');
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.top_p !== undefined) body.top_p = options.top_p;
  if (options?.top_k !== undefined) body.top_k = options.top_k;
  if (options?.stop) body.stop_sequences = Array.isArray(options.stop) ? options.stop : [options.stop];

  if (Array.isArray(options?.tools) && options.tools.length > 0) {
    body.tools = options.tools.map((t: NonNullable<CompletionOptions['tools']>[number]) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
  }
  if (options?.tool_choice) {
    if (options.tool_choice === 'auto') body.tool_choice = { type: 'auto' };
    else if (options.tool_choice === 'required') body.tool_choice = { type: 'any' };
    else if (typeof options.tool_choice === 'object' && options.tool_choice.type === 'function') {
      body.tool_choice = { type: 'tool', name: options.tool_choice.function.name };
    }
  }

  return body;
}

export interface AnthropicStreamState {
  id: string;
  created: number;
  model: string;
  toolIndexByBlockIndex: Map<number, number>;
  nextToolIndex: number;
  emittedRole: boolean;
  emittedFinish: boolean;
  inputTokens: number;
  stopReason: string | null;
}

export function createAnthropicStreamState(model: string): AnthropicStreamState {
  return {
    id: `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    created: Math.floor(Date.now() / 1000),
    model,
    toolIndexByBlockIndex: new Map(),
    nextToolIndex: 0,
    emittedRole: false,
    emittedFinish: false,
    inputTokens: 0,
    stopReason: null,
  };
}

export function mapAnthropicStopReason(reason: string | null | undefined): string {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  return 'stop';
}

export function parseAnthropicSseEvent(
  data: Record<string, any>,
  state: AnthropicStreamState,
): ChatCompletionChunk[] {
  const type = String(data?.type ?? '');
  const out: ChatCompletionChunk[] = [];
  const make = (delta: Record<string, unknown>, finishReason: string | null = null, usage?: TokenUsage): ChatCompletionChunk => ({
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{
      index: 0,
      delta: delta as ChatCompletionChunk['choices'][0]['delta'],
      finish_reason: finishReason,
    }],
    ...(usage ? { usage } : {}),
  });

  if (type === 'message_start' && data.message) {
    if (typeof data.message.id === 'string') state.id = data.message.id;
    if (typeof data.message.model === 'string') state.model = data.message.model;
    state.inputTokens = Number(data.message.usage?.input_tokens ?? 0);
    return out;
  }

  if (type === 'content_block_start' && data.content_block?.type === 'tool_use') {
    const blockIndex = Number(data.index ?? 0);
    const toolIdx = state.nextToolIndex++;
    state.toolIndexByBlockIndex.set(blockIndex, toolIdx);
    const delta: Record<string, unknown> = {
      ...(state.emittedRole ? {} : { role: 'assistant' }),
      tool_calls: [{
        index: toolIdx,
        id: String(data.content_block.id || `call_${toolIdx}`),
        type: 'function',
        function: { name: String(data.content_block.name || ''), arguments: '' },
      }],
    };
    state.emittedRole = true;
    out.push(make(delta));
    return out;
  }

  if (type === 'content_block_delta' && data.delta) {
    if (data.delta.type === 'text_delta' && typeof data.delta.text === 'string' && data.delta.text) {
      const delta: Record<string, unknown> = state.emittedRole
        ? { content: data.delta.text }
        : { role: 'assistant', content: data.delta.text };
      state.emittedRole = true;
      out.push(make(delta));
    } else if (data.delta.type === 'thinking_delta' && typeof data.delta.thinking === 'string' && data.delta.thinking) {
      const delta: Record<string, unknown> = state.emittedRole
        ? { reasoning_content: data.delta.thinking }
        : { role: 'assistant', reasoning_content: data.delta.thinking };
      state.emittedRole = true;
      out.push(make(delta));
    } else if (data.delta.type === 'input_json_delta' && typeof data.delta.partial_json === 'string') {
      const blockIndex = Number(data.index ?? 0);
      const toolIdx = state.toolIndexByBlockIndex.get(blockIndex) ?? 0;
      out.push(make({ tool_calls: [{ index: toolIdx, function: { arguments: data.delta.partial_json } }] }));
    }
    return out;
  }

  if (type === 'message_delta') {
    state.stopReason = data.delta?.stop_reason ?? state.stopReason;
    const outputTokens = Number(data.usage?.output_tokens ?? 0);
    if (data.delta?.stop_reason && !state.emittedFinish) {
      state.emittedFinish = true;
      out.push(make({}, mapAnthropicStopReason(state.stopReason), {
        prompt_tokens: state.inputTokens,
        completion_tokens: outputTokens,
        total_tokens: state.inputTokens + outputTokens,
      }));
    }
    return out;
  }

  if (type === 'message_stop' && !state.emittedFinish) {
    state.emittedFinish = true;
    out.push(make({}, mapAnthropicStopReason(state.stopReason)));
    return out;
  }

  if (type === 'error') {
    const msg = data.error?.message || data.message || 'Upstream Anthropic stream error';
    throw new Error(String(msg));
  }

  return out;
}

export function anthropicJsonToOpenAIResponse(data: Record<string, any>, model: string): ChatCompletionResponse {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const texts: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: ChatToolCall[] = [];

  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    else if (b.type === 'thinking' && typeof b.thinking === 'string') reasoning.push(b.thinking);
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: String(b.id || `call_${toolCalls.length}`),
        type: 'function',
        function: {
          name: String(b.name || ''),
          arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}),
        },
      });
    }
  }

  const promptTokens = Number(data?.usage?.input_tokens ?? 0);
  const completionTokens = Number(data?.usage?.output_tokens ?? 0);
  const message: ChatMessage & { reasoning_content?: string } = {
    role: 'assistant',
    content: texts.length > 0 ? texts.join('') : (toolCalls.length > 0 ? (null as unknown as string) : ''),
    ...(reasoning.length > 0 ? { reasoning_content: reasoning.join('') } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  return {
    id: String(data?.id || `chatcmpl-${Date.now()}`),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: String(data?.model || model),
    choices: [{
      index: 0,
      message: message as ChatMessage,
      finish_reason: mapAnthropicStopReason(data?.stop_reason),
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export async function aggregateStreamToCompletion(
  stream: AsyncGenerator<ChatCompletionChunk>,
  fallbackModel: string,
): Promise<ChatCompletionResponse> {
  let id = `chatcmpl-${Date.now()}`;
  let created = Math.floor(Date.now() / 1000);
  let model = fallbackModel;
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const tools = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();
  let finishReason = 'stop';
  let usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for await (const chunk of stream) {
    if (chunk.id) id = chunk.id;
    if (chunk.created) created = chunk.created;
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta as { content?: string; reasoning_content?: string; tool_calls?: Array<Record<string, any>> } | undefined;
    if (!delta) continue;
    if (typeof delta.content === 'string') contentParts.push(delta.content);
    if (typeof delta.reasoning_content === 'string') reasoningParts.push(delta.reasoning_content);
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = Number(tc.index ?? 0);
        const existing = tools.get(idx) ?? {
          id: typeof tc.id === 'string' && tc.id ? tc.id : `call_${idx}`,
          type: 'function' as const,
          function: { name: '', arguments: '' },
        };
        if (typeof tc.id === 'string' && tc.id) existing.id = tc.id;
        if (typeof tc.function?.name === 'string' && tc.function.name) {
          existing.function.name += tc.function.name;
        }
        if (typeof tc.function?.arguments === 'string') {
          existing.function.arguments += tc.function.arguments;
        }
        tools.set(idx, existing);
      }
    }
  }

  const toolCalls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
  const content = contentParts.join('');
  const reasoningContent = reasoningParts.join('');
  const msg: ChatMessage & { reasoning_content?: string } = {
    role: 'assistant',
    content: content.length > 0 ? content : (toolCalls.length > 0 ? (null as unknown as string) : ''),
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: msg as ChatMessage,
      finish_reason: finishReason,
    }],
    usage,
  };
}

export async function* readFramedSseLines(
  res: Response,
  readChunk: <T>(read: () => Promise<T>, stallMs: number, msg?: string) => Promise<T>,
  firstByteMs: number,
  stallMs: number,
  firstByteMsg: string,
): AsyncGenerator<{ event: string | null; data: string }> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: string | null = null;
  let awaitingFirst = true;

  try {
    while (true) {
      const { done, value } = awaitingFirst
        ? await readChunk(() => reader.read(), firstByteMs, firstByteMsg)
        : await readChunk(() => reader.read(), stallMs);
      awaitingFirst = false;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (!line) {
          currentEvent = null;
          continue;
        }
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
          continue;
        }
        if (line.startsWith('data:')) {
          yield { event: currentEvent, data: line.slice(5).trimStart() };
        }
      }
    }
    const tail = buffer.replace(/\r$/, '').trim();
    if (tail.startsWith('data:')) {
      yield { event: currentEvent, data: tail.slice(5).trimStart() };
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
