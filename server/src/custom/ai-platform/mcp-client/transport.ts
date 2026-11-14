import {
  MCP_LIMITS,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  type McpCallToolResult,
  type McpToolDescriptor,
  type McpTransportErrorCode,
} from '@freellmapi/shared/ai-platform-mcp.js';
import { SafeHttpError, safeFetch } from '../../x-gateway/support-safe-http.js';
import {
  getAllowedInternalOrigins,
  type McpSession,
  type McpTransportConfig,
} from './store.js';

export class McpTransportError extends Error {
  constructor(
    public readonly code: McpTransportErrorCode,
    message: string,
    public readonly status?: number,
    public readonly uncertain = false,
  ) {
    super(message);
    this.name = 'McpTransportError';
  }
}

export interface McpTransportOptions {
  allowedInternalOrigins?: readonly string[];
  dnsResolver?: (host: string) => Promise<string[]>;
  fetchFn?: typeof fetch;
  retryOn404?: boolean;
  deadlineAtMs?: number;
  preDispatchGuard?: () => void | Promise<void>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const TRUNCATED_MARKER = '\n...[truncated]';
const MAX_JSON_RPC_BODY_BYTES = 2 * 1024 * 1024;
const SUPPORTED_VERSIONS_SET = new Set<string>(MCP_SUPPORTED_PROTOCOL_VERSIONS);

let nextRpcId = 1;
function allocateRpcId(): number {
  nextRpcId = nextRpcId >= Number.MAX_SAFE_INTEGER ? 1 : nextRpcId + 1;
  return nextRpcId;
}

// ── Per-Server Concurrency Semaphore ─────────────────────────────────────────

interface SemaphoreState {
  active: number;
  waiters: Array<() => void>;
}

const serverSemaphores = new Map<number, SemaphoreState>();

function getSemaphore(serverId: number): SemaphoreState {
  let state = serverSemaphores.get(serverId);
  if (!state) {
    state = { active: 0, waiters: [] };
    serverSemaphores.set(serverId, state);
  }
  return state;
}

async function acquireServerSlot(
  serverId: number,
  maxConcurrency: number,
  signal: AbortSignal,
  isDeadlineExpired: () => boolean,
): Promise<() => void> {
  const limit = Math.max(
    MCP_LIMITS.minConcurrency,
    Math.min(MCP_LIMITS.maxConcurrency, Math.trunc(maxConcurrency || MCP_LIMITS.defaultMaxConcurrency)),
  );
  const state = getSemaphore(serverId);

  if (signal.aborted) {
    throw new McpTransportError(
      isDeadlineExpired() ? 'timeout' : 'http',
      isDeadlineExpired() ? 'MCP request timed out while waiting for concurrency slot.' : 'MCP request aborted.',
    );
  }

  if (state.active >= limit) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const idx = state.waiters.indexOf(wake);
        if (idx !== -1) state.waiters.splice(idx, 1);
        reject(
          new McpTransportError(
            isDeadlineExpired() ? 'timeout' : 'http',
            isDeadlineExpired()
              ? 'MCP request timed out while waiting for concurrency slot.'
              : 'MCP request aborted.',
          ),
        );
      };
      const wake = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      state.waiters.push(wake);
    });
  }

  state.active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active = Math.max(0, state.active - 1);
    const next = state.waiters.shift();
    if (next) {
      next();
    } else if (state.active === 0) {
      serverSemaphores.delete(serverId);
    }
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveAllowedOrigins(opts?: McpTransportOptions): readonly string[] {
  if (opts?.allowedInternalOrigins !== undefined) {
    return opts.allowedInternalOrigins;
  }
  try {
    return getAllowedInternalOrigins();
  } catch {
    return [];
  }
}

export function computeOperationDeadlineMs(timeoutMs: number): number {
  const effectiveTimeout = Math.max(
    50,
    Math.min(MCP_LIMITS.maxTimeoutMs, Math.trunc(timeoutMs || MCP_LIMITS.defaultTimeoutMs)),
  );
  return Date.now() + effectiveTimeout;
}

