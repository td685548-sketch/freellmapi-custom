import {
  DEFAULT_CREDENTIAL_WEIGHT,
  DEFAULT_MAX_QUEUE_SIZE,
  type AccountResiliencePolicy,
} from '@freellmapi/shared/account-resilience.js';
import { getDb } from '../../db/index.js';
import { sanitizeProviderErrorMessage } from '../../lib/error-redaction.js';
import {
  defaultAccountResiliencePolicy,
  getAccountResiliencePolicy,
} from './weights.js';
import {
  clearProviderAccountIssueDedupe,
  notifyProviderAccountIssue,
} from '../notifications/telegram-bot.js';

export const REFRESH_CIRCUIT_BASE_MS = 60_000;
export const REFRESH_CIRCUIT_MAX_MS = 4 * 60 * 60_000;

const EXTRA_TOKEN_REDACTIONS: ReadonlyArray< readonly [RegExp, string]> = [
  [/(["']?)\b(refresh[_-]?token|id[_-]?token|client[_-]?secret|code[_-]?verifier)\b\1(\s*[:=]\s*)(["']?)[^"',\s}\]]+/gi, '$1$2$1$3$4[redacted]'],
  [/\b(?:rt_|ya29\.|sk-ant-|ghu_|gho_|ghp_|github_pat_)[A-Za-z0-9._-]{6,}\b/g, '[redacted-token]'],
];

/**
 * Scrubs any OAuth token, secret, or credential fragment before persisting
 * `last_refresh_error` to SQLite or returning it via admin APIs.
 */
export function sanitizeRefreshCircuitError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'OAuth token refresh failed';
  let scrubbed = raw;
  for (const [pattern, replacement] of EXTRA_TOKEN_REDACTIONS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return sanitizeProviderErrorMessage(scrubbed);
}

export interface RefreshCircuitOptions {
  nowMs?: number;
  baseMs?: number;
  maxMs?: number;
}

export function computeRefreshBackoffUntil(
  failureCount: number,
  options: RefreshCircuitOptions = {},
): string {
  const nowMs = options.nowMs ?? Date.now();
  const baseMs = options.baseMs ?? REFRESH_CIRCUIT_BASE_MS;
  const maxMs = options.maxMs ?? REFRESH_CIRCUIT_MAX_MS;
  const steps = Math.max(0, Math.trunc(failureCount) - 1);
  const backoffMs = Math.min(baseMs * (2 ** steps), maxMs);
  return new Date(nowMs + Math.max(1, backoffMs)).toISOString();
}

export interface RefreshCircuitState {
  inBackoff: boolean;
  until: string | null;
  remainingMs: number;
  failureCount: number;
  lastError: string | null;
}

export function getRefreshCircuitState(
  accountId: number,
  nowMs = Date.now(),
): RefreshCircuitState {
  const policy = getAccountResiliencePolicy(accountId);
  if (!policy.refreshCircuitUntil) {
    return {
      inBackoff: false,
      until: null,
      remainingMs: 0,
      failureCount: policy.refreshFailureCount,
      lastError: policy.lastRefreshError,
    };
  }
  const untilMs = Date.parse(policy.refreshCircuitUntil);
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) {
    return {
      inBackoff: false,
      until: policy.refreshCircuitUntil,
      remainingMs: 0,
      failureCount: policy.refreshFailureCount,
      lastError: policy.lastRefreshError,
    };
  }
  return {
    inBackoff: true,
    until: policy.refreshCircuitUntil,
    remainingMs: untilMs - nowMs,
    failureCount: policy.refreshFailureCount,
    lastError: policy.lastRefreshError,
  };
}

/**
 * True when `accountId` has an active persisted OAuth refresh backoff window in SQLite.
 * Survives process restarts so background pings and routing skip hammering OAuth endpoints.
 */
export function isInPersistedRefreshBackoff(
  accountId: number,
  nowMs = Date.now(),
): boolean {
  return getRefreshCircuitState(accountId, nowMs).inBackoff;
}

/**
 * Records an OAuth token refresh failure in SQLite with exponential backoff,
 * preserving existing weight and semaphore settings on the account.
 */
export function recordRefreshCircuitFailure(
  accountId: number,
  error: unknown,
  options: RefreshCircuitOptions = {},
): AccountResiliencePolicy {
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const current = getAccountResiliencePolicy(accountId);
  const nextFailures = current.refreshFailureCount + 1;
  const computedUntil = computeRefreshBackoffUntil(nextFailures, { ...options, nowMs });

  // Never shorten an already longer active backoff window.
  const existingUntilMs = current.refreshCircuitUntil ? Date.parse(current.refreshCircuitUntil) : 0;
  const computedUntilMs = Date.parse(computedUntil);
  const effectiveUntil =
    Number.isFinite(existingUntilMs) && existingUntilMs > computedUntilMs
      ? current.refreshCircuitUntil!
      : computedUntil;

  const safeError = sanitizeRefreshCircuitError(error);

  try {
    getDb()
      .prepare(
        `INSERT INTO custom_x_account_resilience (
           account_id, weight, max_concurrency, max_queue_size, fail_fast,
           refresh_circuit_until, refresh_failures, last_refresh_error, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           refresh_circuit_until = excluded.refresh_circuit_until,
           refresh_failures = excluded.refresh_failures,
           last_refresh_error = excluded.last_refresh_error,
           updated_at = excluded.updated_at`,
      )
      .run(
        accountId,
        current.weight ?? DEFAULT_CREDENTIAL_WEIGHT,
        current.maxConcurrency,
        current.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
        current.failFast ? 1 : 0,
        effectiveUntil,
        nextFailures,
        safeError,
        nowIso,
      );
    if (nextFailures === 1 || nextFailures % 3 === 0) {
      notifyProviderAccountIssue({
        accountId,
        reason: safeError || 'OAuth token refresh failed and entered circuit backoff.',
        isRefreshCircuit: true,
        nowMs,
      });
    }
    return getAccountResiliencePolicy(accountId);
  } catch {
    return {
      ...(current ?? defaultAccountResiliencePolicy(accountId)),
      refreshCircuitUntil: effectiveUntil,
      refreshFailureCount: nextFailures,
      lastRefreshError: safeError,
      updatedAt: nowIso,
    };
  }
}

/**
 * Clears the persisted OAuth refresh backoff circuit after a successful refresh
 * or manual operator reset, keeping weight and concurrency policy untouched.
 */
export function clearRefreshCircuit(accountId: number): AccountResiliencePolicy {
  const nowIso = new Date().toISOString();
  try {
    getDb()
      .prepare(
        `UPDATE custom_x_account_resilience
            SET refresh_circuit_until = NULL,
                refresh_failures = 0,
                last_refresh_error = NULL,
                updated_at = ?
          WHERE account_id = ?`,
      )
      .run(nowIso, accountId);
  } catch {
    // Best effort if DB is not initialized or row does not exist yet.
  }
  clearProviderAccountIssueDedupe(accountId);
  return getAccountResiliencePolicy(accountId);
}
