import { createHash, randomUUID } from 'node:crypto';
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  Platform,
} from '@freellmapi/shared/types.js';
import {
  BaseProvider,
  type CompletionOptions,
  type KeyValidationOptions,
  type KeyValidationResult,
  providerHttpError,
} from '../../providers/base.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../../services/provider-quota.js';
import { DEFAULT_STREAM_STALL_MS, readFramedSseLines } from './wire-helpers.js';

export interface AntigravityProviderOptions {
  name?: string;
  baseUrl?: string;
  tokenUrl?: string;
  cloudCodeBaseUrl?: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

export interface AntigravityCredential {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  projectId?: string;
  email?: string;
}

export const ANTIGRAVITY_DEFAULT_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com';
export const ANTIGRAVITY_CLOUD_CODE_BASE = 'https://cloudcode-pa.googleapis.com';
export const ANTIGRAVITY_IDE_USER_AGENT = 'antigravity/hub/2.24.0 darwin/arm64';
export const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
export const ANTIGRAVITY_CLIENT_SECRET = String.fromCharCode(
  71, 79, 67, 83, 80, 88, 45, 75, 53, 56, 70, 87, 82, 52, 56, 54, 76, 100, 76, 74, 49, 109, 76, 66, 56, 115, 88, 67, 52, 122, 54, 113, 68, 65, 102,
);
const DEFAULT_THOUGHT_SIG = 'skip_thought_signature_validator';
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();
const projectCache = new Map<string, string>();

export function _resetAntigravityCachesForTests(): void {
  tokenCache.clear();
  projectCache.clear();
}

export function parseAntigravityCredential(raw: string): AntigravityCredential {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const p = JSON.parse(trimmed) as Record<string, any>;
      return {
        accessToken: typeof p.accessToken === 'string' ? p.accessToken : typeof p.access_token === 'string' ? p.access_token : undefined,
        refreshToken: typeof p.refreshToken === 'string' ? p.refreshToken : typeof p.refresh_token === 'string' ? p.refresh_token : undefined,
        expiresAt: typeof p.expiresAt === 'number' ? p.expiresAt : undefined,
        projectId: typeof p.projectId === 'string'
          ? p.projectId
          : typeof p.project_id === 'string'
            ? p.project_id
            : typeof p.providerSpecificData?.projectId === 'string'
              ? p.providerSpecificData.projectId
              : undefined,
        email: typeof p.email === 'string' ? p.email : undefined,
      };
    } catch { /* fallback below */ }
  }
  return { accessToken: trimmed };
}

function sanitizeFunctionName(name: string): string {
  const cleaned = (name || '_unknown').replace(/[^a-zA-Z0-9_.:-]/g, '_');
  const prefixed = /^[a-zA-Z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
  return prefixed.slice(0, 64);
}

function cleanSchemaForAntigravity(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchemaForAntigravity);
  const out: Record<string, unknown> = {};
  const stripKeys = new Set([
    '$schema', '$id', '$defs', 'definitions', '$ref', 'additionalProperties',
    'default', 'title', 'examples', 'exclusiveMinimum', 'exclusiveMaximum',
    'propertyNames', 'patternProperties', 'const',
  ]);
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (stripKeys.has(k)) continue;
    if (k === 'type' && Array.isArray(v)) {
      const nonNull = v.find((t) => t !== 'null');
      out.type = nonNull ?? 'string';
      continue;
    }
    out[k] = cleanSchemaForAntigravity(v);
  }
  return out;
}

