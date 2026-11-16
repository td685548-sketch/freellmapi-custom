import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { getDb } from '../../db/index.js';

const ERROR_WINDOW_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const RECENT_REQUESTS_LIMIT = 20;

export interface ActiveUsageRequest {
  id: string;
  provider: string;
  model: string;
  startedAt: string;
}

export interface RecentUsageRequest {
  id: number;
  provider: string;
  model: string;
  status: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  errorMessage: string | null;
  fromPlayground: boolean;
  timestamp: string;
}

export interface UsageStreamSnapshot {
  activeRequests: ActiveUsageRequest[];
  lastProvider: string;
  errorProvider: string;
  errorModel: string | null;
  errorMessage: string | null;
  recentRequests: RecentUsageRequest[];
}

interface InternalActiveRequest extends ActiveUsageRequest {
  fromPlayground?: boolean;
}

interface ErrorState {
  provider: string;
  model: string;
  message: string;
  timestamp: number;
}

interface UsageStreamState {
  seq: number;
  active: Map<string, InternalActiveRequest>;
  lastProvider: string;
  lastError: ErrorState | null;
  errorClearTimer: NodeJS.Timeout | null;
  emitter: EventEmitter;
}

const globalKey = '__x_gateway_usage_stream_state__';
const g = global as unknown as Record<string, UsageStreamState | undefined>;

if (!g[globalKey]) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  g[globalKey] = {
    seq: 0,
    active: new Map(),
    lastProvider: '',
    lastError: null,
    errorClearTimer: null,
    emitter,
  };
}

const state = g[globalKey]!;

function emitUpdate(): void {
  state.emitter.emit('update');
}

export function beginUsageRequest(provider: string, model: string, fromPlayground = false): string {
  state.seq += 1;
  const id = `req_${Date.now()}_${state.seq}`;
  state.active.set(id, {
    id,
    provider,
    model,
    startedAt: new Date().toISOString(),
    fromPlayground,
  });
  emitUpdate();
  return id;
}

export function cancelUsageRequest(tokenId: string | null | undefined): void {
  if (!tokenId) return;
  if (state.active.delete(tokenId)) {
    emitUpdate();
  }
}

export function endUsageRequest(
  tokenId: string | null | undefined,
  outcome: {
    status: 'success' | 'error';
    provider: string;
    model: string;
    errorMessage?: string | null;
  },
): void {
  if (tokenId) {
    state.active.delete(tokenId);
  }
  state.lastProvider = outcome.provider;

  if (outcome.status === 'error') {
    state.lastError = {
      provider: outcome.provider,
      model: outcome.model,
      message: outcome.errorMessage || 'Request failed',
      timestamp: Date.now(),
    };
    if (state.errorClearTimer) {
      clearTimeout(state.errorClearTimer);
    }
    state.errorClearTimer = setTimeout(() => {
      state.errorClearTimer = null;
      if (state.lastError && Date.now() - state.lastError.timestamp >= ERROR_WINDOW_MS) {
        state.lastError = null;
        emitUpdate();
      }
    }, ERROR_WINDOW_MS + 100);
    if (state.errorClearTimer.unref) state.errorClearTimer.unref();
  }

  emitUpdate();
}

export function queryRecentRequests(limit = RECENT_REQUESTS_LIMIT): RecentUsageRequest[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, platform, model_id AS modelId, status,
            input_tokens AS promptTokens, output_tokens AS completionTokens,
            latency_ms AS latencyMs, error AS errorMessage,
            client_agent AS clientAgent, created_at AS timestamp
       FROM requests
      WHERE caller = 'x-gateway'
      ORDER BY id DESC
      LIMIT ?`,
  ).all(limit) as Array<{
    id: number;
    platform: string;
    modelId: string;
    status: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    errorMessage: string | null;
    clientAgent: string | null;
    timestamp: string;
  }>;

  return rows.map(r => ({
    id: r.id,
    provider: r.platform,
    model: r.modelId,
    status: r.status,
    promptTokens: r.promptTokens ?? 0,
    completionTokens: r.completionTokens ?? 0,
    latencyMs: r.latencyMs ?? 0,
    errorMessage: r.errorMessage ?? null,
    fromPlayground: r.clientAgent === 'playground',
    timestamp: r.timestamp,
  }));
}

export function getUsageStreamSnapshot(): UsageStreamSnapshot {
  const activeError =
    state.lastError && Date.now() - state.lastError.timestamp < ERROR_WINDOW_MS
      ? state.lastError
      : null;
  const recentRequests = queryRecentRequests(RECENT_REQUESTS_LIMIT);
  const lastProvider = state.lastProvider || recentRequests[0]?.provider || '';

  return {
    activeRequests: Array.from(state.active.values()).map(({ id, provider, model, startedAt }) => ({
      id,
      provider,
      model,
      startedAt,
    })),
    lastProvider,
    errorProvider: activeError ? activeError.provider : '',
    errorModel: activeError ? activeError.model : null,
    errorMessage: activeError ? activeError.message : null,
    recentRequests,
  };
}

export function handleUsageStream(req: Request, res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;

  const sendSnapshot = () => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify(getUsageStreamSnapshot())}\n\n`);
    } catch {
      cleanup();
    }
  };

  sendSnapshot();

  state.emitter.on('update', sendSnapshot);

  const heartbeat = setInterval(() => {
    if (closed) {
      clearInterval(heartbeat);
      return;
    }
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, HEARTBEAT_INTERVAL_MS);
  if (heartbeat.unref) heartbeat.unref();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    state.emitter.off('update', sendSnapshot);
    try {
      res.end();
    } catch {
      // already closed
    }
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
}
