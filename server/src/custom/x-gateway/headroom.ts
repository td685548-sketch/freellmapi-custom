import { getSetting, setSetting } from '../../db/index.js';
import { assessProviderUrl } from '../../lib/url-guard.js';

export const HEADROOM_CONFIG_KEY = 'x_headroom_config';
export const HEADROOM_STATS_KEY = 'x_headroom_stats';
export const DEFAULT_HEADROOM_TIMEOUT_MS = 3000;
const MIN_TIMEOUT_MS = 200;
const MAX_TIMEOUT_MS = 30000;
const SNAPSHOT_TTL_MS = 5000;
const HEADROOM_TOOL_OUTPUT_MAX_DEPTH = 8;

export type HeadroomReadinessState = 'unconfigured' | 'disabled' | 'ready' | 'unreachable' | 'blocked';

export interface HeadroomConfig {
  enabled: boolean;
  url: string;
  maskedUrl: string;
  timeoutMs: number;
  compressUserMessages: boolean;
  source: 'setting' | 'env' | 'default';
}

export interface HeadroomDiagnostics {
  reason?: string;
  endpoint?: string;
  durationMs?: number;
  before?: {
    bodyBytes: number;
    messageBytes: number;
    toolSchemaBytes: number;
    toolHistoryBytes: number;
  };
  after?: {
    bodyBytes: number;
    messageBytes: number;
    toolSchemaBytes: number;
    toolHistoryBytes: number;
  };
}

export interface HeadroomCompressionResponse {
  messages: Array<Record<string, unknown>>;
  tokens_before?: number;
  tokens_after?: number;
  tokens_saved?: number;
  tokensBeforeEst: number;
  tokensAfterEst: number;
  tokensSavedEst: number;
  bytesBefore: number;
  bytesAfter: number;
  durationMs: number;
}

export interface HeadroomStats {
  requests: number;
  compressed: number;
  bypassed: number;
  errors: number;
  bytesBefore: number;
  bytesAfter: number;
  tokensBeforeEst: number;
  tokensAfterEst: number;
  tokensSavedEst: number;
  proxyReportedTokensSaved: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface HeadroomProbeResult {
  ok: boolean;
  state: HeadroomReadinessState;
  reachable: boolean;
  ready: boolean;
  endpoint: string;
  latencyMs: number;
  status?: number;
  version?: string | null;
  error?: string | null;
  checkedAt: string;
}

let cachedConfig: { config: HeadroomConfig; loadedAt: number } | null = null;
let lastProbeCache: HeadroomProbeResult | null = null;
let statsLoaded = false;

const statsState: HeadroomStats = {
  requests: 0,
  compressed: 0,
  bypassed: 0,
  errors: 0,
  bytesBefore: 0,
  bytesAfter: 0,
  tokensBeforeEst: 0,
  tokensAfterEst: 0,
  tokensSavedEst: 0,
  proxyReportedTokensSaved: 0,
  lastSuccessAt: null,
  lastError: null,
  lastErrorAt: null,
};

export function maskHeadroomUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '';
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return trimmed
      .replace(/\/\/[^/@\s]+@/, '//***@')
      .replace(/[?#].*$/, '');
  }
}

export function scrubSensitiveUrlText(text: unknown): string {
  return String(text ?? '')
    .replace(/\/\/[^/@\s]+@/g, '//')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s)]*/g, '$1')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
}

function normalizeTimeout(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_HEADROOM_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(num)));
}

export function invalidateHeadroomCache(): void {
  cachedConfig = null;
  statsLoaded = false;
}

