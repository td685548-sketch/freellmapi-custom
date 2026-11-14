import type { NextFunction, Request, Response } from 'express';

/**
 * A short-lived copy of the expensive, install-wide /api/analytics answers.
 *
 * Why: every handler here is a synchronous scan of the request ledger (up to ~100k rows), so
 * one Analytics page load blocks the event loop for roughly three quarters of a second, and
 * every proxied request queues behind it. Several admins or tabs asking the same question at
 * the same moment repeat that work for an answer that has not changed.
 *
 * What it is not: an authorisation cache. It is mounted AFTER the auth and `view_logs` gates,
 * so every request is still authenticated and authorised on its own; only the computed body
 * is reused. The data is install-wide (no handler reads the caller), so one copy fits every
 * caller who is allowed to see it. Quota and key state are never touched.
 *
 * Bounds: at most MAX_ENTRIES answers, each reused for at most ANALYTICS_MEMO_TTL_MS
 * (default 10 s; 0 turns it off). Only successful GETs of the listed aggregate routes are kept;
 * the request list and the single-request detail stay live because they are what people
 * watch for new traffic.
 */

const DEFAULT_TTL_MS = 10_000;
const MAX_ENTRIES = 64;
const MEMOIZED_PATHS = new Set([
  '/summary', '/by-model', '/by-platform', '/by-client', '/by-key',
  '/timeline', '/error-distribution', '/errors',
]);

interface Entry { at: number; status: number; body: unknown }
const cache = new Map<string, Entry>();

// Off under NODE_ENV=test like the other in-process caches, so suites that change the
// database and read straight back see the change. A test of the memo itself turns it on.
let ttlOverride: number | null = null;
export function setAnalyticsMemoTtlForTest(ms: number | null): void { ttlOverride = ms; cache.clear(); }

function ttlMs(): number {
  if (ttlOverride !== null) return ttlOverride;
  if (process.env.NODE_ENV === 'test') return 0;
  const raw = process.env.ANALYTICS_MEMO_TTL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TTL_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_MS;
}

/** Same question, same key, whatever order the query parameters arrive in. */
function keyOf(req: Request): string {
  const entries = Object.entries(req.query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${req.path}?${JSON.stringify(entries)}`;
}

export function analyticsMemo(req: Request, res: Response, next: NextFunction): void {
  const ttl = ttlMs();
  if (ttl <= 0 || req.method !== 'GET' || !MEMOIZED_PATHS.has(req.path)) { next(); return; }

  const key = keyOf(req);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Analytics-Cache', 'hit');
    res.status(hit.status).json(hit.body);
    return;
  }
  if (hit) cache.delete(key);

  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode === 200) {
      cache.delete(key); // re-insert at the newest position
      cache.set(key, { at: Date.now(), status: res.statusCode, body });
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    }
    return json(body);
  };
  res.setHeader('X-Analytics-Cache', 'miss');
  next();
}

/** Test hook. */
export function clearAnalyticsMemo(): void { cache.clear(); }
