import type { Request, Response, NextFunction } from 'express';
import { validateSession } from '../services/auth.js';

// Gate the /api/* admin surface behind a dashboard session (#35, item #2).
// The token is the opaque session token issued by /api/auth/login|setup, sent
// as `Authorization: Bearer <token>`. The /v1 proxy is NOT gated by this — it
// keeps its own unified-API-key auth for app clients.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
  // The same request passes through this gate twice (the fork's permission gate,
  // then upstream's own mount). Validating once per request is enough: it is the
  // same token milliseconds apart, and a remote database makes every extra
  // lookup a blocking round trip. Never reused across requests.
  const prior = req as Request & { user?: ReturnType<typeof validateSession>; sessionToken?: string };
  if (prior.user && token && prior.sessionToken === token) { next(); return; }
  // A signed-out visitor on a route an administrator opened to guests (custom/register.ts, read-only).
  if (prior.user && !token && (req as Request & { guestAccess?: boolean }).guestAccess) { next(); return; }
  const session = validateSession(token);
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  (req as Request & { user?: typeof session }).user = session;
  prior.sessionToken = token;
  next();
}