export function getHeadroomConfig(): HeadroomConfig {
  const now = Date.now();
  if (cachedConfig && now - cachedConfig.loadedAt < SNAPSHOT_TTL_MS) {
    return cachedConfig.config;
  }

  const envUrl = (process.env.X_HEADROOM_URL ?? process.env.HEADROOM_URL ?? '').trim();
  const envEnabledRaw = (process.env.X_HEADROOM_ENABLED ?? process.env.HEADROOM_ENABLED ?? '').trim().toLowerCase();
  const envEnabled = envEnabledRaw === '1' || envEnabledRaw === 'true';
  const envTimeout = process.env.X_HEADROOM_TIMEOUT_MS ?? process.env.HEADROOM_TIMEOUT_MS;
  const envCompressUser = (process.env.X_HEADROOM_COMPRESS_USER_MESSAGES ?? '').trim().toLowerCase();

  let stored: Partial<HeadroomConfig> | null = null;
  try {
    const raw = getSetting(HEADROOM_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        stored = parsed;
      }
    }
  } catch {
    stored = null;
  }

  const hasStored = stored !== null && (
    stored.enabled !== undefined ||
    stored.url !== undefined ||
    stored.timeoutMs !== undefined ||
    stored.compressUserMessages !== undefined
  );
  const hasEnv = Boolean(envUrl || envEnabledRaw || envTimeout);

  const url = typeof stored?.url === 'string' ? stored.url.trim() : envUrl;
  const enabled = typeof stored?.enabled === 'boolean' ? stored.enabled : envEnabled;
  const timeoutMs = normalizeTimeout(stored?.timeoutMs ?? envTimeout);
  const compressUserMessages = typeof stored?.compressUserMessages === 'boolean'
    ? stored.compressUserMessages
    : envCompressUser === '1' || envCompressUser === 'true';

  const config: HeadroomConfig = {
    enabled,
    url,
    maskedUrl: maskHeadroomUrl(url),
    timeoutMs,
    compressUserMessages,
    source: hasStored ? 'setting' : hasEnv ? 'env' : 'default',
  };

  cachedConfig = { config, loadedAt: now };
  return config;
}

export function setHeadroomConfig(patch: {
  enabled?: boolean;
  url?: string;
  timeoutMs?: number;
  compressUserMessages?: boolean;
}): HeadroomConfig {
  const current = getHeadroomConfig();
  const next = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    url: typeof patch.url === 'string' ? patch.url.trim() : current.url,
    timeoutMs: patch.timeoutMs !== undefined ? normalizeTimeout(patch.timeoutMs) : current.timeoutMs,
    compressUserMessages: typeof patch.compressUserMessages === 'boolean'
      ? patch.compressUserMessages
      : current.compressUserMessages,
  };

  try {
    setSetting(HEADROOM_CONFIG_KEY, JSON.stringify(next));
  } catch {
    // Fail open if DB write fails
  }

  cachedConfig = null;
  if (patch.url !== undefined && patch.url.trim() !== current.url) {
    lastProbeCache = null;
  }
  return getHeadroomConfig();
}

function ensureStatsLoaded(): void {
  if (statsLoaded) return;
  try {
    const raw = getSetting(HEADROOM_STATS_KEY);
    statsLoaded = true;
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed.requests === 'number' && parsed.requests >= statsState.requests) {
      statsState.requests = parsed.requests;
      statsState.compressed = parsed.compressed ?? 0;
      statsState.bypassed = parsed.bypassed ?? 0;
      statsState.errors = parsed.errors ?? 0;
      statsState.bytesBefore = parsed.bytesBefore ?? 0;
      statsState.bytesAfter = parsed.bytesAfter ?? 0;
      statsState.tokensBeforeEst = parsed.tokensBeforeEst ?? 0;
      statsState.tokensAfterEst = parsed.tokensAfterEst ?? 0;
      statsState.tokensSavedEst = parsed.tokensSavedEst ?? 0;
      statsState.proxyReportedTokensSaved = parsed.proxyReportedTokensSaved ?? 0;
      statsState.lastSuccessAt = parsed.lastSuccessAt ?? null;
      statsState.lastError = parsed.lastError ?? null;
      statsState.lastErrorAt = parsed.lastErrorAt ?? null;
    }
  } catch {
    // Ignore DB load error
  }
}

function persistStats(): void {
  try {
    setSetting(HEADROOM_STATS_KEY, JSON.stringify(statsState));
  } catch {
    // Fail open
  }
}

export function getHeadroomStats(): HeadroomStats {
  ensureStatsLoaded();
  return { ...statsState };
}

