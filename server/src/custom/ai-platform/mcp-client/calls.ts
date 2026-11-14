import type { Scope } from '@freellmapi/shared/ai-platform.js';
import {
  MCP_LIMITS,
  type McpCallView,
  type McpCallsResponse,
  type McpJournalOutcomeInput,
  type McpToolCallStatus,
} from '@freellmapi/shared/ai-platform-mcp.js';
import { getDb } from '../../../db/index.js';
import { maskText } from '../masking.js';
import { normalizeScope } from '../scope.js';
import { sanitizeMcpText } from './sanitize.js';
import {
  getToolCallsRetentionDays,
  toCallView,
  type McpCallRow,
} from './store.js';

const TRUNCATED_MARKER = '\n...[truncated]';

function truncateUtf8WithMarker(
  text: string | null | undefined,
  maxBytes: number = MCP_LIMITS.callLogMaxBytes,
): string | null {
  if (text === null || text === undefined) return null;
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const markerBytes = Buffer.byteLength(TRUNCATED_MARKER, 'utf8');
  const budget = Math.max(0, maxBytes - markerBytes);
  let slice = buf.subarray(0, budget).toString('utf8');
  // Strip trailing replacement character if a multi-byte UTF-8 sequence was cut
  if (slice.endsWith('\uFFFD')) {
    slice = slice.slice(0, -1);
  }
  return `${slice}${TRUNCATED_MARKER}`;
}

export interface RecordToolCallInput {
  runId?: string | null;
  executionKey?: string | null;
  scope: Scope;
  endUser: string | null;
  role?: string;
  serverId: number;
  toolName: string;
  argsMasked: string | null;
  resultMasked: string | null;
  status: McpToolCallStatus;
  durationMs: number;
  resultBytes: number;
}

