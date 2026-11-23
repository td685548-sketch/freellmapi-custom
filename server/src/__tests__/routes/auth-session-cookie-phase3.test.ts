import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, regenerateUnifiedKey } from '../../db/index.js';
import { setGuestPermissions } from '../../services/guest-access.js';

// Phase 3 of the httpOnly-cookie session move (services/session-cookie.ts,
// services/csrf.ts): the Authorization / x-dashboard-token header fallback
// is gone — the httpOnly `flm_session` cookie is the ONLY carrier for a
// dashboard session. A header is ignored for session auth: a header-only
// request is a 401, a header never rescues a stale cookie, and every
// authenticated mutation still needs the double-submit CSRF pair
// (readable `flm_csrf` cookie + `X-CSRF-Token` header). Scripts and
// non-browser callers must log in, capture the Set-Cookie pair, and send
// Cookie + X-CSRF-Token — there is no header login anymore. The unified
// /v1 API key is a separate mechanism and is untouched.

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

describe('Dashboard session is cookie-only — Phase 3', () => {
  let app: Express;
  let token = '';
  let csrfValue = '';
  let sessionCookie = '';
  let csrfCookie = '';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  afterAll(() => {
    setGuestPermissions([]);
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

  it('a header-only GET is a 401 — the header is ignored for session auth', async () => {
    const { status, body } = await call(app, 'GET', '/api/keys', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('a header-only mutation is a 401', async () => {
    const { status, body } = await call(app, 'POST', '/api/keys', {
      body: {},
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('a valid cookie is used even with a bogus header alongside it', async () => {
    const { status } = await call(app, 'GET', '/api/keys', {
      cookie: sessionCookie,
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    expect(status).toBe(200);
  });

  it('a cookie mutation without a CSRF token is rejected with 403 csrf_required', async () => {
    const { status, body } = await call(app, 'POST', '/api/keys', {
      body: {},
      cookie: `${sessionCookie}; ${csrfCookie}`,
    });
    expect(status).toBe(403);
    expect(body.error.type).toBe('csrf_required');
  });

  it('a cookie mutation with a matching CSRF pair gets past requireAuth', async () => {
    // {} fails the handler's own validation with 400 — the point is it gets
    // past requireAuth, unlike the cookie-only call without CSRF above.
    const { status } = await call(app, 'POST', '/api/keys', {
      body: {},
      cookie: `${sessionCookie}; ${csrfCookie}`,
      headers: { 'X-CSRF-Token': csrfValue },
    });
    expect(status).toBe(400);
  });

  it('script flow: login, capture Set-Cookie, then mutate with Cookie + X-CSRF-Token', async () => {
    // A non-browser caller has no header login anymore: log in, read the
    // Set-Cookie pair, and send it back on the mutation.
    const login = await call(app, 'POST', '/api/auth/login', {
      body: { email: 'admin@example.com', password: 'supersecret' },
    });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeUndefined();
    const scriptToken = cookieValue(login.cookies, 'flm_session')!;
    const scriptCsrf = cookieValue(login.cookies, 'flm_csrf')!;
    expect(typeof scriptToken).toBe('string');
    expect(typeof scriptCsrf).toBe('string');
    const { status } = await call(app, 'POST', '/api/keys', {
      body: {},
      cookie: `flm_session=${scriptToken}; flm_csrf=${scriptCsrf}`,
      headers: { 'X-CSRF-Token': scriptCsrf },
    });
    expect(status).toBe(400);
  });

  it('a unified API key on a guest route is not guest content (401), while no credential is', async () => {
    // Phase 3 guest edge: a caller presenting only a unified key on a guest
    // GET route was previously passed through (then 401'd by requireAuth,
    // since a key is not a session). That is preserved: the key counts as a
    // credential, so the request is not served guest content.
    setGuestPermissions(['view_models']);
    try {
      const guest = await call(app, 'GET', '/api/user/session', {});
      expect(guest.status).toBe(200);
      expect(guest.body.role).toBe('guest');

      const key = regenerateUnifiedKey();
      const keyed = await call(app, 'GET', '/api/user/session', {
        headers: { Authorization: `Bearer ${key}` },
      });
      expect(keyed.status).toBe(401);
      expect(keyed.body.error.type).toBe('authentication_error');
    } finally {
      setGuestPermissions([]);
    }
  });
});