export function resetHeadroomStats(): HeadroomStats {
  statsState.requests = 0;
  statsState.compressed = 0;
  statsState.bypassed = 0;
  statsState.errors = 0;
  statsState.bytesBefore = 0;
  statsState.bytesAfter = 0;
  statsState.tokensBeforeEst = 0;
  statsState.tokensAfterEst = 0;
  statsState.tokensSavedEst = 0;
  statsState.proxyReportedTokensSaved = 0;
  statsState.lastSuccessAt = null;
  statsState.lastError = null;
  statsState.lastErrorAt = null;
  statsLoaded = true;
  persistStats();
  return getHeadroomStats();
}

export function buildCompressEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '').replace(/\/v1\/compress$/i, '')}/v1/compress`;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    const raw = String(url).replace(/#.*$/, '');
    const [base, query = ''] = raw.split('?', 2);
    const cleanBase = base.replace(/\/$/, '').replace(/\/v1\/compress$/i, '');
    const endpoint = `${cleanBase}/v1/compress`;
    return query ? `${endpoint}?${query}` : endpoint;
  }
}

export function buildHealthEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '').replace(/\/v1\/compress$/i, '')}/health`;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    const cleanBase = String(url).replace(/[?#].*$/, '').replace(/\/$/, '').replace(/\/v1\/compress$/i, '');
    return `${cleanBase}/health`;
  }
}

function describeFetchError(error: unknown): string {
  const err = error as { message?: string; code?: string; cause?: { message?: string; code?: string } };
  const cause = err?.cause;
  const code = cause?.code || err?.code;
  const message = scrubSensitiveUrlText(cause?.message || err?.message || String(error));
  return code ? `${code}: ${message}` : message;
}

export async function probeHeadroomConnection(options?: {
  url?: string;
  timeoutMs?: number;
}): Promise<HeadroomProbeResult> {
  const cfg = getHeadroomConfig();
  const targetUrl = (options?.url !== undefined ? options.url : cfg.url).trim();
  const timeoutMs = normalizeTimeout(options?.timeoutMs ?? cfg.timeoutMs);
  const checkedAt = new Date().toISOString();

  if (!targetUrl) {
    const result: HeadroomProbeResult = {
      ok: false,
      state: 'unconfigured',
      reachable: false,
      ready: false,
      endpoint: '',
      latencyMs: 0,
      error: 'Headroom service URL is not configured.',
      checkedAt,
    };
    if (options?.url === undefined) lastProbeCache = result;
    return result;
  }

  const guard = await assessProviderUrl(targetUrl);
  const masked = maskHeadroomUrl(targetUrl);
  if (!guard.allowed) {
    const result: HeadroomProbeResult = {
      ok: false,
      state: 'blocked',
      reachable: false,
      ready: false,
      endpoint: masked,
      latencyMs: 0,
      error: guard.reason,
      checkedAt,
    };
    if (options?.url === undefined) lastProbeCache = result;
    return result;
  }

  const startedAt = Date.now();
  const healthUrl = buildHealthEndpoint(targetUrl);
  const compressUrl = buildCompressEndpoint(targetUrl);

  try {
    const healthRes = await fetch(healthUrl, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (healthRes.ok) {
      let version: string | null = null;
      try {
        const body = (await healthRes.json()) as { version?: string };
        if (typeof body?.version === 'string') version = body.version;
      } catch {
        // Plain text OK is fine
      }
      const latencyMs = Date.now() - startedAt;
      const result: HeadroomProbeResult = {
        ok: true,
        state: cfg.enabled ? 'ready' : 'disabled',
        reachable: true,
        ready: cfg.enabled,
        endpoint: masked,
        latencyMs,
        status: healthRes.status,
        version,
        error: null,
        checkedAt,
      };
      if (options?.url === undefined) lastProbeCache = result;
      return result;
    }

    const compressRes = await fetch(compressUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });

    const latencyMs = Date.now() - startedAt;
    if (compressRes.ok) {
      const data = await compressRes.json().catch(() => null) as { messages?: unknown[]; version?: string } | null;
      if (data && Array.isArray(data.messages)) {
        const result: HeadroomProbeResult = {
          ok: true,
          state: cfg.enabled ? 'ready' : 'disabled',
          reachable: true,
          ready: cfg.enabled,
          endpoint: masked,
          latencyMs,
          status: compressRes.status,
          version: typeof data.version === 'string' ? data.version : null,
          error: null,
          checkedAt,
        };
        if (options?.url === undefined) lastProbeCache = result;
        return result;
      }
    }

    const errMsg = `Headroom responded with HTTP ${compressRes.status}`;
    const result: HeadroomProbeResult = {
      ok: false,
      state: 'unreachable',
      reachable: false,
      ready: false,
      endpoint: masked,
      latencyMs,
      status: compressRes.status,
      error: errMsg,
      checkedAt,
    };
    if (options?.url === undefined) lastProbeCache = result;
    return result;
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const result: HeadroomProbeResult = {
      ok: false,
      state: 'unreachable',
      reachable: false,
      ready: false,
      endpoint: masked,
      latencyMs,
      error: describeFetchError(err),
      checkedAt,
    };
    if (options?.url === undefined) lastProbeCache = result;
    return result;
  }
}

