import type { NextFunction, Request, Response } from 'express';

// /livez and /readyz are public, unthrottled and each runs a database query. On a
// remote database that is a blocking round trip per call, so a loop of anonymous
// GETs is enough to starve the server. Answer from a short-lived copy instead: at
// most one real check per TTL no matter how many callers. Health stays honest to
// within a few seconds, which is all a probe can tell anyway.

const TTL_MS = 15_000;

// Bypassed under NODE_ENV=test like the other in-process caches: suites change the
// database and probe straight away. A test that exercises the cache turns it on.
let testOverride: boolean | null = null;
const enabled = (): boolean => testOverride ?? process.env.NODE_ENV !== 'test';
export function setStatusCacheTestOverride(value: boolean | null): void { testOverride = value; cache.clear(); }

interface Entry { at: number; status: number; body: unknown }
const cache = new Map<string, Entry>();

export function statusCache(req: Request, res: Response, next: NextFunction): void {
  if (!enabled() || (req.method !== 'GET' && req.method !== 'HEAD')) { next(); return; }
  const key = req.path;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(hit.status).json(hit.body);
    return;
  }
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    cache.set(key, { at: Date.now(), status: res.statusCode, body });
    return json(body);
  };
  next();
}

/** Test hook. */
export function clearStatusCache(): void { cache.clear(); }
