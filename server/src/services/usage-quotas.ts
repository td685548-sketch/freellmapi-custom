import { getDb } from '../db/index.js';
import type { UsageAmount, UsageQuota, UsageQuotaState } from '@freellmapi/shared/usage-quota.js';
import { noteAllowance } from './usage-alerts.js';

// Daily / monthly allowances (requests and tokens) of accounts and client profiles.
//
// Cost model, because every statement on a remote database blocks the event loop:
//   - a subject with NO limit costs one SELECT per 30 seconds (the cached "no limit" answer);
//   - a subject WITH a limit keeps its running totals in memory after one SELECT per window, so
//     admitting a request touches no database, and finishing a successful one is a single upsert.
// The totals live in `custom_usage_counters`, so they survive a restart (the per-minute window does
// not). A request is counted when it is ADMITTED, so parallel requests cannot all slip under the
// limit; a failed one is handed back. Token limits cannot be known up front, so they stop the NEXT
// request once the total has reached the limit (one request can overshoot).

export type SubjectKind = 'user' | 'profile';
export const NO_QUOTA: UsageQuota = { dailyRequests: null, dailyTokens: null, monthlyRequests: null, monthlyTokens: null };

const QUOTA_TTL_MS = 30_000;
export const MAX_QUOTA_VALUE = 1_000_000_000_000;

let clock: () => number = Date.now;
/** Tests only: drive the window boundaries. Pass null to restore the real clock. */
export function setQuotaClock(fn: (() => number) | null): void { clock = fn ?? Date.now; }

const quotaCache = new Map<string, { at: number; quota: UsageQuota | null }>();
const counters = new Map<string, UsageAmount>();

/** Tests only: forget everything held in memory, as a restart would. */
export function resetQuotaCaches(): void { quotaCache.clear(); counters.clear(); }

const subject = (kind: SubjectKind, id: number): string => `${kind}:${id}`;

interface Windows { day: string; month: string; dayResetMs: number; monthResetMs: number }
function windowsAt(now: number): Windows {
  const d = new Date(now);
  const iso = d.toISOString();
  return {
    day: 'd' + iso.slice(0, 10),
    month: 'm' + iso.slice(0, 7),
    dayResetMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1),
    monthResetMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  };
}

interface QuotaRow {
  daily_requests: number | null; daily_tokens: number | null; monthly_requests: number | null; monthly_tokens: number | null;
}
const fromRow = (r: QuotaRow): UsageQuota => ({
  dailyRequests: r.daily_requests, dailyTokens: r.daily_tokens, monthlyRequests: r.monthly_requests, monthlyTokens: r.monthly_tokens,
});
const hasLimit = (q: UsageQuota): boolean => Object.values(q).some(v => v !== null);

function readQuota(kind: SubjectKind, id: number): UsageQuota | null {
  const row = getDb().prepare(
    'SELECT daily_requests, daily_tokens, monthly_requests, monthly_tokens FROM custom_usage_quotas WHERE subject_kind = ? AND subject_id = ?',
  ).get(kind, id) as QuotaRow | undefined;
  const quota = row ? fromRow(row) : null;
  return quota && hasLimit(quota) ? quota : null;
}

function quotaOf(kind: SubjectKind, id: number, now: number): UsageQuota | null {
  const key = subject(kind, id);
  const hit = quotaCache.get(key);
  if (hit && now - hit.at < QUOTA_TTL_MS) return hit.quota;
  const quota = readQuota(kind, id);
  quotaCache.set(key, { at: now, quota });
  return quota;
}

/** The running totals of a subject's current day and month, loaded once per window. */
function totalsOf(kind: SubjectKind, id: number, w: Windows): { day: UsageAmount; month: UsageAmount } {
  const dayKey = `${subject(kind, id)}:${w.day}`;
  const monthKey = `${subject(kind, id)}:${w.month}`;
  let day = counters.get(dayKey);
  let month = counters.get(monthKey);
  if (!day || !month) {
    const rows = getDb().prepare(
      'SELECT period, requests, tokens FROM custom_usage_counters WHERE subject_kind = ? AND subject_id = ? AND period IN (?, ?)',
    ).all(kind, id, w.day, w.month) as Array<{ period: string; requests: number; tokens: number }>;
    // A new window starts: forget this subject's finished ones.
    for (const k of counters.keys()) if (k.startsWith(subject(kind, id) + ':') && k !== dayKey && k !== monthKey) counters.delete(k);
    day = { requests: 0, tokens: 0 };
    month = { requests: 0, tokens: 0 };
    for (const r of rows) Object.assign(r.period === w.day ? day : month, { requests: r.requests, tokens: r.tokens });
    counters.set(dayKey, day);
    counters.set(monthKey, month);
  }
  return { day, month };
}

export interface QuotaDenial {
  period: 'daily' | 'monthly';
  metric: 'requests' | 'tokens';
  limit: number;
  used: number;
  /** Epoch ms when the window that is full resets. */
  resetsAtMs: number;
}

export type Admission =
  | { ok: true; settle: (succeeded: boolean, tokens: number) => void }
  | { ok: false; denial: QuotaDenial };

const ADMIT_FREE: Admission = { ok: true, settle: () => {} };

/**
 * Decide whether a request of this subject may start. When it may and the subject has a limit, it is
 * counted at once; `settle` must be called exactly once when the request ends to keep it (success,
 * with the tokens it used) or hand it back (failure or hang-up).
 */
