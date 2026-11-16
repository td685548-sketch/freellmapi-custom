import crypto from 'node:crypto';
import {
  DEFAULT_AI_PLATFORM_RETENTION,
  type Scope,
  type Wire,
} from '@freellmapi/shared/ai-platform.js';
import {
  FLOW_LIMITS,
  type FlowRunDetailResponse,
  type FlowRunStatus,
  type FlowRunStepView,
  type FlowRunView,
  type FlowStepKind,
  type FlowStepStatus,
  type FlowStopReason,
} from '@freellmapi/shared/ai-platform-orchestrator.js';
import { getDb } from '../../../db/index.js';
import { maskData, maskText } from '../masking.js';

const RETENTION_KEY = 'ai_platform_retention_v1';
const TRUNCATED_MARKER = '\n...[truncated]';

interface FlowRunRow {
  id: string;
  flow_id: number;
  flow_slug: string;
  flow_version: number;
  profile_id: number;
  end_user: string | null;
  wire: Wire;
  status: FlowRunStatus;
  stop_reason: FlowStopReason | null;
  steps: number;
  tool_calls: number;
  handoffs: number;
  prompt_tokens: number;
  completion_tokens: number;
  final_text_masked: string | null;
  error: string | null;
  state_json: string | null;
  is_dry_run: number;
  started_at: string;
  finished_at: string | null;
}

interface FlowRunStepRow {
  run_id: string;
  seq: number;
  kind: FlowStepKind;
  agent_slug: string;
  model: string | null;
  tool_name: string | null;
  input_masked: string;
  output_masked: string;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
  status: FlowStepStatus;
  error: string | null;
  created_at: string;
}

export interface RunCountersInput {
  steps: number;
  toolCalls: number;
  handoffs: number;
  promptTokens: number;
  completionTokens: number;
}

export interface CreateRunRecordInput {
  id?: string;
  flowId: number;
  flowSlug: string;
  flowVersion: number;
  profileId: number;
  endUser: string | null;
  wire: Wire;
  isDryRun?: boolean;
  stateJson?: string | null;
}

export interface AppendRunStepInput {
  runId: string;
  seq?: number;
  kind: FlowStepKind;
  agentSlug: string;
  model?: string | null;
  toolName?: string | null;
  scopeForMasking: Scope;
  input: unknown;
  output: unknown;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  status: FlowStepStatus;
  error?: string | null;
  role?: string;
}

export interface FinishRunRecordParams {
  status: Exclude<FlowRunStatus, 'running' | 'awaiting_approval'>;
  stopReason?: FlowStopReason | null;
  finalText?: string | null;
  error?: string | null;
  scopeForMasking: Scope;
  counters?: RunCountersInput;
  role?: string;
}

export interface ListRunsFilter {
  flowId?: number;
  profileId?: number;
  status?: FlowRunStatus;
  before?: string;
  limit?: number;
}

function nonNegInt(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function truncateUtf8Safe(text: string, maxBytes: number = FLOW_LIMITS.stepLogMaxBytes): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;

  const markerBytes = Buffer.byteLength(TRUNCATED_MARKER, 'utf8');
  const budget = Math.max(0, maxBytes - markerBytes);
  let end = budget;
  // If budget cuts inside a multi-byte UTF-8 sequence, step back to its leading byte so no partial char remains.
  if (end < buf.length && (buf[end]! & 0xc0) === 0x80) {
    while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
      end -= 1;
    }
  }
  let slice = buf.subarray(0, end).toString('utf8');
  while (slice.endsWith('\uFFFD')) {
    slice = slice.slice(0, -1);
  }
  return `${slice}${TRUNCATED_MARKER}`;
}

function normalizeForSerialization(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForSerialization(item, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined && typeof v !== 'function' && typeof v !== 'symbol') {
      out[k] = normalizeForSerialization(v, seen);
    }
  }
  return out;
}

/**
 * Masks sensitive PII/tokens for the given scope and truncates UTF-8 byte length safely
 * to `FLOW_LIMITS.stepLogMaxBytes` (8,192 bytes) without leaving lone replacement characters.
 */
