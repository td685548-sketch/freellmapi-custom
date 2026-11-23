import type { Request, Response, NextFunction } from 'express';
import { validateSession } from '../services/auth.js';
import { getSessionCookie } from '../services/session-cookie.js';

// Gate the /api/* admin surface behind a dashboard session (#35, item #2).
// The token is the opaque session token issued by /api/auth/login|setup, sent
// as `Authorization: Bearer <token>`. The /v1 proxy is NOT gated by this — it
// keeps its own unified-API-key auth for app clients.
//
// Phase 1 of the httpOnly-cookie move (services/session-cookie.ts): the token
// is ALSO accepted from the `flm_session` cookie — but ONLY for safe methods
// (GET/HEAD/OPTIONS). A cookie-only mutation is rejected with
// 403 cookie_auth_read_only: a cookie is sent automatically by the browser,
// so a cross-site request would carry it where the header could never be
// known; until the CSRF-token system of a later phase lands, the header
// stays the only way to write. The header always wins when both are present,
// so a stale cookie can never override a good header.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const headerToken = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
  const cookieToken = getSessionCookie(req);
  const token = headerToken ?? cookieToken;
  const authedViaCookieOnly = !headerToken && !!cookieToken;
  // The boundary runs before the fast path below: the gate is entered twice
  // per request (the fork's permission gate, then upstream's own mount), and
  // a cookie-only mutation must be refused on the first entry, not waved
  // through because an earlier pass already set req.user.
  if (authedViaCookieOnly && !SAFE_METHODS.has(req.method)) {
    res.status(403).json({ error: { message: 'Cookie sessions are read-only; send the Authorization header for writes.', type: 'cookie_auth_read_only' } });
    return;
  }
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
