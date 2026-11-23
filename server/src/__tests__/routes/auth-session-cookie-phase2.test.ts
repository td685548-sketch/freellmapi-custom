import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Express, Request, Response, NextFunction } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { preparseGuard } from '../../custom/preparse-guard.js';
import { finishGoogleLogin } from '../../services/google-auth.js';

// Phase 3 of the httpOnly-cookie session move (services/session-cookie.ts,
// services/csrf.ts): the session token never reaches browser JS — no token in
// any mint response body, nothing in sessionStorage/localStorage — and the
// httpOnly cookie authenticates mutations ONLY with the double-submit CSRF
// token (readable `flm_csrf` cookie + `X-CSRF-Token` header, compared with
// timingSafeEqual). Phase 3 dropped the Bearer header fallback entirely: a
// header is ignored for session auth, so every authenticated request needs
// the cookie (and every mutation needs the CSRF pair).

async function call(
  app: Express,
  method: string,
  path: string,
  opts: { body?: any; cookie?: string; csrf?: string; headers?: Record<string, string> } = {},
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
        ...(opts.csrf ? { 'X-CSRF-Token': opts.csrf } : {}),
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

describe('Dashboard session without a JS-readable token — Phase 2', () => {
  let app: Express;
  let token = '';
  let sessionCookie = '';
  let csrfCookie = '';
  let csrfValue = '';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  afterAll(() => {
    delete process.env.FREEAPI_DESKTOP;
  });

  it('setup mints a session with no token in the body, and sets both cookies', async () => {
    const { status, body, cookies } = await call(app, 'POST', '/api/auth/setup', {
      body: { email: 'admin@example.com', password: 'supersecret' },
    });
    expect(status).toBe(201);
    expect(body.token).toBeUndefined();
    token = cookieValue(cookies, 'flm_session')!;
    csrfValue = cookieValue(cookies, 'flm_csrf')!;
    expect(typeof token).toBe('string');
    expect(typeof csrfValue).toBe('string');
    sessionCookie = `flm_session=${token}`;
    csrfCookie = `flm_csrf=${csrfValue}`;
  });

  it('login also returns no token, and sets both cookies', async () => {
    const { status, body, cookies } = await call(app, 'POST', '/api/auth/login', {
      body: { email: 'admin@example.com', password: 'supersecret' },
    });
    expect(status).toBe(200);
    expect(body.token).toBeUndefined();
    expect(body).toEqual({ email: 'admin@example.com' });
    token = cookieValue(cookies, 'flm_session')!;
    csrfValue = cookieValue(cookies, 'flm_csrf')!;
    sessionCookie = `flm_session=${token}`;
    csrfCookie = `flm_csrf=${csrfValue}`;
  });

  it('a cookie-only GET still works', async () => {
    const { status } = await call(app, 'GET', '/api/keys', { cookie: sessionCookie });
    expect(status).toBe(200);
  });

  it('cookie-only /status and /me work', async () => {
    const status = await call(app, 'GET', '/api/auth/status', { cookie: sessionCookie });
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ authenticated: true, email: 'admin@example.com' });
    const me = await call(app, 'GET', '/api/auth/me', { cookie: sessionCookie });
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('admin@example.com');
  });

  it('/status mints a CSRF cookie when the session cookie is present but the CSRF cookie is missing', async () => {
    const { status, cookies } = await call(app, 'GET', '/api/auth/status', { cookie: sessionCookie });
    expect(status).toBe(200);
    expect(cookieValue(cookies, 'flm_csrf')).toBeTruthy();
  });

  it('a cookie-only mutation WITH a valid CSRF token succeeds', async () => {
    // {} fails the handler's own validation with 400 — the point is it gets
    // past requireAuth, unlike the cookie-only call without CSRF below.
    const { status } = await call(app, 'POST', '/api/keys', {
      body: {},
      cookie: `${sessionCookie}; ${csrfCookie}`,
      csrf: csrfValue,
    });
    expect(status).toBe(400);
  });

  it('a cookie-only mutation without a CSRF token is rejected with 403 csrf_required', async () => {
    const { status, body } = await call(app, 'POST', '/api/keys', {
      body: {},
      cookie: `${sessionCookie}; ${csrfCookie}`,
    });
    expect(status).toBe(403);
    expect(body.error.type).toBe('csrf_required');
  });

  it('a cookie-only mutation with a forged CSRF token is rejected with 403 csrf_invalid', async () => {
    const { status, body } = await call(app, 'POST', '/api/keys', {
      body: {},
      cookie: `${sessionCookie}; ${csrfCookie}`,
      csrf: 'forged-csrf-value',
    });
    expect(status).toBe(403);
    expect(body.error.type).toBe('csrf_invalid');
  });

  it('a cookie-only mutation with the header but no CSRF cookie is rejected', async () => {
    const { status, body } = await call(app, 'POST', '/api/keys', {
      body: {},
      cookie: sessionCookie,
      csrf: csrfValue,
    });
    expect(status).toBe(403);
    expect(body.error.type).toBe('csrf_required');
  });

  it('a header-only mutation is ignored now (401) — the cookie is the only carrier', async () => {
    const { status, body } = await call(app, 'POST', '/api/keys', {
      body: {},
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('change-password with cookie+CSRF and a wrong password reaches the handler (403 invalid_password)', async () => {
    const { status, body } = await call(app, 'POST', '/api/auth/change-password', {
      body: { currentPassword: 'wrongpassword', newPassword: 'brand-new-password-1' },
      cookie: `${sessionCookie}; ${csrfCookie}`,
      csrf: csrfValue,
    });
    expect(status).toBe(403);
    expect(body.error.type).toBe('invalid_password');
  });

  it('change-password cookie-only without CSRF is stopped by the gate (403 csrf_required)', async () => {
    const { status, body } = await call(app, 'POST', '/api/auth/change-password', {
      body: { currentPassword: 'wrongpassword', newPassword: 'brand-new-password-1' },
      cookie: `${sessionCookie}; ${csrfCookie}`,
    });
    expect(status).toBe(403);
    expect(body.error.type).toBe('csrf_required');
  });

  it('Google complete returns no token in the body, and sets both cookies', async () => {
    // Link a Google identity to the setup account, then mint a handoff ticket
    // the way the OAuth callback does — no browser or Google involved.
    const user = getDb().prepare('SELECT id FROM users WHERE email = ?').get('admin@example.com') as { id: number };
    getDb().prepare('INSERT INTO auth_google_identities (subject, user_id) VALUES (?, ?)').run('google-subject-1', user.id);
    const ticket = finishGoogleLogin({ subject: 'google-subject-1', email: 'admin@example.com', authoritative: true });

    const { status, body, cookies } = await call(app, 'POST', '/api/auth/google/complete', {
      cookie: `flm_google_result=${ticket}`,
    });
    expect(status).toBe(200);
    expect(body.token).toBeUndefined();
    expect(cookieValue(cookies, 'flm_session')).toBeTruthy();
    expect(cookieValue(cookies, 'flm_csrf')).toBeTruthy();
  });

  it('desktop-session returns no token in the body, and sets both cookies', async () => {
    process.env.FREEAPI_DESKTOP = '1';
    const { status, body, cookies } = await call(app, 'POST', '/api/auth/desktop-session', {});
    expect(status).toBe(200);
    expect(body.token).toBeUndefined();
    expect(cookieValue(cookies, 'flm_session')).toBeTruthy();
    expect(cookieValue(cookies, 'flm_csrf')).toBeTruthy();
    delete process.env.FREEAPI_DESKTOP;
  });

  it('logout cookie-only without CSRF is rejected and the session survives', async () => {
    const { status, body } = await call(app, 'POST', '/api/auth/logout', { cookie: sessionCookie });
    expect(status).toBe(403);
    expect(body.error.type).toBe('csrf_required');
    const { status: getStatus } = await call(app, 'GET', '/api/keys', { cookie: sessionCookie });
    expect(getStatus).toBe(200);
  });

  it('logout with cookie+CSRF clears both cookies and invalidates the session', async () => {
    const { status, cookies } = await call(app, 'POST', '/api/auth/logout', {
      cookie: `${sessionCookie}; ${csrfCookie}`,
      csrf: csrfValue,
    });
    expect(status).toBe(200);
    const clearedSession = cookies.find(c => c.startsWith('flm_session='));
    const clearedCsrf = cookies.find(c => c.startsWith('flm_csrf='));
    expect(clearedSession).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(clearedCsrf).toMatch(/Expires=Thu, 01 Jan 1970/);
    // Logout clears the session cookie on both paths: the current Path=/
    // cookie and the legacy Path=/api one a browser may still hold.
    const clearedSessions = cookies.filter(c => c.startsWith('flm_session='));
    expect(clearedSessions.filter(c => c.includes('Path=/;'))).toHaveLength(1);
    expect(clearedSessions.filter(c => c.includes('Path=/api'))).toHaveLength(1);
    expect(clearedSessions.every(c => /Expires=Thu, 01 Jan 1970/.test(c))).toBe(true);
    const { status: getStatus, body } = await call(app, 'GET', '/api/keys', { cookie: sessionCookie });
    expect(getStatus).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });
});

describe('preparse guard with the cookie (Phase 2)', () => {
  let app: Express;
  let token = '';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  // The guard runs before auth and only refuses LARGE bodies from callers
  // with no credential — and only off loopback (a local socket is trusted).
  // These call the guard directly with a non-loopback socket, the way a
  // remote dashboard upload would arrive through a reverse proxy.
  function runGuard(opts: { cookie?: string; token?: string; contentLength?: number }) {
    const req = {
      method: 'POST',
      path: '/api/keys',
      socket: { remoteAddress: '203.0.113.7' },
      headers: {
        'content-length': String(opts.contentLength ?? 300 * 1024),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      query: {},
    } as unknown as Request;
    let status = 0;
    let body: any = null;
    const res = {
      setHeader: () => {},
      status: (code: number) => {
        status = code;
        return { json: (b: any) => { body = b; } };
      },
    } as unknown as Response;
    const next = vi.fn();
    preparseGuard(req, res, next as unknown as NextFunction);
    return { next, status, body };
  }

  it('admits a large body carrying the session cookie', async () => {
    const login = await call(app, 'POST', '/api/auth/setup', {
      body: { email: 'admin@example.com', password: 'supersecret' },
    });
    token = cookieValue(login.cookies, 'flm_session')!;
    const { next, status } = runGuard({ cookie: `flm_session=${token}` });
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).toBe(0);
  });

  it('refuses a large body carrying only a Bearer header (401) — the header is ignored now', () => {
    const { next, status, body } = runGuard({ token });
    expect(next).not.toHaveBeenCalled();
    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('refuses a large anonymous body with 401, without calling next', () => {
    const { next, status, body } = runGuard({});
    expect(next).not.toHaveBeenCalled();
    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('refuses a large body with a forged cookie with 401', () => {
    const { next, status } = runGuard({ cookie: 'flm_session=not-a-real-token' });
    expect(next).not.toHaveBeenCalled();
    expect(status).toBe(401);
  });

  it('leaves a small anonymous body alone', () => {
    const { next, status } = runGuard({ contentLength: 1024 });
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).toBe(0);
  });
});