function createDeadlineSignal(
  callerSignal: AbortSignal,
  timeoutMs: number,
  deadlineAtMs?: number,
): { signal: AbortSignal; isDeadlineExpired: () => boolean; deadlineAtMs: number; cleanup: () => void } {
  const controller = new AbortController();
  let expired = false;

  const effectiveTimeout = Math.max(
    50,
    Math.min(MCP_LIMITS.maxTimeoutMs, Math.trunc(timeoutMs || MCP_LIMITS.defaultTimeoutMs)),
  );
  const targetDeadlineAtMs =
    typeof deadlineAtMs === 'number' && Number.isFinite(deadlineAtMs)
      ? deadlineAtMs
      : Date.now() + effectiveTimeout;

  const onCallerAbort = () => {
    controller.abort(callerSignal.reason);
  };

  if (callerSignal.aborted) {
    controller.abort(callerSignal.reason);
  } else {
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  if (!controller.signal.aborted) {
    const remainingMs = targetDeadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      expired = true;
      controller.abort(new Error('MCP request deadline exceeded'));
    } else {
      timer = setTimeout(() => {
        expired = true;
        controller.abort(new Error('MCP request deadline exceeded'));
      }, remainingMs);
    }
  }

  return {
    signal: controller.signal,
    isDeadlineExpired: () => expired,
    deadlineAtMs: targetDeadlineAtMs,
    cleanup: () => {
      if (timer !== null) clearTimeout(timer);
      callerSignal.removeEventListener('abort', onCallerAbort);
    },
  };
}

function buildAuthHeaders(config: McpTransportConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.authKind === 'bearer' && config.secret) {
    headers['Authorization'] = `Bearer ${config.secret}`;
  } else if (config.authKind === 'header' && config.authHeaderName && config.secret) {
    headers[config.authHeaderName] = config.secret;
  }
  return headers;
}

function assertSessionValid(config: McpTransportConfig, session: McpSession): void {
  const currentOrigin = new URL(config.url).origin;
  if (
    session.serverId !== config.serverId ||
    session.revision !== config.revision ||
    session.credentialGeneration !== config.credentialGeneration ||
    session.origin !== currentOrigin
  ) {
    throw new McpTransportError(
      'protocol',
      'MCP session invalidated because server revision, credentials, or origin changed.',
    );
  }
  if (!SUPPORTED_VERSIONS_SET.has(session.protocolVersion)) {
    throw new McpTransportError(
      'protocol',
      `Unsupported MCP protocol version '${session.protocolVersion}'.`,
    );
  }
}

function truncateUtf8(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= maxBytes) {
    return { text, bytes: totalBytes, truncated: false };
  }
  const markerBytes = Buffer.byteLength(TRUNCATED_MARKER, 'utf8');
  const budget = Math.max(0, maxBytes - markerBytes);
  let slice = Buffer.from(text, 'utf8').subarray(0, budget).toString('utf8');
  if (slice.endsWith('\uFFFD')) {
    slice = slice.slice(0, -1);
  }
  return {
    text: `${slice}${TRUNCATED_MARKER}`,
    bytes: totalBytes,
    truncated: true,
  };
}

