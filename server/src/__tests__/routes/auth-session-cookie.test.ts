import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

// Phase 3 of the httpOnly-cookie session move (services/session-cookie.ts,
// services/csrf.ts): the login/setup/reset/desktop-session/register/SSO-complete
// endpoints set the session as an httpOnly `flm_session` cookie AND a readable
// `flm_csrf` double-submit cookie, and NO token ever reaches the response body.
// requireAuth accepts the cookie for mutations ONLY with a valid CSRF token
// (403 csrf_required / csrf_invalid). Phase 3 dropped the Authorization /
// x-dashboard-token header fallback entirely: a header is ignored for
// session auth, so a header-only request is a 401 and a header never rescues
// a stale cookie. (Phase 1's read-only boundary, cookie_auth_read_only, is
// gone — replaced by the CSRF gate in Phase 2.)

async function call(
  app: Express,
  method: string,
  path: string,
  opts: { body?: any; cookie?: string; headers?: Record<string, string> } = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method,
      headers: {
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.cookie ? { Cookie: opts.cookie } : {}),
        ...opts.headers,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, body: data, cookies: res.headers.getSetCookie() };
  } finally {
    server.close();
  }
}

function cookieValue(cookies: string[], name: string): string | undefined {
  const found = cookies.find(c => c.startsWith(`${name}=`));
  return found?.split(';')[0]!.slice(name.length + 1);
}

