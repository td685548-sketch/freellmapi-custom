import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDb, defaultDbFactory, type Db } from '../../db/index.js';
import { nodeSqliteFactory } from '../../db/node-sqlite.js';
import { initEncryptionKey } from '../../lib/crypto.js';
import * as store from '../../custom/x-gateway/support-store.js';

let db: Db;
beforeEach(() => {
  db = connectDb(':memory:', { factory: path => {
    try { return defaultDbFactory()(path); } catch (error) {
      // Some development installs have an incompatible native addon. Exercise
      // real SQLite through the shipped adapter on Node 22.13+ in that case.
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DLOPEN_FAILED') throw error;
      return nodeSqliteFactory(path);
    }
  } });
  vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
  initEncryptionKey(db);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  db?.close?.();
});

function tenant(name = 'Demo Shop') { return store.createSupportTenant({ name }); }
function user() {
  return { userId: 'cust_101', name: 'Alice', email: 'alice@example.com', role: 'customer',
    permissions: ['orders:read_own', 'tickets:create'], metadata: { locale: 'vi' } };
}
function signed(secret: string, payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `sup_ctx_${encoded}.${crypto.createHmac('sha256', secret).update(encoded).digest('base64url')}`;
}
function expectStatus(action: () => unknown, status: number) {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(store.SupportStoreError);
    expect(error).toHaveProperty('status', status);
    return;
  }
  expect.fail(`Expected SupportStoreError(${status}).`);
}

describe('support tenants', () => {
  it('bootstraps fresh connections, lists tenants and exposes only masked secrets', () => {
    expect(store.listSupportTenants()).toEqual([]);
    const { tenant: created, signingSecret } = tenant();
    expect(created).toMatchObject({ name: 'Demo Shop', slug: 'demo-shop', defaultModel: 'auto',
      allowGuest: true, enabled: true, createdBy: null, rolesConfig: store.DEFAULT_SUPPORT_ROLES });
    expect(created.publicKey).toMatch(/^pk_sup_[a-f0-9]+$/);
    expect(created.signingSecretMasked).not.toBe(signingSecret);
    expect(JSON.stringify(created)).not.toContain(signingSecret);
    expect(store.getSupportTenantSigningSecret(created.id)).toBe(signingSecret);
    expect(store.getSupportTenantByPublicKey(created.publicKey)).toEqual(created);
    expect(store.listSupportTenants()).toEqual([created]);
    const stored = db.prepare('SELECT * FROM x_support_tenants WHERE id = ?').get(created.id);
    expect(JSON.stringify(stored)).not.toContain(signingSecret);
    expect(stored).toHaveProperty('secret_auth_tag');
    expect(Date.parse(created.createdAt)).not.toBeNaN();
  });

  it('updates tenant settings, preserves immutable fields and handles conflicts', () => {
    const { tenant: created } = tenant();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 1000));
    const updated = store.updateSupportTenant(created.id, { name: 'Renamed', slug: 'renamed', defaultModel: 'combo:support',
      systemPrompt: 'Help customers', allowedOrigins: ['https://shop.example'], allowGuest: false,
      rolesConfig: [{ role: 'member', label: 'Member', permissions: ['read'] }], enabled: false });
    expect(updated).toMatchObject({ name: 'Renamed', slug: 'renamed', allowGuest: false, enabled: false,
      defaultModel: 'combo:support', systemPrompt: 'Help customers', allowedOrigins: ['https://shop.example'] });
    expect(updated.publicKey).toBe(created.publicKey);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect(store.updateSupportTenant(created.id, {})).toEqual(updated);
    expectStatus(() => store.createSupportTenant({ name: 'Duplicate', slug: 'renamed' }), 409);
    const other = tenant('Other').tenant;
    expectStatus(() => store.updateSupportTenant(other.id, { slug: 'renamed' }), 409);
    expectStatus(() => store.updateSupportTenant(other.id, { slug: 'invalid slug' }), 400);
    expectStatus(() => store.createSupportTenant({ name: '' }), 400);
    expectStatus(() => store.updateSupportTenant(other.id, { rolesConfig: [
      { role: 'guest', label: 'A', permissions: [] }, { role: 'guest', label: 'B', permissions: [] },
    ] }), 400);
  });

  it('rotates the secret and invalidates existing tokens without changing the public key', () => {
    const original = tenant();
    const token = store.mintSupportUserToken(original.tenant.id, user());
    const rotated = store.rotateSupportTenantSecret(original.tenant.id);
    expect(rotated.signingSecret).not.toBe(original.signingSecret);
    expect(rotated.tenant.publicKey).toBe(original.tenant.publicKey);
    expect(store.getSupportTenantSigningSecret(original.tenant.id)).toBe(rotated.signingSecret);
    expectStatus(() => store.verifySupportUserToken(original.tenant.id, token), 401);
    expect(store.verifySupportUserToken(original.tenant.id, store.mintSupportUserToken(rotated.signingSecret, user())).verified).toBe(true);
  });

  it('returns 404 for missing lookups and deletes child configurations atomically', () => {
    const { tenant: created } = tenant();
    store.createSupportTool(created.id, { name: 'orders', endpointUrl: 'https://example.com/orders' });
    store.createSupportDbSource(created.id, { name: 'Orders' });
    const other = tenant('Other').tenant;
    const otherTool = store.createSupportTool(other.id, { name: 'orders', endpointUrl: 'https://example.com/orders' });
    expect(store.deleteSupportTenant(created.id)).toBe(true);
    expect(store.deleteSupportTenant(created.id)).toBe(false);
    expect(db.prepare('SELECT * FROM x_support_tools WHERE tenant_id = ?').all(created.id)).toEqual([]);
    expect(db.prepare('SELECT * FROM x_support_db_sources WHERE tenant_id = ?').all(created.id)).toEqual([]);
    expect(store.getSupportTool(other.id, otherTool.id)).toEqual(otherTool);
    expectStatus(() => store.getSupportTenant(created.id), 404);
    expectStatus(() => store.getSupportTenantByPublicKey('missing'), 404);
    expectStatus(() => store.rotateSupportTenantSecret(created.id), 404);
    expectStatus(() => store.getSupportTenantSigningSecret(created.id), 404);
    expectStatus(() => store.listSupportTools(created.id), 404);
    expectStatus(() => store.listSupportDbSources(created.id), 404);
  });

  it('rolls back child deletion if deleting the tenant fails', () => {
    const { tenant: created } = tenant();
    const tool = store.createSupportTool(created.id, { name: 'orders', endpointUrl: 'https://example.com' });
    const source = store.createSupportDbSource(created.id, { name: 'Orders' });
    db.exec(`CREATE TRIGGER prevent_tenant_delete BEFORE DELETE ON x_support_tenants
      BEGIN SELECT RAISE(ABORT, 'delete blocked'); END;`);
    expect(() => store.deleteSupportTenant(created.id)).toThrow('delete blocked');
    expect(store.getSupportTenant(created.id)).toEqual(created);
    expect(store.getSupportTool(created.id, tool.id)).toEqual(tool);
    expect(store.getSupportDbSource(created.id, source.id)).toEqual(source);
  });
});

