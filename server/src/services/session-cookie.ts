import type { Request, Response } from 'express';

// Dashboard session as an httpOnly cookie — the session-cookie migration
// (see client/src/lib/api.ts for the client side).
//
// Phase 1 proved the mechanism end to end: the login/setup/reset/
// desktop-session/register/SSO-complete endpoints ALSO set the session token
// as a cookie, and requireAuth ALSO accepted it — but only for safe methods,
// because accepting cookie auth for mutations with no CSRF check would have
// opened a cross-site hole.
//
// Phase 2 (this file's current state) completes the client move: the browser
// dashboard no longer stores the token in sessionStorage, no longer sends the
// Authorization header, and no mint endpoint returns the token in JSON — the
// httpOnly cookie is the only carrier the browser has. Cookie-authed
// mutations are now accepted, but only with a valid CSRF token (see
// services/csrf.ts). The server-side header fallback is deliberately KEPT in
// this phase: non-browser callers (curl scripts, server tests, the
// server-side loopback forwards in customer-ai/copilot) still authenticate
// with the header, and the XSS guarantee does not depend on removing it —
// page JS cannot read the token anywhere, so there is nothing to steal.
// Dropping the fallback entirely is Phase 3.
//
// Cookie attributes:
//  - httpOnly: the point of the exercise — JS (and any XSS) cannot read it.
//  - SameSite=Lax: a cross-site fetch/POST does not carry it at all, which
//    is a second layer under the safe-method boundary above.
//  - Secure only when THIS request arrived over HTTPS. Render terminates
//    TLS and forwards X-Forwarded-Proto: https; the desktop/loopback server
//    is plain HTTP, and a Secure cookie there would never be sent back, so
//    the flag must follow the request, not the deployment. The check mirrors
//    app.ts's isHttpsRequest (kept local: importing app.ts here would cycle
//    through the routers).
//  - Path=/api: the cookie is only needed for the admin API; scoping it
//    there keeps it off the static-asset requests the same origin serves.
//    The unified /v1 key is a separate mechanism and never uses this cookie.

export const SESSION_COOKIE_NAME = 'flm_session';

/** TLS terminated here (req.secure), or in front of us and forwarded. */
export function isHttpsRequest(req: Request): boolean {
  const forwardedProto = req.headers['x-forwarded-proto'];
  // A proxy chain sends a comma-separated list; the client-facing hop is first.
  const first = String(forwardedProto ?? '').split(',')[0]!.trim().toLowerCase();
  return first === 'https' || req.secure;
}

/** Set the session cookie for a freshly minted token. maxAgeMs is the TTL the
 *  session row itself was created with (30 days normally, 24h for desktop). */
export function setSessionCookie(res: Response, req: Request, token: string, maxAgeMs: number): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttpsRequest(req),
    path: '/api',
    maxAge: maxAgeMs,
  });
}

/** Clear the session cookie. The attributes must match the set call or the
 *  browser will not remove it. */
export function clearSessionCookie(res: Response, req: Request): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttpsRequest(req),
    path: '/api',
  });
}

/** Read the session token from the cookie, if present. Same parse as the SSO
 *  routers' readCookie (sso/router.ts): split on ';', trim, prefix-match. */
export function getSessionCookie(req: Request): string | undefined {
  const item = req.headers.cookie
    ?.split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  return item ? item.slice(SESSION_COOKIE_NAME.length + 1) : undefined;
}

/** The dashboard session token as presented on the Authorization header
 *  (Bearer, or the Ollama wire's x-dashboard-token). Header only — the
 *  cookie is a separate, deliberately JS-invisible carrier. */
export function headerSessionToken(req: Request): string | undefined {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
}

/** The one place that resolves "the caller's session token": the header when
 *  a non-browser caller presents one, else the httpOnly cookie. The header
 *  always wins, so a stale cookie can never override a good header.
 *  Phase 2 keeps this fallback (non-browser clients, curl scripts, server
 *  tests and the server-side loopback forwards still use the header); what
 *  changed is that the browser dashboard no longer sends it — see
 *  client/src/lib/api.ts. Dropping the fallback entirely is Phase 3. */
export function sessionTokenFromRequest(req: Request): string | undefined {
  return headerSessionToken(req) ?? getSessionCookie(req);
}
