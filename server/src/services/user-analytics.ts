import { getDb } from '../db/index.js';
import type { RequestAnalytics, UserAnalytics, UserAnalyticsDay } from '@freellmapi/shared/user-analytics.js';

// Per-account analytics over `requests.user_id` (set for traffic that arrived with
// a personal `sk-flm-…` key). Raw rows follow the analytics retention, so this reads
// the window the instance still keeps; `retainedSince` says where it begins.

export const DEFAULT_ANALYTICS_DAYS = 30;
export const MAX_ANALYTICS_DAYS = 90;
const DAY_MS = 86_400_000;
const MODEL_LIMIT = 10;

export function clampAnalyticsDays(raw: unknown): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? Math.trunc(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_ANALYTICS_DAYS;
  return Math.min(MAX_ANALYTICS_DAYS, Math.max(1, n));
}

// The same 'YYYY-MM-DD HH:MM:SS' UTC text logRequest writes, so range filters compare as strings.
function sqlTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// The attribution columns analytics can group by. A closed set: the name is spliced into SQL.
type OwnerColumn = 'user_id' | 'profile_id';

export function getRequestAnalytics(column: OwnerColumn, ownerId: number, days: number, now: number = Date.now()): RequestAnalytics {
  const db = getDb();
  const since = sqlTime(now - days * DAY_MS);

  const t = db.prepare(`
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(status = 'success'), 0) AS success,
      COALESCE(SUM(status = 'error'), 0) AS errors,
      COALESCE(SUM(status = 'canceled'), 0) AS canceled,
      COALESCE(SUM(CASE WHEN status = 'success' THEN input_tokens ELSE 0 END), 0) AS inputTokens,
      COALESCE(SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END), 0) AS outputTokens,
      AVG(CASE WHEN status = 'success' THEN latency_ms END) AS avgLatencyMs,
      MAX(created_at) AS lastRequestAt
    FROM requests WHERE ${column} = ? AND created_at >= ?
  `).get(ownerId, since) as {
    requests: number; success: number; errors: number; canceled: number;
    inputTokens: number; outputTokens: number; avgLatencyMs: number | null; lastRequestAt: string | null;
  };

  const dayRows = db.prepare(`
    SELECT substr(created_at, 1, 10) AS date,
           COUNT(*) AS requests,
           COALESCE(SUM(status = 'error'), 0) AS errors,
           COALESCE(SUM(CASE WHEN status = 'success' THEN input_tokens + output_tokens ELSE 0 END), 0) AS tokens
    FROM requests WHERE ${column} = ? AND created_at >= ?
    GROUP BY date
  `).all(ownerId, since) as UserAnalyticsDay[];
  const byDate = new Map(dayRows.map(r => [r.date, r]));
  const daily: UserAnalyticsDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now - i * DAY_MS).toISOString().slice(0, 10);
    daily.push(byDate.get(date) ?? { date, requests: 0, errors: 0, tokens: 0 });
  }

  const models = db.prepare(`
    SELECT platform, model_id AS modelId,
           COUNT(*) AS requests,
           COALESCE(SUM(status = 'error'), 0) AS errors,
           COALESCE(SUM(CASE WHEN status = 'success' THEN input_tokens + output_tokens ELSE 0 END), 0) AS tokens
    FROM requests WHERE ${column} = ? AND created_at >= ?
    GROUP BY platform, model_id
    ORDER BY requests DESC, tokens DESC
    LIMIT ?
  `).all(ownerId, since, MODEL_LIMIT) as UserAnalytics['models'];

  const first = db.prepare(`SELECT MIN(created_at) AS first FROM requests WHERE ${column} = ?`)
    .get(ownerId) as { first: string | null };

  return {
    days,
    since,
    totals: {
      requests: t.requests,
      success: t.success,
      errors: t.errors,
      canceled: t.canceled,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      avgLatencyMs: t.avgLatencyMs == null ? null : Math.round(t.avgLatencyMs),
      lastRequestAt: t.lastRequestAt,
    },
    daily,
    models,
    retainedSince: first.first,
  };
}

export function getUserAnalytics(userId: number, email: string, days: number, now: number = Date.now()): UserAnalytics {
  return { userId, email, ...getRequestAnalytics('user_id', userId, days, now) };
}