describe('signed support user context', () => {
  it('mints the shared format with expiry and merges role and signed permissions', () => {
    const { tenant: created, signingSecret } = tenant();
    for (const key of [created.id, signingSecret]) {
      const token = store.mintSupportUserToken(key, user());
      expect(token).toMatch(/^sup_ctx_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
      const payload = JSON.parse(Buffer.from(token.slice(8).split('.')[0], 'base64url').toString());
      expect(payload.exp - payload.iat).toBe(3600);
      expect(store.verifySupportUserToken(created.id, token)).toEqual({
        tenantId: created.id, ...user(), permissions: ['products:read', 'orders:read_own', 'tickets:create'],
        verified: true, expiresAt: payload.exp,
      });
    }
  });

  it('uses the current role configuration and allows custom signed roles', () => {
    const { tenant: created } = tenant();
    const token = store.mintSupportUserToken(created.id, { userId: 'u1', role: 'agent' });
    store.updateSupportTenant(created.id, { rolesConfig: [{ role: 'agent', label: 'Agent', permissions: ['tickets:read'] }] });
    expect(store.verifySupportUserToken(created.id, token).permissions).toEqual(['tickets:read']);
  });

  it.each([undefined, null, ''])('falls back to guest only for a missing token: %s', token => {
    const { tenant: created } = tenant();
    expect(store.verifySupportUserToken(created.id, token)).toEqual({ tenantId: created.id, userId: 'guest', name: 'Guest',
      role: 'guest', permissions: ['products:read'], verified: false });
    store.updateSupportTenant(created.id, { allowGuest: false });
    expect(() => store.verifySupportUserToken(created.id, token)).toThrow('Support context token is required.');
    expectStatus(() => store.verifySupportUserToken(created.id, token), 401);
  });

  it('rejects payload/signature tampering, other tenant keys and malformed tokens even when guests are allowed', () => {
    const { tenant: created } = tenant();
    const other = tenant('Other');
    const token = store.mintSupportUserToken(created.id, user());
    const [body, signature] = token.slice(8).split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), role: 'admin' })).toString('base64url');
    for (const invalid of ['garbage', ' ', 'sup_ctx_a.a', `${token}.extra`, `sup_ctx_${forged}.${signature}`,
      `sup_ctx_${body}.${'A'.repeat(43)}`, store.mintSupportUserToken(other.signingSecret, user())]) {
      expectStatus(() => store.verifySupportUserToken(created.id, invalid), 401);
    }
    expectStatus(() => store.verifySupportUserToken(other.tenant.id, token), 401);
  });

  it('expires at the exact deadline and rejects malformed signed claims', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
    const { tenant: created, signingSecret } = tenant();
    const now = Math.floor(Date.now() / 1000);
    const token = store.mintSupportUserToken(created.id, { ...user(), ttlSeconds: 10 });
    vi.advanceTimersByTime(9000);
    expect(store.verifySupportUserToken(created.id, token).verified).toBe(true);
    vi.advanceTimersByTime(1000);
    expectStatus(() => store.verifySupportUserToken(created.id, token), 401);
    for (const patch of [{ exp: undefined }, { exp: 'forever' }, { exp: now - 1 }, { iat: now + 100 },
      { userId: '' }, { role: null }, { permissions: '*' }, { metadata: [] }, { tenantId: created.id + 1 }]) {
      expectStatus(() => store.verifySupportUserToken(created.id, signed(signingSecret,
        { ...user(), iat: now, exp: now + 3600, ...patch })), 401);
    }
    const malformed = Buffer.from('{').toString('base64url');
    const sig = crypto.createHmac('sha256', signingSecret).update(malformed).digest('base64url');
    expectStatus(() => store.verifySupportUserToken(created.id, `sup_ctx_${malformed}.${sig}`), 401);
  });

  it('rejects disabled tenants and invalid mint inputs', () => {
    const { tenant: created } = tenant();
    const token = store.mintSupportUserToken(created.id, user());
    store.updateSupportTenant(created.id, { enabled: false });
    expectStatus(() => store.verifySupportUserToken(created.id, token), 403);
    expectStatus(() => store.verifySupportUserToken(created.id, null), 403);
    for (const ttlSeconds of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) {
      expectStatus(() => store.mintSupportUserToken(created.id, { ...user(), ttlSeconds }), 400);
    }
    expectStatus(() => store.mintSupportUserToken('', user()), 400);
  });
});

