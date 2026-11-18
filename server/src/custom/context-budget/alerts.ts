import { getDb } from '../../db/index.js';
import { deliverAlert } from '../../services/usage-alerts.js';

export const CONTEXT_ALERT_WINDOW_MS = 15 * 60_000;
export const CONTEXT_ALERT_COOLDOWN_MS = 60 * 60_000;
export const CONTEXT_BUDGET_EXCEEDED_THRESHOLD = 3;
export const CONTEXT_HIGH_TRIM_MIN_REQUESTS = 10;
export const CONTEXT_HIGH_TRIM_MIN_RATE = 0.8;

const exceededWindows = new Map<number, number[]>();
const trimWindows = new Map<number, Array<{ at: number; trimmed: boolean }>>();
const lastAlertAt = new Map<string, number>();

function lookupProfileName(profileId: number): string {
  try {
    const row = getDb()
      .prepare('SELECT name FROM client_profiles WHERE id = ?')
      .get(profileId) as { name?: string } | undefined;
    return row?.name?.trim() || `#${profileId}`;
  } catch {
    return `#${profileId}`;
  }
}

/**
 * Record an HTTP 400 `context_budget_exceeded` rejection at the gate.
 * When a profile accumulates at least `CONTEXT_BUDGET_EXCEEDED_THRESHOLD` (3) rejections
 * within 15 minutes (at most once per hour per profile), emit a proactive usage alert.
 */
export function noteContextBudgetExceeded(
  profileId: number,
  mandatoryTokens: number,
  budgetTokens: number,
  now: number = Date.now(),
): void {
  try {
    if (!Number.isInteger(profileId) || profileId <= 0) return;
    const recent = (exceededWindows.get(profileId) ?? []).filter(
      (ts) => now - ts < CONTEXT_ALERT_WINDOW_MS,
    );
    recent.push(now);
    exceededWindows.set(profileId, recent.length > 500 ? recent.slice(-500) : recent);

    if (recent.length < CONTEXT_BUDGET_EXCEEDED_THRESHOLD) return;
    const cooldownKey = `budget_exceeded:${profileId}`;
    if (now - (lastAlertAt.get(cooldownKey) ?? -Infinity) < CONTEXT_ALERT_COOLDOWN_MS) return;
    lastAlertAt.set(cooldownKey, now);

    const name = lookupProfileName(profileId);
    const windowMins = CONTEXT_ALERT_WINDOW_MS / 60_000;
    const message =
      `Client key "${name}" rejected ${recent.length} request(s) in the last ${windowMins} minutes ` +
      `because mandatory context (~${mandatoryTokens.toLocaleString('en-US')} tokens) exceeded the ${budgetTokens.toLocaleString('en-US')}-token budget.`;

    void deliverAlert(
      {
        alert: 'context_budget',
        level: 'warn',
        subject: { kind: 'profile', id: profileId, name },
        message,
        details: {
          kind: 'budget_exceeded',
          window_minutes: windowMins,
          rejections: recent.length,
          mandatory_tokens: mandatoryTokens,
          budget_tokens: budgetTokens,
        },
      },
      now,
    ).catch(() => {});
  } catch {
    // Observational only: never disrupt inference rejection path.
  }
}

/**
 * Record a completed Context Policy assembly outcome.
 * When at least `CONTEXT_HIGH_TRIM_MIN_REQUESTS` (10) requests in 15 minutes occur and
 * `>= 80%` required trimming history/knowledge/client turns, emit an informational alert
 * at most once per hour per profile.
 */
export function noteContextReportOutcome(
  profileId: number,
  summary: {
    histDropped: number;
    kbDropped: number;
    clientDropped: number;
    budget: number;
    estimatedTokens: number;
  },
  now: number = Date.now(),
): void {
  try {
    if (!Number.isInteger(profileId) || profileId <= 0) return;
    const trimmed =
      summary.histDropped > 0 || summary.kbDropped > 0 || summary.clientDropped > 0;
    const list = (trimWindows.get(profileId) ?? []).filter(
      (entry) => now - entry.at < CONTEXT_ALERT_WINDOW_MS,
    );
    list.push({ at: now, trimmed });
    trimWindows.set(profileId, list.length > 1000 ? list.slice(-1000) : list);

    if (list.length < CONTEXT_HIGH_TRIM_MIN_REQUESTS) return;
    const trimmedCount = list.filter((entry) => entry.trimmed).length;
    const rate = trimmedCount / list.length;
    if (rate < CONTEXT_HIGH_TRIM_MIN_RATE) return;

    const cooldownKey = `high_trim:${profileId}`;
    if (now - (lastAlertAt.get(cooldownKey) ?? -Infinity) < CONTEXT_ALERT_COOLDOWN_MS) return;
    lastAlertAt.set(cooldownKey, now);

    const name = lookupProfileName(profileId);
    const windowMins = CONTEXT_ALERT_WINDOW_MS / 60_000;
    const pct = Math.round(rate * 100);
    const message =
      `Client key "${name}" trimmed context on ${trimmedCount} of ${list.length} requests (${pct}%) ` +
      `over the past ${windowMins} minutes (current budget ${summary.budget.toLocaleString('en-US')} tokens). ` +
      `Consider enabling summary folding or increasing maxInputTokens.`;

    void deliverAlert(
      {
        alert: 'context_budget',
        level: 'info',
        subject: { kind: 'profile', id: profileId, name },
        message,
        details: {
          kind: 'high_trim_rate',
          window_minutes: windowMins,
          requests: list.length,
          trimmed_requests: trimmedCount,
          trimmed_rate: Math.round(rate * 10_000) / 10_000,
          budget_tokens: summary.budget,
          estimated_tokens: summary.estimatedTokens,
        },
      },
      now,
    ).catch(() => {});
  } catch {
    // Observational only.
  }
}

/**
 * Reset in-memory context-budget alert windows and cooldowns (used by tests).
 */
export function resetContextBudgetAlerts(): void {
  exceededWindows.clear();
  trimWindows.clear();
  lastAlertAt.clear();
}
