import { createHash, randomUUID } from 'node:crypto';
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  Platform,
  TokenUsage,
} from '@freellmapi/shared/types.js';
import {
  BaseProvider,
  type CompletionOptions,
  type KeyValidationOptions,
  type KeyValidationResult,
  providerHttpError,
} from '../../providers/base.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../../services/provider-quota.js';
import { DEFAULT_STREAM_STALL_MS, aggregateStreamToCompletion } from './wire-helpers.js';

export interface CommandCodeProviderOptions {
  name?: string;
  baseUrl?: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

const DEFAULT_GENERATE_URL = 'https://api.commandcode.ai/alpha/generate';
const COMMAND_CODE_MAX_TOKENS = 64_000;

export function slugifyPath(value: string): string {
  return String(value ?? '')
    .replace(/([A-Z]{2,})(\d+)/g, '$1 $2')
    .replace(/([a-z\d]+)([A-Z]{2,})/g, '$1 $2')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-rt-z\d]+)/g, '$1 $2')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\d]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function toCommandCodeSessionUuid(sessionId?: string): string {
  if (!sessionId) return randomUUID();
  const h = createHash('sha256').update(String(sessionId)).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function flattenText(content: ChatMessage['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string') return p.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function safeParseJson(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw !== 'string') return raw as Record<string, unknown>;
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { raw };
  }
}