export function maskAndTruncateTrace(scope: Scope, value: unknown, role?: string): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return truncateUtf8Safe(maskText(scope, value, role));
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return truncateUtf8Safe(String(value));
  }
  const normalized = normalizeForSerialization(value);
  const masked = maskData(scope, normalized, role);
  let serialized: string;
  try {
    serialized = JSON.stringify(masked) ?? '';
  } catch {
    serialized = maskText(scope, String(value), role);
  }
  return truncateUtf8Safe(serialized);
}

function toRunView(row: FlowRunRow): FlowRunView {
  return {
    id: row.id,
    flowId: row.flow_id,
    flowSlug: row.flow_slug,
    flowVersion: row.flow_version,
    profileId: row.profile_id,
    endUser: row.end_user,
    wire: row.wire,
    status: row.status,
    stopReason: row.stop_reason,
    steps: row.steps,
    toolCalls: row.tool_calls,
    handoffs: row.handoffs,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.prompt_tokens + row.completion_tokens,
    finalTextMasked: row.final_text_masked,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    isDryRun: row.is_dry_run === 1,
  };
}

function toStepView(row: FlowRunStepRow): FlowRunStepView {
  return {
    runId: row.run_id,
    seq: row.seq,
    kind: row.kind,
    agentSlug: row.agent_slug,
    model: row.model,
    toolName: row.tool_name,
    inputMasked: row.input_masked,
    outputMasked: row.output_masked,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    durationMs: row.duration_ms,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
  };
}

export function createRunRecord(input: CreateRunRecordInput): FlowRunView {
  const id = input.id ?? `run_${crypto.randomUUID()}`;
  const db = getDb();
  db.prepare(
    `INSERT INTO custom_ai_runs (
      id, flow_id, flow_slug, flow_version, profile_id, end_user, wire,
      status, state_json, is_dry_run
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
  ).run(
    id,
    input.flowId,
    input.flowSlug,
    input.flowVersion,
    input.profileId,
    input.endUser ?? null,
    input.wire,
    input.stateJson ?? null,
    input.isDryRun ? 1 : 0,
  );

  const created = db.prepare('SELECT * FROM custom_ai_runs WHERE id = ?').get(id) as FlowRunRow;
  return toRunView(created);
}

export function appendRunStep(input: AppendRunStepInput): FlowRunStepView {
  const db = getDb();
  const inputMasked = maskAndTruncateTrace(input.scopeForMasking, input.input, input.role);
  const outputMasked = maskAndTruncateTrace(input.scopeForMasking, input.output, input.role);
  const errorMasked =
    input.error !== undefined && input.error !== null
      ? maskAndTruncateTrace(input.scopeForMasking, input.error, input.role)
      : null;

  const insertTx = db.transaction((): FlowRunStepRow => {
    let seq = input.seq;
    if (seq === undefined) {
      const seqRow = db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM custom_ai_run_steps WHERE run_id = ?')
        .get(input.runId) as { next_seq: number };
      seq = seqRow.next_seq;
    }

    db.prepare(
      `INSERT INTO custom_ai_run_steps (
        run_id, seq, kind, agent_slug, model, tool_name,
        input_masked, output_masked, prompt_tokens, completion_tokens,
        duration_ms, status, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.runId,
      seq,
      input.kind,
      input.agentSlug,
      input.model ?? null,
      input.toolName ?? null,
      inputMasked,
      outputMasked,
      nonNegInt(input.promptTokens),
      nonNegInt(input.completionTokens),
      nonNegInt(input.durationMs),
      input.status,
      errorMasked,
    );

    return db
      .prepare('SELECT * FROM custom_ai_run_steps WHERE run_id = ? AND seq = ?')
      .get(input.runId, seq) as FlowRunStepRow;
  });

  return toStepView(insertTx());
}