export async function getHeadroomStatus(probeLive = false): Promise<{
  config: HeadroomConfig;
  stats: HeadroomStats;
  status: HeadroomProbeResult;
  envVars: string[];
}> {
  const config = getHeadroomConfig();
  const stats = getHeadroomStats();
  let status: HeadroomProbeResult;

  if (!config.url) {
    status = {
      ok: false,
      state: 'unconfigured',
      reachable: false,
      ready: false,
      endpoint: '',
      latencyMs: 0,
      error: 'No Headroom service URL configured (set X_HEADROOM_URL or configure in dashboard).',
      checkedAt: new Date().toISOString(),
    };
  } else if (probeLive || !lastProbeCache || lastProbeCache.endpoint !== config.maskedUrl) {
    status = await probeHeadroomConnection();
  } else {
    status = {
      ...lastProbeCache,
      state: lastProbeCache.reachable ? (config.enabled ? 'ready' : 'disabled') : lastProbeCache.state,
      ready: lastProbeCache.reachable && config.enabled,
    };
  }

  return {
    config,
    stats,
    status,
    envVars: ['X_HEADROOM_URL', 'HEADROOM_URL', 'X_HEADROOM_ENABLED', 'X_HEADROOM_TIMEOUT_MS'],
  };
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) || '', 'utf8');
  } catch {
    return 0;
  }
}

function messagePayload(body: Record<string, unknown> | null | undefined): unknown[] | null {
  if (Array.isArray(body?.messages)) return body.messages;
  if (Array.isArray(body?.input)) return body.input;
  const reqObj = body?.request as Record<string, unknown> | undefined;
  if (Array.isArray(reqObj?.contents)) return reqObj.contents;
  if (Array.isArray(body?.contents)) return body.contents;
  return null;
}

function captureSizeSnapshot(body: Record<string, unknown>): NonNullable<HeadroomDiagnostics['before']> {
  const messages = messagePayload(body);
  const toolHistory = (messages || []).filter((message: any) =>
    message?.role === 'tool'
    || message?.role === 'function'
    || message?.tool_calls?.length
    || message?.type === 'function_call_output'
    || message?.parts?.some?.((part: any) => part?.functionResponse || part?.functionCall)
    || (Array.isArray(message?.content) && message.content.some((part: any) => part?.type === 'tool_use' || part?.type === 'tool_result'))
  );

  const reqObj = body?.request as Record<string, unknown> | undefined;
  return {
    bodyBytes: jsonBytes(body),
    messageBytes: messages ? jsonBytes(messages) : 0,
    toolSchemaBytes: jsonBytes(body?.tools || reqObj?.tools || []),
    toolHistoryBytes: jsonBytes(toolHistory),
  };
}

function setDiagnostic(diagnostics: HeadroomDiagnostics | undefined, reason: string): void {
  if (diagnostics && !diagnostics.reason) diagnostics.reason = reason;
}

interface TargetRef {
  object: Record<string, any>;
  key: string | number;
  text: string;
}

