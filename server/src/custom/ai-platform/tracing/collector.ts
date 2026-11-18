import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Scope, Wire } from '@freellmapi/shared/ai-platform.js';
import {
  TRACING_LIMITS,
  type TraceAttributeValue,
  type TraceRecord,
  type TraceSpanKind,
  type TraceSpanNode,
  type TraceSpanStatus,
  type TraceStatus,
} from '@freellmapi/shared/ai-platform-tracing-oauth.js';
import {
  registerAttemptTraceObserver,
  type AttemptTraceRecord,
} from '../../../lib/attempt-trace.js';
import { isInternalCall } from '../loopback.js';
import { normalizeScope } from '../scope.js';
import { redactTraceAttributes, redactTraceString, saveTraceRecord } from './store.js';

export interface InboundTraceIdentity {
  traceId: string;
  requestId: string;
  threadId: string | null;
  traceSource: string;
  explicit: boolean;
}

interface MutableSpan {
  id: string;
  parentId: string | null;
  name: string;
  kind: TraceSpanKind;
  startedAtMs: number;
  startOffsetMs: number;
  durationMs: number;
  status: TraceSpanStatus;
  model?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  errorSummary?: string | null;
  attributes: Record<string, TraceAttributeValue>;
  closed: boolean;
}

export interface ActiveTraceCollector {
  readonly traceId: string;
  readonly requestId: string;
  readonly threadId: string | null;
  readonly traceSource: string;
  readonly scope: Scope;
  readonly endUser: string | null;
  readonly wire: Wire;
  readonly requestedModel: string;
  readonly startedAtMs: number;
  readonly startedAtIso: string;
  readonly rootSpanId: string;
  servedModel: string | null;
  status: TraceStatus;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  errorSummary: string | null;
  spans: Map<string, MutableSpan>;
  finalized: boolean;
  finalize(override?: {
    status?: TraceStatus;
    servedModel?: string | null;
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    errorSummary?: string | null;
  }): TraceRecord | null;
}

interface TraceExecutionContext {
  collector: ActiveTraceCollector;
  activeSpanId: string;
}

const traceStorage = new AsyncLocalStorage<TraceExecutionContext>();
const inFlightCollectors = new Map<string, { collector: ActiveTraceCollector; expiresAtMs: number }>();

const SAFE_ID_CHARS_RE = /[^a-zA-Z0-9._:-]/g;
const IN_FLIGHT_TTL_MS = 10 * 60_000;

function firstHeader(headers: Request['headers'], name: string): string | undefined {
  const raw = headers[name.toLowerCase()];
  const val = Array.isArray(raw) ? raw[0] : raw;
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}

export function sanitizeTraceIdentifier(raw: string, maxLen = 128): string {
  const cleaned = raw.trim().replace(SAFE_ID_CHARS_RE, '_').slice(0, maxLen);
  return cleaned;
}

function parseSentryTraceId(raw: string): string | null {
  // Format: <32-hex-trace-id>-<16-hex-span-id>(-<sampled>)?
  const trimmed = raw.trim();
  const dashIdx = trimmed.indexOf('-');
  const candidate = dashIdx > 0 ? trimmed.slice(0, dashIdx) : trimmed;
  const clean = sanitizeTraceIdentifier(candidate, 64);
  return clean.length >= 8 ? clean : null;
}

function parseW3cTraceparent(raw: string): string | null {
  // Format: 00-<32hex>-<16hex>-<2hex>
  const parts = raw.trim().split('-');
  if (parts.length >= 2 && /^[0-9a-fA-F]{16,64}$/.test(parts[1]!)) {
    return parts[1]!.toLowerCase();
  }
  return null;
}