async function readBoundedText(
  res: Response,
  signal: AbortSignal,
  maxBytes: number,
  isDeadlineExpired: () => boolean,
): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });

  const readNextChunk = (): ReturnType<typeof reader.read> => {
    if (signal.aborted) {
      return Promise.reject(
        new McpTransportError(
          isDeadlineExpired() ? 'timeout' : 'http',
          isDeadlineExpired() ? 'MCP response timed out.' : 'MCP response aborted.',
        ),
      );
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const onChunkAbort = () => {
        if (settled) return;
        settled = true;
        void reader.cancel().catch(() => {});
        reject(
          new McpTransportError(
            isDeadlineExpired() ? 'timeout' : 'http',
            isDeadlineExpired() ? 'MCP response timed out.' : 'MCP response aborted.',
          ),
        );
      };
      signal.addEventListener('abort', onChunkAbort, { once: true });
      reader.read().then(
        (res) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onChunkAbort);
          resolve(res);
        },
        (err) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onChunkAbort);
          reject(err);
        },
      );
    });
  };

  try {
    while (true) {
      if (signal.aborted) {
        throw new McpTransportError(
          isDeadlineExpired() ? 'timeout' : 'http',
          isDeadlineExpired() ? 'MCP response timed out.' : 'MCP response aborted.',
        );
      }
      const { done, value } = await readNextChunk();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          void reader.cancel().catch(() => {});
          throw new McpTransportError(
            'too_large',
            `MCP response body exceeded ${maxBytes} bytes.`,
          );
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (err) {
    void reader.cancel().catch(() => {});
    if (err instanceof McpTransportError) throw err;
    if (signal.aborted || isDeadlineExpired()) {
      throw new McpTransportError(
        isDeadlineExpired() ? 'timeout' : 'http',
        isDeadlineExpired() ? 'MCP response timed out.' : 'MCP response aborted.',
      );
    }
    throw new McpTransportError('http', `MCP stream read failed: ${(err as Error).message}`);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function readSseForRpcId(
  res: Response,
  expectedId: number,
  signal: AbortSignal,
  isDeadlineExpired: () => boolean,
): Promise<JsonRpcResponse> {
  if (!res.body) {
    throw new McpTransportError('protocol', 'Empty SSE response body from MCP server.');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalBytes = 0;

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });

  const parseBlock = (block: string): JsonRpcResponse | null => {
    const lines = block.split(/\r?\n/);
    const dataLines: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) return null;
    const rawData = dataLines.join('\n');
    if (Buffer.byteLength(rawData, 'utf8') > MCP_LIMITS.maxSseFrameBytes) {
      throw new McpTransportError('too_large', 'MCP SSE event frame exceeded maxSseFrameBytes.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      throw new McpTransportError('protocol', 'Invalid JSON-RPC payload inside SSE event.');
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const msg = parsed as JsonRpcResponse;
    if (msg.id === expectedId) {
      return msg;
    }
    return null;
  };

  try {
    while (true) {
      if (signal.aborted) {
        throw new McpTransportError(
          isDeadlineExpired() ? 'timeout' : 'http',
          isDeadlineExpired() ? 'MCP SSE stream timed out.' : 'MCP SSE stream aborted.',
        );
      }
      const { done, value } = await reader.read();
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > MAX_JSON_RPC_BODY_BYTES) {
          void reader.cancel().catch(() => {});
          throw new McpTransportError('too_large', 'MCP SSE stream exceeded maximum size.');
        }
        buffer += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(buffer, 'utf8') > MCP_LIMITS.maxSseFrameBytes) {
          void reader.cancel().catch(() => {});
          throw new McpTransportError('too_large', 'MCP SSE frame exceeded maxSseFrameBytes.');
        }

        let sepIdx = buffer.search(/\r?\n\r?\n/);
        while (sepIdx !== -1) {
          const match = /\r?\n\r?\n/.exec(buffer);
          const sepLen = match ? match[0].length : 2;
          const block = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + sepLen);
          const matched = parseBlock(block);
          if (matched) {
            void reader.cancel().catch(() => {});
            return matched;
          }
          sepIdx = buffer.search(/\r?\n\r?\n/);
        }
      }
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
          const matched = parseBlock(buffer);
          if (matched) return matched;
        }
        break;
      }
    }
    throw new McpTransportError('protocol', `SSE stream ended without JSON-RPC response for id ${expectedId}.`);
  } catch (err) {
    void reader.cancel().catch(() => {});
    if (err instanceof McpTransportError) throw err;
    if (signal.aborted || isDeadlineExpired()) {
      throw new McpTransportError(
        isDeadlineExpired() ? 'timeout' : 'http',
        isDeadlineExpired() ? 'MCP SSE stream timed out.' : 'MCP SSE stream aborted.',
      );
    }
    throw new McpTransportError('http', `MCP SSE read failed: ${(err as Error).message}`);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function dispatchJsonRpc(
  config: McpTransportConfig,
  payload: Record<string, unknown>,
  session: Pick<McpSession, 'sessionId' | 'protocolVersion'> | null,
  signal: AbortSignal,
  isDeadlineExpired: () => boolean,
  opts?: McpTransportOptions,
  isNotification = false,
): Promise<{ rpc: JsonRpcResponse | null; responseSessionId: string | null }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...buildAuthHeaders(config),
  };
  if (session?.protocolVersion) {
    headers['MCP-Protocol-Version'] = session.protocolVersion;
  }
  if (session?.sessionId) {
    headers['Mcp-Session-Id'] = session.sessionId;
  }

  if (signal.aborted || isDeadlineExpired()) {
    throw new McpTransportError(
      isDeadlineExpired() ? 'timeout' : 'http',
      isDeadlineExpired() ? 'MCP request timed out.' : 'MCP request aborted.',
    );
  }

  if (opts?.preDispatchGuard) {
    await opts.preDispatchGuard();
  }

  let res: Response;
  try {
    res = await safeFetch(
      config.url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
      },
      {
        allowedOrigins: resolveAllowedOrigins(opts),
        requireExplicitHttpOrigin: true,
        followRedirects: {
          maxRedirects: MCP_LIMITS.maxRedirects,
          methodPreservingOnly: true,
          stripHeadersOnCrossOrigin: config.authHeaderName ? [config.authHeaderName] : [],
        },
        dnsResolver: opts?.dnsResolver,
        fetchFn: opts?.fetchFn,
        signal,
      },
    );
  } catch (err) {
    if (err instanceof McpTransportError) throw err;
    if (signal.aborted || isDeadlineExpired()) {
      throw new McpTransportError(
        isDeadlineExpired() ? 'timeout' : 'http',
        isDeadlineExpired() ? 'MCP request timed out.' : 'MCP request aborted.',
      );
    }
    if (err instanceof SafeHttpError) {
      const lower = err.message.toLowerCase();
      const isUnsafe =
        err.status === 403 ||
        lower.includes('ssrf') ||
        lower.includes('metadata') ||
        lower.includes('private') ||
        lower.includes('redirect') ||
        lower.includes('http:');
      throw new McpTransportError(isUnsafe ? 'unsafe_url' : 'http', err.message, err.status);
    }
    throw new McpTransportError('http', `MCP HTTP dispatch failed: ${(err as Error).message}`);
  }

  const responseSessionId = res.headers.get('mcp-session-id');

  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel().catch(() => {});
    throw new McpTransportError('http', `MCP server returned HTTP ${res.status}.`, res.status);
  }

  if (isNotification && (res.status === 202 || res.status === 204)) {
    await res.body?.cancel().catch(() => {});
    return { rpc: null, responseSessionId };
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('text/event-stream')) {
    const rpcId = payload.id as number;
    const rpc = await readSseForRpcId(res, rpcId, signal, isDeadlineExpired);
    return { rpc, responseSessionId };
  }

  const text = await readBoundedText(res, signal, MAX_JSON_RPC_BODY_BYTES, isDeadlineExpired);
  if (isNotification && text.trim().length === 0) {
    return { rpc: null, responseSessionId };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpTransportError('protocol', 'MCP server returned malformed JSON-RPC response.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new McpTransportError('protocol', 'MCP JSON-RPC response must be an object.');
  }
  const rpc = parsed as JsonRpcResponse;
  if (!isNotification && rpc.id !== payload.id) {
    throw new McpTransportError(
      'protocol',
      `MCP JSON-RPC id mismatch: expected ${String(payload.id)}, got ${String(rpc.id)}.`,
    );
  }
  return { rpc, responseSessionId };
}

