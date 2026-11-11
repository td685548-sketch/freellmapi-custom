import { prepareClaudeOAuthBody } from './claude-oauth.js';
import { parseOAuthCredential } from './oauth-credentials.js';
import crypto from 'node:crypto';
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  Platform,
} from '@freellmapi/shared/types.js';
import { contentToString, estimateInputTokens } from '../../lib/content.js';
import { BaseProvider, providerHttpError, type CompletionOptions, type KeyValidationResult } from '../../providers/base.js';
import type { QuotaObservationContext } from '../../services/provider-quota.js';
import { runChatGptWebChat } from './chatgpt-web-chat.js';
import {
  fetchChatGptWebAccessToken,
  normalizeChatGptWebCookie,
} from './chatgpt-web-image.js';
import { looksLikeCookieHeader, looksLikeHtmlDocument } from './cookie-format.js';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface WebCookieProviderConfig {
  providerId: string;
  name: string;
  baseUrl: string;
  timeoutMs?: number;
}

const DEFAULT_COOKIE_NAMES: Record<string, string> = {
  'grok-web': 'sso',
  'chatgpt-web': '__Secure-next-auth.session-token',
  'perplexity-web': '__Secure-next-auth.session-token',
  'gemini-web': '__Secure-1PSID',
  'deepseek-web': 'userToken',
  'muse-web': 'session',
  'uc-web': 'session',
};

const ORIGIN_BY_PROVIDER: Record<string, string> = {
  'grok-web': 'https://grok.com',
  'chatgpt-web': 'https://chatgpt.com',
  'perplexity-web': 'https://www.perplexity.ai',
  'gemini-web': 'https://gemini.google.com',
  'deepseek-web': 'https://chat.deepseek.com',
  'muse-web': 'https://muse.ai',
  'uc-web': 'https://internal.chatuncensored.ai',
};

/**
 * Normalizes a user-provided web session credential into HTTP headers.
 * Accepts:
 * - Full Cookie header string (`sso=abc; sso-rw=def` or `Cookie: ...`)
 * - Raw cookie value (`eyJ...`) mapped to the provider's primary session cookie name
 * - Bearer token (`Bearer eyJ...` or JWT/token for deepseek-web / chatgpt-web)
 */
