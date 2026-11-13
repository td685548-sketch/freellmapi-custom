import type { NextFunction, Request, Response } from 'express';

/**
 * Thruline used to live under `/x` (`/x/v1`, `/x/v1beta`, `/x/api`, the console
 * pages). Clients, embedded widgets and bookmarks configured before the rename
 * keep working: the old prefix is rewritten to `/thruline` before any routing.
 */
export function legacyGatewayPath(req: Request, _res: Response, next: NextFunction): void {
  if (req.url === '/x' || req.url.startsWith('/x/') || req.url.startsWith('/x?')) {
    req.url = `/thruline${req.url.slice(2)}`;
  }
  next();
}
