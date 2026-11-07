import { getDb } from '../db/index.js';
import type { EndUserQuota } from '@freellmapi/shared/end-users.js';
import { quotaNow, windowsAt, type Windows } from './usage-quotas.js';

// The allowance every end user of a client key gets (client_profiles.eu_*), enforced like the
// account / key allowances: counted when admitted, handed back on failure, kept in the database per
// end user and window (custom_end_user_counters) so a restart keeps it. Keys without such an
// allowance cost nothing here.

export const NO_END_USER_QUOTA: EndUserQuota = { dailyRequests: null, dailyTokens: null, monthlyRequests: null, monthlyTokens: null };
export const MAX_END_USER_LENGTH = 128;

/** The end user a request names, or null. Trimmed; refused (null) when empty, too long or not printable. */
export function normalizeEndUser(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.length > MAX_END_USER_LENGTH || [...v].some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return null;
  return v;
}

export const hasEndUserQuota = (q: EndUserQuota): boolean => Object.values(q).some(v => v !== null);

interface Amount { requests: number; tokens: number }
const counters = new Map<string, Amount>();
const MAX_TRACKED = 50_000;

/** Tests only. */
export function resetEndUserCounters(): void { counters.clear(); }

function totals(profileId: number, endUser: string, w: Windows): { day: Amount; month: Amount } {
  const dayKey = `${profileId}\u0000${endUser}\u0000${w.day}`;
  const monthKey = `${profileId}\u0000${endUser}\u0000${w.month}`;
  let day = counters.get(dayKey);
  let month = counters.get(monthKey);
  if (!day || !month) {
    const rows = getDb().prepare(
      'SELECT period, requests, tokens FROM custom_end_user_counters WHERE profile_id = ? AND end_user = ? AND period IN (?, ?)',
    ).all(profileId, endUser, w.day, w.month) as Array<{ period: string; requests: number; tokens: number }>;
    day = { requests: 0, tokens: 0 };
    month = { requests: 0, tokens: 0 };
    for (const r of rows) Object.assign(r.period === w.day ? day : month, { requests: r.requests, tokens: r.tokens });
    if (counters.size > MAX_TRACKED) {
      // Oldest first (insertion order); they reload from the database if they come back.
      let drop = counters.size - MAX_TRACKED + 1_000;
      for (const k of counters.keys()) { counters.delete(k); if (--drop <= 0) break; }
    }
    counters.set(dayKey, day);
    counters.set(monthKey, month);
  }
  return { day, month };
}

export interface EndUserDenial { period: 'daily' | 'monthly'; metric: 'requests' | 'tokens'; limit: number; used: number; resetsAtMs: number }
export type EndUserAdmission = { ok: true; settle: (succeeded: boolean, tokens: number) => void } | { ok: false; denial: EndUserDenial };

export function admitEndUser(profileId: number, endUser: string, quota: EndUserQuota): EndUserAdmission {
  const w = windowsAt(quotaNow());
  const { day, month } = totals(profileId, endUser, w);
  const checks: Array<[EndUserDenial['period'], EndUserDenial['metric'], number | null, number, number]> = [
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
          INSERT INTO custom_end_user_counters (profile_id, end_user, period, requests, tokens) VALUES (?, ?, ?, 1, ?), (?, ?, ?, 1, ?)
          ON CONFLICT(profile_id, end_user, period) DO UPDATE SET requests = requests + excluded.requests, tokens = tokens + excluded.tokens
        `).run(profileId, endUser, w.day, used, profileId, endUser, w.month, used);
      } catch (err) {
        console.error('[end-user-quota] could not persist usage:', err);
      }
    },
  };
}

export function getEndUserQuota(profileId: number): EndUserQuota | null {
  const row = getDb().prepare(`
    SELECT eu_daily_requests AS dailyRequests, eu_daily_tokens AS dailyTokens, eu_monthly_requests AS monthlyRequests, eu_monthly_tokens AS monthlyTokens
    FROM client_profiles WHERE id = ?
  `).get(profileId) as EndUserQuota | undefined;
  return row ?? null;
}

/**
 * Replace the per-end-user allowance of a key. A key that newly gets one starts counting now, seeded
 * from the request log for today and this month, so end users who already used it are not reset.
 */
export function setEndUserQuota(profileId: number, quota: EndUserQuota): boolean {
  const db = getDb();
  const previous = getEndUserQuota(profileId);
  if (!previous) return false;
  db.prepare(`
    UPDATE client_profiles SET eu_daily_requests = ?, eu_daily_tokens = ?, eu_monthly_requests = ?, eu_monthly_tokens = ? WHERE id = ?
  `).run(quota.dailyRequests, quota.dailyTokens, quota.monthlyRequests, quota.monthlyTokens, profileId);
  for (const k of [...counters.keys()]) if (k.startsWith(`${profileId}\u0000`)) counters.delete(k);
  if (!hasEndUserQuota(quota)) {
    db.prepare('DELETE FROM custom_end_user_counters WHERE profile_id = ?').run(profileId);
  } else if (!hasEndUserQuota(previous)) {
    const w = windowsAt(quotaNow());
    db.prepare('DELETE FROM custom_end_user_counters WHERE profile_id = ?').run(profileId);
    for (const [period, from] of [[w.day, w.day.slice(1) + ' 00:00:00'], [w.month, w.month.slice(1) + '-01 00:00:00']] as const) {
      db.prepare(`
        INSERT INTO custom_end_user_counters (profile_id, end_user, period, requests, tokens)
        SELECT profile_id, end_user, ?, COUNT(*), COALESCE(SUM(input_tokens + output_tokens), 0)
        FROM requests WHERE profile_id = ? AND end_user IS NOT NULL AND status = 'success' AND created_at >= ?
        GROUP BY end_user
      `).run(period, profileId, from);
    }
  }
  return true;
}

/** Today's and this month's totals of the end users of one key, as stored. */
export function storedEndUserTotals(profileId: number): Map<string, { today: Amount; month: Amount }> {
  const w = windowsAt(quotaNow());
  const rows = getDb().prepare(
    'SELECT end_user AS endUser, period, requests, tokens FROM custom_end_user_counters WHERE profile_id = ? AND period IN (?, ?)',
  ).all(profileId, w.day, w.month) as Array<{ endUser: string; period: string; requests: number; tokens: number }>;
  const out = new Map<string, { today: Amount; month: Amount }>();
  for (const r of rows) {
    const e = out.get(r.endUser) ?? { today: { requests: 0, tokens: 0 }, month: { requests: 0, tokens: 0 } };
    (r.period === w.day ? e.today : e.month).requests = r.requests;
    (r.period === w.day ? e.today : e.month).tokens = r.tokens;
    out.set(r.endUser, e);
  }
  return out;
}
