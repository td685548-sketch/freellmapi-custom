import { getDb } from '../../../db/index.js';
import { expireApprovals } from '../orchestrator/approvals.js';
import { pruneToolCalls, transitionToolCallOutcome } from './calls.js';
import { CURRENT_OWNER_INSTANCE_ID, isOwnerDefinitelyDead } from './owner-instance.js';

export { CURRENT_OWNER_INSTANCE_ID } from './owner-instance.js';

export const MCP_MAINTENANCE_INTERVAL_MS = 60_000;

let lastMaintenanceAtMs = 0;

export interface McpMaintenanceResult {
  ran: boolean;
  expiredApprovals: number;
  prunedToolCalls: number;
  reconciledExecuting: number;
}

/** Resets the throttle timestamp for deterministic tests. */
export function resetMcpMaintenanceForTests(): void {
  lastMaintenanceAtMs = 0;
}

function hasOwnerInstanceColumn(): boolean {
  try {
    const cols = getDb()
      .prepare('PRAGMA table_info(custom_ai_approvals)')
      .all() as Array<{ name: string }>;
    return cols.some((c) => c.name === 'owner_instance_id');
  } catch {
    return false;
  }
}

/**
 * Reconciles only demonstrably dead processes on this host. Remote and legacy
 * owner IDs are left for operator reconciliation; they are never redispatched.
 */
export function reconcileStaleExecutingApprovals(
  currentOwnerId: string = CURRENT_OWNER_INSTANCE_ID,
): number {
  if (!hasOwnerInstanceColumn()) return 0;
  try {
    const db = getDb();
    const candidates = db
      .prepare(
        `SELECT id, execution_key, owner_instance_id FROM custom_ai_approvals
          WHERE status = 'executing'
            AND owner_instance_id IS NOT NULL
            AND owner_instance_id != ?`,
      )
      .all(currentOwnerId) as Array<{ id: number; execution_key: string; owner_instance_id: string }>;
    return db.transaction(() => {
      let changed = 0;
      for (const row of candidates) {
        if (!isOwnerDefinitelyDead(row.owner_instance_id)) continue;
        const message = 'Execution owner exited before the write outcome was recorded.';
        const result = db.prepare(
          `UPDATE custom_ai_approvals SET status = 'unknown', error_text = COALESCE(error_text, ?)
            WHERE id = ? AND status = 'executing' AND owner_instance_id = ?`,
        ).run(message, row.id, row.owner_instance_id);
        if (result.changes > 0) {
          transitionToolCallOutcome(row.execution_key, { status: 'unknown', errorText: message });
          changed += result.changes;
        }
      }
      return changed;
    })();
  } catch {
    return 0;
  }
}

/**
 * Throttled lazy maintenance for MCP approvals expiry, tool-call retention pruning,
 * and stale cross-process `executing` reconciliation. Safe to call on request paths.
 */
export function maybeRunMcpMaintenance(options?: {
  now?: Date;
  force?: boolean;
  minIntervalMs?: number;
  ownerInstanceId?: string;
}): McpMaintenanceResult {
  const now = options?.now ?? new Date();
  const nowMs = now.getTime();
  const minInterval = options?.minIntervalMs ?? MCP_MAINTENANCE_INTERVAL_MS;

  if (!options?.force && lastMaintenanceAtMs > 0 && nowMs - lastMaintenanceAtMs < minInterval) {
    return {
      ran: false,
      expiredApprovals: 0,
      prunedToolCalls: 0,
      reconciledExecuting: 0,
    };
  }

  lastMaintenanceAtMs = nowMs;
  const expiredApprovals = expireApprovals(now);
  const prunedToolCalls = pruneToolCalls(now);
  const reconciledExecuting = reconcileStaleExecutingApprovals(
    options?.ownerInstanceId ?? CURRENT_OWNER_INSTANCE_ID,
  );

  return {
    ran: true,
    expiredApprovals,
    prunedToolCalls,
    reconciledExecuting,
  };
}
