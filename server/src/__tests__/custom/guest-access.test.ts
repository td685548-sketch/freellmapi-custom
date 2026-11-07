import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setUserPermissions } from '../../services/users.js';
import { resetGuestCache, setGuestPermissions } from '../../services/guest-access.js';

// Signed-out visitors ("guests") may read exactly the views an administrator opened, and nothing else.

describe('guest access', () => {
  let server: Server;
  let base: string;
  let ownerId: number;
  let ownerToken: string;
  let delegateId: number;
  let delegateToken: string;
  const SECRET = 'gsk_guest_must_never_see_this';

  const get = async (path: string, token?: string, method = 'GET', body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* csv */ }
    return { status: res.status, text, body: json, headers: res.headers };
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const key = encrypt(SECRET);
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','prod key',?,?,?,'healthy',1)`).run(key.encrypted, key.iv, key.authTag);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    ownerId = createUser('owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);
    delegateId = createUser('delegate@example.com', 'DelegatePass123!', 'member').userId;
    delegateToken = createSession(delegateId);
  });
  afterAll(() => { server?.close(); });
  beforeEach(() => { setGuestPermissions([]); resetGuestCache(); });

  it('gives nothing to signed-out visitors by default', async () => {
    expect((await get('/api/auth/guest')).body).toEqual({ permissions: [] });
    expect((await get('/api/fallback')).status).toBe(401);
    expect((await get('/api/user/session')).status).toBe(401);
  });

  it('opens the Models views read-only once allowed, and nothing more', async () => {
    expect((await get('/api/admin/guest-access', ownerToken, 'PUT', { permissions: ['view_models'] })).body.permissions).toEqual(['view_models']);
    expect((await get('/api/auth/guest')).body).toEqual({ permissions: ['view_models'] });
    expect((await get('/api/user/session')).body).toMatchObject({ role: 'guest', userId: 0, permissions: ['view_models'], guest: true });
    for (const path of ['/api/fallback', '/api/fallback/token-usage', '/api/fallback/routing', '/api/fallback/rate-limit-usage', '/api/profiles/active']) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      expect(r.text, path).not.toContain(SECRET);
      expect(r.text, path).not.toMatch(/encrypted|auth_tag/);
    }
    // which stored key or custom endpoint serves a model stays private
    getDb().prepare("UPDATE models SET key_id = 1 WHERE id = (SELECT MIN(id) FROM models WHERE platform = 'groq')").run();
    resetGuestCache();
    const chain = (await get('/api/fallback')).body as Array<Record<string, unknown>>;
    expect(chain.every(e => e.keyId === null && e.keyLabel === null && e.endpointScope === null && e.qualifiedModelId === null)).toBe(true);
    const asOwner = (await get('/api/fallback', ownerToken)).body as Array<Record<string, unknown>>;
    expect(asOwner.some(e => e.keyId === 1 && e.keyLabel === 'prod key')).toBe(true);
    expect(JSON.stringify(chain)).not.toContain('prod key');
    // never a write, never another view
    expect((await get('/api/fallback', undefined, 'PUT', [])).status).toBe(401);
    expect((await get('/api/fallback/routing', undefined, 'PUT', { strategy: 'priority' })).status).toBe(401);
    for (const path of ['/api/keys', '/api/settings/api-key', '/api/usage/profiles', '/api/usage/accounts', '/api/admin/users', '/api/client-profiles', '/api/models', '/api/analytics', '/api/fallback/chain', '/api/logs']) {
      expect((await get(path)).status, path).toBe(401);
    }
    // a wrong or expired token is not a guest: the dashboard is told to sign in again
    expect((await get('/api/fallback', 'not-a-session')).status).toBe(401);
  });

  it('answers guests from one shared 30-second copy', async () => {
    setGuestPermissions(['view_models']);
    expect((await get('/api/fallback/token-usage')).headers.get('x-guest-cache')).toBeNull();
    const second = await get('/api/fallback/token-usage');
    expect(second.status).toBe(200);
    expect(second.headers.get('x-guest-cache')).toBe('hit');
    expect(second.headers.get('content-type')).toContain('application/json');
    // signed-in users never get the guest copy
    expect((await get('/api/fallback/token-usage', ownerToken)).headers.get('x-guest-cache')).toBeNull();
  });

  it('opens the client key ranking and its export separately from accounts', async () => {
    setGuestPermissions(['view_usage_profiles']);
    expect((await get('/api/usage/profiles')).status).toBe(200);
    expect((await get('/api/usage/export/profiles.csv')).text).toContain('day,client_key_id');
    expect((await get('/api/usage/accounts')).status).toBe(401);
    expect((await get('/api/usage/export/accounts.csv')).status).toBe(401);
    expect((await get('/api/fallback')).status).toBe(401);
  });

  it('lets only account-permission managers change guest access, and only to read permissions', async () => {
    expect((await get('/api/admin/guest-access', ownerToken, 'PUT', { permissions: ['manage_keys'] })).status).toBe(400);
    expect((await get('/api/admin/guest-access', ownerToken, 'PUT', { permissions: ['view_keys'] })).status).toBe(400);
    setUserPermissions(delegateId, ['view_users'], ownerId);
    const seen = await get('/api/admin/guest-access', delegateToken);
    expect(seen.status).toBe(200);
    expect(seen.body.available.map((p: any) => p.key)).toEqual(['view_models', 'view_usage_profiles', 'view_usage_accounts', 'try_playground']);
    expect((await get('/api/admin/guest-access', delegateToken, 'PUT', { permissions: ['view_models'] })).status).toBe(403);
    setUserPermissions(delegateId, ['edit_user_permissions'], ownerId);
    expect((await get('/api/admin/guest-access', delegateToken, 'PUT', { permissions: ['view_models'] })).status).toBe(200);
    setUserPermissions(delegateId, [], ownerId);
    expect((await get('/api/admin/guest-access')).status).toBe(401); // a guest cannot open its own door
  });
});