export function buildWebSessionHeaders(
  providerId: string,
  rawCredential: string,
): Record<string, string> {
  const trimmed = rawCredential.trim().replace(/^(?:Cookie|Authorization):\s*/i, '').trim();
  const origin = ORIGIN_BY_PROVIDER[providerId] ?? new URL(
    ORIGIN_BY_PROVIDER['chatgpt-web'],
  ).origin;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream, */*',
    'User-Agent': BROWSER_USER_AGENT,
    'Origin': origin,
    'Referer': `${origin}/`,
  };

  // ChatGPT Web is the only webCookie provider that exchanges the stored cookie
  // for an access token; normalize token / Cookie header / storage-state JSON
  // into the Cookie header the handshake expects.
  if (providerId === 'chatgpt-web') {
    headers['Cookie'] = normalizeChatGptWebCookie(trimmed);
    return headers;
  }

  if (/^Bearer\s+/i.test(trimmed)) {
    headers['Authorization'] = trimmed;
    return headers;
  }

  // If the credential contains key=value pairs (e.g. `sso=xyz; sso-rw=abc`), send as Cookie header
  if (looksLikeCookieHeader(trimmed)) {
    headers['Cookie'] = trimmed;
    return headers;
  }

  const cookieName = DEFAULT_COOKIE_NAMES[providerId] ?? 'session';
  if (providerId === 'deepseek-web') {
    headers['Authorization'] = `Bearer ${trimmed}`;
    headers['Cookie'] = `${cookieName}=${trimmed}`;
    return headers;
  }

  headers['Cookie'] = `${cookieName}=${trimmed}`;
  return headers;
}

function buildConversationPrompt(messages: ChatMessage[]): string {
  if (messages.length === 1) {
    return contentToString(messages[0].content);
  }
  return messages
    .map(m => {
      const text = contentToString(m.content);
      if (!text) return '';
      if (m.role === 'system') return `[System]\n${text}`;
      if (m.role === 'assistant') return `[Assistant]\n${text}`;
      if (m.role === 'tool') return `[Tool Result]\n${text}`;
      return text;
    })
    .filter(Boolean)
    .join('\n\n');
}

export function buildWebProviderPayload(
  providerId: string,
  messages: ChatMessage[],
  modelId: string,
  stream: boolean,
  options?: CompletionOptions,
): { pathSuffix: string; body: Record<string, unknown> } {
  const prompt = buildConversationPrompt(messages);

  switch (providerId) {
    case 'grok-web':
      return {
        pathSuffix: '',
        body: {
          temporary: false,
          modelName: modelId || 'grok-3',
          message: prompt,
          fileAttachments: [],
          imageAttachments: [],
          disableSearch: false,
          enableImageGeneration: false,
          returnImageBytes: false,
          returnRawGrokInXaiRequest: false,
          enableImageStreaming: false,
          imageGenerationCount: 0,
          forceConcise: false,
          toolOverrides: {},
          enableSideBySide: false,
          sendFinalMetadata: true,
          isReasoning: modelId.includes('reasoning') || modelId.includes('think'),
        },
      };

    case 'perplexity-web':
      return {
        pathSuffix: '',
        body: {
          query_str: prompt,
          params: {
            model_preference: modelId || 'turbo',
            mode: 'concise',
            sources: ['web'],
            version: '2.18',
          },
        },
      };

    case 'deepseek-web':
      return {
        pathSuffix: '',
        body: {
          chat_session_id: null,
          parent_message_id: null,
          prompt,
          ref_file_ids: [],
          thinking_enabled: modelId.includes('reasoner') || modelId.includes('r1'),
          search_enabled: modelId.includes('search'),
        },
      };

    case 'chatgpt-web':
      return {
        pathSuffix: '/backend-api/conversation',
        body: {
          action: 'next',
          messages: [
            {
              id: crypto.randomUUID(),
              author: { role: 'user' },
              content: { content_type: 'text', parts: [prompt] },
            },
          ],
          parent_message_id: crypto.randomUUID(),
          model: modelId || 'gpt-4o',
          timezone_offset_min: 0,
        },
      };

    default:
      return {
        pathSuffix: '/v1/chat/completions',
        body: {
          model: modelId,
          messages,
          stream,
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options?.max_tokens !== undefined ? { max_tokens: options.max_tokens } : {}),
          ...(options?.top_p !== undefined ? { top_p: options.top_p } : {}),
        },
      };
  }
}

export function extractWebResponseText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return '';
  const obj = payload as Record<string, any>;

  // Standard OpenAI choices
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const choice = obj.choices[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string') return delta;
    const msg = choice?.message?.content;
    if (typeof msg === 'string') return msg;
    if (typeof choice?.text === 'string') return choice.text;
  }

  // Grok Web response lines: { result: { response: { token, modelResponse: { message } } } }
  const grokToken = obj.result?.response?.token ?? obj.result?.token;
  if (typeof grokToken === 'string') return grokToken;
  const grokFull = obj.result?.response?.modelResponse?.message ?? obj.result?.modelResponse?.message;
  if (typeof grokFull === 'string') return grokFull;

  // ChatGPT Web: { message: { content: { parts: ["..."] } } }
  const parts = obj.message?.content?.parts;
  if (Array.isArray(parts) && typeof parts[0] === 'string') {
    return parts.join('');
  }

  // Perplexity Web: { answer: "..." } or { text: "..." }
  if (typeof obj.answer === 'string') return obj.answer;
  if (typeof obj.output_text === 'string') return obj.output_text;
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.content === 'string') return obj.content;
  if (typeof obj.response === 'string') return obj.response;

  // DeepSeek Web: { choices: [{ delta: { content } }] } or { v: "..." }
  if (typeof obj.v === 'string') return obj.v;

  return '';
}

function resolveTargetUrl(baseUrl: string, pathSuffix: string): string {
  const cleanBase = baseUrl.trim().replace(/\/+$/, '');
  if (!pathSuffix) return cleanBase;
  if (cleanBase.endsWith(pathSuffix) || cleanBase.endsWith('/chat/completions')) {
    return cleanBase;
  }
  return `${cleanBase}${pathSuffix}`;
}

/**
 * Adapter for 9Router `webCookie` providers (`grok-web`, `chatgpt-web`, `perplexity-web`,
 * `gemini-web`, `deepseek-web`, `muse-web`, `uc-web`).
 * Translates OpenAI chat completion requests into web session requests with Cookie/Bearer
 * headers and normalizes JSON / SSE / NDJSON responses back to OpenAI format.
 */
export class WebCookieProvider extends BaseProvider {
  readonly platform: Platform = 'custom';
  readonly name: string;
  readonly providerId: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: WebCookieProviderConfig) {
    super();
    this.providerId = config.providerId;
    this.name = config.name;
    this.baseUrl = config.baseUrl;
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  override async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    _quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    if (this.providerId === 'chatgpt-web') {
      return this.chatGptWebCompletion(apiKey, messages, modelId, options);
    }

    const { pathSuffix, body } = buildWebProviderPayload(this.providerId, messages, modelId, false, options);
    const url = resolveTargetUrl(this.baseUrl, pathSuffix);
    const headers = buildWebSessionHeaders(this.providerId, apiKey);

    const res = await this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
      options?.timeoutMs ?? this.timeoutMs,
      { signal: options?.signal, timeoutBounds: 'request' },
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw providerHttpError(
        res,
        `${this.name} web session error (HTTP ${res.status}): ${errText.slice(0, 240) || res.statusText}`,
        errText,
      );
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      throw this.htmlChallengeError('response');
    }

    const rawText = await res.text();
    const trimmed = rawText.trim();
    if (looksLikeHtmlDocument(trimmed)) {
      throw this.htmlChallengeError('response');
    }

    // Check if response is already a standard OpenAI ChatCompletionResponse
    try {
      const parsed = JSON.parse(trimmed) as Record<string, any>;
      if (Array.isArray(parsed.choices) && parsed.choices[0]?.message) {
        return parsed as ChatCompletionResponse;
      }
      const extracted = extractWebResponseText(parsed);
      const promptTokens = estimateInputTokens(messages);
      const completionTokens = Math.max(1, Math.ceil(extracted.length / 4));
      return {
        id: this.makeId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: extracted },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
    } catch {
      // Multi-line NDJSON or SSE stream returned on non-streaming endpoint (e.g. Grok Web / ChatGPT Web)
      let combined = '';
      for (const line of trimmed.split('\n')) {
        const clean = line.trim().replace(/^data:\s*/, '');
        if (!clean || clean === '[DONE]') continue;
        try {
          const obj = JSON.parse(clean);
          combined += extractWebResponseText(obj);
        } catch {
          // ignore non-JSON event lines
        }
      }
      const finalContent = combined || trimmed;
      const promptTokens = estimateInputTokens(messages);
      const completionTokens = Math.max(1, Math.ceil(finalContent.length / 4));
      return {
        id: this.makeId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: finalContent },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
    }
  }

  override async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    _quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    if (this.providerId === 'chatgpt-web') {
      const text = await runChatGptWebChat({
        credential: apiKey,
        messages,
        baseUrl: this.baseUrl,
        platform: this.platform,
        signal: options?.signal,
      });
      const chatGptId = this.makeId();
      const chatGptCreated = Math.floor(Date.now() / 1000);
      if (text) {
        yield {
          id: chatGptId,
          object: 'chat.completion.chunk',
          created: chatGptCreated,
          model: modelId,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        };
      }
      yield {
        id: chatGptId,
        object: 'chat.completion.chunk',
        created: chatGptCreated,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      return;
    }

    const { pathSuffix, body } = buildWebProviderPayload(this.providerId, messages, modelId, true, options);
    const url = resolveTargetUrl(this.baseUrl, pathSuffix);
    const headers = buildWebSessionHeaders(this.providerId, apiKey);

    const res = await this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
      options?.timeoutMs ?? this.timeoutMs,
      { signal: options?.signal },
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw providerHttpError(
        res,
        `${this.name} web stream error (HTTP ${res.status}): ${errText.slice(0, 240) || res.statusText}`,
        errText,
      );
    }

    if ((res.headers.get('content-type') ?? '').includes('text/html')) {
      throw this.htmlChallengeError('stream');
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error(`${this.name}: empty response body`);

    const decoder = new TextDecoder();
    const id = this.makeId();
    const created = Math.floor(Date.now() / 1000);
    let buffer = '';
    let emittedAny = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const trimmed = rawLine.trim();
          if (!trimmed || trimmed.startsWith('event:')) continue;
          const payloadStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
          if (!payloadStr || payloadStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payloadStr) as Record<string, any>;
            if (parsed.object === 'chat.completion.chunk' && Array.isArray(parsed.choices)) {
              emittedAny = true;
              yield parsed as ChatCompletionChunk;
              continue;
            }
            const text = extractWebResponseText(parsed);
            if (text) {
              emittedAny = true;
              yield {
                id,
                object: 'chat.completion.chunk',
                created,
                model: modelId,
                choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
              };
            }
          } catch {
            // Skip non-JSON lines
          }
        }
      }

      if (buffer.trim()) {
        const clean = buffer.trim().replace(/^data:\s*/, '');
        if (clean && clean !== '[DONE]') {
          try {
            const parsed = JSON.parse(clean);
            const text = extractWebResponseText(parsed);
            if (text) {
              emittedAny = true;
              yield {
                id,
                object: 'chat.completion.chunk',
                created,
                model: modelId,
                choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
              };
            }
          } catch {
            if (!emittedAny) {
              emittedAny = true;
              yield {
                id,
                object: 'chat.completion.chunk',
                created,
                model: modelId,
                choices: [{ index: 0, delta: { content: clean }, finish_reason: null }],
              };
            }
          }
        }
      }

      yield {
        id,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  /** Non-streaming ChatGPT Web turn (session -> Sentinel -> prepare -> poll). */
  private async chatGptWebCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const text = await runChatGptWebChat({
      credential: apiKey,
      messages,
      baseUrl: this.baseUrl,
      platform: this.platform,
      signal: options?.signal,
    });
    const promptTokens = estimateInputTokens(messages);
    const completionTokens = Math.max(1, Math.ceil(text.length / 4));
    return {
      id: this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  private htmlChallengeError(phase: string): Error {
    return Object.assign(
      new Error(`${this.name} returned an HTML challenge page (${phase}); refresh the web session cookie`),
      { status: 403 },
    );
  }

  override async validateKey(apiKey: string): Promise<KeyValidationResult> {
    if (!apiKey || !apiKey.trim()) {
      return { valid: false, error: 'Empty web session cookie or token' };
    }
    // Only ChatGPT Web exposes a cheap session probe. Other webCookie providers
    // have no unauthenticated endpoint to validate against.
    if (this.providerId !== 'chatgpt-web') return true;

    try {
      const cookie = normalizeChatGptWebCookie(apiKey);
      await fetchChatGptWebAccessToken(cookie, BROWSER_USER_AGENT, this.baseUrl, this.platform);
      return true;
    } catch (err) {
      const status = (err as { status?: unknown } | null)?.status;
      // Only a definitive auth answer invalidates the key: an unreachable
      // upstream must not mark a working account unhealthy.
      if (status === 401 || status === 403) {
        return {
          valid: false,
          error: err instanceof Error ? err.message : 'ChatGPT Web session is not signed in',
        };
      }
      return true;
    }
  }
}

/**
 * Adapter for upstream providers in the 9Router catalog that speak Anthropic's
 * `/v1/messages` wire format natively (e.g. `claude` at `https://api.anthropic.com/v1`
 * and `glm` at `https://api.z.ai/api/anthropic/v1`).
 */
export class AnthropicWireProvider extends BaseProvider {
  readonly platform: Platform = 'custom';
  readonly name: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(config: { name: string; baseUrl: string; timeoutMs?: number; extraHeaders?: Record<string, string> }) {
    super();
    this.name = config.name;
    this.baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.extraHeaders = config.extraHeaders ?? {};
  }

  private buildAnthropicBody(
    messages: ChatMessage[],
    modelId: string,
    stream: boolean,
    options?: CompletionOptions,
  ): Record<string, unknown> {
    const systemParts: string[] = [];
    const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = contentToString(msg.content);
        if (text) systemParts.push(text);
        continue;
      }
      if (msg.role === 'tool') {
        anthropicMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id ?? 'toolu_0',
              content: contentToString(msg.content),
              ...(msg.is_error === true ? { is_error: true } : {}),
            },
          ],
        });
        continue;
      }
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        const blocks: unknown[] = [];
        const text = contentToString(msg.content);
        if (text) blocks.push({ type: 'text', text });
        for (const tc of msg.tool_calls) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc.function.arguments || '{}');
          } catch {
            input = {};
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
        anthropicMessages.push({ role: 'assistant', content: blocks });
        continue;
      }
      anthropicMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: contentToString(msg.content) || ' ',
      });
    }

    if (anthropicMessages.length === 0) {
      anthropicMessages.push({ role: 'user', content: 'Hello' });
    }

    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens: options?.max_tokens ?? 4096,
      messages: anthropicMessages,
      stream,
    };
    if (systemParts.length > 0) body.system = systemParts.join('\n\n');
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.top_p !== undefined) body.top_p = options.top_p;
    if (options?.tools?.length) {
      body.tools = options.tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters ?? { type: 'object', properties: {} },
      }));
    }
    return body;
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    const credential = parseOAuthCredential(apiKey);
    if (credential) {
      if (credential.kind !== 'claude') throw new Error('Claude requires a matching OAuth credential.');
      return { ...this.extraHeaders, 'Content-Type': 'application/json', Authorization: `Bearer ${credential.accessToken}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14', 'User-Agent': 'claude-cli/2.1.280 (external, sdk-cli)', 'x-app': 'cli' };
    }
    const token = apiKey.trim().replace(/^Bearer\s+/i, '');
    return {
      ...this.extraHeaders,
      'Content-Type': 'application/json',
      'x-api-key': token,
      'Authorization': `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
    };
  }

  override async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const url = parseOAuthCredential(apiKey)?.kind === 'claude'
      ? 'https://api.anthropic.com/v1/messages?beta=true'
      : `${this.baseUrl}/messages`;
    const res = await this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: this.buildHeaders(apiKey),
        body: JSON.stringify(prepareClaudeOAuthBody(apiKey, this.buildAnthropicBody(messages, modelId, false, options))),
      },
      options?.timeoutMs ?? this.timeoutMs,
      { signal: options?.signal, timeoutBounds: 'request' },
    );

    if (!res.ok) {
      await res.body?.cancel();
      const errText = '';
      throw providerHttpError(
        res,
        `${this.name} error (HTTP ${res.status}): Upstream request failed.`,
        errText,
      );
    }

    const data = (await res.json()) as Record<string, any>;
    const blocks = Array.isArray(data.content) ? data.content : [];
    const textParts: string[] = [];
    const toolCalls: ChatToolCall[] = [];

    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (block?.type === 'tool_use') {
        toolCalls.push({
          id: String(block.id ?? `call_${ toolCalls.length + 1 }`),
          type: 'function',
          function: {
            name: String(block.name ?? ''),
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    const promptTokens = data.usage?.input_tokens ?? estimateInputTokens(messages);
    const completionTokens = data.usage?.output_tokens ?? Math.ceil(textParts.join('').length / 4);

    return {
      id: String(data.id ?? this.makeId()),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: String(data.model ?? modelId),
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: textParts.join('') || (toolCalls.length > 0 ? null : ''),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : (data.stop_reason === 'max_tokens' ? 'length' : 'stop'),
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  override async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const url = parseOAuthCredential(apiKey)?.kind === 'claude'
      ? 'https://api.anthropic.com/v1/messages?beta=true'
      : `${this.baseUrl}/messages`;
    const res = await this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: this.buildHeaders(apiKey),
        body: JSON.stringify(prepareClaudeOAuthBody(apiKey, this.buildAnthropicBody(messages, modelId, true, options))),
      },
      options?.timeoutMs ?? this.timeoutMs,
      { signal: options?.signal },
    );

    if (!res.ok) {
      await res.body?.cancel();
      const errText = '';
      throw providerHttpError(
        res,
        `${this.name} stream error (HTTP ${res.status}): Upstream request failed.`,
        errText,
      );
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error(`${this.name}: empty response body`);
    const decoder = new TextDecoder();
    const id = this.makeId();
    const created = Math.floor(Date.now() / 1000);
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payloadStr = trimmed.slice(5).trim();
          if (!payloadStr || payloadStr === '[DONE]') continue;

          try {
            const ev = JSON.parse(payloadStr) as Record<string, any>;
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
              yield {
                id,
                object: 'chat.completion.chunk',
                created,
                model: modelId,
                choices: [{ index: 0, delta: { content: ev.delta.text }, finish_reason: null }],
              };
            } else if (ev.type === 'message_stop') {
              yield {
                id,
                object: 'chat.completion.chunk',
                created,
                model: modelId,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              };
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  override async validateKey(apiKey: string): Promise<KeyValidationResult> {
    return Boolean(apiKey && apiKey.trim());
  }
}
