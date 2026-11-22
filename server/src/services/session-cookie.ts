import type { Request, Response } from 'express';

// Dashboard session as an httpOnly cookie — Phase 1 of the session-cookie
// migration (see client/src/lib/api.ts for the sessionStorage side).
//
// Phase 1 only proves the mechanism end to end, with zero breakage risk:
//  - the login/setup/reset/desktop-session/register/SSO-complete endpoints
//    ALSO set the session token as a cookie (the JSON body still carries it,
//    and the client still stores it in sessionStorage and sends the
//    Authorization header exactly as before);
//  - requireAuth ALSO accepts the cookie, but ONLY for safe methods
//    (GET/HEAD/OPTIONS). A cookie-only mutation is rejected with
//    403 cookie_auth_read_only: accepting cookie auth means a cross-site
//    request now carries credentials where before it could not (the attacker
//    never knew the header), and this boundary is what keeps Phase 1 from
//    opening that hole. The full CSRF-token system for cookie-authed
//    mutations is a later phase; until then the header stays the only way
//    to write.
//  - the client sends `credentials: 'same-origin'` so the cookie rides
//    along on same-origin dashboard calls (the Vite dev proxy makes dev
//    calls same-origin too; a separately-hosted dashboard origin simply
//    never sends the cookie and keeps working on the header).
//
// The security win lands in Phase 2 (stop storing the token in
// sessionStorage), not here: today the token is still readable by any script
// on the dashboard origin. Phase 1 only proves the cookie is set, sent and
// accepted before anything is taken away.
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
function isHttpsRequest(req: Request): boolean {
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