function collectClaudeHeadroomMessages(body: Record<string, any>): {
  messages: Array<Record<string, unknown>>;
  targets: Array<TargetRef | null>;
} | null {
  if (!Array.isArray(body?.messages)) return null;

  const messages: Array<Record<string, unknown>> = [];
  const targets: Array<TargetRef | null> = [];

  const addText = (role: string, object: Record<string, any>, key: string | number, extra: Record<string, unknown> = {}) => {
    if (typeof object?.[key] !== 'string') return;
    messages.push({ role, content: object[key], ...extra });
    targets.push({ object, key, text: object[key] });
  };

  const addContent = (role: string, object: Record<string, any>, key: string | number, extra: Record<string, unknown> = {}) => {
    if (typeof object?.[key] === 'string') {
      addText(role, object, key, extra);
    } else if (Array.isArray(object?.[key])) {
      for (const block of object[key]) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          addText(role, block, 'text', extra);
        }
      }
    }
  };

  addContent('system', body, 'system');

  for (const message of body.messages) {
    if (!message || typeof message !== 'object') continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const toolUses = blocks.filter((block: any) => block?.type === 'tool_use');

    if (message.role === 'assistant' && toolUses.length > 0) {
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: toolUses.map((block: any) => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
        })),
      });
      targets.push(null);
    }

    addContent(message.role, message, 'content');

    for (const block of blocks) {
      if (block?.type === 'tool_result' && block.is_error !== true) {
        addContent('tool', block, 'content', { tool_call_id: block.tool_use_id });
      }
    }
  }

  return targets.some(Boolean) ? { messages, targets } : null;
}

function collectToolOutputText(body: Record<string, any>, format?: string): {
  messages: Array<Record<string, unknown>>;
  targets: TargetRef[];
} | null {
  const messages: Array<Record<string, unknown>> = [];
  const targets: TargetRef[] = [];

  const visit = (object: Record<string, any>, key: string | number, depth = 0) => {
    if (depth > HEADROOM_TOOL_OUTPUT_MAX_DEPTH) return;
    const value = object?.[key];
    if (typeof value === 'string') {
      if (!value.trim()) return;
      messages.push({ role: 'tool', tool_call_id: `headroom-tool-${messages.length}`, content: value });
      targets.push({ object, key, text: value });
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) visit(value, i, depth + 1);
    } else if (value && typeof value === 'object') {
      if (value.type && value.type !== 'text' && value.type !== 'input_text') return;
      for (const field of ['result', 'output', 'content', 'text']) {
        if (Object.prototype.hasOwnProperty.call(value, field)) visit(value, field, depth + 1);
      }
    }
  };

  if (format === 'openai-responses' && Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (item?.type === 'function_call_output' && item.is_error !== true) {
        visit(item, 'output');
      } else if (item && (item.role === 'user' || item.role === 'system' || item.role === 'developer')) {
        if (typeof item.content === 'string') {
          messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: item.content });
          targets.push({ object: item, key: 'content', text: item.content });
        } else if (Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part && (part.type === 'input_text' || part.type === 'text') && typeof part.text === 'string') {
              messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: part.text });
              targets.push({ object: part, key: 'text', text: part.text });
            }
          }
        }
      }
    }
    return messages.length > 0 ? { messages, targets } : null;
  }

  if (format === 'gemini' || Array.isArray(body?.contents) || Array.isArray(body?.request?.contents)) {
    const contents = (body?.request?.contents || body?.contents) as any[];
    if (!Array.isArray(contents)) return null;

    for (const content of contents) {
      if (!Array.isArray(content?.parts)) continue;
      const role = content.role === 'model' ? 'assistant' : 'user';
      for (const part of content.parts) {
        if (part?.functionResponse && !part.functionResponse.response?.error) {
          visit(part.functionResponse, 'response');
        } else if (typeof part?.text === 'string' && part.text.trim()) {
          messages.push({ role, content: part.text });
          targets.push({ object: part, key: 'text', text: part.text });
        }
      }
    }
    return messages.length > 0 ? { messages, targets } : null;
  }

  return null;
}

