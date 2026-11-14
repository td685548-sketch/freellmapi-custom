import crypto from 'node:crypto';
import { getDb } from '../../../db/index.js';
import { expireApprovals } from '../orchestrator/approvals.js';
import { pruneToolCalls } from './calls.js';

export const MCP_MAINTENANCE_INTERVAL_MS = 60_000;

/**
 * Unique identifier for the current server process instance so stale `executing`
 * rows from an earlier process can be reconciled to `unknown` without touching
 * active work in the current process or another live instance.
 */
export const CURRENT_OWNER_INSTANCE_ID = `mcp-${process.pid}-${crypto.randomUUID()}`;

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
 * Reconciles `executing` approvals left behind by an earlier process instance
 * (`owner_instance_id IS NOT NULL AND owner_instance_id != currentOwnerId`) to `unknown`
 * without ever re-dispatching them or sweeping live in-flight approvals.
 */
export function reconcileStaleExecutingApprovals(
  currentOwnerId: string = CURRENT_OWNER_INSTANCE_ID,
): number {
  if (!hasOwnerInstanceColumn()) return 0;
  try {
    const res = getDb()
      .prepare(
        `UPDATE custom_ai_approvals
            SET status = 'unknown',
                error_text = COALESCE(error_text, 'Process restarted while write execution outcome was unknown.')
          WHERE status = 'executing'
            AND owner_instance_id IS NOT NULL
            AND owner_instance_id != ?`,
      )
      .run(currentOwnerId);
    return res.changes;
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