async function performInitialize(
  config: McpTransportConfig,
  signal: AbortSignal,
  isDeadlineExpired: () => boolean,
  opts?: McpTransportOptions,
): Promise<McpSession> {
  const initId = allocateRpcId();
  const { rpc, responseSessionId } = await dispatchJsonRpc(
    config,
    {
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'freellmapi-mcp-client',
          version: '1.0.0',
        },
      },
    },
    null,
    signal,
    isDeadlineExpired,
    opts,
    false,
  );

  if (!rpc || rpc.error) {
    throw new McpTransportError(
      'protocol',
      rpc?.error?.message ?? 'MCP initialize failed with JSON-RPC error.',
    );
  }

  const result = (rpc.result && typeof rpc.result === 'object' ? rpc.result : {}) as {
    protocolVersion?: unknown;
    serverInfo?: unknown;
  };
  const negotiatedVersion =
    typeof result.protocolVersion === 'string' ? result.protocolVersion : '';
  if (!SUPPORTED_VERSIONS_SET.has(negotiatedVersion)) {
    throw new McpTransportError(
      'protocol',
      `Unsupported MCP protocol version negotiated: '${negotiatedVersion || 'missing'}'. Supported: ${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`,
    );
  }

  const session: McpSession = {
    serverId: config.serverId,
    revision: config.revision,
    credentialGeneration: config.credentialGeneration,
    origin: new URL(config.url).origin,
    sessionId: responseSessionId ?? null,
    protocolVersion: negotiatedVersion,
    serverInfo:
      result.serverInfo && typeof result.serverInfo === 'object'
        ? (result.serverInfo as Record<string, unknown>)
        : null,
  };

  await dispatchJsonRpc(
    config,
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    },
    session,
    signal,
    isDeadlineExpired,
    opts,
    true,
  );

  return session;
}

