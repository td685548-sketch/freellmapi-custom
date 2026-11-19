import { createHash } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
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
import {
  DEFAULT_STREAM_STALL_MS,
  anthropicJsonToOpenAIResponse,
  chatToAnthropicRequest,
  createAnthropicStreamState,
  parseAnthropicSseEvent,
  readFramedSseLines,
} from './wire-helpers.js';

export type VertexVariant = 'vertex' | 'vertex-partner';

export interface VertexProviderOptions {
  providerId?: VertexVariant;
  name?: string;
  baseUrl?: string;
  tokenUrl?: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

interface VertexServiceAccountJson {
  type: 'service_account';
  project_id: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
  location?: string;
}

interface VertexAdcJson {
  type: 'authorized_user';
  client_id: string;
  client_secret: string;
  refresh_token: string;
  quota_project_id?: string;
  project_id?: string;
  location?: string;
}

interface TokenCacheEntry {
  accessToken: string;
  expiresAt: number;
}

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const vertexTokenCache = new Map<string, TokenCacheEntry>();
const projectIdCache = new Map<string, string>();

export function _resetVertexCachesForTests(): void {
  vertexTokenCache.clear();
  projectIdCache.clear();
}

export function parseVertexServiceAccount(raw: string): VertexServiceAccountJson | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed?.type === 'service_account'
      && typeof parsed.client_email === 'string'
      && typeof parsed.private_key === 'string'
      && typeof parsed.project_id === 'string'
    ) {
      return parsed as VertexServiceAccountJson;
    }
  } catch { /* not JSON */ }
  return null;
}

export function parseVertexAdcJson(raw: string): VertexAdcJson | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed?.type === 'authorized_user'
      && typeof parsed.client_id === 'string'
      && typeof parsed.client_secret === 'string'
      && typeof parsed.refresh_token === 'string'
    ) {
      return parsed as VertexAdcJson;
    }
  } catch { /* not JSON */ }
  return null;
}

function parseGenericVertexJson(raw: string): {
  apiKey?: string;
  accessToken?: string;
  projectId?: string;
  location?: string;
} | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : typeof parsed.key === 'string' ? parsed.key : undefined,
        accessToken: typeof parsed.accessToken === 'string' ? parsed.accessToken : typeof parsed.access_token === 'string' ? parsed.access_token : undefined,
        projectId: typeof parsed.projectId === 'string' ? parsed.projectId : typeof parsed.project_id === 'string' ? parsed.project_id : undefined,
        location: typeof parsed.location === 'string' ? parsed.location : undefined,
      };
    }
  } catch { /* raw key */ }
  return null;
}

function textFromMessage(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/s);
  return match ? { mimeType: match[1], data: match[2] } : null;
}

function toVertexGeminiPayload(
  modelId: string,
  messages: ChatMessage[],
  options?: CompletionOptions,
): Record<string, unknown> {
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
        const parsed = JSON.parse(rawText);
        responseObj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { result: parsed };
      } catch {
        responseObj = { result: rawText };
      }
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: msg.name || msg.tool_call_id || 'tool', response: responseObj } }],
      });
      continue;
    }
    if (msg.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      const text = textFromMessage(msg.content);
      if (text) parts.push({ text });
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            const p = JSON.parse(tc.function.arguments || '{}');
            if (p && typeof p === 'object' && !Array.isArray(p)) args = p;
          } catch { /* empty */ }
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }

    const parts: Array<Record<string, unknown>> = [];
    if (typeof msg.content === 'string') {
      if (msg.content) parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'text' && typeof p.text === 'string' && p.text) {
          parts.push({ text: p.text });
        } else if (p.type === 'image_url') {
          const url = typeof p.image_url === 'string'
            ? p.image_url
            : (p.image_url as { url?: string } | undefined)?.url;
          if (url) {
            const d = parseDataUrl(url);
            if (d) parts.push({ inlineData: { mimeType: d.mimeType, data: d.data } });
            else parts.push({ fileData: { fileUri: url } });
          }
        }
      }
    }
    if (parts.length === 0) parts.push({ text: '' });
    contents.push({ role: 'user', parts });
  }

  const generationConfig: Record<string, unknown> = {};
  if (options?.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (options?.max_tokens !== undefined) generationConfig.maxOutputTokens = options.max_tokens;
  if (options?.top_p !== undefined) generationConfig.topP = options.top_p;
  if (options?.top_k !== undefined) generationConfig.topK = options.top_k;
  if (options?.stop) generationConfig.stopSequences = Array.isArray(options.stop) ? options.stop : [options.stop];

  const payload: Record<string, unknown> = {
    contents,
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };
  if (systemTexts.length > 0) {
    payload.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };
  }
  if (Array.isArray(options?.tools) && options.tools.length > 0) {
    const declarations = options.tools.map((t: NonNullable<CompletionOptions['tools']>[number]) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      parameters: t.function.parameters ?? { type: 'object', properties: {} },
    }));
    payload.tools = [{ functionDeclarations: declarations }];
  }
  if (modelId.includes('gemma-') && systemTexts.length > 0 && contents.length > 0) {
    delete payload.systemInstruction;
    contents[0] = { role: 'user', parts: [{ text: systemTexts.join('\n\n') }, ...((contents[0].parts as Array<Record<string, unknown>>) ?? [])] };
  }
  return payload;
}