describe('support webhook tools', () => {
  it('stores role policies, preserves partial updates and enforces per-tenant names', () => {
    const { tenant: created } = tenant();
    const input = { name: 'get_orders', description: 'Read orders', endpointUrl: 'https://shop.example/orders',
      headers: { Authorization: 'Bearer webhook-key' }, parametersSchema: { type: 'object' },
      allowedRoles: ['customer', 'admin'], lockUserIdParam: 'user_id', bypassUserLockRoles: ['admin'] };
    const tool = store.createSupportTool(created.id, input);
    expect(tool).toMatchObject({ ...input, tenantId: created.id, method: 'POST', enabled: true });
    expect(store.listSupportTools(created.id)).toEqual([tool]);
    const updated = store.updateSupportTool(created.id, tool.id, { method: 'GET', enabled: false, allowedRoles: [], lockUserIdParam: null });
    expect(updated).toMatchObject({ ...input, method: 'GET', enabled: false, allowedRoles: [], lockUserIdParam: null });
    expect(store.updateSupportTool(created.id, tool.id, {})).toEqual({ ...updated, updatedAt: expect.any(String) });
    expectStatus(() => store.createSupportTool(created.id, input), 409);
    const other = tenant('Other').tenant;
    expect(store.createSupportTool(other.id, input).tenantId).toBe(other.id);
    expectStatus(() => store.getSupportTool(other.id, tool.id), 404);
    expectStatus(() => store.updateSupportTool(other.id, tool.id, { name: 'stolen' }), 404);
    expect(store.deleteSupportTool(other.id, tool.id)).toBe(false);
    expect(store.deleteSupportTool(created.id, tool.id)).toBe(true);
    expect(store.deleteSupportTool(created.id, tool.id)).toBe(false);
    expect(store.listSupportTools(created.id)).toEqual([]);
  });

  it('validates names, endpoints and tenant existence', () => {
    const { tenant: created } = tenant();
    for (const name of ['bad name', '', 'a'.repeat(65)]) {
      expectStatus(() => store.createSupportTool(created.id, { name, endpointUrl: 'https://example.com' }), 400);
    }
    expectStatus(() => store.createSupportTool(created.id, { name: 'ok', endpointUrl: 'file:///etc/passwd' }), 400);
    expectStatus(() => store.createSupportTool(9999, { name: 'ok', endpointUrl: 'https://example.com' }), 404);
  });
});

