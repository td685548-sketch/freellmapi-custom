import type { Request, Response, NextFunction } from 'express';
import { validateSession } from '../services/auth.js';
import { sessionTokenFromRequest } from '../services/session-cookie.js';
import { assertCsrfForCookieMutation } from '../services/csrf.js';

// Gate the /api/* admin surface behind a dashboard session (#35, item #2).
// The token is the opaque session token issued by /api/auth/login|setup, sent
// as `Authorization: Bearer <token>` — or, since the httpOnly-cookie move,
// as the `flm_session` cookie the browser sends automatically. The /v1 proxy
// is NOT gated by this — it keeps its own unified-API-key auth for app
// clients.
//
// Cookie auth and CSRF (Phase 2, services/csrf.ts): a cookie is sent
// automatically by the browser, so a cross-site request would carry it
// where the header could never be known. A cookie-only mutation is
// therefore accepted only with a valid double-submit CSRF token
// (X-CSRF-Token header == flm_csrf cookie); without one it is refused with
// 403 csrf_required / csrf_invalid. The header always wins when both are
// present, so a stale cookie can never override a good header, and
// header-authed requests need no CSRF token at all.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = sessionTokenFromRequest(req);
  // The boundary runs before the fast path below: the gate is entered twice
  // per request (the fork's permission gate, then upstream's own mount), and
  // a cookie-only mutation without a CSRF token must be refused on the
  // first entry, not waved through because an earlier pass already set
  // req.user.
  if (!assertCsrfForCookieMutation(req, res)) return;
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