function mapGeminiFinish(reason?: string): string {
  const upper = (reason ?? '').toUpperCase();
  if (upper === 'MAX_TOKENS') return 'length';
  if (upper === 'SAFETY' || upper === 'RECITATION' || upper === 'BLOCKLIST') return 'content_filter';
  return 'stop';
}

function parseGeminiPartsToResponse(data: Record<string, any>, modelId: string): ChatCompletionResponse {
  const candidate = data?.candidates?.[0];
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const texts: string[] = [];
  const thoughts: string[] = [];
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.thought === true && typeof part.text === 'string') {
      thoughts.push(part.text);
    } else if (typeof part.text === 'string') {
      texts.push(part.text);
    } else if (part.functionCall?.name) {
      toolCalls.push({
        id: `call_${toolCalls.length}_${Date.now().toString(36)}`,
        type: 'function',
        function: {
          name: String(part.functionCall.name),
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }

  const promptTokens = Number(data?.usageMetadata?.promptTokenCount ?? 0);
  const completionTokens = Number(data?.usageMetadata?.candidatesTokenCount ?? 0);
  const text = texts.join('');
  const reasoning = thoughts.join('');
  const message: ChatMessage & { reasoning_content?: string } = {
    role: 'assistant',
    content: text.length > 0 ? text : (toolCalls.length > 0 ? (null as unknown as string) : ''),
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  return {
    id: `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{
      index: 0,
      message: message as ChatMessage,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : mapGeminiFinish(candidate?.finishReason),
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: Number(data?.usageMetadata?.totalTokenCount ?? (promptTokens + completionTokens)),
    },
  };
}

export class VertexProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  readonly variant: VertexVariant;
  private readonly baseUrl: string;
  private readonly tokenUrl: string;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: VertexProviderOptions = {}) {
    super();
    this.variant = opts.providerId ?? 'vertex';
    this.platform = this.variant as Platform;
    this.name = opts.name ?? (this.variant === 'vertex-partner' ? 'Vertex Partner' : 'Vertex AI');
    this.baseUrl = (opts.baseUrl || 'https://aiplatform.googleapis.com').replace(/\/+$/, '');
    this.tokenUrl = opts.tokenUrl ?? GOOGLE_OAUTH_TOKEN_URL;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.extraHeaders = { ...opts.extraHeaders };
  }

  private async mintServiceAccountToken(sa: VertexServiceAccountJson): Promise<string> {
    const cacheKey = `${sa.client_email}:${this.tokenUrl}`;
    const cached = vertexTokenCache.get(cacheKey);
    if (cached && cached.expiresAt - Date.now() > 300_000) {
      return cached.accessToken;
    }

    const tokenEndpoint = sa.token_uri || this.tokenUrl;
    const privateKey = await importPKCS8(sa.private_key.replace(/\\n/g, '\n'), 'RS256');
    const nowSec = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: CLOUD_PLATFORM_SCOPE })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(sa.client_email)
      .setSubject(sa.client_email)
      .setAudience(tokenEndpoint)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 3600)
      .sign(privateKey);

    const res = await this.fetchWithTimeout(
      tokenEndpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      },
      15_000,
      { timeoutBounds: 'request' },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw providerHttpError(res, `Vertex Service Account token exchange failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json?.access_token) throw new Error('Vertex Service Account token exchange returned no access_token');
    const expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
    vertexTokenCache.set(cacheKey, { accessToken: json.access_token, expiresAt });
    return json.access_token;
  }

  private async refreshAdcToken(adc: VertexAdcJson): Promise<string> {
    const cacheKey = createHash('sha256').update(`${adc.client_id}:${adc.refresh_token}:${this.tokenUrl}`).digest('hex');
    const cached = vertexTokenCache.get(cacheKey);
    if (cached && cached.expiresAt - Date.now() > 300_000) {
      return cached.accessToken;
    }

    const res = await this.fetchWithTimeout(
      this.tokenUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: adc.client_id,
          client_secret: adc.client_secret,
          refresh_token: adc.refresh_token,
        }).toString(),
      },
      15_000,
      { timeoutBounds: 'request' },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw providerHttpError(res, `Vertex ADC token refresh failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json?.access_token) throw new Error('Vertex ADC token refresh returned no access_token');
    const expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
    vertexTokenCache.set(cacheKey, { accessToken: json.access_token, expiresAt });
    return json.access_token;
  }

  private async resolveProjectIdFromApiKey(rawKey: string): Promise<string | null> {
    const cacheKey = `${this.baseUrl}:${rawKey}`;
    if (projectIdCache.has(cacheKey)) return projectIdCache.get(cacheKey)!;
    const probeUrl = `${this.baseUrl}/v1/publishers/google/models/__probe__:generateContent?key=${encodeURIComponent(rawKey)}`;
    const res = await this.fetchWithTimeout(
      probeUrl,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      10_000,
      { timeoutBounds: 'request' },
    );
    const json = (await res.json().catch(() => null)) as any;
    const msg = json?.[0]?.error?.message || json?.error?.message || '';
    const match = typeof msg === 'string' ? msg.match(/projects\/([^/]+)\//) : null;
    const projectId = match?.[1] ?? null;
    if (projectId) projectIdCache.set(cacheKey, projectId);
    return projectId;
  }

  async resolveAuth(credential: string, modelId: string): Promise<{
    bearerToken?: string;
    rawApiKey?: string;
    projectId?: string;
    location: string;
  }> {
    const defaultLocFor = (hasExplicitBearer: boolean) =>
      this.variant === 'vertex-partner' || /^gemini-4/i.test(modelId) || !hasExplicitBearer
        ? 'global'
        : 'us-central1';

    const sa = parseVertexServiceAccount(credential);
    if (sa) {
      const bearerToken = await this.mintServiceAccountToken(sa);
      return {
        bearerToken,
        projectId: sa.project_id,
        location: sa.location || defaultLocFor(true),
      };
    }

    const adc = parseVertexAdcJson(credential);
    if (adc) {
      const bearerToken = await this.refreshAdcToken(adc);
      const projectId = adc.quota_project_id || adc.project_id;
      return {
        bearerToken,
        projectId,
        location: adc.location || defaultLocFor(true),
      };
    }

    const custom = parseGenericVertexJson(credential);
    if (custom) {
      let projectId = custom.projectId;
      if (this.variant === 'vertex-partner' && !projectId && custom.apiKey) {
        projectId = (await this.resolveProjectIdFromApiKey(custom.apiKey)) ?? undefined;
      }
      return {
        bearerToken: custom.accessToken,
        rawApiKey: custom.apiKey,
        projectId,
        location: custom.location || defaultLocFor(Boolean(custom.accessToken)),
      };
    }

    let projectId: string | undefined;
    if (this.variant === 'vertex-partner') {
      projectId = (await this.resolveProjectIdFromApiKey(credential)) ?? undefined;
    }
    return {
      rawApiKey: credential,
      projectId,
      location: 'global',
    };
  }

  private buildRequestConfig(
    auth: Awaited<ReturnType<VertexProvider['resolveAuth']>>,
    modelId: string,
    stream: boolean,
  ): { url: string; headers: Record<string, string>; mode: 'partner' | 'claude' | 'gemini' } {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.extraHeaders,
    };
    if (auth.bearerToken) headers.Authorization = `Bearer ${auth.bearerToken}`;
    if (stream) headers.Accept = 'text/event-stream';

    if (this.variant === 'vertex-partner') {
      if (!auth.projectId) {
        throw new Error('Vertex Partner models require project_id (use Service Account JSON, ADC JSON with quota_project_id, or JSON with projectId).');
      }
      const loc = auth.location || 'global';
      let url = `${this.baseUrl}/v1/projects/${auth.projectId}/locations/${loc}/endpoints/openapi/chat/completions`;
      if (!auth.bearerToken && auth.rawApiKey) url += `?key=${encodeURIComponent(auth.rawApiKey)}`;
      return { url, headers, mode: 'partner' };
    }

    if (/^claude/i.test(modelId)) {
      if (!auth.projectId) {
        throw new Error('Claude models on Vertex AI require project_id in your Service Account or ADC JSON.');
      }
      const action = stream ? 'streamRawPredict' : 'rawPredict';
      let url = `${this.baseUrl}/v1/projects/${auth.projectId}/locations/${auth.location}/publishers/anthropic/models/${modelId}:${action}`;
      if (!auth.bearerToken && auth.rawApiKey) url += `?key=${encodeURIComponent(auth.rawApiKey)}`;
      return { url, headers, mode: 'claude' };
    }

    const action = stream ? 'streamGenerateContent' : 'generateContent';
    let url = auth.projectId
      ? `${this.baseUrl}/v1/projects/${auth.projectId}/locations/${auth.location}/publishers/google/models/${modelId}:${action}`
      : `${this.baseUrl}/v1/publishers/google/models/${modelId}:${action}`;
    if (stream) url += '?alt=sse';
    if (!auth.bearerToken && auth.rawApiKey) {
      url += `${stream ? '&' : '?'}key=${encodeURIComponent(auth.rawApiKey)}`;
    }
    return { url, headers, mode: 'gemini' };
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const auth = await this.resolveAuth(apiKey, modelId);
    const { url, headers, mode } = this.buildRequestConfig(auth, modelId, false);

    const bodyPayload =
      mode === 'partner'
        ? {
            model: modelId,
            messages,
            temperature: options?.temperature,
            max_tokens: options?.max_tokens,
            top_p: options?.top_p,
            stop: options?.stop,
            tools: options?.tools,
            tool_choice: options?.tool_choice,
            stream: false,
          }
        : mode === 'claude'
          ? chatToAnthropicRequest(modelId, messages, options, {
              includeModel: false,
              includeStream: false,
              anthropicVersion: 'vertex-2023-10-16',
            })
          : toVertexGeminiPayload(modelId, messages, options);

    const res = await this.fetchWithTimeout(
      url,
      { method: 'POST', headers, body: JSON.stringify(bodyPayload) },
      options?.timeoutMs ?? this.timeoutMs,
      { signal: options?.signal, timeoutBounds: 'request' },
    );

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      endpoint: mode,
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, any>;
      const msg = err?.error?.message ?? err?.message ?? res.statusText;
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${msg}`, err);
    }

    const json = (await res.json()) as Record<string, any>;
    const out =
      mode === 'partner'
        ? (json as ChatCompletionResponse)
        : mode === 'claude'
          ? anthropicJsonToOpenAIResponse(json, modelId)
          : parseGeminiPartsToResponse(json, modelId);
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
    const auth = await this.resolveAuth(apiKey, modelId);
    const { url, headers, mode } = this.buildRequestConfig(auth, modelId, true);

    const bodyPayload =
      mode === 'partner'
        ? {
            model: modelId,
            messages,
            temperature: options?.temperature,
            max_tokens: options?.max_tokens,
            top_p: options?.top_p,
            stop: options?.stop,
            tools: options?.tools,
            tool_choice: options?.tool_choice,
            stream: true,
          }
        : mode === 'claude'
          ? chatToAnthropicRequest(modelId, messages, options, {
              includeModel: false,
              includeStream: true,
              anthropicVersion: 'vertex-2023-10-16',
            })
          : toVertexGeminiPayload(modelId, messages, options);

    const res = await this.fetchWithTimeout(
      url,
      { method: 'POST', headers, body: JSON.stringify(bodyPayload) },
      options?.timeoutMs ?? this.timeoutMs,
      { signal: options?.signal, timeoutBounds: 'headers' },
    );

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      endpoint: mode,
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, any>;
      const msg = err?.error?.message ?? err?.message ?? res.statusText;
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${msg}`, err);
    }

    if (mode === 'partner') {
      yield* this.readSseStream(res, { firstByteTimeoutMs: options?.timeoutMs ?? this.timeoutMs });
      return;
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

    if (mode === 'claude') {
      const state = createAnthropicStreamState(modelId);
      for await (const { data } of lines) {
        if (!data || data === '[DONE]') break;
        let parsed: Record<string, any>;
        try { parsed = JSON.parse(data); } catch { continue; }
        for (const chunk of parseAnthropicSseEvent(parsed, state)) yield chunk;
      }
      return;
    }

    const id = this.makeId();
    let sawToolCalls = false;
    let emittedFinish = false;
    let nextToolIndex = 0;

    for await (const { data } of lines) {
      if (!data) continue;
      if (data === '[DONE]') break;
      let parsed: Record<string, any>;
      try { parsed = JSON.parse(data); } catch { continue; }
      const candidate = parsed?.candidates?.[0];
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
            id: `call_${nextToolIndex}_${Date.now().toString(36)}`,
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
            finish_reason: sawToolCalls ? 'tool_calls' : mapGeminiFinish(candidate.finishReason),
          }],
        };
      }
    }
  }

  async validateKey(
    apiKey: string,
    _quotaContext?: QuotaObservationContext,
    _options?: KeyValidationOptions,
  ): Promise<KeyValidationResult> {
    const sa = parseVertexServiceAccount(apiKey);
    if (sa) {
      try {
        await this.mintServiceAccountToken(sa);
        return true;
      } catch (err: any) {
        return { valid: false, error: err?.message ?? 'Vertex Service Account validation failed' };
      }
    }

    const adc = parseVertexAdcJson(apiKey);
    if (adc) {
      try {
        await this.refreshAdcToken(adc);
        return true;
      } catch (err: any) {
        return { valid: false, error: err?.message ?? 'Vertex ADC validation failed' };
      }
    }

    const custom = parseGenericVertexJson(apiKey);
    const rawKey = custom?.apiKey ?? (!custom?.accessToken ? apiKey : '');
    if (custom?.accessToken) return true;

    const probeUrl = `${this.baseUrl}/v1/publishers/google/models/__probe__:generateContent?key=${encodeURIComponent(rawKey)}`;
    const res = await this.fetchWithTimeout(
      probeUrl,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      10_000,
      { timeoutBounds: 'request' },
    );
    if (res.ok) return true;
    const errBody = (await res.json().catch(() => null)) as any;
    const msg = String(errBody?.[0]?.error?.message || errBody?.error?.message || '');
    const details = errBody?.error?.details;
    const reason = Array.isArray(details) ? details.find((d: any) => typeof d?.reason === 'string')?.reason : '';
    if (res.status === 401 || reason === 'API_KEY_INVALID' || /API key not valid|API_KEY_INVALID/i.test(msg)) {
      return { valid: false, error: `Vertex API key invalid (HTTP ${res.status}): ${msg}` };
    }
    if (res.status === 403 && /permission|forbidden|disabled/i.test(msg)) {
      return { valid: false, error: `Vertex API key denied (HTTP 403): ${msg}` };
    }
    // 404 __probe__ model or project-scoped error indicates the key authenticated cleanly
    return true;
  }
}
