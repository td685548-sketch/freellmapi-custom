import crypto from 'node:crypto';
import type { Scope } from '@freellmapi/shared/ai-platform.js';
import {
  MCP_LIMITS,
  type BoundTool,
  type McpApprovalDecisionInput,
  type McpApprovalStatus,
  type McpApprovalView,
  type ToolContext,
} from '@freellmapi/shared/ai-platform-mcp.js';
import { getDb } from '../../../db/index.js';
import { decrypt, encrypt } from '../../../lib/crypto.js';
import { isPillarEnabled } from '../flags.js';
import { maskData, maskText } from '../masking.js';
import { normalizeScope } from '../scope.js';
import { validateScope } from '../mcp-client/bindings.js';
import { recordToolCall } from '../mcp-client/calls.js';
import { assertToolExecutable } from '../mcp-client/registry.js';
import {
  McpConflictError,
  McpNotFoundError,
  McpPillarDisabledError,
  McpValidationError,
  canonicalJson,
} from '../mcp-client/store.js';

interface ApprovalRow {
  id: number;
  execution_key: string;
  run_id: string | null;
  step_seq: number;
  scope_kind: Scope['kind'];
  scope_id: string;
  end_user: string | null;
  tool_id: number;
  args_ciphertext: string;
  args_iv: string;
  args_tag: string;
  args_masked: string;
  status: McpApprovalStatus;
  decided_by: number | null;
  decided_at: string | null;
  decision_note: string | null;
  expires_at: string;
  created_at: string;
  tool_name?: string | null;
  exposed_name?: string | null;
  server_id?: number | null;
  server_slug?: string | null;
}

export interface WriteExecutionContext {
  approvalId: number;
  executionKey: string;
  scope: Scope;
  endUser: string | null;
  role?: string;
  runId?: string | null;
  toolId: number;
  args: unknown;
  signal: AbortSignal;
}

export interface WriteExecutionOutcome {
  ok: boolean;
  status: 'succeeded' | 'failed' | 'unknown';
  resultMasked: string;
  error?: string;
  durationMs: number;
  resultBytes: number;
}

export interface WriteApprovalExecutor {
  executeClaimedWrite(ctx: WriteExecutionContext): Promise<WriteExecutionOutcome>;
}