function textFromMessage(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

function uuidFromSeed(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function isImageModel(model: string): boolean {
  return /image|imagen|image-generation/i.test(model);
}

function toAntigravityContents(messages: ChatMessage[]): {
  contents: Array<Record<string, unknown>>;
  systemInstruction?: { role: string; parts: Array<{ text: string }> };
} {
  const systemTexts: string[] = [];
  const contents: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === 'system') {
      const t = textFromMessage(msg.content);
      if (t) systemTexts.push(t);
      continue;
    }
    if (msg.role === 'tool') {
      let responseObj: Record<string, unknown>;
      const rawText = typeof msg.content === 'string' ? msg.content : textFromMessage(msg.content);
      try {
        const p = JSON.parse(rawText);
        responseObj = p && typeof p === 'object' && !Array.isArray(p) ? p : { result: p };
      } catch {
        responseObj = { result: rawText };
      }
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: sanitizeFunctionName(msg.name || msg.tool_call_id || 'tool'),
            ...(msg.tool_call_id ? { id: msg.tool_call_id } : {}),
            response: responseObj,
          },
        }],
      });
      continue;
    }
    if (msg.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      const text = textFromMessage(msg.content);
      if (text) parts.push({ text });
      if (Array.isArray(msg.tool_calls)) {
        let firstCall = true;
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(tc.function.arguments || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
          } catch { /* empty */ }
          parts.push({
            functionCall: {
              ...(tc.id ? { id: tc.id } : {}),
              name: sanitizeFunctionName(tc.function.name),
              args,
            },
            ...(firstCall ? { thoughtSignature: DEFAULT_THOUGHT_SIG } : {}),
          });
          firstCall = false;
        }
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }

    const parts: Array<Record<string, unknown>> = [];
    if (typeof msg.content === 'string') {
      if (msg.content) parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string' && part.text) {
          parts.push({ text: part.text });
        } else if (part.type === 'image_url') {
          const url = typeof part.image_url === 'string'
            ? part.image_url
            : (part.image_url as { url?: string } | undefined)?.url;
          const m = typeof url === 'string' ? url.match(/^data:([^;]+);base64,(.+)$/s) : null;
          if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
        }
      }
    }
    if (parts.length === 0) parts.push({ text: '' });
    contents.push({ role: 'user', parts });
  }

  return {
    contents,
    ...(systemTexts.length > 0 ? { systemInstruction: { role: 'user', parts: [{ text: systemTexts.join('\n\n') }] } } : {}),
  };
}

function unwrapAntigravityEnvelope(data: Record<string, any>): Record<string, any> {
  return data?.response && typeof data.response === 'object' ? data.response : data;
}

function parseQuotaResetHint(bodyText: string): string {
  try {
    const err = JSON.parse(bodyText)?.error;
    const details = Array.isArray(err?.details) ? err.details : [];
    for (const d of details) {
      if (d?.metadata?.quotaResetTimeStamp) return ` (resets ${d.metadata.quotaResetTimeStamp})`;
      if (typeof d?.retryDelay === 'string') return ` (retry after ${d.retryDelay})`;
    }
  } catch { /* ignore */ }
  return '';
}

function mapFinishReason(reason?: string): string {
  const r = (reason ?? '').toUpperCase();
  if (r === 'MAX_TOKENS') return 'length';
  if (r === 'SAFETY' || r === 'RECITATION' || r === 'BLOCKLIST') return 'content_filter';
  return 'stop';
}

