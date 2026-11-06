import { getDb } from '../db/index.js';
import type { RecentRequest, RecentRequestsPage, RequestAttempt } from '@freellmapi/shared/recent-requests.js';

// The newest logged requests of one account (requests.user_id) or client profile (requests.profile_id),
// newest first, a page at a time, optionally only the failed ones. Each failed failover attempt is its
// own row; the attempt trace of a request shows the whole chain behind it.

export type RequestOwner = 'user_id' | 'profile_id'; // closed set: spliced into SQL
export const MAX_PAGE = 100;
export const DEFAULT_PAGE = 50;

export function clampPage(raw: unknown): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? Math.min(MAX_PAGE, Math.max(1, n)) : DEFAULT_PAGE;
}

export function listRecentRequests(
  owner: RequestOwner,
  ownerId: number,
  opts: { onlyErrors: boolean; limit: number; before: number | null },
): RecentRequestsPage {
  const where = [`${owner} = ?`];
  const params: unknown[] = [ownerId];
  if (opts.onlyErrors) where.push("status = 'error'");
  if (opts.before !== null) { where.push('id < ?'); params.push(opts.before); }
  const rows = getDb().prepare(`
    SELECT id, created_at AS createdAt, status, platform, model_id AS modelId, requested_model AS requestedModel,
           latency_ms AS latencyMs, ttfb_ms AS ttfbMs, input_tokens AS inputTokens, output_tokens AS outputTokens, error
    FROM requests WHERE ${where.join(' AND ')}
    ORDER BY id DESC LIMIT ?
  `).all(...params, opts.limit + 1) as RecentRequest[];
  const more = rows.length > opts.limit;
  const page = more ? rows.slice(0, opts.limit) : rows;
  return { requests: page, nextBefore: more ? page[page.length - 1]!.id : null };
}

/** The attempt chain of one request, or null when the request is not this owner's. */
export function requestAttempts(owner: RequestOwner, ownerId: number, requestId: number): RequestAttempt[] | null {
  const db = getDb();
  if (!db.prepare(`SELECT 1 FROM requests WHERE id = ? AND ${owner} = ?`).get(requestId, ownerId)) return null;
  return db.prepare(`
    SELECT ordinal, platform, model_id AS modelId, key_label AS keyLabel, outcome, duration_ms AS durationMs, error_summary AS error
    FROM request_attempts WHERE request_id = ? ORDER BY ordinal
  `).all(requestId) as RequestAttempt[];
}