export function updateRunProgress(
  runId: string,
  counters: RunCountersInput,
  stateJson?: string | null,
): void {
  const db = getDb();
  if (stateJson !== undefined) {
    db.prepare(
      `UPDATE custom_ai_runs
          SET steps = ?,
              tool_calls = ?,
              handoffs = ?,
              prompt_tokens = ?,
              completion_tokens = ?,
              state_json = ?
        WHERE id = ?`,
    ).run(
      nonNegInt(counters.steps),
      nonNegInt(counters.toolCalls),
      nonNegInt(counters.handoffs),
      nonNegInt(counters.promptTokens),
      nonNegInt(counters.completionTokens),
      stateJson,
      runId,
    );
    return;
  }

  db.prepare(
    `UPDATE custom_ai_runs
        SET steps = ?,
            tool_calls = ?,
            handoffs = ?,
            prompt_tokens = ?,
            completion_tokens = ?
      WHERE id = ?`,
  ).run(
    nonNegInt(counters.steps),
    nonNegInt(counters.toolCalls),
    nonNegInt(counters.handoffs),
    nonNegInt(counters.promptTokens),
    nonNegInt(counters.completionTokens),
    runId,
  );
}

export function pauseRunForApproval(
  runId: string,
  counters: RunCountersInput,
  stateJson: string,
): void {
  getDb()
    .prepare(
      `UPDATE custom_ai_runs
          SET status = 'awaiting_approval',
              steps = ?,
              tool_calls = ?,
              handoffs = ?,
              prompt_tokens = ?,
              completion_tokens = ?,
              state_json = ?
        WHERE id = ?`,
    )
    .run(
      nonNegInt(counters.steps),
      nonNegInt(counters.toolCalls),
      nonNegInt(counters.handoffs),
      nonNegInt(counters.promptTokens),
      nonNegInt(counters.completionTokens),
      stateJson,
      runId,
    );
}

export function markRunRunning(runId: string, stateJson?: string | null): void {
  getDb()
    .prepare(
      `UPDATE custom_ai_runs
          SET status = 'running',
              state_json = ?
        WHERE id = ?`,
    )
    .run(stateJson ?? null, runId);
}

export function finishRunRecord(runId: string, params: FinishRunRecordParams): FlowRunView {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM custom_ai_runs WHERE id = ?').get(runId) as
    | FlowRunRow
    | undefined;
  if (!existing) {
    throw new Error(`Run '${runId}' not found.`);
  }

  const finalTextMasked =
    params.finalText !== undefined && params.finalText !== null
      ? maskText(params.scopeForMasking, params.finalText, params.role)
      : null;
  const errorMasked =
    params.error !== undefined && params.error !== null
      ? maskText(params.scopeForMasking, params.error, params.role)
      : null;

  if (
    existing.status === 'running' ||
    existing.status === 'awaiting_approval' ||
    existing.status === params.status
  ) {
    if (params.counters) {
      db.prepare(
        `UPDATE custom_ai_runs
            SET status = ?,
                stop_reason = ?,
                final_text_masked = ?,
                error = ?,
                steps = ?,
                tool_calls = ?,
                handoffs = ?,
                prompt_tokens = ?,
                completion_tokens = ?,
                state_json = NULL,
                finished_at = COALESCE(finished_at, datetime('now'))
          WHERE id = ?
            AND (status IN ('running', 'awaiting_approval') OR status = ?)`,
      ).run(
        params.status,
        params.stopReason ?? null,
        finalTextMasked,
        errorMasked,
        nonNegInt(params.counters.steps),
        nonNegInt(params.counters.toolCalls),
        nonNegInt(params.counters.handoffs),
        nonNegInt(params.counters.promptTokens),
        nonNegInt(params.counters.completionTokens),
        runId,
        params.status,
      );
    } else {
      db.prepare(
        `UPDATE custom_ai_runs
            SET status = ?,
                stop_reason = ?,
                final_text_masked = ?,
                error = ?,
                state_json = NULL,
                finished_at = COALESCE(finished_at, datetime('now'))
          WHERE id = ?
            AND (status IN ('running', 'awaiting_approval') OR status = ?)`,
      ).run(
        params.status,
        params.stopReason ?? null,
        finalTextMasked,
        errorMasked,
        runId,
        params.status,
      );
    }
  }

  const updated = db.prepare('SELECT * FROM custom_ai_runs WHERE id = ?').get(runId) as FlowRunRow;
  return toRunView(updated);
}