function tryExtractClaudeCodeSession(req: Request): string | null {
  if (req.method !== 'POST') return null;
  const path = (req.originalUrl || req.url || req.path || '').split('?')[0] ?? '';
  if (!path.endsWith('/messages')) return null;
  if (!req.body || typeof req.body !== 'object') return null;

  const metadata = (req.body as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const userId = (metadata as { user_id?: unknown }).user_id;
  if (typeof userId !== 'string' || !userId.trim()) return null;

  const trimmed = userId.trim();
  // Claude Code user_id format: user_<hash>_account_<uuid>_session_<uuid>
  const sessionMatch = /(?:^|_)session_([a-zA-Z0-9-]{6,64})(?:$|_)/.exec(trimmed);
  if (sessionMatch?.[1]) {
    return sanitizeTraceIdentifier(`cc-${sessionMatch[1]}`, 96);
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { session_id?: unknown };
      if (typeof parsed.session_id === 'string' && parsed.session_id.trim()) {
        return sanitizeTraceIdentifier(`cc-${parsed.session_id.trim()}`, 96);
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Extracts traceId, threadId, and requestId from standard & coding-agent headers/payloads
 * (AxonHub tracing parity: X-FreeLLM-Trace-Id, AH-Trace-Id, Trace-Id, X-Trace-Id, Sentry-Trace,
 * W3C traceparent, OpenCode, Codex, and Claude Code metadata.user_id).
 */
export function extractInboundTraceIdentity(req: Request): InboundTraceIdentity {
  const headers = req.headers ?? {};

  let traceId = '';
  let traceSource = 'generated';
  let explicit = false;

  const primaryCandidates: Array<[string, string]> = [
    ['x-freellm-trace-id', 'x-freellm-trace-id'],
    ['ah-trace-id', 'ah-trace-id'],
    ['trace-id', 'trace-id'],
    ['x-trace-id', 'x-trace-id'],
  ];

  for (const [headerName, source] of primaryCandidates) {
    const val = firstHeader(headers, headerName);
    if (val) {
      const clean = sanitizeTraceIdentifier(val);
      if (clean) {
        traceId = clean;
        traceSource = source;
        explicit = true;
        break;
      }
    }
  }

  if (!traceId) {
    const sentry = firstHeader(headers, 'sentry-trace');
    const parsed = sentry ? parseSentryTraceId(sentry) : null;
    if (parsed) {
      traceId = parsed;
      traceSource = 'sentry-trace';
      explicit = true;
    }
  }

  if (!traceId) {
    const traceparent = firstHeader(headers, 'traceparent');
    const parsed = traceparent ? parseW3cTraceparent(traceparent) : null;
    if (parsed) {
      traceId = parsed;
      traceSource = 'traceparent';
      explicit = true;
    }
  }

  if (!traceId) {
    const openCodeVal =
      firstHeader(headers, 'x-opencode-trace-id') ??
      firstHeader(headers, 'x-opencode-session') ??
      firstHeader(headers, 'opencode-session-id');
    if (openCodeVal) {
      const clean = sanitizeTraceIdentifier(openCodeVal);
      if (clean) {
        traceId = clean;
        traceSource = 'opencode';
        explicit = true;
      }
    }
  }

  if (!traceId) {
    const claudeSession = tryExtractClaudeCodeSession(req);
    if (claudeSession) {
      traceId = claudeSession;
      traceSource = 'claude-code';
      explicit = true;
    }
  }

  if (!traceId) {
    const codexVal =
      firstHeader(headers, 'x-codex-turn-id') ??
      firstHeader(headers, 'x-codex-session-id') ??
      firstHeader(headers, 'codex-session-id') ??
      firstHeader(headers, 'session_id');
    if (codexVal) {
      const clean = sanitizeTraceIdentifier(codexVal);
      if (clean) {
        traceId = clean;
        traceSource = 'codex';
        explicit = true;
      }
    }
  }

  if (!traceId) {
    traceId = `at-${crypto.randomUUID()}`;
    traceSource = 'generated';
  }

  const rawThread =
    firstHeader(headers, 'x-freellm-thread-id') ??
    firstHeader(headers, 'ah-thread-id') ??
    firstHeader(headers, 'x-thread-id') ??
    firstHeader(headers, 'x-conversation-id') ??
    firstHeader(headers, 'x-opencode-session') ??
    firstHeader(headers, 'x-codex-session-id') ??
    firstHeader(headers, 'session_id');
  const threadId = rawThread ? sanitizeTraceIdentifier(rawThread) || null : null;

  const rawReqId =
    firstHeader(headers, 'x-freellm-request-id') ??
    firstHeader(headers, 'ah-request-id') ??
    firstHeader(headers, 'x-request-id');
  const requestId =
    (rawReqId ? sanitizeTraceIdentifier(rawReqId) : '') || `ar-${crypto.randomUUID()}`;

  return {
    traceId,
    requestId,
    threadId,
    traceSource,
    explicit,
  };
}

function sweepExpiredInFlight(nowMs: number): void {
  if (inFlightCollectors.size < 64) return;
  for (const [id, entry] of inFlightCollectors) {
    if (entry.expiresAtMs <= nowMs || entry.collector.finalized) {
      inFlightCollectors.delete(id);
    }
  }
}

function buildSpanTree(collector: ActiveTraceCollector, finishedAtMs: number): TraceSpanNode {
  const nodesById = new Map<string, TraceSpanNode>();
  for (const span of collector.spans.values()) {
    const durationMs = span.closed
      ? span.durationMs
      : Math.max(0, finishedAtMs - span.startedAtMs);
    nodesById.set(span.id, {
      id: span.id,
      parentId: span.parentId,
      name: span.name,
      kind: span.kind,
      startOffsetMs: Math.max(0, span.startOffsetMs),
      durationMs: Math.max(0, durationMs),
      status: span.status,
      ...(span.model !== undefined ? { model: span.model } : {}),
      ...(span.promptTokens !== undefined ? { promptTokens: span.promptTokens } : {}),
      ...(span.completionTokens !== undefined ? { completionTokens: span.completionTokens } : {}),
      ...(span.cachedTokens !== undefined ? { cachedTokens: span.cachedTokens } : {}),
      errorSummary: span.errorSummary ?? null,
      attributes: { ...span.attributes },
      children: [],
    });
  }

  const rootNode = nodesById.get(collector.rootSpanId)!;
  for (const node of nodesById.values()) {
    if (node.id === collector.rootSpanId) continue;
    const parent = (node.parentId ? nodesById.get(node.parentId) : undefined) ?? rootNode;
    parent.children.push(node);
  }

  const sortChildren = (node: TraceSpanNode) => {
    node.children.sort((a, b) => a.startOffsetMs - b.startOffsetMs);
    for (const child of node.children) {
      sortChildren(child);
    }
  };
  sortChildren(rootNode);

  return rootNode;
}

export interface StartRequestTraceOptions {
  req: Request;
  res?: Response;
  scope: Scope;
  endUser: string | null;
  wire: Wire;
  requestedModel: string;
}

export function createRequestTraceCollector(opts: StartRequestTraceOptions): ActiveTraceCollector {
  const nowMs = Date.now();
  sweepExpiredInFlight(nowMs);
  const normScope = normalizeScope(opts.scope);
  const identity = extractInboundTraceIdentity(opts.req);

  // Ensure unique traceId per distinct request if an in-flight collector already uses the same ID
  // or if caller reused a thread-like session ID across multiple turns.
  let traceId = identity.traceId;
  if (inFlightCollectors.has(traceId)) {
    traceId = `${traceId.slice(0, 96)}-${crypto.randomBytes(4).toString('hex')}`;
  }

  const rootSpanId = 'span_root';
  const startedAtIso = new Date(nowMs).toISOString();
  const spans = new Map<string, MutableSpan>();

  const rootSpan: MutableSpan = {
    id: rootSpanId,
    parentId: null,
    name: `${opts.wire} ${opts.requestedModel || 'auto'}`,
    kind: 'request',
    startedAtMs: nowMs,
    startOffsetMs: 0,
    durationMs: 0,
    status: 'ok',
    model: opts.requestedModel || 'auto',
    errorSummary: null,
    attributes: redactTraceAttributes(normScope, {
      wire: opts.wire,
      traceSource: identity.traceSource,
      requestId: identity.requestId,
      ...(identity.threadId ? { threadId: identity.threadId } : {}),
    }),
    closed: false,
  };
  spans.set(rootSpanId, rootSpan);

  const collector: ActiveTraceCollector = {
    traceId,
    requestId: identity.requestId,
    threadId: identity.threadId,
    traceSource: identity.traceSource,
    scope: normScope,
    endUser: opts.endUser,
    wire: opts.wire,
    requestedModel: opts.requestedModel || 'auto',
    startedAtMs: nowMs,
    startedAtIso,
    rootSpanId,
    servedModel: null,
    status: 'ok',
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    errorSummary: null,
    spans,
    finalized: false,
    finalize(override) {
      if (collector.finalized) return null;
      collector.finalized = true;
      inFlightCollectors.delete(collector.traceId);

      const finishedAtMs = Date.now();
      const totalDurationMs = Math.max(0, finishedAtMs - collector.startedAtMs);

      if (override?.status) collector.status = override.status;
      if (override?.servedModel !== undefined) collector.servedModel = override.servedModel;
      if (override?.promptTokens !== undefined) collector.promptTokens = override.promptTokens;
      if (override?.completionTokens !== undefined) collector.completionTokens = override.completionTokens;
      if (override?.cachedTokens !== undefined) collector.cachedTokens = override.cachedTokens;
      if (override?.errorSummary !== undefined) collector.errorSummary = override.errorSummary;

      rootSpan.durationMs = totalDurationMs;
      rootSpan.closed = true;
      rootSpan.model = collector.servedModel ?? collector.requestedModel;
      rootSpan.promptTokens = collector.promptTokens;
      rootSpan.completionTokens = collector.completionTokens;
      rootSpan.cachedTokens = collector.cachedTokens;
      rootSpan.status =
        collector.status === 'error'
          ? 'error'
          : collector.status === 'cancelled'
            ? 'cancelled'
            : collector.status === 'awaiting_approval'
              ? 'awaiting_approval'
              : 'ok';
      rootSpan.errorSummary = collector.errorSummary;

      const rootNode = buildSpanTree(collector, finishedAtMs);
      const record: TraceRecord = {
        traceId: collector.traceId,
        requestId: collector.requestId,
        threadId: collector.threadId,
        traceSource: collector.traceSource,
        scopeKind: collector.scope.kind,
        scopeId: collector.scope.id,
        endUser: collector.endUser,
        wire: collector.wire,
        requestedModel: collector.requestedModel,
        servedModel: collector.servedModel,
        status: collector.status,
        durationMs: totalDurationMs,
        promptTokens: collector.promptTokens,
        completionTokens: collector.completionTokens,
        cachedTokens: collector.cachedTokens,
        totalTokens: collector.promptTokens + collector.completionTokens,
        spansCount: collector.spans.size,
        errorSummary: collector.errorSummary,
        startedAt: collector.startedAtIso,
        finishedAt: new Date(finishedAtMs).toISOString(),
        rootSpan: rootNode,
      };

      try {
        return saveTraceRecord(record);
      } catch {
        return record;
      }
    },
  };

  inFlightCollectors.set(traceId, {
    collector,
    expiresAtMs: nowMs + IN_FLIGHT_TTL_MS,
  });

  if (opts.res) {
    const res = opts.res;
    if (!res.headersSent) {
      res.setHeader('X-FreeLLM-Trace-Id', traceId);
    }
    const onDone = () => {
      res.off('finish', onDone);
      res.off('close', onDone);
      if (!collector.finalized) {
        const statusCode = res.statusCode ?? 200;
        let inferredStatus: TraceStatus = collector.status;
        if (inferredStatus === 'ok') {
          if (!res.writableFinished) {
            inferredStatus = 'cancelled';
          } else if (statusCode >= 400) {
            inferredStatus = 'error';
          }
        }
        collector.finalize({ status: inferredStatus });
      }
    };
    res.once('finish', onDone);
    res.once('close', onDone);
  }

  return collector;
}

export function runWithTraceCollector<T>(
  collector: ActiveTraceCollector,
  fn: () => T,
  parentSpanId?: string,
): T {
  const spanId =
    parentSpanId && collector.spans.has(parentSpanId) ? parentSpanId : collector.rootSpanId;
  return traceStorage.run({ collector, activeSpanId: spanId }, fn);
}

export function getActiveTraceCollector(): ActiveTraceCollector | undefined {
  return traceStorage.getStore()?.collector;
}

export function getActiveSpanId(): string | undefined {
  return traceStorage.getStore()?.activeSpanId;
}

export interface SpanHandle {
  readonly id: string;
  setAttributes(attrs: Record<string, unknown>): void;
  setTokens(usage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number; model?: string | null }): void;
  end(outcome?: { status?: TraceSpanStatus; errorSummary?: string | null; attributes?: Record<string, unknown> }): void;
}

export function startChildSpan(
  kind: TraceSpanKind,
  name: string,
  initialAttributes?: Record<string, unknown>,
): SpanHandle | null {
  const store = traceStorage.getStore();
  if (!store || store.collector.finalized) return null;
  if (store.collector.spans.size >= TRACING_LIMITS.maxSpansPerTrace) return null;

  const { collector, activeSpanId } = store;
  const nowMs = Date.now();
  const id = `span_${collector.spans.size}_${crypto.randomBytes(4).toString('hex')}`;
  const span: MutableSpan = {
    id,
    parentId: activeSpanId,
    name: redactTraceString(collector.scope, name, 120),
    kind,
    startedAtMs: nowMs,
    startOffsetMs: Math.max(0, nowMs - collector.startedAtMs),
    durationMs: 0,
    status: 'ok',
    attributes: redactTraceAttributes(collector.scope, initialAttributes),
    closed: false,
  };
  collector.spans.set(id, span);

  return {
    id,
    setAttributes(attrs) {
      const clean = redactTraceAttributes(collector.scope, attrs);
      Object.assign(span.attributes, clean);
    },
    setTokens(usage) {
      if (usage.model !== undefined) span.model = usage.model;
      if (typeof usage.promptTokens === 'number') span.promptTokens = Math.max(0, Math.trunc(usage.promptTokens));
      if (typeof usage.completionTokens === 'number') {
        span.completionTokens = Math.max(0, Math.trunc(usage.completionTokens));
      }
      if (typeof usage.cachedTokens === 'number') span.cachedTokens = Math.max(0, Math.trunc(usage.cachedTokens));
    },
    end(outcome) {
      if (span.closed) return;
      span.closed = true;
      span.durationMs = Math.max(0, Date.now() - span.startedAtMs);
      if (outcome?.status) span.status = outcome.status;
      if (outcome?.errorSummary) {
        span.errorSummary = redactTraceString(
          collector.scope,
          outcome.errorSummary,
          TRACING_LIMITS.maxErrorSummaryChars,
        );
      }
      if (outcome?.attributes) {
        Object.assign(span.attributes, redactTraceAttributes(collector.scope, outcome.attributes));
      }
    },
  };
}

export async function runWithSpan<T>(
  kind: TraceSpanKind,
  name: string,
  initialAttributes: Record<string, unknown> | undefined,
  fn: (span: SpanHandle | null) => Promise<T> | T,
): Promise<T> {
  const store = traceStorage.getStore();
  if (!store || store.collector.finalized) {
    return await fn(null);
  }
  const handle = startChildSpan(kind, name, initialAttributes);
  if (!handle) {
    return await fn(null);
  }
  try {
    const result = await traceStorage.run(
      { collector: store.collector, activeSpanId: handle.id },
      () => fn(handle),
    );
    handle.end();
    return result;
  } catch (err) {
    handle.end({
      status: 'error',
      errorSummary: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function recordCompletedSpan(params: {
  kind: TraceSpanKind;
  name: string;
  startOffsetMs?: number;
  durationMs: number;
  status?: TraceSpanStatus;
  model?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  errorSummary?: string | null;
  attributes?: Record<string, unknown>;
  parentSpanId?: string;
}): string | null {
  const store = traceStorage.getStore();
  if (!store || store.collector.finalized) return null;
  if (store.collector.spans.size >= TRACING_LIMITS.maxSpansPerTrace) return null;

  const { collector, activeSpanId } = store;
  const nowMs = Date.now();
  const durationMs = Math.max(0, Math.round(params.durationMs));
  const startOffsetMs =
    typeof params.startOffsetMs === 'number' && Number.isFinite(params.startOffsetMs)
      ? Math.max(0, Math.round(params.startOffsetMs))
      : Math.max(0, nowMs - durationMs - collector.startedAtMs);

  const parentId =
    params.parentSpanId && collector.spans.has(params.parentSpanId)
      ? params.parentSpanId
      : activeSpanId;

  const id = `span_${collector.spans.size}_${crypto.randomBytes(4).toString('hex')}`;
  const span: MutableSpan = {
    id,
    parentId,
    name: redactTraceString(collector.scope, params.name, 120),
    kind: params.kind,
    startedAtMs: collector.startedAtMs + startOffsetMs,
    startOffsetMs,
    durationMs,
    status: params.status ?? 'ok',
    ...(params.model !== undefined ? { model: params.model } : {}),
    ...(params.promptTokens !== undefined ? { promptTokens: params.promptTokens } : {}),
    ...(params.completionTokens !== undefined ? { completionTokens: params.completionTokens } : {}),
    ...(params.cachedTokens !== undefined ? { cachedTokens: params.cachedTokens } : {}),
    errorSummary: params.errorSummary
      ? redactTraceString(collector.scope, params.errorSummary, TRACING_LIMITS.maxErrorSummaryChars)
      : null,
    attributes: redactTraceAttributes(collector.scope, params.attributes),
    closed: true,
  };
  collector.spans.set(id, span);
  return id;
}

/**
 * Bridges per-attempt failover records from `server/src/lib/attempt-trace.ts`
 * into `upstream_attempt` child spans on the active AI Platform hierarchical trace.
 */
export function bridgeAttemptTraceRecords(
  records: readonly AttemptTraceRecord[],
  loopStartedAtMs?: number,
): void {
  const store = traceStorage.getStore();
  if (!store || store.collector.finalized || records.length === 0) return;

  const { collector } = store;
  const baseOffsetMs =
    typeof loopStartedAtMs === 'number' && Number.isFinite(loopStartedAtMs)
      ? Math.max(0, loopStartedAtMs - collector.startedAtMs)
      : Math.max(0, Date.now() - collector.startedAtMs - (records[records.length - 1]?.durationMs ?? 0));

  for (const rec of records) {
    const status: TraceSpanStatus =
      rec.outcome === 'ok' || rec.outcome === 'committed'
        ? 'ok'
        : rec.outcome === 'client_abort'
          ? 'cancelled'
          : 'error';
    const modelLabel = `${rec.platform}/${rec.modelId}`;
    if (status === 'ok') {
      collector.servedModel = modelLabel;
    }
    recordCompletedSpan({
      kind: 'upstream_attempt',
      name: `${rec.platform}/${rec.modelId} (#${rec.ordinal + 1})`,
      startOffsetMs: baseOffsetMs + Math.max(0, rec.startOffsetMs),
      durationMs: Math.max(0, rec.durationMs),
      status,
      model: modelLabel,
      errorSummary: rec.errorSummary,
      attributes: {
        ordinal: rec.ordinal,
        platform: rec.platform,
        modelId: rec.modelId,
        keyOrdinal: rec.keyOrdinal,
        keyLabel: rec.keyLabel,
        outcome: rec.outcome,
      },
    });
  }
}

export function noteTraceUsage(usage: {
  servedModel?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
}): void {
  const collector = traceStorage.getStore()?.collector;
  if (!collector || collector.finalized) return;
  if (usage.servedModel) collector.servedModel = usage.servedModel;
  if (typeof usage.promptTokens === 'number' && usage.promptTokens > 0) {
    collector.promptTokens += Math.trunc(usage.promptTokens);
  }
  if (typeof usage.completionTokens === 'number' && usage.completionTokens > 0) {
    collector.completionTokens += Math.trunc(usage.completionTokens);
  }
  if (typeof usage.cachedTokens === 'number' && usage.cachedTokens > 0) {
    collector.cachedTokens += Math.trunc(usage.cachedTokens);
  }
}

export function noteTraceOutcome(outcome: {
  status: TraceStatus;
  errorSummary?: string | null;
  servedModel?: string | null;
}): void {
  const collector = traceStorage.getStore()?.collector;
  if (!collector || collector.finalized) return;
  collector.status = outcome.status;
  if (outcome.servedModel) collector.servedModel = outcome.servedModel;
  if (outcome.errorSummary) {
    collector.errorSummary = redactTraceString(
      collector.scope,
      outcome.errorSummary,
      TRACING_LIMITS.maxErrorSummaryChars,
    );
  }
}

export function getLoopbackTraceHeaders(): Record<string, string> {
  const store = traceStorage.getStore();
  if (!store || store.collector.finalized) return {};
  return {
    [TRACING_LIMITS.traceHeaderName]: store.collector.traceId,
    [TRACING_LIMITS.parentSpanHeaderName]: store.activeSpanId,
  };
}

/**
 * Re-attaches an authenticated internal loopback subcall (`isInternalCall(req) !== null`)
 * to its parent in-flight `ActiveTraceCollector` so inner prompt renders and upstream
 * provider failover hops nest cleanly under the calling MCP/orchestrator span.
 */
export function runWithLoopbackTraceIfInternal<T>(req: Request, fn: () => T): T {
  if (isInternalCall(req) === null) {
    return fn();
  }
  const traceId = firstHeader(req.headers, TRACING_LIMITS.traceHeaderName);
  if (!traceId) {
    return fn();
  }
  const entry = inFlightCollectors.get(traceId);
  if (!entry || entry.collector.finalized) {
    return fn();
  }
  const parentSpanId = firstHeader(req.headers, TRACING_LIMITS.parentSpanHeaderName);
  return runWithTraceCollector(entry.collector, fn, parentSpanId);
}

registerAttemptTraceObserver((records, startedAtMs) => {
  bridgeAttemptTraceRecords(records, startedAtMs);
});