function textFromHeadroomMessage(message: Record<string, unknown>): string | null {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (typeof (part as any)?.text === 'string') parts.push((part as any).text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function applyProjectedMessages(
  projection: { messages: Array<Record<string, unknown>>; targets: Array<TargetRef | null> },
  compressedMessages: Array<Record<string, unknown>>,
  diagnostics: HeadroomDiagnostics | undefined,
  label: string
): boolean {
  if (!Array.isArray(compressedMessages) || compressedMessages.length !== projection.messages.length) {
    setDiagnostic(diagnostics, `proxy response did not match ${label} message count`);
    return false;
  }

  const updates: Array<{ target: TargetRef; text: string }> = [];

  for (let i = 0; i < projection.messages.length; i++) {
    const expected = projection.messages[i];
    const actual = compressedMessages[i];
    if (!actual || actual.role !== expected.role || actual.tool_call_id !== expected.tool_call_id) {
      setDiagnostic(diagnostics, `proxy response did not preserve ${label} message order or tool_call_id`);
      return false;
    }

    const text = textFromHeadroomMessage(actual);
    if (text === null) {
      setDiagnostic(diagnostics, `proxy response missing ${label} text content`);
      return false;
    }

    const target = projection.targets[i];
    if (target && text.trim().length > 0 && text.length < target.text.length) {
      updates.push({ target, text });
    }
  }

  for (const { target, text } of updates) {
    target.object[target.key] = text;
  }

  return true;
}

async function callCompressEndpoint(opts: {
  url: string;
  messages: Array<Record<string, unknown>>;
  model?: string;
  timeoutMs: number;
  compressUserMessages?: boolean;
  signal?: AbortSignal;
  diagnostics: HeadroomDiagnostics;
}): Promise<{ messages: Array<Record<string, unknown>>; tokens_before?: number; tokens_after?: number; tokens_saved?: number } | null> {
  const guard = await assessProviderUrl(opts.url);
  if (!guard.allowed) {
    setDiagnostic(opts.diagnostics, `blocked by url-guard: ${guard.reason}`);
    return null;
  }

  const endpoint = buildCompressEndpoint(opts.url);
  opts.diagnostics.endpoint = maskHeadroomUrl(endpoint);

  const payload: Record<string, unknown> = {
    messages: opts.messages,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.compressUserMessages ? { config: { compress_user_messages: true } } : {}),
  };

  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
  const combinedSignal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: combinedSignal,
    });
  } catch (error) {
    setDiagnostic(opts.diagnostics, `request failed: ${describeFetchError(error)}`);
    return null;
  }

  if (!res.ok) {
    setDiagnostic(opts.diagnostics, `proxy returned HTTP ${res.status}`);
    return null;
  }

  let data: any;
  try {
    data = (await res.json());
  } catch {
    setDiagnostic(opts.diagnostics, 'proxy returned invalid JSON');
    return null;
  }

  if (!Array.isArray(data?.messages)) {
    setDiagnostic(opts.diagnostics, 'proxy response missing messages[]');
    return null;
  }

  return data;
}