export function getRunRecord(runId: string): { run: FlowRunView; stateJson: string | null } | null {
  const row = getDb().prepare('SELECT * FROM custom_ai_runs WHERE id = ?').get(runId) as
    | FlowRunRow
    | undefined;
  if (!row) return null;
  return {
    run: toRunView(row),
    stateJson: row.state_json,
  };
}

export function getRunDetail(runId: string, afterSeq?: number): FlowRunDetailResponse | null {
  const db = getDb();
  const runRow = db.prepare('SELECT * FROM custom_ai_runs WHERE id = ?').get(runId) as
    | FlowRunRow
    | undefined;
  if (!runRow) return null;

  const hasAfter = typeof afterSeq === 'number' && Number.isFinite(afterSeq);
  const stepRows = hasAfter
    ? (db
        .prepare('SELECT * FROM custom_ai_run_steps WHERE run_id = ? AND seq > ? ORDER BY seq ASC')
        .all(runId, Math.trunc(afterSeq)) as FlowRunStepRow[])
    : (db
        .prepare('SELECT * FROM custom_ai_run_steps WHERE run_id = ? ORDER BY seq ASC')
        .all(runId) as FlowRunStepRow[]);

  return {
    run: toRunView(runRow),
    steps: stepRows.map(toStepView),
  };
}

export function listRuns(filter: ListRunsFilter = {}): FlowRunView[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.flowId !== undefined) {
    where.push('flow_id = ?');
    params.push(filter.flowId);
  }
  if (filter.profileId !== undefined) {
    where.push('profile_id = ?');
    params.push(filter.profileId);
  }
  if (filter.status !== undefined) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.before !== undefined && filter.before !== '') {
    if (filter.before.startsWith('run_')) {
      const anchor = db
        .prepare('SELECT rowid, started_at FROM custom_ai_runs WHERE id = ?')
        .get(filter.before) as { rowid: number; started_at: string } | undefined;
      if (anchor) {
        where.push('(started_at < ? OR (started_at = ? AND rowid < ?))');
        params.push(anchor.started_at, anchor.started_at, anchor.rowid);
      } else {
        return [];
      }
    } else if (/^\d+$/.test(filter.before)) {
      where.push('rowid < ?');
      params.push(Number(filter.before));
    } else {
      where.push('datetime(started_at) < datetime(?)');
      params.push(filter.before);
    }
  }

  const rawLimit = filter.limit ?? FLOW_LIMITS.defaultListLimit;
  const limit = Math.max(1, Math.min(FLOW_LIMITS.maxListLimit, Math.trunc(rawLimit)));
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT *
         FROM custom_ai_runs
         ${whereSql}
        ORDER BY started_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(...params, limit) as FlowRunRow[];

  return rows.map(toRunView);
}

export function getRunsRetentionDays(): number {
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

export function pruneExpiredRuns(retentionDays?: number, now: Date = new Date()): number {
  const days =
    retentionDays !== undefined && Number.isFinite(retentionDays)
      ? Math.max(1, Math.min(3650, Math.trunc(retentionDays)))
      : getRunsRetentionDays();
  const cutoffIso = new Date(now.getTime() - days * 86_400_000).toISOString();
  const db = getDb();

  const pruneTx = db.transaction((): number => {
    db.prepare(
      `DELETE FROM custom_ai_run_steps
        WHERE run_id IN (
          SELECT id FROM custom_ai_runs WHERE datetime(started_at) < datetime(?)
        )`,
    ).run(cutoffIso);
    const res = db
      .prepare('DELETE FROM custom_ai_runs WHERE datetime(started_at) < datetime(?)')
      .run(cutoffIso);
    return res.changes;
  });

  return pruneTx();
}
