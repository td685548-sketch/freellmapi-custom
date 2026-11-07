import { getDb } from '../db/index.js';
import type { EndUserOverview, EndUserRow } from '@freellmapi/shared/end-users.js';
import { NO_END_USER_QUOTA, getEndUserQuota, hasEndUserQuota, storedEndUserTotals } from './end-user-quotas.js';

const DAY_MS = 86_400_000;
const LIMIT = 500;
const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** The end users of one client key over the window, busiest first, with their allowance use. Null for an unknown key. */
export function getEndUserOverview(profileId: number, days: number, now: number = Date.now()): EndUserOverview | null {
  const quota = getEndUserQuota(profileId);
  if (!quota) return null;
  const db = getDb();
  const since = sqlTime(now - days * DAY_MS);
  const rows = db.prepare(`
    SELECT end_user AS endUser, COUNT(*) AS requests,
           SUM(status = 'success') AS success, SUM(status = 'error') AS errors,
           SUM(CASE WHEN status = 'success' THEN input_tokens + output_tokens ELSE 0 END) AS tokens,
           AVG(CASE WHEN status = 'success' THEN latency_ms END) AS avgLatencyMs,
           MAX(created_at) AS lastRequestAt
    FROM requests WHERE profile_id = ? AND end_user IS NOT NULL AND created_at >= ?
    GROUP BY end_user ORDER BY requests DESC, end_user ASC LIMIT ?
  `).all(profileId, since, LIMIT) as Array<Omit<EndUserRow, 'today' | 'month'>>;
  const unattributed = db.prepare('SELECT COUNT(*) AS n FROM requests WHERE profile_id = ? AND end_user IS NULL AND created_at >= ?')
    .get(profileId, since) as { n: number };
  const tracked = hasEndUserQuota(quota);
  const stored = tracked ? storedEndUserTotals(profileId) : null;
  return {
    days,
    unattributedRequests: unattributed.n,
    quota: quota ?? NO_END_USER_QUOTA,
    endUsers: rows.map(r => ({
      ...r,
      avgLatencyMs: r.avgLatencyMs == null ? null : Math.round(r.avgLatencyMs),
      today: stored ? stored.get(r.endUser)?.today ?? { requests: 0, tokens: 0 } : null,
      month: stored ? stored.get(r.endUser)?.month ?? { requests: 0, tokens: 0 } : null,
    })),
  };
}