export async function compressWithHeadroom(
  body: Record<string, any>,
  options?: {
    model?: string;
    format?: 'claude' | 'openai-responses' | 'gemini';
    enabled?: boolean;
    url?: string;
    timeoutMs?: number;
    compressUserMessages?: boolean;
    signal?: AbortSignal;
    diagnostics?: HeadroomDiagnostics;
  }
): Promise<HeadroomCompressionResponse | null> {
  const cfg = getHeadroomConfig();
  const enabled = options?.enabled !== undefined ? options.enabled : cfg.enabled;
  const url = (options?.url !== undefined ? options.url : cfg.url).trim();
  const timeoutMs = normalizeTimeout(options?.timeoutMs ?? cfg.timeoutMs);
  const compressUserMessages = options?.compressUserMessages !== undefined
    ? options.compressUserMessages
    : cfg.compressUserMessages;
  const diagnostics = options?.diagnostics ?? {};
  const startedAt = Date.now();

  if (!enabled) {
    setDiagnostic(diagnostics, 'disabled');
    return null;
  }

  if (!url) {
    setDiagnostic(diagnostics, 'missing proxy URL');
    return null;
  }

  if (!body || typeof body !== 'object') {
    setDiagnostic(diagnostics, 'missing request body');
    return null;
  }

  ensureStatsLoaded();
  statsState.requests += 1;

  try {
    diagnostics.before = captureSizeSnapshot(body);
    const bytesBefore = diagnostics.before.bodyBytes;
    const format = options?.format;

    // 1. Claude / Anthropic Messages projection
    const isClaudeShape = format === 'claude' || (
      Array.isArray(body.messages) &&
      (body.system !== undefined || body.messages.some((m: any) =>
        Array.isArray(m?.content) && m.content.some((b: any) => b?.type === 'tool_result' || b?.type === 'tool_use'))
    ));

    if (isClaudeShape) {
      const projection = collectClaudeHeadroomMessages(body);
      if (!projection || projection.messages.length === 0) {
        setDiagnostic(diagnostics, 'Claude request has no eligible text content');
        statsState.bypassed += 1;
        persistStats();
        return null;
      }

      const data = await callCompressEndpoint({
        url,
        messages: projection.messages,
        model: options?.model,
        timeoutMs,
        compressUserMessages,
        signal: options?.signal,
        diagnostics,
      });

      if (!data || !applyProjectedMessages(projection, data.messages, diagnostics, 'Claude')) {
        recordHeadroomFailureOrBypass(diagnostics);
        return null;
      }

      diagnostics.after = captureSizeSnapshot(body);
      return finalizeHeadroomResult(data, bytesBefore, diagnostics.after.bodyBytes, startedAt, diagnostics);
    }

    // 2. OpenAI Responses or Gemini projection
    const toolOrNativeProjection = collectToolOutputText(body, format);
    if (toolOrNativeProjection) {
      const data = await callCompressEndpoint({
        url,
        messages: toolOrNativeProjection.messages,
        model: options?.model,
        timeoutMs,
        compressUserMessages,
        signal: options?.signal,
        diagnostics,
      });

      if (!data || !applyProjectedMessages(toolOrNativeProjection, data.messages, diagnostics, format || 'projected')) {
        recordHeadroomFailureOrBypass(diagnostics);
        return null;
      }

      diagnostics.after = captureSizeSnapshot(body);
      return finalizeHeadroomResult(data, bytesBefore, diagnostics.after.bodyBytes, startedAt, diagnostics);
    }

    // 3. Standard OpenAI messages[] shape
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      setDiagnostic(diagnostics, `unsupported ${format || 'unknown'} request shape`);
      statsState.bypassed += 1;
      persistStats();
      return null;
    }

    const originalMessages = body.messages as Array<Record<string, any>>;
    const data = await callCompressEndpoint({
      url,
      messages: originalMessages,
      model: options?.model,
      timeoutMs,
      compressUserMessages,
      signal: options?.signal,
      diagnostics,
    });

    if (!data) {
      recordHeadroomFailureOrBypass(diagnostics);
      return null;
    }

    const returned = data.messages as Array<Record<string, any>>;
    if (returned.length !== originalMessages.length) {
      const origToolIds = originalMessages
        .filter(m => m?.role === 'tool' && m.tool_call_id)
        .map(m => String(m.tool_call_id));
      const retToolIds = returned
        .filter(m => m?.role === 'tool' && m.tool_call_id)
        .map(m => String(m.tool_call_id));

      if (origToolIds.join('|') !== retToolIds.join('|') || returned.length === 0) {
        setDiagnostic(diagnostics, 'proxy response did not preserve tool_call_id sequence');
        statsState.errors += 1;
        statsState.lastError = diagnostics.reason ?? 'invalid proxy response';
        statsState.lastErrorAt = new Date().toISOString();
        persistStats();
        return null;
      }
    } else {
      for (let i = 0; i < originalMessages.length; i++) {
        const orig = originalMessages[i];
        const next = returned[i];
        if (!next || next.role !== orig.role) {
          setDiagnostic(diagnostics, 'proxy response altered message roles');
          statsState.errors += 1;
          persistStats();
          return null;
        }
        if (orig.tool_call_id && next.tool_call_id !== orig.tool_call_id) {
          setDiagnostic(diagnostics, 'proxy response altered tool_call_id');
          statsState.errors += 1;
          persistStats();
          return null;
        }
        if (orig.is_error === true) {
          next.content = orig.content;
        }
      }
    }

    const candidateBytes = jsonBytes({ ...body, messages: returned });
    if (candidateBytes >= bytesBefore) {
      setDiagnostic(diagnostics, 'not_profitable');
      statsState.bypassed += 1;
      persistStats();
      return null;
    }

    body.messages = returned;
    diagnostics.after = captureSizeSnapshot(body);
    return finalizeHeadroomResult(data, bytesBefore, diagnostics.after.bodyBytes, startedAt, diagnostics);
  } catch (error) {
    setDiagnostic(diagnostics, `unexpected error: ${describeFetchError(error)}`);
    statsState.errors += 1;
    statsState.lastError = diagnostics.reason ?? 'unexpected error';
    statsState.lastErrorAt = new Date().toISOString();
    persistStats();
    return null;
  }
}

