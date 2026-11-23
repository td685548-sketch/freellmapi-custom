import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

// Phase 1 of the httpOnly-cookie session move (services/session-cookie.ts):
// the login/setup/reset/desktop-session/register/SSO-complete endpoints ALSO
// set the session token as an httpOnly `flm_session` cookie, requireAuth
// ALSO accepts it — but only for safe methods. A cookie-only mutation is
// rejected with 403 cookie_auth_read_only, and the header keeps working
// exactly as before.

async function call(
  app: Express,
  method: string,
  path: string,
  opts: { body?: any; token?: string; cookie?: string; headers?: Record<string, string> } = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method,
      headers: {
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
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
    expect(typeof body.token).toBe('string');
    token = body.token;
    const value = cookieValue(cookies, 'flm_session');
    expect(value).toBe(token);
    cookie = `flm_session=${value}`;
  });

  it('login sets the cookie with httpOnly, SameSite=Lax, Path=/api, 30-day Max-Age, no Secure on plain HTTP', async () => {
    const { status, body, cookies } = await call(app, 'POST', '/api/auth/login', {
      body: { email: 'admin@example.com', password: 'supersecret' },
    });
    expect(status).toBe(200);
    expect(typeof body.token).toBe('string');
    token = body.token;
    const setCookie = cookies.find(c => c.startsWith('flm_session='));
    expect(setCookie).toBeDefined();
    expect(cookieValue(cookies, 'flm_session')).toBe(token);
    expect(setCookie!).toContain('HttpOnly');
    expect(setCookie!).toContain('SameSite=Lax');
    expect(setCookie!).toContain('Path=/api');
    expect(setCookie!).toContain('Max-Age=2592000');
    expect(setCookie!).not.toContain('Secure');
    cookie = `flm_session=${cookieValue(cookies, 'flm_session')}`;
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

  it('a cookie-only mutation is rejected with 403 cookie_auth_read_only', async () => {
    const { status, body } = await call(app, 'POST', '/api/keys', { body: {}, cookie });
    expect(status).toBe(403);
    expect(body.error.type).toBe('cookie_auth_read_only');
  });

  it('header auth still works for mutations, and the header wins over a stale cookie', async () => {
    // {} fails the handler's own validation with 400 — the point is it gets
    // past requireAuth, unlike the cookie-only call above.
    const viaHeader = await call(app, 'POST', '/api/keys', { body: {}, token });
    expect(viaHeader.status).toBe(400);
    const viaBoth = await call(app, 'POST', '/api/keys', {
      body: {},
      token,
      cookie: 'flm_session=stale-token-that-does-not-exist',
    });
    expect(viaBoth.status).toBe(400);
  });

  it('a forged cookie is still a 401, not a pass', async () => {
    const { status, body } = await call(app, 'GET', '/api/keys', { cookie: 'flm_session=not-a-real-token' });
    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('logout clears the cookie for a presented session', async () => {
    const { status, cookies } = await call(app, 'POST', '/api/auth/logout', { token });
    expect(status).toBe(200);
    const cleared = cookies.find(c => c.startsWith('flm_session='));
    expect(cleared).toBeDefined();
    // Express clearCookie expires the cookie in the past.
    expect(cleared!).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('logout without a session does not touch the cookie', async () => {
    const { status, cookies } = await call(app, 'POST', '/api/auth/logout', {});
    expect(status).toBe(200);
    expect(cookies.filter(c => c.startsWith('flm_session='))).toHaveLength(0);
  });

  it('desktop-session sets a 24h cookie', async () => {
    process.env.FREEAPI_DESKTOP = '1';
    const { status, cookies } = await call(app, 'POST', '/api/auth/desktop-session', {});
    expect(status).toBe(200);
    const setCookie = cookies.find(c => c.startsWith('flm_session='));
    expect(setCookie).toBeDefined();
    expect(setCookie!).toContain('Max-Age=86400');
    expect(setCookie!).toContain('HttpOnly');
    expect(setCookie!).not.toContain('Secure');
    delete process.env.FREEAPI_DESKTOP;
  });
});