describe('support database sources', () => {
  it('round trips table policies and encrypts tokens, preserving or clearing them on update', () => {
    const { tenant: created } = tenant();
    const tablePolicies: store.SupportTablePolicy[] = [{ tableName: 'orders', description: 'Customer orders',
      allowedRoles: ['customer', 'admin'], allowedColumns: ['id', 'user_id'], deniedColumns: ['password'],
      rowOwnerColumn: 'user_id', bypassRowLockRoles: ['admin'] }];
    const source = store.createSupportDbSource(created.id, { name: 'Remote', driver: 'sql-http',
      connectionUrl: 'https://sql.example/query', authToken: 'secret-db-token', schemaSql: 'CREATE TABLE orders(id);', tablePolicies });
    expect(source).toMatchObject({ tenantId: created.id, driver: 'sql-http', maxRows: 50, enabled: true, tablePolicies });
    expect(source.authTokenMasked).not.toBe('secret-db-token');
    expect(store.getSupportDbSourceAuthToken(created.id, source.id)).toBe('secret-db-token');
    expect(JSON.stringify(db.prepare('SELECT * FROM x_support_db_sources').get())).not.toContain('secret-db-token');
    expect(store.listSupportDbSources(created.id)).toEqual([source]);
    const updated = store.updateSupportDbSource(created.id, source.id, { name: 'Renamed', maxRows: 10, enabled: false });
    expect(updated).toMatchObject({ name: 'Renamed', maxRows: 10, enabled: false, tablePolicies });
    expect(store.getSupportDbSourceAuthToken(created.id, source.id)).toBe('secret-db-token');
    expect(store.updateSupportDbSource(created.id, source.id, {})).toEqual({ ...updated, updatedAt: expect.any(String) });
    store.updateSupportDbSource(created.id, source.id, { authToken: 'replacement', tablePolicies: [] });
    expect(store.getSupportDbSourceAuthToken(created.id, source.id)).toBe('replacement');
    expect(store.updateSupportDbSource(created.id, source.id, { authToken: '' }).authTokenMasked).toBe('');
    expect(store.getSupportDbSourceAuthToken(created.id, source.id)).toBe('');
  });

  it('uses sandbox defaults and scopes every source operation to its tenant', () => {
    const { tenant: created } = tenant();
    const source = store.createSupportDbSource(created.id, { name: 'Sandbox' });
    expect(source).toMatchObject({ driver: 'sqlite-sandbox', connectionUrl: '', authTokenMasked: '', schemaSql: '', tablePolicies: [], maxRows: 50 });
    const other = tenant('Other').tenant;
    expectStatus(() => store.getSupportDbSource(other.id, source.id), 404);
    expectStatus(() => store.getSupportDbSourceAuthToken(other.id, source.id), 404);
    expectStatus(() => store.updateSupportDbSource(other.id, source.id, { authToken: 'stolen' }), 404);
    expect(store.deleteSupportDbSource(other.id, source.id)).toBe(false);
    expectStatus(() => store.createSupportDbSource(9999, { name: 'Missing' }), 404);
    expectStatus(() => store.updateSupportDbSource(created.id, source.id, { maxRows: 0 }), 400);
    expect(store.deleteSupportDbSource(created.id, source.id)).toBe(true);
    expect(store.deleteSupportDbSource(created.id, source.id)).toBe(false);
    expect(store.listSupportDbSources(created.id)).toEqual([]);
  });
});
