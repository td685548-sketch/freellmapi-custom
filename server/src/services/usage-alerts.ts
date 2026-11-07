import { getDb, getSetting, setSetting } from '../db/index.js';
import { providerLog } from '../lib/server-logs.js';
import type { UsageAmount, UsageQuota } from '@freellmapi/shared/usage-quota.js';
import { notificationEmailAvailable, sendNotificationEmail } from './notification-mailer.js';

// Early warnings for accounts and client keys, so an operator hears about trouble before the web app's
// users do:
//   - allowance: 80% and 100% of each daily / monthly limit (requests or tokens), once per window;
//   - errors: at least 5 failed of at least 10 requests, and at least half of them, in 15 minutes
//     (failed = 5xx, or a 429 that came from the providers, not from this gateway's own limits);
//     at most once an hour per subject.
// Every alert is written to the server log (Logs page, event "usage_alert") and, when configured, POSTed
// to a webhook (Slack / Discord compatible: the message is also in `text` and `content`) and emailed
// through the Gmail sender. Alerting never throws into the request path.

export type SubjectKind = 'user' | 'profile';

export const ALLOWANCE_THRESHOLDS = [0.8, 1] as const;
export const ERROR_WINDOW_MS = 15 * 60_000;
export const ERROR_MIN_REQUESTS = 10;
export const ERROR_MIN_FAILURES = 5;
export const ERROR_MIN_RATE = 0.5;
export const ERROR_ALERT_COOLDOWN_MS = 60 * 60_000;

const WEBHOOK_KEY = 'usage_alerts_webhook_url';
const EMAIL_KEY = 'usage_alerts_email';

export interface AlertSettings { webhookUrl: string; email: string; emailAvailable: boolean }

export function getAlertSettings(): AlertSettings {
  return { webhookUrl: getSetting(WEBHOOK_KEY) ?? '', email: getSetting(EMAIL_KEY) ?? '', emailAvailable: notificationEmailAvailable() };
}

export function setAlertSettings(next: { webhookUrl?: string; email?: string }): AlertSettings {
  if (next.webhookUrl !== undefined) setSetting(WEBHOOK_KEY, next.webhookUrl);
  if (next.email !== undefined) setSetting(EMAIL_KEY, next.email);
  return getAlertSettings();
}

export interface UsageAlert {
  alert: 'allowance' | 'errors' | 'test' | 'weekly_report';
  level: 'info' | 'warn';
  subject: { kind: SubjectKind; id: number; name: string } | null;
  message: string;
  details: Record<string, unknown>;
}

export interface Delivery { webhook: { sent: boolean; status: number | null } | null; email: { sent: boolean } | null }