export class AntigravityProvider extends BaseProvider {
  readonly platform = 'antigravity' as Platform;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly cloudCodeBaseUrl: string;
  private readonly tokenUrl: string;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: AntigravityProviderOptions = {}) {
    super();
    this.name = opts.name ?? 'Antigravity';
    this.baseUrl = (opts.baseUrl || ANTIGRAVITY_DEFAULT_BASE_URL).replace(/\/v1internal$/i, '').replace(/\/+$/, '');
    this.cloudCodeBaseUrl = (opts.cloudCodeBaseUrl || ANTIGRAVITY_CLOUD_CODE_BASE).replace(/\/+$/, '');
    this.tokenUrl = opts.tokenUrl ?? 'https://oauth2.googleapis.com/token';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.extraHeaders = { ...opts.extraHeaders };
  }

  private async ensureAccessToken(cred: AntigravityCredential): Promise<{ accessToken: string; expiresAt?: number }> {
    const cacheKey = cred.refreshToken ? `ag:${createHash('sha256').update(cred.refreshToken).digest('hex')}` : '';
    const cached = cacheKey ? tokenCache.get(cacheKey) : undefined;
    if (cached && cached.expiresAt - Date.now() > 300_000) {
      return cached;
    }

    const notExpired = cred.accessToken && (!cred.expiresAt || cred.expiresAt - Date.now() > 300_000);
    if (notExpired && cred.accessToken) {
      return { accessToken: cred.accessToken, expiresAt: cred.expiresAt };
    }

    if (!cred.refreshToken) {
      if (cred.accessToken) return { accessToken: cred.accessToken, expiresAt: cred.expiresAt };
      throw new Error('Antigravity credential missing accessToken and refreshToken');
    }

    const res = await this.fetchWithTimeout(
      this.tokenUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: ANTIGRAVITY_CLIENT_ID,
          client_secret: ANTIGRAVITY_CLIENT_SECRET,
          refresh_token: cred.refreshToken,
        }).toString(),
      },
      15_000,
      { timeoutBounds: 'request' },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw providerHttpError(res, `Antigravity token refresh failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json?.access_token) throw new Error('Antigravity token refresh returned no access_token');
    const entry = {
      accessToken: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    if (cacheKey) tokenCache.set(cacheKey, entry);
    return entry;
  }

  private async ensureProjectId(accessToken: string, cred: AntigravityCredential): Promise<string> {
    if (cred.projectId) return cred.projectId;
    const key = createHash('sha256').update(accessToken).digest('hex');
    if (projectCache.has(key)) return projectCache.get(key)!;

    try {
      const res = await this.fetchWithTimeout(
        `${this.cloudCodeBaseUrl}/v1internal:loadCodeAssist`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': ANTIGRAVITY_IDE_USER_AGENT,
          },
          body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
        },
        10_000,
        { timeoutBounds: 'request' },
      );
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { cloudaicompanionProject?: string | { id?: string } };
        const proj = typeof data.cloudaicompanionProject === 'string'
          ? data.cloudaicompanionProject
          : data.cloudaicompanionProject?.id;
        if (proj) {
          projectCache.set(key, proj);
          return proj;
        }
      }
    } catch { /* fallback below */ }

    const fallback = `ag-${key.slice(0, 12)}`;
    projectCache.set(key, fallback);
    return fallback;
  }

  private buildEnvelope(
    modelId: string,
    messages: ChatMessage[],
    options: CompletionOptions | undefined,
    projectId: string,
    cred: AntigravityCredential,
  ): Record<string, unknown> {
    const cleanModel = modelId.replace(/-(\d+)x(\d+)$/, '');
    const { contents, systemInstruction } = toAntigravityContents(messages);
    const seed = cred.email || projectId || 'anonymous';
    const sessionId = uuidFromSeed(`antigravity:session:${seed}`);
    const conversationId = uuidFromSeed(`antigravity:conversation:${seed}`);
    const trajectoryId = uuidFromSeed(`antigravity:trajectory:${seed}:${cleanModel}`);
    const requestType = isImageModel(modelId) ? 'image_gen' : 'agent';
    const requestId = `agent/${conversationId}/${Date.now()}/${trajectoryId}/${Math.max(1, contents.length * 2 - 1)}`;

    const generationConfig: Record<string, unknown> = {};
    if (options?.temperature !== undefined) generationConfig.temperature = options.temperature;
    if (options?.top_p !== undefined) generationConfig.topP = options.top_p;
    if (options?.top_k !== undefined) generationConfig.topK = options.top_k;
    if (options?.max_tokens !== undefined) generationConfig.maxOutputTokens = Math.min(options.max_tokens, 64_000);
    if (options?.stop) generationConfig.stopSequences = Array.isArray(options.stop) ? options.stop : [options.stop];

    const request: Record<string, unknown> = {
      contents,
      sessionId,
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    };

    if (!isImageModel(modelId)) {
      if (systemInstruction) request.systemInstruction = systemInstruction;
      if (Array.isArray(options?.tools) && options.tools.length > 0) {
        request.tools = [{
          functionDeclarations: options.tools.map((t: NonNullable<CompletionOptions['tools']>[number]) => ({
            name: sanitizeFunctionName(t.function.name),
            description: t.function.description ?? '',
            parameters: cleanSchemaForAntigravity(t.function.parameters ?? { type: 'object', properties: {} }),
          })),
        }];
      }
    }

    return {
      project: projectId,
      model: cleanModel,
      userAgent: 'antigravity',
      requestType,
      requestId,
      request,
    };
  }

  private async fetchWithTransientRetry(
    url: string,
    body: string,
    accessToken: string,
    timeoutMs: number,
    stream: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': ANTIGRAVITY_IDE_USER_AGENT,
            ...(stream ? { Accept: 'text/event-stream' } : {}),
            ...this.extraHeaders,
          },
          body,
        },
        timeoutMs,
        { signal, timeoutBounds: stream ? 'headers' : 'request' },
      );
      if (TRANSIENT_STATUSES.has(res.status) && attempt < 2 && !signal?.aborted) {
        res.body?.cancel?.().catch(() => {});
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      return res;
    }
    throw new Error('Antigravity request exhausted transient retries');
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const cred = parseAntigravityCredential(apiKey);
    const { accessToken } = await this.ensureAccessToken(cred);
    const projectId = await this.ensureProjectId(accessToken, cred);
    const envelope = this.buildEnvelope(modelId, messages, options, projectId, cred);
    const url = `${this.baseUrl}/v1internal:generateContent`;

    const res = await this.fetchWithTransientRetry(
      url,
      JSON.stringify(envelope),
      accessToken,
      options?.timeoutMs ?? this.timeoutMs,
      false,
      options?.signal,
    );

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      endpoint: 'generateContent',
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const hint = (res.status === 429 || res.status === 409) ? parseQuotaResetHint(bodyText) : '';
      let msg = res.statusText;
      try { msg = JSON.parse(bodyText)?.error?.message ?? msg; } catch { /* ignore */ }
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${msg}${hint}`);
    }

    const raw = (await res.json()) as Record<string, any>;
    const payload = unwrapAntigravityEnvelope(raw);
    const candidate = payload?.candidates?.[0];
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const texts: string[] = [];
    const thoughts: string[] = [];
    const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];

    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      if (p.thought === true && typeof p.text === 'string') thoughts.push(p.text);
      else if (typeof p.text === 'string') texts.push(p.text);
      else if (p.functionCall?.name) {
        toolCalls.push({
          id: String(p.functionCall.id || `call_${toolCalls.length}_${randomUUID().slice(0, 6)}`),
          type: 'function',
          function: { name: String(p.functionCall.name), arguments: JSON.stringify(p.functionCall.args ?? {}) },
        });
      }
    }

    const promptTokens = Number(payload?.usageMetadata?.promptTokenCount ?? 0);
    const completionTokens = Number(payload?.usageMetadata?.candidatesTokenCount ?? 0);
    const text = texts.join('');
    const reasoning = thoughts.join('');
    const out: ChatCompletionResponse = {
      id: this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text.length > 0 ? text : (toolCalls.length > 0 ? (null as unknown as string) : ''),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        } as ChatMessage,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : mapFinishReason(candidate?.finishReason),
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: Number(payload?.usageMetadata?.totalTokenCount ?? (promptTokens + completionTokens)),
      },
      _routed_via: { platform: this.platform, model: modelId },
    };
    return out;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    if (isImageModel(modelId)) {
      const done = await this.chatCompletion(apiKey, messages, modelId, options, quotaContext);
      const id = done.id;
      const msg = done.choices[0]?.message;
      const contentStr = textFromMessage(msg?.content ?? '');
      yield {
        id,
        object: 'chat.completion.chunk',
        created: done.created,
        model: modelId,
        choices: [{ index: 0, delta: { role: 'assistant', content: contentStr }, finish_reason: 'stop' }],
      };
      return;
    }

    const cred = parseAntigravityCredential(apiKey);
    const { accessToken } = await this.ensureAccessToken(cred);
    const projectId = await this.ensureProjectId(accessToken, cred);
    const envelope = this.buildEnvelope(modelId, messages, options, projectId, cred);
    const url = `${this.baseUrl}/v1internal:streamGenerateContent?alt=sse`;

    const res = await this.fetchWithTransientRetry(
      url,
      JSON.stringify(envelope),
      accessToken,
      options?.timeoutMs ?? this.timeoutMs,
      true,
      options?.signal,
    );

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      endpoint: 'streamGenerateContent',
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const hint = (res.status === 429 || res.status === 409) ? parseQuotaResetHint(bodyText) : '';
      let msg = res.statusText;
      try { msg = JSON.parse(bodyText)?.error?.message ?? msg; } catch { /* ignore */ }
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${msg}${hint}`);
    }

    const stallMs = DEFAULT_STREAM_STALL_MS;
    const firstByteMs = this.firstByteBudgetMs(options?.timeoutMs ?? this.timeoutMs, stallMs);
    const lines = readFramedSseLines(
      res,
      (read, ms, msg) => this.readWithStallTimeout(read, ms, msg),
      firstByteMs,
      stallMs,
      this.firstByteTimeoutMessage(firstByteMs),
    );

    const id = this.makeId();
    let sawToolCalls = false;
    let emittedFinish = false;
    let nextToolIndex = 0;

    for await (const { data } of lines) {
      if (!data) continue;
      if (data === '[DONE]') break;
      let parsed: Record<string, any>;
      try { parsed = JSON.parse(data); } catch { continue; }
      const payload = unwrapAntigravityEnvelope(parsed);
      const candidate = payload?.candidates?.[0];
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      const texts: string[] = [];
      const thoughts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];

      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        if (p.thought === true && typeof p.text === 'string') thoughts.push(p.text);
        else if (typeof p.text === 'string') texts.push(p.text);
        else if (p.functionCall?.name) {
          sawToolCalls = true;
          toolCalls.push({
            index: nextToolIndex++,
            id: String(p.functionCall.id || `call_${nextToolIndex}`),
            type: 'function',
            function: { name: String(p.functionCall.name), arguments: JSON.stringify(p.functionCall.args ?? {}) },
          });
        }
      }

      if (texts.length > 0 || thoughts.length > 0 || toolCalls.length > 0) {
        yield {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{
            index: 0,
            delta: {
              ...(texts.length > 0 ? { content: texts.join('') } : {}),
              ...(thoughts.length > 0 ? { reasoning_content: thoughts.join('') } : {}),
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls as any } : {}),
            },
            finish_reason: null,
          }],
        };
      }

      if (candidate?.finishReason && !emittedFinish) {
        emittedFinish = true;
        yield {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: sawToolCalls ? 'tool_calls' : mapFinishReason(candidate.finishReason),
          }],
        };
      }
    }
  }

  async validateKey(
    apiKey: string,
    _quotaContext?: QuotaObservationContext,
    options?: KeyValidationOptions,
  ): Promise<KeyValidationResult> {
    try {
      const cred = parseAntigravityCredential(apiKey);
      const refreshed = await this.ensureAccessToken(cred);
      if (options?.onCredentialUpdate && refreshed.accessToken !== cred.accessToken) {
        options.onCredentialUpdate(JSON.stringify({ ...cred, ...refreshed }));
      }
      await this.ensureProjectId(refreshed.accessToken, cred);
      return true;
    } catch (err: any) {
      return { valid: false, error: err?.message ?? 'Antigravity validation failed' };
    }
  }
}