describe('Dashboard session as an httpOnly cookie — Phase 1', () => {
  let app: Express;
  let token = '';
  let csrf = '';
  let cookie = '';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  afterAll(() => {
    delete process.env.FREEAPI_DESKTOP;
  });

  it('setup mints a session and sets the cookie', async () => {
    const { status, body, cookies } = await call(app, 'POST', '/api/auth/setup', {
      body: { email: 'admin@example.com', password: 'supersecret' },
    });
    expect(status).toBe(201);
    // Phase 2: no token in the body — the session rides the httpOnly cookie.
    expect(body.token).toBeUndefined();
    token = cookieValue(cookies, 'flm_session')!;
    expect(typeof token).toBe('string');
    const value = cookieValue(cookies, 'flm_session');
    expect(value).toBe(token);
    csrf = cookieValue(cookies, 'flm_csrf')!;
    cookie = `flm_session=${value}; flm_csrf=${csrf}`;
  });

  it('login sets the cookie with httpOnly, SameSite=Lax, Path=/, 30-day Max-Age, no Secure on plain HTTP', async () => {
    const { status, body, cookies } = await call(app, 'POST', '/api/auth/login', {
      body: { email: 'admin@example.com', password: 'supersecret' },
    });
    expect(status).toBe(200);
    expect(body.token).toBeUndefined();
    token = cookieValue(cookies, 'flm_session')!;
    expect(typeof token).toBe('string');
    const setCookie = cookies.find(c => c.startsWith('flm_session='));
    expect(setCookie).toBeDefined();
    expect(cookieValue(cookies, 'flm_session')).toBe(token);
    expect(setCookie!).toContain('HttpOnly');
    expect(setCookie!).toContain('SameSite=Lax');
    expect(setCookie!).toContain('Path=/;');
    expect(setCookie!).toContain('Max-Age=2592000');
    expect(setCookie!).not.toContain('Secure');
    // The mint also clears the legacy Path=/api cookie: a browser upgrading
    // from the /api-scoped cookie may still hold a revoked one, which would
    // otherwise shadow the new cookie (browsers send the longer path first).
    const legacyClear = cookies.filter(c => c.startsWith('flm_session=') && c.includes('Path=/api'));
    expect(legacyClear).toHaveLength(1);
    expect(legacyClear[0]).toMatch(/Expires=Thu, 01 Jan 1970/);
    // The CSRF cookie rides along: readable by JS, same SameSite/Path.
    const csrfCookie = cookies.find(c => c.startsWith('flm_csrf='));
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie!).not.toContain('HttpOnly');
    expect(csrfCookie!).toContain('SameSite=Lax');
    expect(csrfCookie!).toContain('Path=/api');
    csrf = cookieValue(cookies, 'flm_csrf')!;
    cookie = `flm_session=${cookieValue(cookies, 'flm_session')}; flm_csrf=${csrf}`;
  });

  it('login over HTTPS sets the Secure flag', async () => {
    const { status, cookies } = await call(app, 'POST', '/api/auth/login', {
      body: { email: 'admin@example.com', password: 'supersecret' },
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(status).toBe(200);
    const setCookie = cookies.find(c => c.startsWith('flm_session='));
    expect(setCookie!).toContain('Secure');
  });

  it('a cookie-only GET succeeds (no header)', async () => {
    const { status } = await call(app, 'GET', '/api/keys', { cookie });
    expect(status).toBe(200);
  });

  it('a cookie-only mutation without a CSRF token is rejected with 403 csrf_required', async () => {
    const { status, body } = await call(app, 'POST', '/api/keys', { body: {}, cookie });
    expect(status).toBe(403);
    expect(body.error.type).toBe('csrf_required');
  });

  it('a header-only mutation is ignored now (401) — the cookie is the only carrier', async () => {
    // Phase 3: the Authorization header is ignored for session auth.
    const viaHeader = await call(app, 'POST', '/api/keys', {
      body: {},
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(viaHeader.status).toBe(401);
    expect(viaHeader.body.error.type).toBe('authentication_error');
    // ...and it does not rescue a stale cookie either: the cookie is used,
    // the header ignored. (CSRF pair is valid here so the request reaches
    // session validation instead of the CSRF gate.)
    const viaBoth = await call(app, 'POST', '/api/keys', {
      body: {},
      headers: { Authorization: `Bearer ${token}`, 'X-CSRF-Token': 'test-csrf' },
      cookie: 'flm_session=stale-token-that-does-not-exist; flm_csrf=test-csrf',
    });
    expect(viaBoth.status).toBe(401);
    expect(viaBoth.body.error.type).toBe('authentication_error');
  });

  it('a forged cookie is still a 401, not a pass', async () => {
    const { status, body } = await call(app, 'GET', '/api/keys', { cookie: 'flm_session=not-a-real-token' });
    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('logout clears both cookies for a presented session', async () => {
    const { status, cookies } = await call(app, 'POST', '/api/auth/logout', {
      cookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(status).toBe(200);
    const cleared = cookies.find(c => c.startsWith('flm_session='));
    expect(cleared).toBeDefined();
    // Express clearCookie expires the cookie in the past.
    expect(cleared!).toMatch(/Expires=Thu, 01 Jan 1970/);
    const csrfCleared = cookies.find(c => c.startsWith('flm_csrf='));
    expect(csrfCleared).toBeDefined();
    expect(csrfCleared!).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('logout without a session does not touch the cookie', async () => {
    const { status, cookies } = await call(app, 'POST', '/api/auth/logout', {});
    expect(status).toBe(200);
    expect(cookies.filter(c => c.startsWith('flm_session='))).toHaveLength(0);
  });

  it('desktop-session sets a 24h cookie', async () => {
    process.env.FREEAPI_DESKTOP = '1';
    const { status, body, cookies } = await call(app, 'POST', '/api/auth/desktop-session', {});
    expect(status).toBe(200);
    expect(body.token).toBeUndefined();
    const setCookie = cookies.find(c => c.startsWith('flm_session='));
    expect(setCookie).toBeDefined();
    expect(setCookie!).toContain('Max-Age=86400');
    expect(setCookie!).toContain('HttpOnly');
    expect(setCookie!).not.toContain('Secure');
    expect(cookies.find(c => c.startsWith('flm_csrf='))).toBeDefined();
    delete process.env.FREEAPI_DESKTOP;
  });
});