export function admitQuota(kind: SubjectKind, id: number): Admission {
  const now = clock();
  const quota = quotaOf(kind, id, now);
  if (!quota) return ADMIT_FREE;

  const w = windowsAt(now);
  const { day, month } = totalsOf(kind, id, w);
  const checks: Array<[QuotaDenial['period'], QuotaDenial['metric'], number | null, number, number]> = [
    ['daily', 'requests', quota.dailyRequests, day.requests, w.dayResetMs],
    ['daily', 'tokens', quota.dailyTokens, day.tokens, w.dayResetMs],
    ['monthly', 'requests', quota.monthlyRequests, month.requests, w.monthResetMs],
    ['monthly', 'tokens', quota.monthlyTokens, month.tokens, w.monthResetMs],
  ];
  for (const [period, metric, limit, used, resetsAtMs] of checks) {
    if (limit !== null && used >= limit) return { ok: false, denial: { period, metric, limit, used, resetsAtMs } };
  }

  day.requests += 1;
  month.requests += 1;
  let settled = false;
  return {
    ok: true,
    settle(succeeded, tokens) {
      if (settled) return;
      settled = true;
      if (!succeeded) {
        day.requests = Math.max(0, day.requests - 1);
        month.requests = Math.max(0, month.requests - 1);
        return;
      }
      const used = Math.max(0, Math.floor(tokens));
      day.tokens += used;
      month.tokens += used;
      try {
        getDb().prepare(`
          INSERT INTO custom_usage_counters (subject_kind, subject_id, period, requests, tokens)
          VALUES (?, ?, ?, 1, ?), (?, ?, ?, 1, ?)
          ON CONFLICT(subject_kind, subject_id, period) DO UPDATE SET
            requests = requests + excluded.requests, tokens = tokens + excluded.tokens
        `).run(kind, id, w.day, used, kind, id, w.month, used);
      } catch (err) {
        console.error('[usage-quota] could not persist usage:', err);
      }
      noteAllowance(kind, id, quota, { day, month }, w);
    },
  };
}

/** The limits and what has been used, for the dashboard. */
export function getQuotaState(kind: SubjectKind, id: number): UsageQuotaState {
  const now = clock();
  const w = windowsAt(now);
  const quota = quotaOf(kind, id, now);
  const t = quota ? totalsOf(kind, id, w) : { day: { requests: 0, tokens: 0 }, month: { requests: 0, tokens: 0 } };
  return {
    quota: quota ?? NO_QUOTA,
    tracked: quota !== null,
    usage: { day: { ...t.day }, month: { ...t.month } },
    resetsAt: { day: new Date(w.dayResetMs).toISOString(), month: new Date(w.monthResetMs).toISOString() },
  };
}

// `requests` columns that attribute a request to each kind of subject. A closed set: spliced into SQL.
const OWNER_COLUMN: Record<SubjectKind, 'user_id' | 'profile_id'> = { user: 'user_id', profile: 'profile_id' };

/**
 * Set or clear a subject's limits. All-null clears them (and the totals). The first time a subject
 * gets a limit, today's and this month's totals are seeded from the request log, so a limit set in
 * the middle of the day counts what was already used.
 */
export function setQuota(kind: SubjectKind, id: number, quota: UsageQuota): void {
  const db = getDb();
  const now = clock();
  const key = subject(kind, id);
  const forget = () => { for (const k of counters.keys()) if (k.startsWith(key + ':')) counters.delete(k); };

  if (!hasLimit(quota)) {
    db.prepare('DELETE FROM custom_usage_quotas WHERE subject_kind = ? AND subject_id = ?').run(kind, id);
    db.prepare('DELETE FROM custom_usage_counters WHERE subject_kind = ? AND subject_id = ?').run(kind, id);
    forget();
    quotaCache.set(key, { at: now, quota: null });
    return;
  }

  const previous = readQuota(kind, id);
  db.prepare(`
    INSERT INTO custom_usage_quotas (subject_kind, subject_id, daily_requests, daily_tokens, monthly_requests, monthly_tokens, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(subject_kind, subject_id) DO UPDATE SET
      daily_requests = excluded.daily_requests, daily_tokens = excluded.daily_tokens,
      monthly_requests = excluded.monthly_requests, monthly_tokens = excluded.monthly_tokens,
      updated_at = excluded.updated_at
  `).run(kind, id, quota.dailyRequests, quota.dailyTokens, quota.monthlyRequests, quota.monthlyTokens);

  if (!previous) {
    const w = windowsAt(now);
    const column = OWNER_COLUMN[kind];
    const seed = (from: string): UsageAmount => db.prepare(`
      SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
      FROM requests WHERE ${column} = ? AND status = 'success' AND created_at >= ?
    `).get(id, from) as UsageAmount;
    const day = seed(w.day.slice(1) + ' 00:00:00');
    const month = seed(w.month.slice(1) + '-01 00:00:00');
    db.prepare(`
      INSERT INTO custom_usage_counters (subject_kind, subject_id, period, requests, tokens)
      VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)
      ON CONFLICT(subject_kind, subject_id, period) DO UPDATE SET requests = excluded.requests, tokens = excluded.tokens
    `).run(kind, id, w.day, day.requests, day.tokens, kind, id, w.month, month.requests, month.tokens);
  }
  forget();
  quotaCache.set(key, { at: now, quota });
}