// ── Public Transport Functions ───────────────────────────────────────────────

export async function mcpInitialize(
  config: McpTransportConfig,
  signal: AbortSignal,
  opts?: McpTransportOptions,
): Promise<McpSession> {
  const deadline = createDeadlineSignal(signal, config.timeoutMs, opts?.deadlineAtMs);
  let release: (() => void) | null = null;
  try {
    release = await acquireServerSlot(
      config.serverId,
      config.maxConcurrency,
      deadline.signal,
      deadline.isDeadlineExpired,
    );
    return await performInitialize(config, deadline.signal, deadline.isDeadlineExpired, opts);
  } finally {
    release?.();
    deadline.cleanup();
  }
}

export async function mcpListTools(
  config: McpTransportConfig,
  session: McpSession,
  signal: AbortSignal,
  opts?: McpTransportOptions,
): Promise<McpToolDescriptor[]> {
  assertSessionValid(config, session);
  const deadline = createDeadlineSignal(signal, config.timeoutMs, opts?.deadlineAtMs);
  let release: (() => void) | null = null;

  try {
    release = await acquireServerSlot(
      config.serverId,
      config.maxConcurrency,
      deadline.signal,
      deadline.isDeadlineExpired,
    );

    const runList = async (activeSession: McpSession): Promise<McpToolDescriptor[]> => {
      const tools: McpToolDescriptor[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;

      for (let page = 0; page < MCP_LIMITS.maxToolPages; page += 1) {
        const rpcId = allocateRpcId();
        const { rpc } = await dispatchJsonRpc(
          config,
          {
            jsonrpc: '2.0',
            id: rpcId,
            method: 'tools/list',
            params: cursor ? { cursor } : {},
          },
          activeSession,
          deadline.signal,
          deadline.isDeadlineExpired,
          opts,
          false,
        );

        if (!rpc || rpc.error) {
          throw new McpTransportError(
            'protocol',
            rpc?.error?.message ?? 'MCP tools/list failed with JSON-RPC error.',
          );
        }

        const result = (rpc.result && typeof rpc.result === 'object' ? rpc.result : {}) as {
          tools?: unknown;
          nextCursor?: unknown;
        };
        const pageTools = Array.isArray(result.tools) ? result.tools : [];
        for (const item of pageTools) {
          if (!item || typeof item !== 'object') continue;
          const t = item as Record<string, unknown>;
          if (typeof t.name !== 'string' || !t.name) continue;
          tools.push({
            name: t.name,
            description: typeof t.description === 'string' ? t.description : null,
            inputSchema:
              t.inputSchema && typeof t.inputSchema === 'object'
                ? (t.inputSchema as Record<string, unknown>)
                : { type: 'object' },
            outputSchema:
              t.outputSchema && typeof t.outputSchema === 'object'
                ? (t.outputSchema as Record<string, unknown>)
                : null,
            annotations:
              t.annotations && typeof t.annotations === 'object'
                ? (t.annotations as Record<string, unknown>)
                : undefined,
          });
        }

        const nextCursor =
          typeof result.nextCursor === 'string' && result.nextCursor.length > 0
            ? result.nextCursor
            : undefined;
        if (!nextCursor) {
          return tools;
        }
        if (seenCursors.has(nextCursor) || nextCursor === cursor) {
          throw new McpTransportError('protocol', 'Cursor cycle detected in MCP tools/list.');
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      throw new McpTransportError(
        'protocol',
        `MCP tools/list exceeded maximum page count (${MCP_LIMITS.maxToolPages}).`,
      );
    };

    try {
      return await runList(session);
    } catch (err) {
      const canRetry = opts?.retryOn404 !== false;
      if (canRetry && err instanceof McpTransportError && err.code === 'http' && err.status === 404) {
        const refreshed = await performInitialize(
          config,
          deadline.signal,
          deadline.isDeadlineExpired,
          opts,
        );
        Object.assign(session, refreshed);
        return await runList(refreshed);
      }
      throw err;
    }
  } finally {
    release?.();
    deadline.cleanup();
  }
}

export async function mcpCallTool(
  config: McpTransportConfig,
  session: McpSession,
  name: string,
  args: unknown,
  signal: AbortSignal,
  opts?: McpTransportOptions,
): Promise<McpCallToolResult> {
  assertSessionValid(config, session);
  const deadline = createDeadlineSignal(signal, config.timeoutMs, opts?.deadlineAtMs);
  let release: (() => void) | null = null;
  const retryOn404 = opts?.retryOn404 === true;

  try {
    release = await acquireServerSlot(
      config.serverId,
      config.maxConcurrency,
      deadline.signal,
      deadline.isDeadlineExpired,
    );

    const invoke = async (activeSession: McpSession): Promise<McpCallToolResult> => {
      const rpcId = allocateRpcId();
      const { rpc } = await dispatchJsonRpc(
        config,
        {
          jsonrpc: '2.0',
          id: rpcId,
          method: 'tools/call',
          params: {
            name,
            arguments: args && typeof args === 'object' ? args : {},
          },
        },
        activeSession,
        deadline.signal,
        deadline.isDeadlineExpired,
        opts,
        false,
      );

      if (!rpc || rpc.error) {
        const errMsg = rpc?.error?.message ?? 'MCP tools/call returned JSON-RPC error.';
        const truncated = truncateUtf8(errMsg, config.maxResultBytes);
        return {
          content: truncated.text,
          isError: true,
          bytes: truncated.bytes,
          truncated: truncated.truncated,
        };
      }

      const result = (rpc.result && typeof rpc.result === 'object' ? rpc.result : {}) as {
        content?: unknown;
        structuredContent?: unknown;
        isError?: unknown;
      };

      const parts: string[] = [];
      if (Array.isArray(result.content)) {
        for (const block of result.content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            parts.push(b.text);
          } else if (typeof b.type === 'string') {
            parts.push(JSON.stringify(b));
          }
        }
      }
      if (result.structuredContent !== undefined) {
        const structuredText =
          typeof result.structuredContent === 'string'
            ? result.structuredContent
            : JSON.stringify(result.structuredContent);
        if (parts.length === 0) {
          parts.push(structuredText);
        } else {
          parts.push(structuredText);
        }
      }

      const rawContent = parts.join('\n');
      const truncated = truncateUtf8(rawContent, config.maxResultBytes);
      return {
        content: truncated.text,
        isError: result.isError === true,
        bytes: truncated.bytes,
        truncated: truncated.truncated,
      };
    };

    try {
      return await invoke(session);
    } catch (err) {
      if (
        retryOn404 &&
        err instanceof McpTransportError &&
        err.code === 'http' &&
        err.status === 404
      ) {
        const refreshed = await performInitialize(
          config,
          deadline.signal,
          deadline.isDeadlineExpired,
          opts,
        );
        Object.assign(session, refreshed);
        return await invoke(refreshed);
      }

      if (
        !retryOn404 &&
        err instanceof McpTransportError &&
        (err.code === 'timeout' ||
          (err.code === 'http' && (err.status === 404 || err.status === 502 || err.status === undefined)))
      ) {
        throw new McpTransportError(err.code, err.message, err.status, true);
      }
      throw err;
    }
  } finally {
    release?.();
    deadline.cleanup();
  }
}
