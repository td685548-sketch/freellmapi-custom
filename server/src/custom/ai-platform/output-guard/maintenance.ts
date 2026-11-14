import { pruneGuardEvents } from './events.js';

export const GUARD_MAINTENANCE_INTERVAL_MS = 60_000;

let lastGuardMaintenanceAtMs = 0;

export interface GuardMaintenanceResult {
  ran: boolean;
  purgedExcerpts: number;
  prunedEvents: number;
}

export function resetGuardMaintenanceForTests(): void {
  lastGuardMaintenanceAtMs = 0;
}

/**
 * Throttled lazy maintenance for output-guard excerpt expiration and 90-day event retention.
 * Safe to invoke on guard admin/event read paths; never touches MCP approvals or execution journal.
 */
export function maybeRunGuardMaintenance(options?: {
  now?: Date;
  force?: boolean;
  minIntervalMs?: number;
}): GuardMaintenanceResult {
  const now = options?.now ?? new Date();
  const nowMs = now.getTime();
  const minInterval = options?.minIntervalMs ?? GUARD_MAINTENANCE_INTERVAL_MS;

  if (!options?.force && lastGuardMaintenanceAtMs > 0 && nowMs - lastGuardMaintenanceAtMs < minInterval) {
    return { ran: false, purgedExcerpts: 0, prunedEvents: 0 };
  }

  lastGuardMaintenanceAtMs = nowMs;
  try {
    const { purgedExcerpts, prunedEvents } = pruneGuardEvents(now);
    return { ran: true, purgedExcerpts, prunedEvents };
  } catch {
    return { ran: true, purgedExcerpts: 0, prunedEvents: 0 };
  }
}
