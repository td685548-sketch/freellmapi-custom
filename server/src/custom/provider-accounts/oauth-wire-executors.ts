import { createHash, randomUUID } from 'node:crypto';
import * as zlib from 'node:zlib';
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
  aggregateStreamToCompletion,
  anthropicJsonToOpenAIResponse,
  chatToAnthropicRequest,
  chatToResponsesRequest,
  createAnthropicStreamState,
  createResponsesStreamState,
  parseAnthropicSseEvent,
  parseResponsesSseEvent,
  readFramedSseLines,
} from './wire-helpers.js';

export interface ParsedOAuthBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  userId?: string;
  organizationId?: string;
  systemId?: string;
  machineId?: string;
  baseUrl?: string;
  apiKey?: string;
  raw: Record<string, any>;
}

const refreshedTokenCache = new Map<string, { accessToken: string; refreshToken?: string; expiresAt: number }>();
const zedLlmTokenCache = new Map<string, { token: string; expiresAt: number }>();
const grokTurnStore = new Map<string, number>();

export function _resetOAuthWireCachesForTests(): void {
  refreshedTokenCache.clear();
  zedLlmTokenCache.clear();
  grokTurnStore.clear();
}

export function parseOAuthBundle(raw: string): ParsedOAuthBundle {
  const trimmed = String(raw ?? '').trim();
  if (trimmed.startsWith('{')) {
    try {
      const p = JSON.parse(trimmed) as Record<string, any>;
      const accessToken = String(
        p.accessToken ?? p.access_token ?? p.sk ?? p.apiKey ?? p.api_key ?? p.token ?? '',
      ).trim();
      const refreshToken = typeof p.refreshToken === 'string'
        ? p.refreshToken
        : typeof p.refresh_token === 'string'
          ? p.refresh_token
          : undefined;
      const expiresAt = typeof p.expiresAt === 'number'
        ? p.expiresAt
        : typeof p.expires_at === 'number'
          ? p.expires_at
          : undefined;
      const psd = p.providerSpecificData && typeof p.providerSpecificData === 'object'
        ? p.providerSpecificData
        : {};
      return {
        accessToken,
        refreshToken,
        expiresAt,
        userId: typeof (p.userId ?? p.user_id ?? psd.userId) === 'string'
          ? String(p.userId ?? p.user_id ?? psd.userId)
          : undefined,
        organizationId: typeof (p.organizationId ?? p.defaultOrganizationId ?? psd.organizationId) === 'string'
          ? String(p.organizationId ?? p.defaultOrganizationId ?? psd.organizationId)
          : undefined,
        systemId: typeof (p.systemId ?? psd.systemId) === 'string'
          ? String(p.systemId ?? psd.systemId)
          : undefined,
        machineId: typeof (p.machineId ?? psd.machineId) === 'string'
          ? String(p.machineId ?? psd.machineId)
          : undefined,
        baseUrl: typeof (p.baseUrl ?? p.base_url ?? p.url ?? p.resourceUrl ?? p.resource_url ?? psd.baseUrl) === 'string'
          ? String(p.baseUrl ?? p.base_url ?? p.url ?? p.resourceUrl ?? p.resource_url ?? psd.baseUrl)
          : undefined,
        apiKey: typeof (p.apiKey ?? p.api_key ?? p.sk) === 'string'
          ? String(p.apiKey ?? p.api_key ?? p.sk)
          : undefined,
        raw: p,
      };
    } catch { /* fall back to raw token */ }
  }
  return { accessToken: trimmed, raw: {} };
}

async function refreshBearerIfNeeded(
  bundle: ParsedOAuthBundle,
  cachePrefix: string,
  refreshFn: (() => Promise<{ accessToken: string; refreshToken?: string; expiresAt: number } | null>) | null,
  onCredentialUpdate?: (next: string) => void,
): Promise<string> {
  const key = bundle.refreshToken
    ? `${cachePrefix}:${createHash('sha256').update(bundle.refreshToken).digest('hex')}`
    : '';
  const cached = key ? refreshedTokenCache.get(key) : undefined;
  if (cached && cached.expiresAt - Date.now() > 120_000) {
    return cached.accessToken;
  }
  const notExpired = bundle.accessToken && (!bundle.expiresAt || bundle.expiresAt - Date.now() > 120_000);
  if (notExpired) return bundle.accessToken;
  if (!refreshFn || !bundle.refreshToken) return bundle.accessToken;

  const refreshed = await refreshFn();
  if (refreshed?.accessToken) {
    if (key) refreshedTokenCache.set(key, refreshed);
    if (onCredentialUpdate && Object.keys(bundle.raw).length > 0) {
      onCredentialUpdate(JSON.stringify({
        ...bundle.raw,
        accessToken: refreshed.accessToken,
        ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
        expiresAt: refreshed.expiresAt,
      }));
    }
    return refreshed.accessToken;
  }
  return bundle.accessToken;
}

// ---------------------------------------------------------------------------
// 1. Grok CLI Provider (Responses API wire + monotonic x-grok-turn-idx)
// ---------------------------------------------------------------------------

