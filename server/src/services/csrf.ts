import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { getSessionCookie, isHttpsRequest } from './session-cookie.js';

// CSRF protection for cookie-authed dashboard mutations — Phase 2 of the
// session-cookie move (services/session-cookie.ts).
//
// Why this exists: the session cookie is sent automatically by the browser,
// so once the dashboard authenticates with the cookie alone, a cross-site
// request (a malicious page posting a form, or a fetch the victim's browser
// is tricked into making) would arrive authenticated. SameSite=Lax already
// blocks the cookie on cross-site fetch/POST, but it is a browser behaviour,
// not a guarantee — the token is what must close the hole.
//
// Mechanism — double-submit cookie (stateless, no DB, no extra round trip):
//  - the server mints a random CSRF value at every session mint (login,
//    setup, reset-password, desktop-session, register, SSO/Google complete)
//    and sets it as a separate, JS-READABLE cookie `flm_csrf` (httpOnly must
//    be off: the page script has to read it back);
//  - the client sends that value back as the `X-CSRF-Token` header on every
//    mutation (see client/src/lib/api.ts `csrfHeaders()`);
//  - the server accepts a cookie-only mutation only when the header value
//    equals the cookie value (timing-safe compare). A cross-site page cannot
//    read the cookie (same-origin policy), so it cannot forge the header —
//    and a custom header on a cross-origin fetch would need a CORS preflight
//    the allowlist denies anyway.
//  - a session created before Phase 2 has a session cookie but no CSRF
//    cookie; GET /api/auth/status mints one whenever a valid session is
//    presented without it, and the AuthGate calls /status before any
//    mutation-capable UI renders, so the cookie is always there by then.
//
// Phase 3: dashboard session auth is cookie-only, so EVERY authenticated
// mutation needs a valid CSRF token — there is no header-authed request
// left to exempt. An attacker who does not know the CSRF value cannot put
// it in an X-CSRF-Token header cross-site (same-origin policy keeps the
// flm_csrf cookie unreadable to them, and a custom header on a
// cross-origin fetch would need a CORS preflight the allowlist denies
// anyway). The token never leaves the server except inside the httpOnly
// cookie — the CSRF value is NOT a session credential (knowing it alone
// authenticates nothing), which is why it may live in a readable cookie.
//
// Cookie attributes mirror the session cookie (SameSite=Lax, Secure only on
// real HTTPS, Path=/, maxAge = session TTL) so the two cookies are set
// and cleared together. Path MUST be / — not /api: the client reads this
// cookie via document.cookie on dashboard pages (/, /thruline, /settings,
// none of which are under /api), and a Path=/api cookie is invisible to
// document.cookie there, so getCsrfToken() returned null and every
// cookie-authed mutation failed with 403 csrf_required (live bug since
// the Phase 2 deploy). The session cookie went through the same widening
// in PR #208, with the same migration hazard handled the same way:
//  - Legacy Path=/api cookie: after this change a browser can hold BOTH
//    cookies (the old /api one and the new / one). Browsers send the
//    longer-path cookie first and getCsrfCookie takes the first match,
//    while dashboard JS can only see the Path=/ one — so a stale /api
//    cookie would make the server compare the header against the wrong
//    value and answer csrf_invalid. Every mint therefore also clears the
//    legacy /api cookie, and logout clears both paths. The set is emitted
//    BEFORE the legacy clear so a naive first-match Set-Cookie parser
//    still sees the live token.

export const CSRF_COOKIE_NAME = 'flm_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string | undefined): boolean {
  return SAFE_METHODS.has((method ?? 'GET').toUpperCase());
}

export function mintCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Clear the legacy Path=/api CSRF cookie (see the Path note above).
 *  Emitted at every mint so a stale /api cookie can never shadow the new
 *  Path=/ one. The attributes must match the old set call or the browser
 *  will not remove it. */
function clearLegacyCsrfCookie(res: Response, req: Request): void {
  res.clearCookie(CSRF_COOKIE_NAME, {
    httpOnly: false,
    sameSite: 'lax',
    secure: isHttpsRequest(req),
    path: '/api',
  });
}

/** Set (or rotate) the CSRF cookie. maxAgeMs is the session TTL, matching
 *  the session cookie it is minted alongside. */
export function setCsrfCookie(res: Response, req: Request, token: string, maxAgeMs: number): void {
  // Set first, then clear the legacy cookie: a naive first-match
  // Set-Cookie parser must see the live token, not the expired clear.
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    sameSite: 'lax',
    secure: isHttpsRequest(req),
    path: '/',
    maxAge: maxAgeMs,
  });
  clearLegacyCsrfCookie(res, req);
}

/** Clear the CSRF cookie. Both paths are cleared: the current Path=/
 *  cookie and the legacy Path=/api one a browser may still hold. The
 *  attributes must match the set call or the browser will not remove it. */
export function clearCsrfCookie(res: Response, req: Request): void {
  res.clearCookie(CSRF_COOKIE_NAME, {
    httpOnly: false,
    sameSite: 'lax',
    secure: isHttpsRequest(req),
    path: '/',
  });
  clearLegacyCsrfCookie(res, req);
}

/** Read the CSRF value from the cookie, if present. */
export function getCsrfCookie(req: Request): string | undefined {
  const item = req.headers.cookie
    ?.split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${CSRF_COOKIE_NAME}=`));
  return item ? item.slice(CSRF_COOKIE_NAME.length + 1) : undefined;
}

export type CsrfStatus = 'ok' | 'missing' | 'mismatch';

/** Double-submit check: the X-CSRF-Token header must equal the flm_csrf
 *  cookie. 'missing' when either side is absent, 'mismatch' when both are
 *  present but differ. */
export function csrfCheck(req: Request): CsrfStatus {
  const cookie = getCsrfCookie(req);
  const raw = req.headers[CSRF_HEADER_NAME];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!cookie || !header) return 'missing';
  const a = Buffer.from(cookie);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'ok' : 'mismatch';
}

/**
 * Gate for cookie-authed mutations, shared by requireAuth and the routes
 * that validate the session themselves (routes/auth.ts: logout,
 * change-email, change-password).
 *
 * Returns true when the request may proceed; sends 403 and returns false
 * when a cookie mutation carries no (or a wrong) CSRF token. Requests
 * that are safe methods or carry no cookie session at all always pass —
 * the last case is left to the route's own session validation, which
 * answers 401. (Phase 3: session auth is cookie-only, so there is no
 * header-authed bypass anymore — every authenticated mutation needs the
 * double-submit token.)
 */
export function assertCsrfForCookieMutation(req: Request, res: Response): boolean {
  if (isSafeMethod(req.method)) return true;
  if (!getSessionCookie(req)) return true;
  const status = csrfCheck(req);
  if (status === 'ok') return true;
  res.status(403).json({
    error: {
      message: status === 'missing'
        ? 'Cookie sessions need a CSRF token for writes; send X-CSRF-Token.'
        : 'CSRF token does not match.',
      type: status === 'missing' ? 'csrf_required' : 'csrf_invalid',
    },
  });
  return false;
}
