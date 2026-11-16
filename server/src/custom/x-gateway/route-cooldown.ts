import { sanitizeProviderErrorMessage } from '../../lib/error-redaction.js';
import {
  clearAccountCooldown,
  getAccountCooldown,
  setAccountCooldown,
} from '../provider-accounts/auto-ping.js';

export const TRANSIENT_COOLDOWN_MS = 30_000;
export const AUTH_COOLDOWN_MS = 120_000;
export const NOT_ALLOWED_COOLDOWN_MS = 5_000;
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 300_000;
export const BACKOFF_MAX_LEVEL = 15;
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60_000;

export type RouteErrorReason =
  | 'rate_limit'
  | 'auth_or_config'
  | 'auth_or_not_found'
  | 'not_allowed'
  | 'request_scoped'
  | 'transient';

export interface RouteErrorClassification {
  shouldFallback: boolean;
  requestScoped: boolean;
  cooldownMs: number;
  useBackoff: boolean;
  status?: number;
  reason: RouteErrorReason;
}

const RATE_LIMIT_RE =
  /\b(rate[_ ]?limit|too many requests|quota exceeded|insufficient credit|credit balance is too low|capacity|overloaded|resource_exhausted)\b/i;
const AUTH_OR_CONFIG_RE =
  /\b(no credentials|invalid api key|invalid_api_key|improperly formed request|unauthorized|authentication failed)\b/i;
const NOT_ALLOWED_RE = /\brequest not allowed\b/i;
const STATUS_IN_MSG_RE = /\b(400|401|402|403|404|408|409|413|422|429|500|502|503|504|520|524|529)\b/;

const backoffLevels = new Map<string, number>();

function backoffKey(accountId: number, modelId: string): string {
  return `${accountId}:${modelId}`;
}

export function resetRouteBackoff(): void {
  backoffLevels.clear();
}

export function extractErrorStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const record = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
    for (const candidate of [record.status, record.statusCode, record.response?.status]) {
      if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 100 && candidate < 600) {
        return candidate;
      }
    }
  }
  const message = err instanceof Error ? err.message : String(err ?? '');
  const match = STATUS_IN_MSG_RE.exec(message);
  return match ? Number(match[1]) : undefined;
}

/**
 * Classify an upstream error using 9router's error rules:
 * rate-limit/capacity -> exponential backoff; 401-404/auth -> 2m cooldown;
 * other 4xx -> request-scoped (no cooldown, skip same-provider rotation);
 * 5xx/network/empty stream -> 30s transient cooldown.
 */
export function classifyRouteError(err: unknown): RouteErrorClassification {
  const status = extractErrorStatus(err);
  const message = err instanceof Error ? err.message : String(err ?? '');

  if (RATE_LIMIT_RE.test(message)) {
    return { shouldFallback: true, requestScoped: false, cooldownMs: 0, useBackoff: true, status, reason: 'rate_limit' };
  }
  if (AUTH_OR_CONFIG_RE.test(message)) {
    return { shouldFallback: true, requestScoped: false, cooldownMs: AUTH_COOLDOWN_MS, useBackoff: false, status, reason: 'auth_or_config' };
  }
  if (NOT_ALLOWED_RE.test(message)) {
    return { shouldFallback: true, requestScoped: false, cooldownMs: NOT_ALLOWED_COOLDOWN_MS, useBackoff: false, status, reason: 'not_allowed' };
  }

  if (status === 429) {
    return { shouldFallback: true, requestScoped: false, cooldownMs: 0, useBackoff: true, status, reason: 'rate_limit' };
  }
  if (status === 401 || status === 402 || status === 403 || status === 404) {
    return { shouldFallback: true, requestScoped: false, cooldownMs: AUTH_COOLDOWN_MS, useBackoff: false, status, reason: 'auth_or_not_found' };
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409) {
    return { shouldFallback: false, requestScoped: true, cooldownMs: 0, useBackoff: false, status, reason: 'request_scoped' };
  }

  return { shouldFallback: true, requestScoped: false, cooldownMs: TRANSIENT_COOLDOWN_MS, useBackoff: false, status, reason: 'transient' };
}

function nextBackoffMs(accountId: number, modelId: string): number {
  const key = backoffKey(accountId, modelId);
  const level = Math.min(BACKOFF_MAX_LEVEL, (backoffLevels.get(key) ?? 0) + 1);
  backoffLevels.set(key, level);
  return Math.min(BACKOFF_BASE_MS * (2 ** Math.max(0, level - 1)), BACKOFF_MAX_MS);
}

/**
 * Record an upstream failure for `(accountId, modelId)`:
 * skips cooldown/backoff for request-scoped 4xx, otherwise applies backoff or
 * rule-based cooldown while preserving any longer Retry-After already set.
 */
export function recordCandidateFailure(
  accountId: number,
  modelId: string,
  err: unknown,
): RouteErrorClassification {
  const classification = classifyRouteError(err);
  if (classification.requestScoped) {
    return classification;
  }

  const targetMs = classification.useBackoff
    ? nextBackoffMs(accountId, modelId)
    : classification.cooldownMs;
  const existing = getAccountCooldown(accountId, modelId);
  const effectiveMs = Math.min(
    MAX_RATE_LIMIT_COOLDOWN_MS,
    Math.max(existing.inCooldown ? existing.remainingMs : 0, targetMs),
  );
  const rawMessage = err instanceof Error ? err.message : 'Upstream provider error';
  setAccountCooldown(accountId, effectiveMs, modelId, sanitizeProviderErrorMessage(rawMessage));
  return classification;
}

/** Clear any active cooldown and reset exponential backoff on a successful response. */
export function recordCandidateSuccess(accountId: number, modelId: string): void {
  clearAccountCooldown(accountId, modelId);
  backoffLevels.delete(backoffKey(accountId, modelId));
}

export function filterCandidatesByCooldown<T extends { account: { id: number }; modelId: string }>(
  candidates: T[],
): {
  available: T[];
  allRateLimited: boolean;
  retryAfterMs: number;
} {
  if (candidates.length === 0) {
    return { available: [], allRateLimited: false, retryAfterMs: 0 };
  }
  const available: T[] = [];
  let minRemainingMs = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const cooldown = getAccountCooldown(candidate.account.id, candidate.modelId);
    if (cooldown.inCooldown) {
      if (cooldown.remainingMs > 0) {
        minRemainingMs = Math.min(minRemainingMs, cooldown.remainingMs);
      }
      continue;
    }
    available.push(candidate);
  }
  if (available.length > 0) {
    return { available, allRateLimited: false, retryAfterMs: 0 };
  }
  return {
    available: [],
    allRateLimited: true,
    retryAfterMs: Number.isFinite(minRemainingMs) ? minRemainingMs : 0,
  };
}
