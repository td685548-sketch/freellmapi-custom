import { getDb } from '../db/index.js';
import type { UsageOverview, UsageRow, UsageSubjectKind } from '@freellmapi/shared/usage-overview.js';
import { windowsAt } from './usage-quotas.js';

// The ranking page's data: every account or client profile with its figures over the
// window, idle ones included, so the dashboard can sort and filter without asking again.
// Two statements per kind (figures, then the 95th percentile of successful latencies).

const DAY_MS = 86_400_000;

interface Source {
  /** `requests` column holding the subject id. */
  owner: 'user_id' | 'profile_id';
  /** SELECT list + FROM for the subjects; must expose id, name, rpmLimit, plus extras. */
  subjects: string;
}

// Closed set: these strings are spliced into SQL, never taken from a request.
const SOURCES: Record<UsageSubjectKind, Source> = {
  account: {
    owner: 'user_id',
    subjects: `
      SELECT u.id AS id, u.email AS name, u.role AS role, NULL AS enabled,
             (SELECT MAX(k.rpm_limit) FROM user_api_keys k WHERE k.user_id = u.id AND k.revoked = 0) AS rpmLimit
      FROM users u`,
  },
  profile: {
    owner: 'profile_id',
    subjects: `
      SELECT p.id AS id, p.name AS name, NULL AS role, p.enabled AS enabled, p.rpm_limit AS rpmLimit
      FROM client_profiles p`,
  },
};

function sqlTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// Each computation aggregates the whole window of the request log (a remote read on Turso). It is
// reused for up to 30 seconds while nothing it depends on has changed: the newest request, today's
// allowance totals, the limits, the newest account / key. That check reads a few index ends only, so
// a new request shows at once while an idle dashboard re-opened costs next to nothing. `fresh`
// skips the reuse.
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; signature: string; value: UsageOverview }>();

/** Tests only. */
export function resetUsageOverviewCache(): void { cache.clear(); }

function signatureOf(now: number): string {
  const w = windowsAt(now);
  const r = getDb().prepare(`SELECT
      (SELECT MAX(id) FROM requests) AS lastRequest,
      (SELECT COALESCE(SUM(requests), 0) || ':' || COALESCE(SUM(tokens), 0) FROM custom_usage_counters WHERE period IN (?, ?)) AS counters,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM custom_usage_quotas) AS quotas,
      (SELECT MAX(id) FROM users) AS lastUser,
      (SELECT MAX(id) FROM client_profiles) AS lastProfile`).get(w.day, w.month) as Record<string, unknown>;
  return JSON.stringify(r);
}

export function getUsageOverview(kind: UsageSubjectKind, days: number, now: number = Date.now(), fresh = false): UsageOverview {
  const key = `${kind}:${days}`;
  const signature = signatureOf(now);
  const hit = cache.get(key);
  if (!fresh && hit && hit.signature === signature && now - hit.at >= 0 && now - hit.at < CACHE_MS) return hit.value;
  const value = computeUsageOverview(kind, days, now);
  cache.set(key, { at: now, signature, value });
  return value;
}

type Allowance = NonNullable<UsageRow['allowance']>;

/** The fullest current allowance per subject, from the stored limits and today's / this month's totals. */
function allowancesOf(kind: UsageSubjectKind, now: number): Map<number, Allowance> {
  const db = getDb();
  const subjectKind = kind === 'account' ? 'user' : 'profile';
  const w = windowsAt(now);
  const limits = db.prepare('SELECT subject_id AS id, daily_requests AS dr, daily_tokens AS dt, monthly_requests AS mr, monthly_tokens AS mt FROM custom_usage_quotas WHERE subject_kind = ?')
    .all(subjectKind) as Array<{ id: number; dr: number | null; dt: number | null; mr: number | null; mt: number | null }>;
  const out = new Map<number, Allowance>();
  if (limits.length === 0) return out;
  const used = new Map<string, { requests: number; tokens: number }>();
  for (const r of db.prepare('SELECT subject_id AS id, period, requests, tokens FROM custom_usage_counters WHERE subject_kind = ? AND period IN (?, ?)')
    .all(subjectKind, w.day, w.month) as Array<{ id: number; period: string; requests: number; tokens: number }>) used.set(`${r.id}:${r.period}`, r);
  for (const l of limits) {
    const day = used.get(`${l.id}:${w.day}`) ?? { requests: 0, tokens: 0 };
    const month = used.get(`${l.id}:${w.month}`) ?? { requests: 0, tokens: 0 };
    const candidates: Array<[number | null, number, Allowance['period'], Allowance['metric']]> = [
      [l.dr, day.requests, 'day', 'requests'], [l.dt, day.tokens, 'day', 'tokens'],
      [l.mr, month.requests, 'month', 'requests'], [l.mt, month.tokens, 'month', 'tokens'],
    ];
    let best: Allowance | null = null;
    for (const [limit, value, period, metric] of candidates) {
      if (limit === null || limit <= 0) continue;
      const share = value / limit;
      if (!best || share > best.used) best = { used: Math.round(share * 1000) / 1000, period, metric };
    }
    if (best) out.set(l.id, best);
  }
  return out;
}