export class GrokCliProvider extends BaseProvider {
  readonly platform = 'grok-cli' as Platform;
  readonly name = 'Grok CLI (Grok Build)';
  private readonly baseUrl: string;
  private readonly tokenUrl: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: { baseUrl?: string; tokenUrl?: string; extraHeaders?: Record<string, string> } = {}) {
    super();
    this.baseUrl = (opts.baseUrl || 'https://cli-chat-proxy.grok.com/v1/responses').replace(/\/+$/, '');
    this.tokenUrl = opts.tokenUrl ?? 'https://auth.x.ai/oauth2/token';
    this.extraHeaders = { ...opts.extraHeaders };
  }

  private async resolveToken(raw: string, onUpdate?: (next: string) => void): Promise<string> {
    const bundle = parseOAuthBundle(raw);
    return refreshBearerIfNeeded(
      bundle,
      'grok-cli',
      bundle.refreshToken
        ? async () => {
            const res = await this.fetchWithTimeout(
              this.tokenUrl,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  grant_type: 'refresh_token',
                  client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
                  refresh_token: bundle.refreshToken!,
                }).toString(),
              },
              15_000,
              { timeoutBounds: 'request' },
            );
            if (!res.ok) return null;
            const d = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
            if (!d?.access_token) return null;
            return {
              accessToken: d.access_token,
              refreshToken: d.refresh_token,
              expiresAt: Date.now() + (d.expires_in ?? 3600) * 1000,
            };
          }
        : null,
      onUpdate,
    );
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
    const token = await this.resolveToken(apiKey);
    const sessionKey = `grok:${quotaContext?.keyId ?? 'anon'}`;
    const userTurns = Math.max(1, messages.filter((m) => m.role === 'user').length);
    const prev = grokTurnStore.get(sessionKey) ?? 0;
    const turnIdx = prev > 0 ? Math.max(userTurns, prev + 1) : userTurns;
    grokTurnStore.set(sessionKey, turnIdx);

    const payload = chatToResponsesRequest(modelId, messages, options);
    const res = await this.fetchWithTimeout(
      this.baseUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'grok-shell/1.0.44 (linux; x86_64)',
          'x-grok-client-identifier': 'grok-shell',
          'x-grok-client-version': '1.0.44',
          'x-grok-turn-idx': String(turnIdx),
          ...this.extraHeaders,
        },
        body: JSON.stringify(payload),
      },
      options?.timeoutMs ?? 120_000,
      { signal: options?.signal, timeoutBounds: 'headers' },
    );

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      endpoint: 'responses',
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, any>;
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${err?.error?.message ?? res.statusText}`, err);
    }

    const stallMs = DEFAULT_STREAM_STALL_MS;
    const firstByteMs = this.firstByteBudgetMs(options?.timeoutMs ?? 120_000, stallMs);
    const lines = readFramedSseLines(
      res,
      (r, ms, m) => this.readWithStallTimeout(r, ms, m),
      firstByteMs,
      stallMs,
      this.firstByteTimeoutMessage(firstByteMs),
    );
    const state = createResponsesStreamState(modelId);
    for await (const { data } of lines) {
      if (!data || data === '[DONE]') break;
      let parsed: Record<string, any>;
      try { parsed = JSON.parse(data); } catch { continue; }
      for (const chunk of parseResponsesSseEvent(parsed, state)) yield chunk;
    }
  }

  async validateKey(
    apiKey: string,
    _quotaContext?: QuotaObservationContext,
    options?: KeyValidationOptions,
  ): Promise<KeyValidationResult> {
    try {
      const token = await this.resolveToken(apiKey, options?.onCredentialUpdate);
      return token ? true : { valid: false, error: 'Missing Grok CLI access token' };
    } catch (err: any) {
      return { valid: false, error: err?.message ?? 'Grok CLI token check failed' };
    }
  }
}

// ---------------------------------------------------------------------------
// 2. CodeBuddy Provider (codebuddy-cn & codebuddy-intl)
// ---------------------------------------------------------------------------

const CODEBUDDY_NEUTRAL_PROMPT = 'You are a helpful AI assistant that helps with software engineering tasks.';
const CODEBUDDY_AGENT_PROMPT_RE =
  /you are claude code|claude.?code.+official.+cli|anthropic.+official.+cli|you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)|you are an? (?:ai )?(?:coding |code )?agent|cc_entrypoint\s*=|<agent-identity>|<Role>|<Behavior_Instructions>/i;

function sanitizeCodeBuddyMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'system') return m;
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
        : '';
    if (!text) return m;
    if (text.length > 2000 || CODEBUDDY_AGENT_PROMPT_RE.test(text)) {
      return typeof m.content === 'string'
        ? { ...m, content: CODEBUDDY_NEUTRAL_PROMPT }
        : { ...m, content: [{ type: 'text', text: CODEBUDDY_NEUTRAL_PROMPT }] };
    }
    return m;
  });
}

export class CodeBuddyProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  readonly variant: 'codebuddy-cn' | 'codebuddy-intl';
  private readonly baseUrl: string;
  private readonly refreshUrl: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(variant: 'codebuddy-cn' | 'codebuddy-intl', opts: { baseUrl?: string; extraHeaders?: Record<string, string> } = {}) {
    super();
    this.variant = variant;
    this.platform = variant as Platform;
    this.name = variant === 'codebuddy-cn' ? 'CodeBuddy CN' : 'CodeBuddy';
    const domain = variant === 'codebuddy-cn' ? 'https://copilot.tencent.com' : 'https://www.codebuddy.ai';
    const raw = (opts.baseUrl || `${domain}/v2/chat/completions`).replace(/\/+$/, '');
    this.baseUrl = raw.endsWith('/chat/completions') ? raw : `${raw}/chat/completions`;
    this.refreshUrl = `${domain}/v2/plugin/auth/token/refresh`;
    this.extraHeaders = { ...opts.extraHeaders };
  }

  private async resolveToken(raw: string, onUpdate?: (next: string) => void): Promise<string> {
    const bundle = parseOAuthBundle(raw);
    return refreshBearerIfNeeded(
      bundle,
      this.variant,
      bundle.refreshToken
        ? async () => {
            const res = await this.fetchWithTimeout(
              this.refreshUrl,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'User-Agent': this.variant === 'codebuddy-cn' ? 'CLI/2.63.2 CodeBuddy/2.63.2' : 'IDE/2.63.2 CodeBuddy/2.63.2',
                },
                body: JSON.stringify({ refreshToken: bundle.refreshToken }),
              },
              15_000,
              { timeoutBounds: 'request' },
            );
            if (!res.ok) return null;
            const d = (await res.json()) as { code?: number; data?: { accessToken?: string; refreshToken?: string; expiresIn?: number } };
            const tok = d?.data?.accessToken;
            if (!tok) return null;
            return {
              accessToken: tok,
              refreshToken: d.data?.refreshToken,
              expiresAt: Date.now() + (d.data?.expiresIn ?? 3600) * 1000,
            };
          }
        : null,
      onUpdate,
    );
  }

  private buildHeaders(token: string): Record<string, string> {
    const isCn = this.variant === 'codebuddy-cn';
    return {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
      'User-Agent': isCn ? 'CLI/2.108.1 CodeBuddy/2.108.1' : 'IDE/2.108.1 CodeBuddy/2.108.1',
      'X-Product': 'SaaS',
      'X-IDE-Type': isCn ? 'CLI' : 'IDE',
      'X-IDE-Name': isCn ? 'CLI' : 'IDE',
      'x-requested-with': 'XMLHttpRequest',
      'x-codebuddy-request': '1',
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
    const token = await this.resolveToken(apiKey);
    const body: Record<string, unknown> = {
      model: modelId,
      messages: sanitizeCodeBuddyMessages(messages),
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      top_p: options?.top_p,
      stop: options?.stop,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
      stream: true,
    };
    if (options?.reasoning_effort && options.reasoning_effort !== 'none') {
      body.reasoning_effort = options.reasoning_effort;
      body.reasoning_summary = 'auto';
    }

    const res = await this.fetchWithTimeout(
      this.baseUrl,
      { method: 'POST', headers: this.buildHeaders(token), body: JSON.stringify(body) },
      options?.timeoutMs ?? 120_000,
      { signal: options?.signal, timeoutBounds: 'headers' },
    );

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      endpoint: 'chat/completions',
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      try {
        const parsed = JSON.parse(bodyText);
        const msg = String(parsed?.msg || parsed?.message || parsed?.error?.message || '');
        if (parsed?.code === 6004 || /超出频率限制|frequency limit|限额/i.test(msg)) {
          const fake429 = new Response(bodyText, { status: 429, headers: res.headers });
          throw providerHttpError(fake429, `${this.name} rate limit (6004): ${msg}`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('rate limit')) throw e;
      }
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${bodyText.slice(0, 200) || res.statusText}`);
    }

    yield* this.readSseStream(res, { firstByteTimeoutMs: options?.timeoutMs ?? 120_000 });
  }

  async validateKey(
    apiKey: string,
    _quotaContext?: QuotaObservationContext,
    options?: KeyValidationOptions,
  ): Promise<KeyValidationResult> {
    try {
      const token = await this.resolveToken(apiKey, options?.onCredentialUpdate);
      return token ? true : { valid: false, error: `Missing ${this.name} access token` };
    } catch (err: any) {
      return { valid: false, error: err?.message ?? `${this.name} validation failed` };
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Cline & ClinePass Provider
// ---------------------------------------------------------------------------

export class ClineProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly refreshUrl = 'https://api.cline.bot/api/v1/auth/refresh';
  private readonly extraHeaders: Record<string, string>;

  constructor(variant: 'cline' | 'clinepass', opts: { baseUrl?: string; extraHeaders?: Record<string, string> } = {}) {
    super();
    this.platform = variant as Platform;
    this.name = variant === 'clinepass' ? 'ClinePass' : 'Cline';
    const raw = (opts.baseUrl || 'https://api.cline.bot/api/v1/chat/completions').replace(/\/+$/, '');
    this.baseUrl = raw.endsWith('/chat/completions') ? raw : `${raw}/chat/completions`;
    this.extraHeaders = { ...opts.extraHeaders };
  }

  private async resolveToken(raw: string, onUpdate?: (next: string) => void): Promise<string> {
    const bundle = parseOAuthBundle(raw);
    return refreshBearerIfNeeded(
      bundle,
      this.platform,
      bundle.refreshToken
        ? async () => {
            const res = await this.fetchWithTimeout(
              this.refreshUrl,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refreshToken: bundle.refreshToken, grantType: 'refresh_token' }),
              },
              15_000,
              { timeoutBounds: 'request' },
            );
            if (!res.ok) return null;
            const d = (await res.json()) as { data?: { accessToken?: string; refreshToken?: string; expiresAt?: string | number } };
            const tok = d?.data?.accessToken;
            if (!tok) return null;
            const exp = typeof d.data?.expiresAt === 'string'
              ? Date.parse(d.data.expiresAt)
              : typeof d.data?.expiresAt === 'number'
                ? d.data.expiresAt
                : Date.now() + 3600_000;
            return { accessToken: tok, refreshToken: d.data?.refreshToken, expiresAt: exp };
          }
        : null,
      onUpdate,
    );
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const token = await this.resolveToken(apiKey);
    const res = await this.fetchWithTimeout(
      this.baseUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'HTTP-Referer': 'https://cline.bot',
          'X-Title': 'Cline',
          ...this.extraHeaders,
        },
        body: JSON.stringify({
          model: modelId,
          messages,
          temperature: options?.temperature,
          max_tokens: options?.max_tokens,
          top_p: options?.top_p,
          stop: options?.stop,
          tools: options?.tools,
          tool_choice: options?.tool_choice,
          stream: false,
        }),
      },
      options?.timeoutMs ?? 120_000,
      { signal: options?.signal, timeoutBounds: 'request' },
    );

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      endpoint: 'chat/completions',
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, any>;
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${err?.error?.message ?? res.statusText}`, err);
    }
    const data = (await res.json()) as ChatCompletionResponse;
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const token = await this.resolveToken(apiKey);
    const res = await this.fetchWithTimeout(
      this.baseUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
          'HTTP-Referer': 'https://cline.bot',
          'X-Title': 'Cline',
          ...this.extraHeaders,
        },
        body: JSON.stringify({
          model: modelId,
          messages,
          temperature: options?.temperature,
          max_tokens: options?.max_tokens,
          top_p: options?.top_p,
          stop: options?.stop,
          tools: options?.tools,
          tool_choice: options?.tool_choice,
          stream: true,
        }),
      },
      options?.timeoutMs ?? 120_000,
      { signal: options?.signal, timeoutBounds: 'headers' },
    );

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      endpoint: 'chat/completions',
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, any>;
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${err?.error?.message ?? res.statusText}`, err);
    }
    yield* this.readSseStream(res, { firstByteTimeoutMs: options?.timeoutMs ?? 120_000 });
  }

  async validateKey(
    apiKey: string,
    _quotaContext?: QuotaObservationContext,
    options?: KeyValidationOptions,
  ): Promise<KeyValidationResult> {
    try {
      const token = await this.resolveToken(apiKey, options?.onCredentialUpdate);
      return token ? true : { valid: false, error: `Missing ${this.name} token` };
    } catch (err: any) {
      return { valid: false, error: err?.message ?? `${this.name} validation failed` };
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Zed Provider (userId + accessToken -> llm_tokens -> cloud.zed.dev NDJSON)
// ---------------------------------------------------------------------------

function normalizeZedUpstreamProvider(modelId: string): 'anthropic' | 'open_ai' | 'google' | 'x_ai' {
  const m = modelId.toLowerCase();
  if (m.includes('claude')) return 'anthropic';
  if (m.includes('gemini')) return 'google';
  if (m.includes('grok') || m.includes('xai')) return 'x_ai';
  return 'open_ai';
}

export class ZedProvider extends BaseProvider {
  readonly platform = 'zed' as Platform;
  readonly name = 'Zed';
  private readonly cloudBase: string;
  private readonly completionsUrl: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: { baseUrl?: string; cloudBaseUrl?: string; extraHeaders?: Record<string, string> } = {}) {
    super();
    const raw = (opts.baseUrl || 'https://cloud.zed.dev/completions').replace(/\/+$/, '');
    this.completionsUrl = raw.endsWith('/completions') ? raw : `${raw}/completions`;
    this.cloudBase = (opts.cloudBaseUrl || new URL(this.completionsUrl).origin).replace(/\/+$/, '');
    this.extraHeaders = { ...opts.extraHeaders };
  }

  private parseZedCreds(raw: string): { userId: string; accessToken: string; organizationId?: string; systemId?: string } {
    const bundle = parseOAuthBundle(raw);
    if (bundle.userId && bundle.accessToken) {
      return {
        userId: bundle.userId,
        accessToken: bundle.accessToken,
        organizationId: bundle.organizationId,
        systemId: bundle.systemId,
      };
    }
    const parts = String(raw ?? '').trim().split(/\s+/);
    if (parts.length >= 2) return { userId: parts[0], accessToken: parts.slice(1).join(' ') };
    throw new Error('Zed credential requires userId and accessToken');
  }

  private async getLlmToken(raw: string): Promise<string> {
    const creds = this.parseZedCreds(raw);
    const baseHeaders: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `${creds.userId} ${creds.accessToken}`,
      ...(creds.systemId ? { 'x-zed-system-id': creds.systemId } : {}),
    };

    let orgId = creds.organizationId;
    if (!orgId) {
      const meRes = await this.fetchWithTimeout(`${this.cloudBase}/client/users/me`, { method: 'GET', headers: baseHeaders }, 10_000, {
        timeoutBounds: 'request',
      });
      if (!meRes.ok) {
        const text = await meRes.text().catch(() => '');
        throw providerHttpError(meRes, `Zed /client/users/me failed (${meRes.status}): ${text.slice(0, 200)}`);
      }
      const me = (await meRes.json()) as any;
      orgId = me?.default_organization_id
        || me?.organizations?.find((o: any) => o?.is_personal)?.id
        || me?.organizations?.[0]?.id;
    }
    if (!orgId) throw new Error('Zed account has no organization_id');

    const cacheKey = `${creds.userId}:${orgId}:${creds.accessToken.slice(-12)}`;
    const cached = zedLlmTokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const tokRes = await this.fetchWithTimeout(
      `${this.cloudBase}/client/llm_tokens`,
      {
        method: 'POST',
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ organization_id: orgId }),
      },
      10_000,
      { timeoutBounds: 'request' },
    );
    if (!tokRes.ok) {
      const text = await tokRes.text().catch(() => '');
      throw providerHttpError(tokRes, `Zed /client/llm_tokens failed (${tokRes.status}): ${text.slice(0, 200)}`);
    }
    const tokJson = (await tokRes.json()) as { token?: string };
    if (!tokJson?.token) throw new Error('Zed returned no LLM token');
    zedLlmTokenCache.set(cacheKey, { token: tokJson.token, expiresAt: Date.now() + 50 * 60_000 });
    return tokJson.token;
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
    const llmToken = await this.getLlmToken(apiKey);
    const zedProv = normalizeZedUpstreamProvider(modelId);
    const providerRequest =
      zedProv === 'anthropic'
        ? chatToAnthropicRequest(modelId, messages, options, { includeModel: true, includeStream: true })
        : zedProv === 'open_ai'
          ? chatToResponsesRequest(modelId, messages, options)
          : { model: modelId, messages, stream: true, max_tokens: options?.max_tokens, temperature: options?.temperature };

    const envelope = {
      thread_id: randomUUID(),
      prompt_id: randomUUID(),
      intent: 'user_prompt',
      provider: zedProv,
      model: modelId,
      provider_request: providerRequest,
    };

    const res = await this.fetchWithTimeout(
      this.completionsUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson, text/event-stream, */*',
          Authorization: `Bearer ${llmToken}`,
          'x-zed-client-supports-status-messages': 'true',
          'x-zed-client-supports-stream-ended-request-completion-status': 'true',
          'x-zed-client-supports-x-ai': 'true',
          ...this.extraHeaders,
        },
        body: JSON.stringify(envelope),
      },
      options?.timeoutMs ?? 120_000,
      { signal: options?.signal, timeoutBounds: 'headers' },
    );

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      endpoint: 'completions',
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw providerHttpError(res, `Zed API error ${res.status}: ${text.slice(0, 200) || res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body from Zed');
    const decoder = new TextDecoder();
    let buffer = '';
    const anthropicState = createAnthropicStreamState(modelId);
    const responsesState = createResponsesStreamState(modelId);
    const stallMs = DEFAULT_STREAM_STALL_MS;
    const firstByteMs = this.firstByteBudgetMs(options?.timeoutMs ?? 120_000, stallMs);
    let awaitingFirst = true;

    try {
      while (true) {
        const { done, value } = awaitingFirst
          ? await this.readWithStallTimeout(() => reader.read(), firstByteMs, this.firstByteTimeoutMessage(firstByteMs))
          : await this.readWithStallTimeout(() => reader.read(), stallMs);
        awaitingFirst = false;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          let line = rawLine.replace(/\r$/, '').trim();
          if (!line) continue;
          if (line.startsWith('data:')) line = line.slice(5).trim();
          if (!line || line === '[DONE]') continue;
          let frame: Record<string, any>;
          try { frame = JSON.parse(line); } catch { continue; }
          if (frame.status && !frame.event) continue;
          const ev = frame.event ?? frame;
          if (!ev || typeof ev !== 'object') continue;

          if (zedProv === 'anthropic') {
            for (const c of parseAnthropicSseEvent(ev, anthropicState)) yield c;
          } else if (zedProv === 'open_ai') {
            if (ev.object === 'chat.completion.chunk') yield ev as ChatCompletionChunk;
            else for (const c of parseResponsesSseEvent(ev, responsesState)) yield c;
          } else {
            yield ev as ChatCompletionChunk;
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    try {
      await this.getLlmToken(apiKey);
      return true;
    } catch (err: any) {
      return { valid: false, error: err?.message ?? 'Zed validation failed' };
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Cursor IDE Provider (ConnectRPC protobuf framing + Jyh checksum)
// ---------------------------------------------------------------------------

function pbEncodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}

function pbConcat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function pbEncodeField(fieldNum: number, wireType: 0 | 2, val: number | string | Uint8Array): Uint8Array {
  const tag = pbEncodeVarint((fieldNum << 3) | wireType);
  if (wireType === 0) return pbConcat(tag, pbEncodeVarint(Number(val)));
  const data = typeof val === 'string' ? new TextEncoder().encode(val) : (val as Uint8Array);
  return pbConcat(tag, pbEncodeVarint(data.length), data);
}

function pbDecodeVarint(buf: Uint8Array, offset: number): [number, number] {
  let res = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    res |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [res, pos];
}

function pbDecodeMessage(data: Uint8Array): Map<number, Array<{ wireType: number; value: Uint8Array | number }>> {
  const fields = new Map<number, Array<{ wireType: number; value: Uint8Array | number }>>();
  let pos = 0;
  while (pos < data.length) {
    const [tag, p1] = pbDecodeVarint(data, pos);
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;
    pos = p1;
    let value: Uint8Array | number = 0;
    if (wireType === 0) {
      [value, pos] = pbDecodeVarint(data, pos);
    } else if (wireType === 2) {
      const [len, p2] = pbDecodeVarint(data, pos);
      value = data.slice(p2, p2 + len);
      pos = p2 + len;
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
    const arr = fields.get(fieldNum) ?? [];
    arr.push({ wireType, value });
    fields.set(fieldNum, arr);
  }
  return fields;
}

export function generateCursorChecksum(machineId: string): string {
  const ts = Math.floor(Date.now() / 1_000_000);
  const bytes = new Uint8Array([
    (ts >> 40) & 0xff,
    (ts >> 32) & 0xff,
    (ts >> 24) & 0xff,
    (ts >> 16) & 0xff,
    (ts >> 8) & 0xff,
    ts & 0xff,
  ]);
  let key = 165;
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = ((bytes[i] ^ key) + (i % 256)) & 0xff;
    key = bytes[i];
  }
  const encoded = Buffer.from(bytes).toString('base64url');
  return `${encoded}${machineId}`;
}

export function buildCursorHeaders(accessToken: string, machineId?: string): Record<string, string> {
  const cleanToken = accessToken.includes('::') ? accessToken.split('::')[1] : accessToken;
  const effMachine = machineId || createHash('sha256').update(`${cleanToken}machineId`).digest('hex');
  const clientKey = createHash('sha256').update(cleanToken).digest('hex');
  return {
    authorization: `Bearer ${cleanToken}`,
    'connect-accept-encoding': 'gzip',
    'connect-protocol-version': '1',
    'content-type': 'application/connect+proto',
    'user-agent': 'connect-es/1.6.1',
    'x-amzn-trace-id': `Root=${randomUUID()}`,
    'x-client-key': clientKey,
    'x-cursor-checksum': generateCursorChecksum(effMachine),
    'x-cursor-client-version': '3.12.17',
    'x-cursor-client-commit': '0fb762053c34788bb7760d5673f8a6d4c8589d50',
    'x-cursor-client-type': 'ide',
    'x-cursor-client-device-type': 'desktop',
    'x-cursor-config-version': randomUUID(),
    'x-ghost-mode': 'true',
    'x-request-id': randomUUID(),
    'x-session-id': randomUUID(),
  };
}

export function wrapConnectRPCFrame(payload: Uint8Array, compress = false): Uint8Array {
  const body = compress ? new Uint8Array(zlib.gzipSync(Buffer.from(payload))) : payload;
  const frame = new Uint8Array(5 + body.length);
  frame[0] = compress ? 0x01 : 0x00;
  frame[1] = (body.length >> 24) & 0xff;
  frame[2] = (body.length >> 16) & 0xff;
  frame[3] = (body.length >> 8) & 0xff;
  frame[4] = body.length & 0xff;
  frame.set(body, 5);
  return frame;
}

export function buildCursorChatFrame(messages: ChatMessage[], modelName: string): Uint8Array {
  const msgBytes = messages.map((m) => {
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
        : '';
    const role = m.role === 'assistant' ? 2 : 1;
    const inner = pbConcat(
      pbEncodeField(1, 2, text),
      pbEncodeField(2, 0, role),
      pbEncodeField(13, 2, randomUUID()),
      pbEncodeField(29, 0, 0),
      pbEncodeField(47, 0, 1),
    );
    return pbEncodeField(1, 2, inner);
  });

  const modelBytes = pbConcat(pbEncodeField(1, 2, modelName), pbEncodeField(4, 2, new Uint8Array(0)));
  const request = pbConcat(
    ...msgBytes,
    pbEncodeField(2, 0, 1),
    pbEncodeField(4, 0, 1),
    pbEncodeField(5, 2, modelBytes),
    pbEncodeField(23, 2, randomUUID()),
    pbEncodeField(27, 0, 0),
    pbEncodeField(46, 0, 1),
    pbEncodeField(48, 0, 1),
    pbEncodeField(54, 2, 'Ask'),
  );
  return wrapConnectRPCFrame(pbEncodeField(1, 2, request), false);
}

export function decodeCursorResponsePayload(payload: Uint8Array): { text: string | null; thinking: string | null } {
  const fields = pbDecodeMessage(payload);
  const respEntry = fields.get(2)?.[0]?.value;
  if (!(respEntry instanceof Uint8Array)) return { text: null, thinking: null };
  const inner = pbDecodeMessage(respEntry);
  const textVal = inner.get(1)?.[0]?.value;
  const thinkContainer = inner.get(25)?.[0]?.value;
  const text = textVal instanceof Uint8Array ? new TextDecoder().decode(textVal) : null;
  let thinking: string | null = null;
  if (thinkContainer instanceof Uint8Array) {
    const tVal = pbDecodeMessage(thinkContainer).get(1)?.[0]?.value;
    if (tVal instanceof Uint8Array) thinking = new TextDecoder().decode(tVal);
  }
  return { text, thinking };
}

export class CursorProvider extends BaseProvider {
  readonly platform = 'cursor' as Platform;
  readonly name = 'Cursor IDE';
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: { baseUrl?: string; extraHeaders?: Record<string, string> } = {}) {
    super();
    const raw = (opts.baseUrl || 'https://api2.cursor.sh').replace(/\/+$/, '');
    this.baseUrl = raw.endsWith('/StreamUnifiedChatWithTools')
      ? raw
      : `${raw}/aiserver.v1.ChatService/StreamUnifiedChatWithTools`;
    this.extraHeaders = { ...opts.extraHeaders };
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
    const bundle = parseOAuthBundle(apiKey);
    const frame = buildCursorChatFrame(messages, modelId);
    const headers = { ...buildCursorHeaders(bundle.accessToken, bundle.machineId), ...this.extraHeaders };

    const res = await this.fetchWithTimeout(
      this.baseUrl,
      { method: 'POST', headers, body: frame as unknown as RequestInit['body'] },
      options?.timeoutMs ?? 120_000,
      { signal: options?.signal, timeoutBounds: 'headers' },
    );

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      endpoint: 'StreamUnifiedChatWithTools',
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${errText.slice(0, 200) || res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body from Cursor');
    const id = this.makeId();
    let buffer: Uint8Array = new Uint8Array(0);
    let emittedRole = false;
    const stallMs = DEFAULT_STREAM_STALL_MS;
    const firstByteMs = this.firstByteBudgetMs(options?.timeoutMs ?? 120_000, stallMs);
    let awaitingFirst = true;

    try {
      while (true) {
        const { done, value } = awaitingFirst
          ? await this.readWithStallTimeout(() => reader.read(), firstByteMs, this.firstByteTimeoutMessage(firstByteMs))
          : await this.readWithStallTimeout(() => reader.read(), stallMs);
        awaitingFirst = false;

        if (value && value.byteLength > 0) {
          const next = new Uint8Array(buffer.byteLength + value.byteLength);
          next.set(buffer, 0);
          next.set(value, buffer.byteLength);
          buffer = next;
        }

        while (buffer.length >= 5) {
          const flags = buffer[0];
          const len = (buffer[1] << 24) | (buffer[2] << 16) | (buffer[3] << 8) | buffer[4];
          if (buffer.length < 5 + len) break;
          let payload: Uint8Array = buffer.slice(5, 5 + len);
          buffer = buffer.slice(5 + len);

          if (flags === 0x01 || flags === 0x03) {
            try { payload = new Uint8Array(zlib.gunzipSync(Buffer.from(payload))); } catch { /* ignore */ }
          }
          if (flags === 0x02 || flags === 0x03) continue;

          const { text, thinking } = decodeCursorResponsePayload(payload);
          if (text || thinking) {
            const delta: Record<string, string> = {
              ...(emittedRole ? {} : { role: 'assistant' }),
              ...(text ? { content: text } : {}),
              ...(thinking ? { reasoning_content: thinking } : {}),
            };
            emittedRole = true;
            yield {
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{ index: 0, delta: delta as any, finish_reason: null }],
            };
          }
        }

        if (done) break;
      }
      yield {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    const { accessToken } = parseOAuthBundle(apiKey);
    return accessToken ? true : { valid: false, error: 'Missing Cursor access token' };
  }
}