function toApprovalView(row: ApprovalRow): McpApprovalView {
  return {
    id: row.id,
    executionKey: row.execution_key,
    runId: row.run_id,
    stepSeq: row.step_seq,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    endUser: row.end_user,
    toolId: row.tool_id,
    ...(row.tool_name != null ? { toolName: row.tool_name } : {}),
    ...(row.exposed_name != null ? { exposedName: row.exposed_name } : {}),
    ...(row.server_id != null ? { serverId: row.server_id } : {}),
    ...(row.server_slug != null ? { serverSlug: row.server_slug } : {}),
    argsMasked: row.args_masked,
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function selectApprovalById(id: number): ApprovalRow | undefined {
  return getDb()
    .prepare(
      `SELECT a.*,
              t.name AS tool_name,
              t.exposed_name AS exposed_name,
              t.server_id AS server_id,
              s.slug AS server_slug
         FROM custom_ai_approvals a
         LEFT JOIN custom_ai_mcp_tools t ON t.id = a.tool_id
         LEFT JOIN custom_ai_mcp_servers s ON s.id = t.server_id
        WHERE a.id = ?`,
    )
    .get(id) as ApprovalRow | undefined;
}

function validateNote(note?: string): string | null {
  if (note === undefined || note === null) return null;
  if (typeof note !== 'string') {
    throw new McpValidationError('Decision note must be a string.', 'invalid_note', 400);
  }
  const trimmed = note.trim();
  if (trimmed.length > MCP_LIMITS.maxDecisionNoteChars) {
    throw new McpValidationError(
      `Decision note must be at most ${MCP_LIMITS.maxDecisionNoteChars} characters.`,
      'invalid_note',
      400,
    );
  }
  return trimmed.length > 0 ? trimmed : null;
}

function maskArgsString(scope: Scope, args: unknown, role?: string): string {
  const masked = maskData(scope, args ?? {}, role);
  const raw = JSON.stringify(masked) ?? '{}';
  const buf = Buffer.from(raw, 'utf8');
  if (buf.length <= MCP_LIMITS.callLogMaxBytes) return raw;
  const suffix = '...[truncated]';
  const budget = Math.max(0, MCP_LIMITS.callLogMaxBytes - Buffer.byteLength(suffix, 'utf8'));
  let slice = buf.subarray(0, budget).toString('utf8');
  if (slice.endsWith('\uFFFD')) slice = slice.slice(0, -1);
  return `${slice}${suffix}`;
}

export function computeExecutionKey(
  turnOrRunId: string,
  stepSeq: number,
  exposedName: string,
  args: unknown,
): string {
  const payload = canonicalJson({
    turnOrRunId,
    stepSeq,
    exposedName,
    args: args ?? {},
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function resolveExecutor(injected?: WriteApprovalExecutor): Promise<WriteApprovalExecutor> {
  if (injected) return injected;
  try {
    const mod = (await import('../mcp-client/executor.js')) as Partial<WriteApprovalExecutor>;
    if (typeof mod.executeClaimedWrite === 'function') {
      return { executeClaimedWrite: mod.executeClaimedWrite };
    }
  } catch {
    // Module not yet available until Agent 2 X0 lands.
  }
  throw new McpConflictError(
    'executor_unavailable',
    'MCP write executor is not available.',
  );
}

export async function requestToolApproval(
  ctx: ToolContext,
  tool: BoundTool,
  args: unknown,
): Promise<{ approvalId: number; executionKey: string }> {
  const norm = normalizeScope(ctx.scope);
  const db = getDb();
  const executionKey = computeExecutionKey(
    ctx.runId ?? ctx.turnId,
    ctx.stepSeq,
    tool.exposedName,
    args,
  );

  const existing = db
    .prepare('SELECT id, execution_key FROM custom_ai_approvals WHERE execution_key = ?')
    .get(executionKey) as { id: number; execution_key: string } | undefined;
  if (existing) {
    return { approvalId: existing.id, executionKey: existing.execution_key };
  }

  const serializedArgs = JSON.stringify(args ?? {});
  const encrypted = encrypt(serializedArgs);
  const argsMasked = maskArgsString(norm, args, ctx.role);
  const expiresAt = new Date(Date.now() + MCP_LIMITS.approvalTtlHours * 3600_000).toISOString();
  const now = new Date().toISOString();

  const res = db
    .prepare(
      `INSERT INTO custom_ai_approvals (
        execution_key, run_id, step_seq, scope_kind, scope_id, end_user,
        tool_id, args_ciphertext, args_iv, args_tag, args_masked,
        status, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      executionKey,
      ctx.runId ?? null,
      Math.max(0, Math.trunc(ctx.stepSeq)),
      norm.kind,
      norm.id,
      ctx.endUser ?? null,
      tool.toolId,
      encrypted.encrypted,
      encrypted.iv,
      encrypted.authTag,
      argsMasked,
      expiresAt,
      now,
    );

  return { approvalId: Number(res.lastInsertRowid), executionKey };
}

export function listApprovals(filter?: {
  status?: McpApprovalStatus;
  scope?: Scope;
  limit?: number;
}): McpApprovalView[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter?.status) {
    clauses.push('a.status = ?');
    params.push(filter.status);
  }
  if (filter?.scope) {
    const norm = normalizeScope(filter.scope);
    clauses.push('a.scope_kind = ? AND a.scope_id = ?');
    params.push(norm.kind, norm.id);
  }

  const rawLimit = filter?.limit ?? MCP_LIMITS.defaultListLimit;
  const limit = Math.max(1, Math.min(MCP_LIMITS.maxListLimit, Math.trunc(rawLimit)));
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT a.*,
              t.name AS tool_name,
              t.exposed_name AS exposed_name,
              t.server_id AS server_id,
              s.slug AS server_slug
         FROM custom_ai_approvals a
         LEFT JOIN custom_ai_mcp_tools t ON t.id = a.tool_id
         LEFT JOIN custom_ai_mcp_servers s ON s.id = t.server_id
        ${whereSql}
        ORDER BY a.id DESC
        LIMIT ?`,
    )
    .all(...params) as ApprovalRow[];

  return rows.map(toApprovalView);
}

export function expireApprovals(now: Date = new Date()): number {
  const db = getDb();
  const res = db
    .prepare(
      `UPDATE custom_ai_approvals
          SET status = 'expired'
        WHERE status = 'pending' AND expires_at <= ?`,
    )
    .run(now.toISOString());
  return res.changes;
}

export async function approveAction(
  id: number,
  actorId: number | null,
  input?: McpApprovalDecisionInput,
  executor?: WriteApprovalExecutor,
): Promise<McpApprovalView> {
  if (!isPillarEnabled('mcpClient')) {
    throw new McpPillarDisabledError();
  }

  const note = validateNote(input?.note);
  const db = getDb();
  const nowIso = new Date().toISOString();

  // Claim pending -> approved -> executing atomically in a transaction; zero I/O inside.
  const claimed = db.transaction((): ApprovalRow => {
    expireApprovals(new Date(nowIso));

    const row = selectApprovalById(id);
    if (!row) {
      throw new McpNotFoundError(`Approval ${id} not found.`);
    }
    if (row.status !== 'pending') {
      throw new McpConflictError('already_decided', `Approval ${id} is already '${row.status}'.`);
    }

    const scope: Scope = { kind: row.scope_kind, id: row.scope_id };
    validateScope(scope);

    const bound = db
      .prepare(
        `SELECT 1 FROM custom_ai_tool_bindings
          WHERE tool_id = ? AND scope_kind = ? AND scope_id = ?`,
      )
      .get(row.tool_id, scope.kind, scope.id);
    if (!bound) {
      throw new McpConflictError('binding_revoked', `Tool ${row.tool_id} is no longer bound to scope.`);
    }

    // Revalidate server enabled/not paused and tool allowed/not missing before dispatch.
    assertToolExecutable(row.tool_id);

    const updated = db
      .prepare(
        `UPDATE custom_ai_approvals
            SET status = 'executing',
                decided_by = ?,
                decided_at = ?,
                decision_note = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(actorId, nowIso, note, id);

    if (updated.changes === 0) {
      throw new McpConflictError('already_decided', `Approval ${id} was already claimed.`);
    }

    return selectApprovalById(id)!;
  })();

  let parsedArgs: unknown = {};
  try {
    const raw = decrypt(claimed.args_ciphertext, claimed.args_iv, claimed.args_tag);
    parsedArgs = JSON.parse(raw);
  } catch {
    db.prepare(`UPDATE custom_ai_approvals SET status = 'failed' WHERE id = ? AND status = 'executing'`).run(id);
    throw new McpConflictError('decrypt_failed', 'Failed to decrypt approval arguments.');
  }

  const resolvedExecutor = await resolveExecutor(executor);
  const ac = new AbortController();
  let finalStatus: 'succeeded' | 'failed' | 'unknown' = 'unknown';

  try {
    const outcome = await resolvedExecutor.executeClaimedWrite({
      approvalId: claimed.id,
      executionKey: claimed.execution_key,
      scope: { kind: claimed.scope_kind, id: claimed.scope_id },
      endUser: claimed.end_user,
      runId: claimed.run_id,
      toolId: claimed.tool_id,
      args: parsedArgs,
      signal: ac.signal,
    });
    finalStatus = outcome.status;
  } catch {
    // If dispatch threw after leaving our process boundary, treat as uncertain 'unknown'.
    finalStatus = 'unknown';
  }

  db.prepare(
    `UPDATE custom_ai_approvals
        SET status = ?
      WHERE id = ? AND status = 'executing'`,
  ).run(finalStatus, id);

  return toApprovalView(selectApprovalById(id)!);
}

export async function rejectAction(
  id: number,
  actorId: number | null,
  input?: McpApprovalDecisionInput,
): Promise<McpApprovalView> {
  const note = validateNote(input?.note);
  const db = getDb();
  const nowIso = new Date().toISOString();

  const updatedRow = db.transaction((): ApprovalRow => {
    expireApprovals(new Date(nowIso));

    const row = selectApprovalById(id);
    if (!row) {
      throw new McpNotFoundError(`Approval ${id} not found.`);
    }
    if (row.status !== 'pending') {
      throw new McpConflictError('already_decided', `Approval ${id} is already '${row.status}'.`);
    }

    const res = db
      .prepare(
        `UPDATE custom_ai_approvals
            SET status = 'rejected',
                decided_by = ?,
                decided_at = ?,
                decision_note = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(actorId, nowIso, note, id);

    if (res.changes === 0) {
      throw new McpConflictError('already_decided', `Approval ${id} was already decided.`);
    }

    return selectApprovalById(id)!;
  })();

  if (updatedRow.server_id != null && updatedRow.tool_name) {
    const scope: Scope = { kind: updatedRow.scope_kind, id: updatedRow.scope_id };
    recordToolCall({
      runId: updatedRow.run_id,
      executionKey: updatedRow.execution_key,
      scope,
      endUser: updatedRow.end_user,
      serverId: updatedRow.server_id,
      toolName: updatedRow.tool_name,
      argsMasked: updatedRow.args_masked,
      resultMasked: note ? maskText(scope, note) : 'Rejected by reviewer',
      status: 'rejected',
      durationMs: 0,
      resultBytes: 0,
    });
  }

  return toApprovalView(updatedRow);
}
