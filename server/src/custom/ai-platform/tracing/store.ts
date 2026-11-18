import {
  DEFAULT_AI_PLATFORM_RETENTION,
  type Scope,
  type ScopeKind,
  type Wire,
} from '@freellmapi/shared/ai-platform.js';
import {
  TRACING_LIMITS,
  type TraceAttributeValue,
  type TraceRecord,
  type TraceSpanNode,
  type TraceStatus,
  type TraceSummary,
  type TracesListResponse,
} from '@freellmapi/shared/ai-platform-tracing-oauth.js';
import { getDb } from '../../../db/index.js';
import { maskText } from '../masking.js';
import { sanitizeMcpText } from '../mcp-client/sanitize.js';
import { normalizeScope } from '../scope.js';

const RETENTION_KEY = 'ai_platform_retention_v1';
const MAINTENANCE_INTERVAL_MS = 60_000;
let lastPrunedAtMs = 0;

const SENSITIVE_ATTR_KEY_RE =
  /(?:secret|password|passwd|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer|credential|ciphertext|code[_-]?verifier|private[_-]?key|session[_-]?token)/i;

const SAFE_TOKEN_COUNT_KEYS = new Set([
  'prompttokens',
  'completiontokens',
  'cachedtokens',
  'totaltokens',
  'maxtokens',
  'maxoutputtokens',
  'tokencap',
  'inputtokens',
  'outputtokens',
  'estimatedtokens',
  'savedtokens',
]);

interface TraceRow {
  trace_id: string;
  request_id: string;
  thread_id: string | null;
  trace_source: string;
  scope_kind: ScopeKind;
  scope_id: string;
  end_user: string | null;
  wire: Wire;
  requested_model: string;
  served_model: string | null;
  status: TraceStatus;
  duration_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  spans_count: number;
  error_summary: string | null;
  spans_json: string;
  started_at: string;
  finished_at: string;
  created_at: string;
}

export interface ListTracesFilter {
  scope?: Scope;
  status?: TraceStatus;
  model?: string;
  threadId?: string;
  search?: string;
  before?: string;
  limit?: number;
}

function hasTracesTable(): boolean {
  try {
    return Boolean(
      getDb()
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_ai_request_traces'")
        .get(),
    );
  } catch {
    return false;
  }
}

function isSensitiveAttributeKey(key: string): boolean {
  const normalized = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (SAFE_TOKEN_COUNT_KEYS.has(normalized)) return false;
  if (SENSITIVE_ATTR_KEY_RE.test(key)) return true;
  if (/token/i.test(key) && !SAFE_TOKEN_COUNT_KEYS.has(normalized)) return true;
  return false;
}

