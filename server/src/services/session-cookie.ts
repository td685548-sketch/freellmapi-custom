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
// Phase 2 completes the client move: the browser dashboard no longer stores
// the token in sessionStorage, no longer sends the Authorization header, and
// no mint endpoint returns the token in JSON — the httpOnly cookie is the
// only carrier the browser has. Cookie-authed mutations are now accepted,
// but only with a valid CSRF token (see services/csrf.ts). The server-side
// header fallback was deliberately KEPT in that phase: non-browser callers
// (curl scripts, server tests, the server-side loopback forwards in
// customer-ai/copilot) still authenticated with the header, and the XSS
// guarantee does not depend on removing it — page JS cannot read the token
// anywhere, so there is nothing to steal.
//
// Phase 3 (this file's current state) drops the fallback entirely: the
// httpOnly cookie is now the ONLY carrier for a dashboard session. A
// Bearer/x-dashboard-token header is ignored for session auth — scripts
// and non-browser callers must log in, capture the Set-Cookie
// flm_session + flm_csrf pair, and send Cookie + X-CSRF-Token on
// mutations. The unified /v1 API key is a separate mechanism and is
// untouched.
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
//  - Path=/: the cookie also rides same-origin /v1 calls — NOT for auth
//    (/v1 still requires the unified key; requireAuth never runs there),
//    but so playgroundAttribution can attribute a Playground chat to the
//    dashboard account behind the cookie (see
//    custom/playground-attribution.ts). Scoping it to /api (as Phases 1–3
//    did) left Playground chats unattributed: the browser never sent the
//    cookie on /v1, and the old X-FreeLLM-Session header was dropped in
//    Phase 2.
//  - Legacy Path=/api cookie: after this change a browser can hold BOTH
//    cookies (the old /api one, possibly revoked, and the new / one).
//    Browsers send the longer-path cookie first and getSessionCookie takes
//    the first match, so a stale revoked /api cookie would shadow the new
//    one. Every mint therefore also clears the legacy /api cookie, and
//    logout clears both paths. The set is emitted BEFORE the legacy clear
//    so a naive first-match Set-Cookie parser still sees the live token.

export const SESSION_COOKIE_NAME = 'flm_session';

/** TLS terminated here (req.secure), or in front of us and forwarded. */
export function isHttpsRequest(req: Request): boolean {
  const forwardedProto = req.headers['x-forwarded-proto'];
  // A proxy chain sends a comma-separated list; the client-facing hop is first.
  const first = String(forwardedProto ?? '').split(',')[0]!.trim().toLowerCase();
  return first === 'https' || req.secure;
}

/** Clear the legacy Path=/api session cookie (see the Path note above).
 *  Emitted at every mint so a stale revoked /api cookie can never shadow
 *  the new Path=/ one. The attributes must match the old set call or the
 *  browser will not remove it. */
function clearLegacySessionCookie(res: Response, req: Request): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttpsRequest(req),
    path: '/api',
  });
}

/** Set the session cookie for a freshly minted token. maxAgeMs is the TTL the
 *  session row itself was created with (30 days normally, 24h for desktop). */
export function setSessionCookie(res: Response, req: Request, token: string, maxAgeMs: number): void {
  // Set first, then clear the legacy cookie: a naive first-match
  // Set-Cookie parser must see the live token, not the expired clear.
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttpsRequest(req),
    path: '/',
    maxAge: maxAgeMs,
  });
  clearLegacySessionCookie(res, req);
}

/** Clear the session cookie. Both paths are cleared: the current Path=/
 *  cookie and the legacy Path=/api one a browser may still hold. The
 *  attributes must match the set call or the browser will not remove it. */
export function clearSessionCookie(res: Response, req: Request): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttpsRequest(req),
    path: '/',
  });
  clearLegacySessionCookie(res, req);
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

/** The one place that resolves "the caller's session token": the httpOnly
 *  cookie, and nothing else. Phase 3 dropped the Authorization /
 *  x-dashboard-token header fallback — a header is ignored for session
 *  auth, so scripts and non-browser callers must present the cookie. */
export function sessionTokenFromRequest(req: Request): string | undefined {
  return getSessionCookie(req);
}