// ---------------------------------------------------------------------------
// 6. Generic OAuth-Compatible Provider (OpenAI & Anthropic Messages wires)
// ---------------------------------------------------------------------------

export interface OAuthCompatibleOptions {
  providerId: string;
  name: string;
  baseUrl: string;
  wireFormat?: 'openai' | 'anthropic';
  extraHeaders?: Record<string, string>;
  refreshUrl?: string;
  clientId?: string;
}

export class OAuthCompatibleProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly wireFormat: 'openai' | 'anthropic';
  private readonly extraHeaders: Record<string, string>;
  private readonly refreshUrl?: string;
  private readonly clientId?: string;

  constructor(opts: OAuthCompatibleOptions) {
    super();
    this.platform = opts.providerId as Platform;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.wireFormat = opts.wireFormat ?? 'openai';
    this.extraHeaders = { ...opts.extraHeaders };
    this.refreshUrl = opts.refreshUrl;
    this.clientId = opts.clientId;
  }

  private resolveEndpoint(bundle: ParsedOAuthBundle): string {
    const candidate = bundle.baseUrl ? bundle.baseUrl.replace(/\/+$/, '') : this.baseUrl;
    if (this.wireFormat === 'anthropic') {
      return candidate.endsWith('/messages') ? candidate : `${candidate}/messages`;
    }
    return candidate.endsWith('/chat/completions') ? candidate : `${candidate}/chat/completions`;
  }

  private async resolveToken(raw: string, onUpdate?: (next: string) => void): Promise<{ token: string; bundle: ParsedOAuthBundle }> {
    const bundle = parseOAuthBundle(raw);
    const token = await refreshBearerIfNeeded(
      bundle,
      String(this.platform),
      this.refreshUrl && bundle.refreshToken
        ? async () => {
            const params = new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: bundle.refreshToken!,
              ...(this.clientId ? { client_id: this.clientId } : {}),
            });
            const res = await this.fetchWithTimeout(
              this.refreshUrl!,
              { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() },
              15_000,
              { timeoutBounds: 'request' },
            );
            if (!res.ok) return null;
            const d = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
            if (!d?.access_token) return null;
            return {
              accessToken: d.access_token,
              refreshToken: d.refresh_token,
              expiresAt: Date.now() + (d.expires_in ?? 3600) * 1000,
            };
          }
        : null,
      onUpdate,
    );
    return { token, bundle };
  }

  private buildAuthHeaders(token: string, stream: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(stream ? { Accept: 'text/event-stream' } : {}),
      ...this.extraHeaders,
    };
    if (this.wireFormat === 'anthropic') {
      headers['anthropic-version'] = headers['Anthropic-Version'] ?? '2023-06-01';
      if (this.platform === ('kimi' as Platform)) headers.Authorization = `Bearer ${token}`;
      else headers['x-api-key'] = token;
    } else {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const { token, bundle } = await this.resolveToken(apiKey);
    const url = this.resolveEndpoint(bundle);
    const body = this.wireFormat === 'anthropic'
      ? chatToAnthropicRequest(modelId, messages, options, { includeModel: true, includeStream: false })
      : {
          model: modelId,
          messages,
          temperature: options?.temperature,
          max_tokens: options?.max_tokens,
          top_p: options?.top_p,
          stop: options?.stop,
          tools: options?.tools,
          tool_choice: options?.tool_choice,
          stream: false,
        };

    const res = await this.fetchWithTimeout(
      url,
      { method: 'POST', headers: this.buildAuthHeaders(token, false), body: JSON.stringify(body) },
      options?.timeoutMs ?? 120_000,
      { signal: options?.signal, timeoutBounds: 'request' },
    );

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      endpoint: this.wireFormat === 'anthropic' ? 'messages' : 'chat/completions',
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, any>;
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${err?.error?.message ?? err?.message ?? res.statusText}`, err);
    }

    const json = (await res.json()) as Record<string, any>;
    const out = this.wireFormat === 'anthropic'
      ? anthropicJsonToOpenAIResponse(json, modelId)
      : (json as ChatCompletionResponse);
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
    const { token, bundle } = await this.resolveToken(apiKey);
    const url = this.resolveEndpoint(bundle);
    const body = this.wireFormat === 'anthropic'
      ? chatToAnthropicRequest(modelId, messages, options, { includeModel: true, includeStream: true })
      : {
          model: modelId,
          messages,
          temperature: options?.temperature,
          max_tokens: options?.max_tokens,
          top_p: options?.top_p,
          stop: options?.stop,
          tools: options?.tools,
          tool_choice: options?.tool_choice,
          stream: true,
        };

    const res = await this.fetchWithTimeout(
      url,
      { method: 'POST', headers: this.buildAuthHeaders(token, true), body: JSON.stringify(body) },
      options?.timeoutMs ?? 120_000,
      { signal: options?.signal, timeoutBounds: 'headers' },
    );

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      endpoint: this.wireFormat === 'anthropic' ? 'messages' : 'chat/completions',
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, any>;
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${err?.error?.message ?? err?.message ?? res.statusText}`, err);
    }

    if (this.wireFormat === 'openai') {
      yield* this.readSseStream(res, { firstByteTimeoutMs: options?.timeoutMs ?? 120_000 });
      return;
    }

    const stallMs = DEFAULT_STREAM_STALL_MS;
    const firstByteMs = this.firstByteBudgetMs(options?.timeoutMs ?? 120_000, stallMs);
    const lines = readFramedSseLines(
      res,
      (r, ms, m) => this.readWithStallTimeout(r, ms, m),
      firstByteMs,
      stallMs,
      this.firstByteTimeoutMessage(firstByteMs),
    );
    const state = createAnthropicStreamState(modelId);
    for await (const { data } of lines) {
      if (!data || data === '[DONE]') break;
      let parsed: Record<string, any>;
      try { parsed = JSON.parse(data); } catch { continue; }
      for (const chunk of parseAnthropicSseEvent(parsed, state)) yield chunk;
    }
  }

  async validateKey(
    apiKey: string,
    _quotaContext?: QuotaObservationContext,
    options?: KeyValidationOptions,
  ): Promise<KeyValidationResult> {
    try {
      const { token } = await this.resolveToken(apiKey, options?.onCredentialUpdate);
      return token ? true : { valid: false, error: `Missing ${this.name} credential` };
    } catch (err: any) {
      return { valid: false, error: err?.message ?? `${this.name} validation failed` };
    }
  }
}