export function redactTraceString(
  scope: Scope,
  value: string,
  maxChars: number = TRACING_LIMITS.maxAttributeStringChars,
): string {
  const scrubbed = sanitizeMcpText(value);
  let masked = scrubbed;
  try {
    masked = maskText(scope, scrubbed);
  } catch {
    masked = scrubbed;
  }
  if (masked.length <= maxChars) return masked;
  return `${masked.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function redactTraceAttributes(
  scope: Scope,
  raw: Record<string, unknown> | undefined,
): Record<string, TraceAttributeValue> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, TraceAttributeValue> = {};
  const entries = Object.entries(raw);
  let count = 0;
  for (const [key, val] of entries) {
    if (count >= TRACING_LIMITS.maxAttributesPerSpan) break;
    const cleanKey = String(key).trim().slice(0, 64);
    if (!cleanKey) continue;
    count += 1;

    if (isSensitiveAttributeKey(cleanKey)) {
      out[cleanKey] = '[REDACTED]';
      continue;
    }

    if (val === null || val === undefined) {
      out[cleanKey] = null;
    } else if (typeof val === 'boolean') {
      out[cleanKey] = val;
    } else if (typeof val === 'number') {
      out[cleanKey] = Number.isFinite(val) ? val : null;
    } else if (typeof val === 'string') {
      out[cleanKey] = redactTraceString(scope, val);
    } else {
      try {
        out[cleanKey] = redactTraceString(scope, JSON.stringify(val) ?? '');
      } catch {
        out[cleanKey] = '[Object]';
      }
    }
  }
  return out;
}

function sanitizeSpanTree(scope: Scope, node: TraceSpanNode): TraceSpanNode {
  return {
    id: String(node.id),
    parentId: node.parentId ?? null,
    name: redactTraceString(scope, String(node.name || node.kind), 120),
    kind: node.kind,
    startOffsetMs: Math.max(0, Math.round(node.startOffsetMs || 0)),
    durationMs: Math.max(0, Math.round(node.durationMs || 0)),
    status: node.status,
    ...(node.model != null ? { model: redactTraceString(scope, String(node.model), 120) } : {}),
    ...(typeof node.promptTokens === 'number' ? { promptTokens: Math.max(0, Math.trunc(node.promptTokens)) } : {}),
    ...(typeof node.completionTokens === 'number'
      ? { completionTokens: Math.max(0, Math.trunc(node.completionTokens)) }
      : {}),
    ...(typeof node.cachedTokens === 'number' ? { cachedTokens: Math.max(0, Math.trunc(node.cachedTokens)) } : {}),
    errorSummary: node.errorSummary
      ? redactTraceString(scope, node.errorSummary, TRACING_LIMITS.maxErrorSummaryChars)
      : null,
    attributes: redactTraceAttributes(scope, node.attributes),
    children: Array.isArray(node.children)
      ? node.children.map((child) => sanitizeSpanTree(scope, child))
      : [],
  };
}

function toTraceSummary(row: TraceRow): TraceSummary {
  const promptTokens = Math.max(0, row.prompt_tokens ?? 0);
  const completionTokens = Math.max(0, row.completion_tokens ?? 0);
  const cachedTokens = Math.max(0, row.cached_tokens ?? 0);
  return {
    traceId: row.trace_id,
    requestId: row.request_id,
    threadId: row.thread_id,
    traceSource: row.trace_source,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    endUser: row.end_user,
    wire: row.wire,
    requestedModel: row.requested_model,
    servedModel: row.served_model,
    status: row.status,
    durationMs: Math.max(0, row.duration_ms ?? 0),
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: promptTokens + completionTokens,
    spansCount: Math.max(1, row.spans_count ?? 1),
    errorSummary: row.error_summary,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function fallbackRootSpan(row: TraceRow): TraceSpanNode {
  return {
    id: 'span_root',
    parentId: null,
    name: `${row.wire} ${row.requested_model}`,
    kind: 'request',
    startOffsetMs: 0,
    durationMs: Math.max(0, row.duration_ms ?? 0),
    status: row.status === 'cancelled' ? 'cancelled' : row.status === 'error' ? 'error' : 'ok',
    model: row.served_model ?? row.requested_model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    cachedTokens: row.cached_tokens,
    errorSummary: row.error_summary,
    attributes: {},
    children: [],
  };
}

function toTraceRecord(row: TraceRow): TraceRecord {
  const summary = toTraceSummary(row);
  let rootSpan: TraceSpanNode;
  try {
    const parsed = JSON.parse(row.spans_json) as TraceSpanNode;
    rootSpan = parsed && typeof parsed === 'object' && typeof parsed.id === 'string'
      ? parsed
      : fallbackRootSpan(row);
  } catch {
    rootSpan = fallbackRootSpan(row);
  }
  return {
    ...summary,
    rootSpan,
  };
}

export function getTracesRetentionDays(): number {
  try {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(RETENTION_KEY) as { value?: string } | undefined;
    if (!row?.value) return DEFAULT_AI_PLATFORM_RETENTION.runsDays;
    const parsed = JSON.parse(row.value) as { runsDays?: unknown };
    if (
      typeof parsed?.runsDays === 'number' &&
      Number.isInteger(parsed.runsDays) &&
      parsed.runsDays >= 1 &&
      parsed.runsDays <= 3650
    ) {
      return parsed.runsDays;
    }
    return DEFAULT_AI_PLATFORM_RETENTION.runsDays;
  } catch {
    return DEFAULT_AI_PLATFORM_RETENTION.runsDays;
  }
}

export function pruneExpiredTraces(retentionDays?: number, now: Date = new Date()): number {
  if (!hasTracesTable()) return 0;
  const days =
    retentionDays !== undefined && Number.isFinite(retentionDays)
      ? Math.max(1, Math.min(3650, Math.trunc(retentionDays)))
      : getTracesRetentionDays();
  const cutoffIso = new Date(now.getTime() - days * 86_400_000).toISOString();
  const db = getDb();

  const deletedByAge = db
    .prepare('DELETE FROM custom_ai_request_traces WHERE datetime(started_at) < datetime(?)')
    .run(cutoffIso).changes;

  let deletedByCap = 0;
  const countRow = db
    .prepare('SELECT COUNT(*) AS cnt FROM custom_ai_request_traces')
    .get() as { cnt: number } | undefined;
  const currentCount = Number(countRow?.cnt ?? 0);
  if (currentCount > TRACING_LIMITS.maxRetainedTraces) {
    const excess = currentCount - TRACING_LIMITS.maxRetainedTraces;
    deletedByCap = db
      .prepare(
        `DELETE FROM custom_ai_request_traces
          WHERE trace_id IN (
            SELECT trace_id
              FROM custom_ai_request_traces
             ORDER BY started_at ASC, rowid ASC
             LIMIT ?
          )`,
      )
      .run(excess).changes;
  }

  return deletedByAge + deletedByCap;
}

export function maybePruneTraces(nowMs: number = Date.now()): void {
  if (nowMs - lastPrunedAtMs < MAINTENANCE_INTERVAL_MS) return;
  lastPrunedAtMs = nowMs;
  try {
    pruneExpiredTraces(undefined, new Date(nowMs));
  } catch {
    // Best-effort telemetry pruning
  }
}

export function resetTraceMaintenanceForTests(): void {
  lastPrunedAtMs = 0;
}

export function saveTraceRecord(record: TraceRecord): TraceRecord {
  if (!hasTracesTable()) return record;
  const scope = normalizeScope({ kind: record.scopeKind, id: record.scopeId });
  const sanitizedRoot = sanitizeSpanTree(scope, record.rootSpan);
  const cleanError = record.errorSummary
    ? redactTraceString(scope, record.errorSummary, TRACING_LIMITS.maxErrorSummaryChars)
    : null;

  const db = getDb();
  let effectiveTraceId = record.traceId;
  const existingOwner = db
    .prepare('SELECT scope_kind, scope_id FROM custom_ai_request_traces WHERE trace_id = ?')
    .get(effectiveTraceId) as { scope_kind: ScopeKind; scope_id: string } | undefined;

  if (existingOwner && (existingOwner.scope_kind !== scope.kind || existingOwner.scope_id !== scope.id)) {
    effectiveTraceId = `${effectiveTraceId.slice(0, 96)}:${scope.kind}:${scope.id}`;
  }

  const spansJson = JSON.stringify(sanitizedRoot);
  db.prepare(
    `INSERT INTO custom_ai_request_traces (
      trace_id, request_id, thread_id, trace_source,
      scope_kind, scope_id, end_user, wire,
      requested_model, served_model, status,
      duration_ms, prompt_tokens, completion_tokens, cached_tokens,
      spans_count, error_summary, spans_json,
      started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(trace_id) DO UPDATE SET
      request_id = excluded.request_id,
      thread_id = COALESCE(excluded.thread_id, custom_ai_request_traces.thread_id),
      served_model = COALESCE(excluded.served_model, custom_ai_request_traces.served_model),
      status = excluded.status,
      duration_ms = excluded.duration_ms,
      prompt_tokens = excluded.prompt_tokens,
      completion_tokens = excluded.completion_tokens,
      cached_tokens = excluded.cached_tokens,
      spans_count = excluded.spans_count,
      error_summary = excluded.error_summary,
      spans_json = excluded.spans_json,
      finished_at = excluded.finished_at`,
  ).run(
    effectiveTraceId,
    record.requestId,
    record.threadId,
    record.traceSource,
    scope.kind,
    scope.id,
    record.endUser ? redactTraceString(scope, record.endUser, 128) : null,
    record.wire,
    redactTraceString(scope, record.requestedModel, 128),
    record.servedModel ? redactTraceString(scope, record.servedModel, 128) : null,
    record.status,
    Math.max(0, Math.round(record.durationMs)),
    Math.max(0, Math.trunc(record.promptTokens)),
    Math.max(0, Math.trunc(record.completionTokens)),
    Math.max(0, Math.trunc(record.cachedTokens)),
    Math.max(1, Math.trunc(record.spansCount)),
    cleanError,
    spansJson,
    record.startedAt,
    record.finishedAt,
  );

  maybePruneTraces();
  return {
    ...record,
    traceId: effectiveTraceId,
    scopeKind: scope.kind,
    scopeId: scope.id,
    errorSummary: cleanError,
    rootSpan: sanitizedRoot,
  };
}

export function getTraceById(traceId: string, scope?: Scope): TraceRecord | null {
  if (!hasTracesTable()) return null;
  const trimmed = String(traceId ?? '').trim();
  if (!trimmed) return null;

  const db = getDb();
  let row: TraceRow | undefined;
  if (scope) {
    const norm = normalizeScope(scope);
    row = db
      .prepare(
        `SELECT * FROM custom_ai_request_traces
          WHERE trace_id = ? AND scope_kind = ? AND scope_id = ?`,
      )
      .get(trimmed, norm.kind, norm.id) as TraceRow | undefined;
  } else {
    row = db
      .prepare('SELECT * FROM custom_ai_request_traces WHERE trace_id = ?')
      .get(trimmed) as TraceRow | undefined;
  }
  return row ? toTraceRecord(row) : null;
}

export function listTraces(filter: ListTracesFilter = {}): TracesListResponse {
  if (!hasTracesTable()) return { traces: [], nextBefore: null };
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.scope) {
    const norm = normalizeScope(filter.scope);
    clauses.push('scope_kind = ? AND scope_id = ?');
    params.push(norm.kind, norm.id);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.model && filter.model.trim()) {
    const m = `%${filter.model.trim()}%`;
    clauses.push('(requested_model LIKE ? OR served_model LIKE ?)');
    params.push(m, m);
  }
  if (filter.threadId && filter.threadId.trim()) {
    clauses.push('thread_id = ?');
    params.push(filter.threadId.trim());
  }
  if (filter.search && filter.search.trim()) {
    const q = `%${filter.search.trim()}%`;
    clauses.push('(trace_id LIKE ? OR request_id LIKE ? OR requested_model LIKE ? OR COALESCE(served_model, \'\') LIKE ?)');
    params.push(q, q, q, q);
  }
  if (filter.before && filter.before.trim()) {
    clauses.push('started_at < ?');
    params.push(filter.before.trim());
  }

  const rawLimit = filter.limit ?? TRACING_LIMITS.defaultListLimit;
  const limit = Math.max(1, Math.min(TRACING_LIMITS.maxListLimit, Math.trunc(rawLimit)));
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT *
         FROM custom_ai_request_traces
         ${whereSql}
        ORDER BY started_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(...params, limit + 1) as TraceRow[];

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const nextBefore = hasMore && slice.length > 0 ? slice[slice.length - 1]!.started_at : null;

  return {
    traces: slice.map(toTraceSummary),
    nextBefore,
  };
}

export function deleteTraces(filter?: { scope?: Scope; before?: string }): number {
  if (!hasTracesTable()) return 0;
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter?.scope) {
    const norm = normalizeScope(filter.scope);
    clauses.push('scope_kind = ? AND scope_id = ?');
    params.push(norm.kind, norm.id);
  }
  if (filter?.before && filter.before.trim()) {
    clauses.push('datetime(started_at) < datetime(?)');
    params.push(filter.before.trim());
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const res = db.prepare(`DELETE FROM custom_ai_request_traces ${whereSql}`).run(...params);
  return res.changes;
}
