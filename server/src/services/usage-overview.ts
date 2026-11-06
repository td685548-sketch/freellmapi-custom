import { getDb } from '../db/index.js';
import type { UsageOverview, UsageRow, UsageSubjectKind } from '@freellmapi/shared/usage-overview.js';

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

export function getUsageOverview(kind: UsageSubjectKind, days: number, now: number = Date.now()): UsageOverview {
  const db = getDb();
  const { owner, subjects } = SOURCES[kind];
  const since = sqlTime(now - days * DAY_MS);

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
    })),
  };
}