function recordHeadroomFailureOrBypass(diagnostics: HeadroomDiagnostics): void {
  const reason = diagnostics.reason || '';
  if (
    reason.startsWith('request failed') ||
    reason.startsWith('proxy returned HTTP') ||
    reason.startsWith('proxy response') ||
    reason.startsWith('blocked by url-guard')
  ) {
    statsState.errors += 1;
    statsState.lastError = reason;
    statsState.lastErrorAt = new Date().toISOString();
  } else {
    statsState.bypassed += 1;
  }
  persistStats();
}

function finalizeHeadroomResult(
  data: { messages: Array<Record<string, unknown>>; tokens_before?: number; tokens_after?: number; tokens_saved?: number },
  bytesBefore: number,
  bytesAfter: number,
  startedAt: number,
  diagnostics: HeadroomDiagnostics
): HeadroomCompressionResponse | null {
  const durationMs = Date.now() - startedAt;
  diagnostics.durationMs = durationMs;

  if (bytesAfter >= bytesBefore) {
    setDiagnostic(diagnostics, 'not_profitable');
    statsState.bypassed += 1;
    persistStats();
    return null;
  }

  const tokensBeforeEst = Math.max(1, Math.round(bytesBefore / 4));
  const tokensAfterEst = Math.max(1, Math.round(bytesAfter / 4));
  const tokensSavedEst = Math.max(0, tokensBeforeEst - tokensAfterEst);
  const proxyReported = typeof data.tokens_saved === 'number' && data.tokens_saved > 0
    ? Math.round(data.tokens_saved)
    : 0;

  statsState.compressed += 1;
  statsState.bytesBefore += bytesBefore;
  statsState.bytesAfter += bytesAfter;
  statsState.tokensBeforeEst += tokensBeforeEst;
  statsState.tokensAfterEst += tokensAfterEst;
  statsState.tokensSavedEst += tokensSavedEst;
  statsState.proxyReportedTokensSaved += proxyReported;
  statsState.lastSuccessAt = new Date().toISOString();
  statsState.lastError = null;
  persistStats();

  return {
    messages: data.messages,
    tokens_before: typeof data.tokens_before === 'number' ? data.tokens_before : undefined,
    tokens_after: typeof data.tokens_after === 'number' ? data.tokens_after : undefined,
    tokens_saved: typeof data.tokens_saved === 'number' ? data.tokens_saved : undefined,
    tokensBeforeEst,
    tokensAfterEst,
    tokensSavedEst,
    bytesBefore,
    bytesAfter,
    durationMs,
  };
}

export function isHeadroomPhantomSavings(
  stats?: { tokens_saved?: number },
  diagnostics?: HeadroomDiagnostics,
  minShrinkRatio = 0.05
): boolean {
  if (!stats?.tokens_saved || stats.tokens_saved <= 0) return false;
  return (['bodyBytes', 'messageBytes'] as const).every(key => {
    const before = diagnostics?.before?.[key] || 0;
    const after = diagnostics?.after?.[key] || 0;
    return before > 0 && after > 0 && after >= before * (1 - minShrinkRatio);
  });
}

export function formatHeadroomLog(stats: HeadroomCompressionResponse | null): string | null {
  if (!stats || stats.tokensSavedEst <= 0) return null;
  const pct = stats.tokensBeforeEst > 0
    ? ((stats.tokensSavedEst / stats.tokensBeforeEst) * 100).toFixed(1)
    : '0.0';
  return `[HEADROOM] est saved ${stats.tokensSavedEst} tok (${stats.bytesBefore}B→${stats.bytesAfter}B, -${pct}%)${stats.tokens_saved ? ` | proxy_reported=${stats.tokens_saved}` : ''} in ${stats.durationMs}ms`;
}