function toCommandCodePayload(
  modelId: string,
  messages: ChatMessage[],
  options: CompletionOptions | undefined,
  threadId: string,
): Record<string, unknown> {
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id && tc.function?.name) toolNameById.set(tc.id, tc.function.name);
      }
    }
  }

  const outMsgs: Array<Record<string, unknown>> = [];
  const systemTexts: string[] = [];

  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'system') {
      const t = flattenText(m.content);
      if (t) systemTexts.push(t);
      continue;
    }
    if (m.role === 'tool') {
      const value = typeof m.content === 'string' ? m.content : flattenText(m.content);
      const toolName = m.name || (m.tool_call_id ? toolNameById.get(m.tool_call_id) : undefined) || 'unknown';
      outMsgs.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: m.tool_call_id || '',
          toolName,
          output: { type: 'text', value },
        }],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = [];
      const reasoning = (m as ChatMessage & { reasoning_content?: string }).reasoning_content;
      if (typeof reasoning === 'string' && reasoning.trim()) {
        blocks.push({ type: 'reasoning', text: reasoning });
      }
      const text = flattenText(m.content);
      if (text) blocks.push({ type: 'text', text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          blocks.push({
            type: 'tool-call',
            toolCallId: tc.id || '',
            toolName: tc.function?.name || '',
            input: safeParseJson(tc.function?.arguments),
          });
        }
      }
      outMsgs.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
      continue;
    }

    const blocks: Array<Record<string, unknown>> = [];
    if (typeof m.content === 'string') {
      blocks.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          const url = typeof part.image_url === 'string'
            ? part.image_url
            : (part.image_url as { url?: string } | undefined)?.url;
          const match = typeof url === 'string' ? url.match(/^data:([^;]+);base64,(.+)$/s) : null;
          if (match) {
            blocks.push({ type: 'image', image: url, mimeType: match[1], mediaType: match[1] });
          }
        }
      }
    }
    outMsgs.push({ role: 'user', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
  }

  const params: Record<string, unknown> = {
    model: modelId,
    messages: outMsgs,
    stream: true,
    max_tokens: options?.max_tokens ?? COMMAND_CODE_MAX_TOKENS,
    temperature: options?.temperature ?? 0.3,
  };
  if (systemTexts.length > 0) params.system = systemTexts.join('\n\n');
  if (options?.top_p !== undefined) params.top_p = options.top_p;
  if (options?.reasoning_effort) params.reasoning_effort = options.reasoning_effort;
  if (Array.isArray(options?.tools) && options.tools.length > 0) {
    params.tools = options.tools.map((t: NonNullable<CompletionOptions['tools']>[number]) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
  }

  return {
    threadId,
    memory: null,
    taste: null,
    skills: null,
    permissionMode: 'standard',
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().slice(0, 10),
      environment: process.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    params,
  };
}

export function parseCommandCodeError(event: Record<string, any>): {
  statusCode: number;
  message: string;
  type: string;
} {
  const errVal = event?.error ?? event?.message ?? 'CommandCode upstream error';
  const message = typeof errVal === 'string'
    ? errVal
    : typeof errVal?.message === 'string'
      ? errVal.message
      : JSON.stringify(errVal);
  let statusCode = Number(errVal?.statusCode ?? errVal?.status ?? event?.statusCode ?? 0) || 0;
  let type = typeof errVal?.type === 'string' ? errVal.type : 'server_error';

  if (statusCode < 400 || statusCode > 599) {
    const lower = message.toLowerCase();
    if (lower.includes('rate limit') || lower.includes('too many requests')) {
      statusCode = 429;
      type = 'rate_limit_error';
    } else if (lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('authentication')) {
      statusCode = 401;
      type = 'authentication_error';
    } else if (lower.includes('payment required') || lower.includes('billing')) {
      statusCode = 402;
      type = 'billing_error';
    } else if (lower.includes('quota') || lower.includes('forbidden') || lower.includes('permission')) {
      statusCode = 403;
      type = 'permission_error';
    } else if (lower.includes('not found')) {
      statusCode = 404;
      type = 'invalid_request_error';
    } else {
      statusCode = 503;
    }
  }
  return { statusCode, message, type };
}

function mapCommandCodeFinishReason(reason?: string | null): string {
  const r = String(reason || '').toLowerCase();
  if (r === 'tool-calls' || r === 'tool_calls') return 'tool_calls';
  if (r === 'length' || r === 'max-tokens' || r === 'max_tokens') return 'length';
  if (r === 'content-filter' || r === 'content_filter') return 'content_filter';
  return 'stop';
}

interface CommandCodeStreamState {
  id: string;
  created: number;
  model: string;
  emittedRole: boolean;
  toolIndex: number;
  toolIndexById: Map<string, number>;
  finishReason: string | null;
  usage: TokenUsage | null;
}

function translateCommandCodeEvent(event: Record<string, any>, state: CommandCodeStreamState): ChatCompletionChunk[] {
  const make = (delta: Record<string, unknown>, finishReason: string | null = null, usage?: TokenUsage | null): ChatCompletionChunk => ({
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta: delta as any, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  });

  switch (event?.type) {
    case 'text-delta': {
      const text = event.text || event.delta || '';
      if (!text) return [];
      const delta = state.emittedRole ? { content: text } : { role: 'assistant', content: text };
      state.emittedRole = true;
      return [make(delta)];
    }
    case 'reasoning-delta': {
      const text = event.text || '';
      if (!text) return [];
      const delta = state.emittedRole ? { reasoning_content: text } : { role: 'assistant', reasoning_content: text };
      state.emittedRole = true;
      return [make(delta)];
    }
    case 'tool-input-start': {
      const id = String(event.id || event.toolCallId || `call_${state.toolIndex}`);
      let idx = state.toolIndexById.get(id);
      if (idx === undefined) {
        idx = state.toolIndex++;
        state.toolIndexById.set(id, idx);
      }
      const delta = {
        ...(state.emittedRole ? {} : { role: 'assistant' }),
        tool_calls: [{ index: idx, id, type: 'function', function: { name: String(event.toolName || ''), arguments: '' } }],
      };
      state.emittedRole = true;
      return [make(delta)];
    }
    case 'tool-input-delta': {
      const id = String(event.id || event.toolCallId || '');
      const idx = state.toolIndexById.get(id);
      if (idx === undefined) return [];
      return [make({ tool_calls: [{ index: idx, function: { arguments: String(event.delta || event.inputTextDelta || '') } }] })];
    }
    case 'tool-call': {
      const id = String(event.toolCallId || `call_${state.toolIndex}`);
      if (state.toolIndexById.has(id)) return [];
      const idx = state.toolIndex++;
      state.toolIndexById.set(id, idx);
      const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input ?? {});
      const delta = {
        ...(state.emittedRole ? {} : { role: 'assistant' }),
        tool_calls: [{ index: idx, id, type: 'function', function: { name: String(event.toolName || ''), arguments: args } }],
      };
      state.emittedRole = true;
      return [make(delta)];
    }
    case 'finish-step': {
      state.finishReason = mapCommandCodeFinishReason(event.finishReason);
      if (event.usage) {
        const pt = Number(event.usage.inputTokens ?? event.usage.promptTokens ?? 0);
        const ct = Number(event.usage.outputTokens ?? event.usage.completionTokens ?? 0);
        state.usage = {
          prompt_tokens: pt,
          completion_tokens: ct,
          total_tokens: Number(event.usage.totalTokens ?? (pt + ct)),
        };
      }
      return [];
    }
    case 'finish': {
      const u = event.totalUsage;
      if (u) {
        const pt = Number(u.inputTokens ?? u.promptTokens ?? 0);
        const ct = Number(u.outputTokens ?? u.completionTokens ?? 0);
        state.usage = {
          prompt_tokens: pt,
          completion_tokens: ct,
          total_tokens: Number(u.totalTokens ?? (pt + ct)),
        };
      }
      const finishReason = state.finishReason || mapCommandCodeFinishReason(event.finishReason || 'stop');
      return [make({}, finishReason, state.usage)];
    }
    case 'error': {
      const parsed = parseCommandCodeError(event);
      throw new Error(`[CommandCode error: ${parsed.message}]`);
    }
    default:
      return [];
  }
}