/** Send one alert everywhere it is configured to go. Resolves with what happened; never rejects. */
export async function deliverAlert(alert: UsageAlert, now: number = Date.now()): Promise<Delivery> {
  providerLog(alert.level, `[usage-alert] ${alert.message}`, { event: 'usage_alert' });
  const settings = getAlertSettings();
  const result: Delivery = { webhook: null, email: null };
  const at = new Date(now).toISOString();

  if (settings.webhookUrl) {
    try {
      const { proxyFetch } = await import('../lib/proxy.js');
      const res = await proxyFetch(settings.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'freellmapi.usage_alert', alert: alert.alert, subject: alert.subject, message: alert.message,
          text: alert.message, content: alert.message, at, ...alert.details,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      result.webhook = { sent: res.ok, status: res.status };
      if (!res.ok) providerLog('warn', `[usage-alert] webhook answered ${res.status}`, { event: 'usage_alert_webhook' });
    } catch {
      result.webhook = { sent: false, status: null };
      providerLog('warn', '[usage-alert] webhook delivery failed', { event: 'usage_alert_webhook' });
    }
  }
  if (settings.email && settings.emailAvailable) {
    const sent = await sendNotificationEmail(settings.email, `[FreeLLMAPI] ${alert.message.slice(0, 120)}`, `${alert.message}\n\nTime: ${at}\n`).catch(() => false);
    result.email = { sent };
  }
  return result;
}

function fire(alert: UsageAlert): void {
  void deliverAlert(alert).catch(() => { /* deliverAlert never rejects; belt and braces */ });
}

function subjectName(kind: SubjectKind, id: number): string {
  try {
    const row = kind === 'user'
      ? getDb().prepare('SELECT email AS name FROM users WHERE id = ?').get(id) as { name: string } | undefined
      : getDb().prepare('SELECT name FROM client_profiles WHERE id = ?').get(id) as { name: string } | undefined;
    return row?.name ?? `#${id}`;
  } catch { return `#${id}`; }
}
const who = (kind: SubjectKind, name: string) => (kind === 'user' ? `Account ${name}` : `Client key "${name}"`);

// ── allowance thresholds ──────────────────────────────────────────────────

const firedCache = new Map<string, Set<string>>();

/** Tests only. */
export function resetAlertState(): void { firedCache.clear(); errorWindows.clear(); lastErrorAlert.clear(); }

/**
 * Called after a request's usage is booked (services/usage-quotas.ts). Reads and writes the database only
 * when a threshold has just been reached.
 */
export function noteAllowance(
  kind: SubjectKind,
  id: number,
  quota: UsageQuota,
  usage: { day: UsageAmount; month: UsageAmount },
  windows: { day: string; month: string; dayResetMs: number; monthResetMs: number },
): void {
  try {
    const checks: Array<['daily' | 'monthly', 'requests' | 'tokens', number | null, number, string, number]> = [
      ['daily', 'requests', quota.dailyRequests, usage.day.requests, windows.day, windows.dayResetMs],
      ['daily', 'tokens', quota.dailyTokens, usage.day.tokens, windows.day, windows.dayResetMs],
      ['monthly', 'requests', quota.monthlyRequests, usage.month.requests, windows.month, windows.monthResetMs],
      ['monthly', 'tokens', quota.monthlyTokens, usage.month.tokens, windows.month, windows.monthResetMs],
    ];
    for (const [period, metric, limit, used, window, resetMs] of checks) {
      if (limit === null) continue;
      const reached = ALLOWANCE_THRESHOLDS.filter(t => used >= t * limit);
      if (reached.length === 0) continue;
      const key = `usage_alert_fired:${kind}:${id}:${window}`;
      let fired = firedCache.get(key);
      if (!fired) {
        let stored: unknown = [];
        try { stored = JSON.parse(getSetting(key) ?? '[]'); } catch { /* treat as none */ }
        fired = new Set(Array.isArray(stored) ? stored.filter((v): v is string => typeof v === 'string') : []);
        firedCache.set(key, fired);
      }
      const fresh = reached.filter(t => !fired!.has(`${metric}:${t}`));
      if (fresh.length === 0) continue;
      for (const t of fresh) fired.add(`${metric}:${t}`);
      setSetting(key, JSON.stringify([...fired]));
      // Forget this subject's finished windows, so the dedup rows do not pile up day after day.
      getDb().prepare('DELETE FROM settings WHERE key LIKE ? AND key NOT IN (?, ?)').run(
        `usage_alert_fired:${kind}:${id}:%`, `usage_alert_fired:${kind}:${id}:${windows.day}`, `usage_alert_fired:${kind}:${id}:${windows.month}`,
      );
      const top = Math.max(...fresh);
      const name = subjectName(kind, id);
      const resets = new Date(resetMs).toISOString();
      const message = top >= 1
        ? `${who(kind, name)} has used its whole ${period} ${metric} allowance (${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')}); further requests are refused until ${resets}.`
        : `${who(kind, name)} has used ${Math.floor((used / limit) * 100)}% of its ${period} ${metric} allowance (${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')}); it resets at ${resets}.`;
      fire({
        alert: 'allowance', level: top >= 1 ? 'warn' : 'info', subject: { kind, id, name }, message,
        details: { period, metric, threshold: top, used, limit, resets_at: resets },
      });
    }
  } catch { /* observational */ }
}

// ── error spikes ──────────────────────────────────────────────────────────

const errorWindows = new Map<string, Array<{ at: number; failed: boolean }>>();
const lastErrorAlert = new Map<string, number>();

/** Whether a finished response counts as a failure the web app saw. The gateway's own refusals never get here. */
export const isFailure = (status: number): boolean => status >= 500 || status === 429;

/** Called once per finished inference request of an account or client key (custom/quota-gate.ts). */
export function noteOutcome(kind: SubjectKind, id: number, status: number, now: number = Date.now()): void {
  try {
    const key = `${kind}:${id}`;
    const list = (errorWindows.get(key) ?? []).filter(e => now - e.at < ERROR_WINDOW_MS);
    list.push({ at: now, failed: isFailure(status) });
    errorWindows.set(key, list.length > 2_000 ? list.slice(-2_000) : list);
    const failures = list.filter(e => e.failed).length;
    if (list.length < ERROR_MIN_REQUESTS || failures < ERROR_MIN_FAILURES || failures / list.length < ERROR_MIN_RATE) return;
    if (now - (lastErrorAlert.get(key) ?? -Infinity) < ERROR_ALERT_COOLDOWN_MS) return;
    lastErrorAlert.set(key, now);
    const name = subjectName(kind, id);
    fire({
      alert: 'errors', level: 'warn', subject: { kind, id, name },
      message: `${who(kind, name)}: ${failures} of its last ${list.length} requests failed in the past ${ERROR_WINDOW_MS / 60_000} minutes.`,
      details: { window_minutes: ERROR_WINDOW_MS / 60_000, requests: list.length, failures },
    });
  } catch { /* observational */ }
}
