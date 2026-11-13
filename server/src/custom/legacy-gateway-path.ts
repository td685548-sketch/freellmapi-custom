import type { NextFunction, Request, Response } from 'express';

/** Pre-rename prefix -> where it lives now. */
const RENAMED: ReadonlyArray<readonly [string, string]> = [
  ['/api/x-gateway', '/api/thruline'],
  ['/api/x-accounts', '/api/thruline-accounts'],
  ['/x', '/thruline'],
];

/**
 * Thruline used to live under `/x` (`/x/v1`, `/x/v1beta`, `/x/api`, the console
 * pages) with its dashboard API under `/api/x-gateway` and `/api/x-accounts`.
 * Clients, embedded widgets, registered webhooks and bookmarks configured before
 * the rename keep working: the old prefix is rewritten before any routing.
 *
 * `originalUrl` is rewritten as well, because the permission gates resolve the
 * required permission from it; an old address must not resolve to a weaker one.
 */
export function legacyGatewayPath(req: Request, _res: Response, next: NextFunction): void {
  const lower = req.url.toLowerCase();
  for (const [from, to] of RENAMED) {
    const rest = lower.slice(from.length, from.length + 1);
    if (lower.startsWith(from) && (rest === '' || rest === '/' || rest === '?')) {
      req.url = to + req.url.slice(from.length);
      req.originalUrl = req.url;
      break;
    }
  }
  next();
}