export class CommandCodeProvider extends BaseProvider {
  readonly platform = 'commandcode' as Platform;
  readonly name: string;
  private readonly generateUrl: string;
  private readonly originUrl: string;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: CommandCodeProviderOptions = {}) {
    super();
    this.name = opts.name ?? 'Command Code';
    this.generateUrl = (opts.baseUrl || DEFAULT_GENERATE_URL).replace(/\/+$/, '');
    this.originUrl = new URL(this.generateUrl).origin;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.extraHeaders = { ...opts.extraHeaders };
  }

  private buildHeaders(apiKey: string, sessionId: string, accept?: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'User-Agent': 'cli',
      'x-command-code-version': '1.88.5',
      'x-cli-environment': 'production',
      'x-cli-surface': 'cli',
      'x-taste-learning': 'false',
      'x-project-slug': slugifyPath(process.cwd()) || 'workspace',
      'x-session-id': sessionId,
      Authorization: `Bearer ${apiKey}`,
      ...(accept ? { Accept: accept } : {}),
      ...this.extraHeaders,
    };
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const out = await aggregateStreamToCompletion(
      this.streamChatCompletion(apiKey, messages, modelId, options, quotaContext),
      modelId,
    );
    out._routed_via = { platform: this.platform, model: modelId };
    return out;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const threadId = toCommandCodeSessionUuid(quotaContext?.keyId ? `key:${quotaContext.keyId}` : undefined);
    const payload = JSON.stringify(toCommandCodePayload(modelId, messages, options, threadId));
    const maxRetries = 2;

    let initialLines: string[] = [];
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let decoder = new TextDecoder();
    let buffer = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const headers = this.buildHeaders(apiKey, threadId, 'text/event-stream');
      const res = await this.fetchWithTimeout(
        this.generateUrl,
        { method: 'POST', headers, body: payload },
        options?.timeoutMs ?? this.timeoutMs,
        { signal: options?.signal },
      );

      recordQuotaObservationsFromResponse(res, {
        platform: this.platform,
        keyId: quotaContext?.keyId,
        providerAccountId: quotaContext?.providerAccountId,
        modelId,
        endpoint: 'alpha/generate',
      });

      if (!res.ok) {
        if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < maxRetries && !options?.signal?.aborted) {
          res.body?.cancel?.().catch(() => {});
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        const err = (await res.json().catch(() => ({}))) as Record<string, any>;
        const msg = err?.error?.message ?? err?.message ?? res.statusText;
        throw providerHttpError(res, `${this.name} API error ${res.status}: ${msg}`, err);
      }

      if (!res.body) throw new Error('No response body from Command Code');
      const activeReader = res.body.getReader();
      reader = activeReader;
      decoder = new TextDecoder();
      buffer = '';
      initialLines = [];
      let detectedError: { statusCode: number; message: string } | null = null;

      const stallMs = DEFAULT_STREAM_STALL_MS;
      const firstByteMs = this.firstByteBudgetMs(options?.timeoutMs ?? this.timeoutMs, stallMs);
      let awaitingFirst = true;

      while (true) {
        const { done, value } = awaitingFirst
          ? await this.readWithStallTimeout(() => activeReader.read(), firstByteMs, this.firstByteTimeoutMessage(firstByteMs))
          : await this.readWithStallTimeout(() => activeReader.read(), stallMs);
        awaitingFirst = false;

        if (value) buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let ready = false;
        for (const raw of lines) {
          const trimmed = raw.trim();
          if (!trimmed) continue;
          initialLines.push(trimmed);
          const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
          if (!jsonStr || jsonStr === '[DONE]') {
            ready = true;
            continue;
          }
          try {
            const ev = JSON.parse(jsonStr);
            if (ev?.type === 'error') {
              detectedError = parseCommandCodeError(ev);
              ready = true;
              break;
            }
            if (
              ev?.type === 'text-delta'
              || ev?.type === 'reasoning-delta'
              || ev?.type === 'tool-input-start'
              || ev?.type === 'tool-call'
              || ev?.type === 'finish-step'
              || ev?.type === 'finish'
            ) {
              ready = true;
            }
          } catch { /* ignore */ }
        }
        if (done || ready) {
          if (done && buffer.trim()) {
            const trimmed = buffer.trim();
            buffer = '';
            initialLines.push(trimmed);
            try {
              const ev = JSON.parse(trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed);
              if (ev?.type === 'error') detectedError = parseCommandCodeError(ev);
            } catch { /* ignore */ }
          }
          break;
        }
      }

      if (detectedError) {
        reader.cancel().catch(() => {});
        reader = null;
        if (
          (detectedError.statusCode === 502 || detectedError.statusCode === 503 || detectedError.statusCode === 504)
          && attempt < maxRetries
          && !options?.signal?.aborted
        ) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        const synthetic = new Response(JSON.stringify({ error: { message: detectedError.message } }), {
          status: detectedError.statusCode,
        });
        throw providerHttpError(synthetic, `[CommandCode error: ${detectedError.message}]`, {
          error: { message: detectedError.message },
        });
      }

      break;
    }

    const state: CommandCodeStreamState = {
      id: this.makeId(),
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      emittedRole: false,
      toolIndex: 0,
      toolIndexById: new Map(),
      finishReason: null,
      usage: null,
    };

    try {
      for (const line of initialLines) {
        const jsonStr = line.startsWith('data:') ? line.slice(5).trim() : line;
        if (!jsonStr || jsonStr === '[DONE]') continue;
        let ev: Record<string, any>;
        try { ev = JSON.parse(jsonStr); } catch { continue; }
        for (const chunk of translateCommandCodeEvent(ev, state)) yield chunk;
      }

      if (!reader) return;
      const tailReader = reader;
      const stallMs = DEFAULT_STREAM_STALL_MS;
      while (true) {
        const { done, value } = await this.readWithStallTimeout(() => tailReader.read(), stallMs);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const raw of lines) {
          const trimmed = raw.trim();
          if (!trimmed) continue;
          const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
          if (!jsonStr || jsonStr === '[DONE]') continue;
          let ev: Record<string, any>;
          try { ev = JSON.parse(jsonStr); } catch { continue; }
          for (const chunk of translateCommandCodeEvent(ev, state)) yield chunk;
        }
      }

      const tail = buffer.trim();
      if (tail) {
        const jsonStr = tail.startsWith('data:') ? tail.slice(5).trim() : tail;
        if (jsonStr && jsonStr !== '[DONE]') {
          try {
            const ev = JSON.parse(jsonStr);
            for (const chunk of translateCommandCodeEvent(ev, state)) yield chunk;
          } catch { /* ignore */ }
        }
      }
    } finally {
      reader?.cancel().catch(() => {});
    }
  }

  async validateKey(
    apiKey: string,
    _quotaContext?: QuotaObservationContext,
    _options?: KeyValidationOptions,
  ): Promise<KeyValidationResult> {
    const url = `${this.originUrl}/provider/v1/models?view=client`;
    const headers = this.buildHeaders(apiKey, toCommandCodeSessionUuid());
    const res = await this.fetchWithTimeout(url, { method: 'GET', headers }, 10_000, { timeoutBounds: 'request' });
    if (res.ok) return true;
    return this.validationResult(res);
  }
}
