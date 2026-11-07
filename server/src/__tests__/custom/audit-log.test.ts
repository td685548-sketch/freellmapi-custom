import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { setUserPermissions } from '../../services/users.js';
import { describeRoute, summarize } from '../../services/audit-log.js';

// The change history: every successful dashboard write by a signed-in account, with secrets removed.

describe('audit helpers', () => {
  it('names routes, areas and targets', () => {
    expect(describeRoute('/api/client-profiles/12/quota')).toEqual({ route: '/api/client-profiles/:id/quota', area: 'client-profiles', targetId: 12 });
    expect(describeRoute('/api/admin/users/5/permissions')).toEqual({ route: '/api/admin/users/:id/permissions', area: 'admin/users', targetId: 5 });
    expect(describeRoute('/api/settings/usage-alerts')).toMatchObject({ area: 'settings/usage-alerts', targetId: null });
    expect(describeRoute('/api/keys/7')).toMatchObject({ area: 'keys', targetId: 7 });
  });

  it('keeps no secret and stays small', () => {
    const s = summarize({ name: 'Shop', key: 'sk-123', password: 'p', apiKey: 'x', newPassword: 'y', token: 't', webhookUrl: 'https://user:pw@hooks.example.com/x', nested: { clientSecret: 's', ok: 1 }, long: 'a'.repeat(500) }) as Record<string, any>;
    expect(s).toMatchObject({ name: 'Shop', key: '[hidden]', password: '[hidden]', apiKey: '[hidden]', newPassword: '[hidden]', token: '[hidden]', nested: { clientSecret: '[hidden]', ok: 1 } });
    expect(s.webhookUrl).toBe('https://***@hooks.example.com/x');
    expect(s.long.length).toBeLessThanOrEqual(201);
    expect(JSON.stringify(s)).not.toMatch(/sk-123|pw@/);
  });
});

describe('audit log', () => {
  let server: Server;
  let base: string;
  let ownerId: number;
  let ownerToken: string;
  let delegateId: number;
  let delegateToken: string;

  const call = async (path: string, token: string, method = 'GET', body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const settle = () => new Promise(r => setTimeout(r, 30));

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    ownerId = createUser('owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);
    delegateId = createUser('delegate@example.com', 'DelegatePass123!', 'member').userId;
    delegateToken = createSession(delegateId);
  });
  afterAll(() => { server?.close(); });

  it('records successful changes with who, what and the target, never reads or failures', async () => {
    const made = await call('/api/client-profiles', ownerToken, 'POST', { name: 'Shop' });
    expect(made.status).toBe(201);
    await call(`/api/client-profiles/${made.body.id}/quota`, ownerToken, 'PUT', { rpmLimit: 30 });
    await call(`/api/client-profiles/${made.body.id}/quota`, ownerToken, 'PUT', { rpmLimit: 'lots' }); // 400: not recorded
    await call(`/api/client-profiles/${made.body.id}/conversations`, ownerToken); // a read: not recorded
    await call('/api/settings/usage-alerts', ownerToken, 'PUT', { webhookUrl: 'https://u:secret@hooks.example.com/a' });
    await settle();
    const log = await call('/api/audit', ownerToken);
    expect(log.status).toBe(200);
    const routes = log.body.entries.map((e: any) => `${e.method} ${e.route}`);
    expect(routes).toEqual(['PUT /api/settings/usage-alerts', 'PUT /api/client-profiles/:id/quota', 'POST /api/client-profiles']);
    const quota = log.body.entries[1];
    expect(quota).toMatchObject({ actorId: ownerId, actorEmail: 'owner@example.com', area: 'client-profiles', targetId: made.body.id, status: 200, summary: { rpmLimit: 30 } });
    expect(JSON.stringify(log.body.entries)).not.toContain('secret@');
    expect(log.body.areas).toEqual(expect.arrayContaining(['client-profiles', 'settings/usage-alerts']));
  });

  it('filters by area, actor and text, and pages by id', async () => {
    const all = (await call('/api/audit', ownerToken)).body.entries;
    expect((await call('/api/audit?area=client-profiles', ownerToken)).body.entries.every((e: any) => e.area === 'client-profiles')).toBe(true);
    expect((await call(`/api/audit?actor=${delegateId}`, ownerToken)).body.entries).toEqual([]);
    expect((await call('/api/audit?q=usage-alerts', ownerToken)).body.entries).toHaveLength(1);
    const page = (await call(`/api/audit?before=${all[0].id}&limit=1`, ownerToken)).body.entries;
    expect(page).toEqual([all[1]]);
  });

  it('does not record sign-in traffic', async () => {
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM custom_audit_log').get() as { n: number }).n;
    await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', password: 'OwnerPass123!' }) });
    await settle();
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM custom_audit_log').get() as { n: number }).n).toBe(before);
  });

  it('needs view_audit_log to read, and records delegated changes under their own name', async () => {
    expect((await call('/api/audit', delegateToken)).status).toBe(403);
    setUserPermissions(delegateId, ['view_audit_log', 'edit_client_profiles'], ownerId);
    expect((await call('/api/audit', delegateToken)).status).toBe(200);
    const made = await call('/api/client-profiles', delegateToken, 'POST', { name: 'Blog' });
    expect(made.status).toBe(201);
    await settle();
    const mine = (await call(`/api/audit?actor=${delegateId}`, ownerToken)).body.entries;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ actorEmail: 'delegate@example.com', route: '/api/client-profiles' });
    setUserPermissions(delegateId, ['view_logs'], ownerId);
    expect((await call('/api/audit', delegateToken)).status).toBe(200); // the parent covers it
  });
});