export function recordToolCall(input: RecordToolCallInput): McpCallView {
  const norm = normalizeScope(input.scope);
  const db = getDb();

  if (input.executionKey) {
    const existing = db
      .prepare(
        `SELECT c.*, s.slug AS server_slug
           FROM custom_ai_tool_calls c
           LEFT JOIN custom_ai_mcp_servers s ON s.id = c.server_id
          WHERE c.execution_key = ?`,
      )
      .get(input.executionKey) as McpCallRow | undefined;
    if (existing) {
      return toCallView(existing);
    }
  }

  const maskedArgs =
    input.argsMasked === null
      ? null
      : truncateUtf8WithMarker(maskText(norm, input.argsMasked, input.role));
  const maskedResult =
    input.resultMasked === null
      ? null
      : truncateUtf8WithMarker(maskText(norm, input.resultMasked, input.role));

  const now = new Date().toISOString();
  const res = db
    .prepare(
      `INSERT INTO custom_ai_tool_calls (
        run_id, execution_key, scope_kind, scope_id, end_user,
        server_id, tool_name, args_masked, result_masked,
        status, duration_ms, result_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId ?? null,
      input.executionKey ?? null,
      norm.kind,
      norm.id,
      input.endUser ?? null,
      input.serverId,
      input.toolName,
      maskedArgs,
      maskedResult,
      input.status,
      Math.max(0, Math.trunc(input.durationMs)),
      Math.max(0, Math.trunc(input.resultBytes)),
      now,
    );

  const inserted = db
    .prepare(
      `SELECT c.*, s.slug AS server_slug
         FROM custom_ai_tool_calls c
         LEFT JOIN custom_ai_mcp_servers s ON s.id = c.server_id
        WHERE c.id = ?`,
    )
    .get(Number(res.lastInsertRowid)) as McpCallRow;

  return toCallView(inserted);
}

export function getToolCallByExecutionKey(executionKey: string): McpCallView | null {
  if (!executionKey) return null;
  const row = getDb()
    .prepare(
      `SELECT c.*, s.slug AS server_slug
         FROM custom_ai_tool_calls c
         LEFT JOIN custom_ai_mcp_servers s ON s.id = c.server_id
        WHERE c.execution_key = ?`,
    )
    .get(executionKey) as McpCallRow | undefined;
  return row ? toCallView(row) : null;
}

/**
 * Atomically transitions an `awaiting_approval` journal row to a terminal
 * outcome (`ok`, `tool_error`, `timeout`, `too_large`, `blocked`,
 * `transport_error`, `unknown`, `rejected`). Idempotent once terminal; never
 * mutates identity/scope/args columns.
 */
export function transitionToolCallOutcome(
  executionKey: string,
  outcome: McpJournalOutcomeInput,
): McpCallView | null {
  if (!executionKey) return null;
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT c.*, s.slug AS server_slug
         FROM custom_ai_tool_calls c
         LEFT JOIN custom_ai_mcp_servers s ON s.id = c.server_id
        WHERE c.execution_key = ?`,
    )
    .get(executionKey) as McpCallRow | undefined;

  if (!existing) return null;
  if (existing.status !== 'awaiting_approval') {
    return toCallView(existing);
  }

  const scope = { kind: existing.scope_kind, id: existing.scope_id } as Scope;
  const maskedResult =
    outcome.resultMasked === undefined || outcome.resultMasked === null
      ? null
      : truncateUtf8WithMarker(maskText(scope, sanitizeMcpText(outcome.resultMasked)));
  const maskedError =
    outcome.errorText === undefined || outcome.errorText === null
      ? null
      : truncateUtf8WithMarker(maskText(scope, sanitizeMcpText(outcome.errorText)));

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE custom_ai_tool_calls
        SET status = ?,
            result_masked = ?,
            error_text = ?,
            duration_ms = COALESCE(?, duration_ms),
            result_bytes = COALESCE(?, result_bytes),
            updated_at = ?
      WHERE execution_key = ?
        AND status = 'awaiting_approval'`,
  ).run(
    outcome.status,
    maskedResult,
    maskedError,
    outcome.durationMs !== undefined && outcome.durationMs !== null
      ? Math.max(0, Math.trunc(outcome.durationMs))
      : null,
    outcome.resultBytes !== undefined && outcome.resultBytes !== null
      ? Math.max(0, Math.trunc(outcome.resultBytes))
      : null,
    now,
    executionKey,
  );

  return getToolCallByExecutionKey(executionKey);
}

export interface ListToolCallsFilter {
  scope?: Scope;
  serverId?: number;
  status?: McpToolCallStatus;
  before?: string;
  limit?: number;
}

export function listToolCalls(filter: ListToolCallsFilter = {}): McpCallsResponse {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.scope) {
    const norm = normalizeScope(filter.scope);
    where.push('c.scope_kind = ? AND c.scope_id = ?');
    params.push(norm.kind, norm.id);
  }
  if (filter.serverId !== undefined) {
    where.push('c.server_id = ?');
    params.push(filter.serverId);
  }
  if (filter.status !== undefined) {
    where.push('c.status = ?');
    params.push(filter.status);
  }
  if (filter.before !== undefined && filter.before !== '') {
    const beforeId = Number(filter.before);
    if (Number.isInteger(beforeId) && beforeId > 0) {
      where.push('c.id < ?');
      params.push(beforeId);
    }
  }

  const rawLimit = filter.limit ?? MCP_LIMITS.defaultListLimit;
  const limit = Math.max(1, Math.min(MCP_LIMITS.maxListLimit, Math.trunc(rawLimit)));

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(
      `SELECT c.*, s.slug AS server_slug
         FROM custom_ai_tool_calls c
         LEFT JOIN custom_ai_mcp_servers s ON s.id = c.server_id
         ${whereSql}
        ORDER BY c.id DESC
        LIMIT ?`,
    )
    .all(...params, limit + 1) as McpCallRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextBefore = hasMore && page.length > 0 ? String(page[page.length - 1].id) : null;

  return {
    calls: page.map(toCallView),
    nextBefore,
  };
}

export function pruneToolCalls(now: Date = new Date()): number {
  const retentionDays = getToolCallsRetentionDays();
  const cutoffIso = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  const res = getDb()
    .prepare('DELETE FROM custom_ai_tool_calls WHERE datetime(created_at) < datetime(?)')
    .run(cutoffIso);
  return res.changes;
}