function computeUsageOverview(kind: UsageSubjectKind, days: number, now: number): UsageOverview {
  const db = getDb();
  const { owner, subjects } = SOURCES[kind];
  const since = sqlTime(now - days * DAY_MS);
  const before = sqlTime(now - 2 * days * DAY_MS);

  const rows = db.prepare(`
    SELECT s.id, s.name, s.role, s.enabled, s.rpmLimit,
           COALESCE(a.requests, 0) AS requests,
           COALESCE(a.success, 0) AS success,
           COALESCE(a.errors, 0) AS errors,
           COALESCE(a.canceled, 0) AS canceled,
           COALESCE(a.inputTokens, 0) AS inputTokens,
           COALESCE(a.outputTokens, 0) AS outputTokens,
           a.avgLatencyMs AS avgLatencyMs,
           a.lastRequestAt AS lastRequestAt
    FROM (${subjects}) s
    LEFT JOIN (
      SELECT ${owner} AS owner,
             COUNT(*) AS requests,
             SUM(status = 'success') AS success,
             SUM(status = 'error') AS errors,
             SUM(status = 'canceled') AS canceled,
             SUM(CASE WHEN status = 'success' THEN input_tokens ELSE 0 END) AS inputTokens,
             SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END) AS outputTokens,
             AVG(CASE WHEN status = 'success' THEN latency_ms END) AS avgLatencyMs,
             MAX(created_at) AS lastRequestAt
      FROM requests
      WHERE ${owner} IS NOT NULL AND created_at >= ?
      GROUP BY ${owner}
    ) a ON a.owner = s.id
  `).all(since) as Array<{
    id: number; name: string; role: string | null; enabled: number | null; rpmLimit: number | null;
    requests: number; success: number; errors: number; canceled: number;
    inputTokens: number; outputTokens: number; avgLatencyMs: number | null; lastRequestAt: string | null;
  }>;

  // Nearest-rank 95th percentile per subject: the ceil(0.95 * n)-th smallest latency of its successes.
  const p95 = new Map<number, number>();
  const p95Rows = db.prepare(`
    SELECT owner, latency_ms AS value FROM (
      SELECT ${owner} AS owner, latency_ms,
             ROW_NUMBER() OVER (PARTITION BY ${owner} ORDER BY latency_ms) AS rn,
             COUNT(*) OVER (PARTITION BY ${owner}) AS cnt
      FROM requests
      WHERE ${owner} IS NOT NULL AND status = 'success' AND created_at >= ?
    ) WHERE rn = (cnt * 95 + 99) / 100
  `).all(since) as Array<{ owner: number; value: number }>;
  for (const r of p95Rows) p95.set(r.owner, r.value);

  const previous = new Map<number, { requests: number; errors: number; tokens: number }>();
  for (const r of db.prepare(`
    SELECT ${owner} AS owner, COUNT(*) AS requests, SUM(status = 'error') AS errors,
           SUM(CASE WHEN status = 'success' THEN input_tokens + output_tokens ELSE 0 END) AS tokens
    FROM requests
    WHERE ${owner} IS NOT NULL AND created_at >= ? AND created_at < ?
    GROUP BY ${owner}
  `).all(before, since) as Array<{ owner: number; requests: number; errors: number | null; tokens: number | null }>) {
    previous.set(r.owner, { requests: r.requests, errors: r.errors ?? 0, tokens: r.tokens ?? 0 });
  }
  const allowances = allowancesOf(kind, now);

  return {
    kind,
    days,
    since,
    rows: rows.map((r): UsageRow => ({
      kind,
      id: r.id,
      name: r.name,
      ...(kind === 'account' ? { role: r.role === 'admin' ? 'admin' as const : 'member' as const } : { enabled: r.enabled === 1 }),
      requests: r.requests,
      success: r.success,
      errors: r.errors,
      canceled: r.canceled,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      avgLatencyMs: r.avgLatencyMs == null ? null : Math.round(r.avgLatencyMs),
      p95LatencyMs: p95.get(r.id) ?? null,
      lastRequestAt: r.lastRequestAt,
      rpmLimit: r.rpmLimit,
      previous: previous.get(r.id) ?? { requests: 0, errors: 0, tokens: 0 },
      allowance: allowances.get(r.id) ?? null,
    })),
    generatedAt: new Date(now).toISOString(),
  };
}
