import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { getConfigSnapshot, setEnabled } from '../../custom/x-gateway/config.js';

// The console switch is the only way an operator can enable /thruline/v1, so it is
// checked through the real HTTP surface with the same permission leaves the
// gateway uses.
describe('X Gateway console API', () => {
  let server: Server;
  let base: string;
  let adminToken: string;
  let editorToken: string;
  let memberToken: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const admin = createUser('console-admin@example.com', 'AdminPass123!');
    adminToken = createSession(admin.userId);
    const editor = createUser('console-editor@example.com', 'EditorPass123!', 'member');
    getDb().prepare("UPDATE users SET permissions = ? WHERE id = ?")
      .run(JSON.stringify(['use_x_gateway', 'edit_x_settings']), editor.userId);
    editorToken = createSession(editor.userId);
    const member = createUser('console-member@example.com', 'MemberPass123!', 'member');
    memberToken = createSession(member.userId);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    setEnabled(false);
  });
  afterAll(() => server?.close());

  async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  it('requires a session and refuses accounts without the gateway permission', async () => {
    expect((await call('/api/thruline/status')).status).toBe(401);
    const member = await call('/api/thruline/status', { token: memberToken });
    expect(member.status).toBe(403);
    expect((await call('/api/thruline/enabled', { method: 'PUT', token: memberToken, body: { enabled: true } })).status).toBe(403);
  });

  it('reports the off state and the default savers', async () => {
    const res = await call('/api/thruline/status', { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: false,
      defaults: { caveman: false, ponytail: 'off', input: 'off' },
      combosCount: 0,
    });
  });

  it('toggles the gateway with edit_x_settings and invalidates the snapshot', async () => {
    const on = await call('/api/thruline/enabled', { method: 'PUT', token: editorToken, body: { enabled: true } });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ enabled: true });
    expect(getConfigSnapshot().enabled).toBe(true);
    expect((await call('/api/thruline/status', { token: editorToken })).body.enabled).toBe(true);

    const off = await call('/api/thruline/enabled', { method: 'PUT', token: adminToken, body: { enabled: false } });
    expect(off.status).toBe(200);
    expect(getConfigSnapshot().enabled).toBe(false);
  });

  it('rejects an invalid enabled body without changing the switch', async () => {
    const res = await call('/api/thruline/enabled', { method: 'PUT', token: adminToken, body: { enabled: 'yes' } });
    expect(res.status).toBe(400);
    expect(getConfigSnapshot().enabled).toBe(false);
  });

  it('stores strict default savers and reads them back', async () => {
    const put = await call('/api/thruline/defaults', {
      method: 'PUT', token: adminToken, body: { caveman: true, ponytail: 'lite', input: 'standard' },
    });
    expect(put.status).toBe(200);
    expect((await call('/api/thruline/defaults', { token: adminToken })).body)
      .toEqual({ caveman: true, ponytail: 'lite', input: 'standard' });

    const bad = await call('/api/thruline/defaults', {
      method: 'PUT', token: adminToken, body: { caveman: true, ponytail: 'max', input: 'off' },
    });
    expect(bad.status).toBe(400);
    expect((await call('/api/thruline/defaults', { token: adminToken })).body.ponytail).toBe('lite');

    // Restore the documented defaults so the later suites in this process are unaffected.
    await call('/api/thruline/defaults', {
      method: 'PUT', token: adminToken, body: { caveman: false, ponytail: 'off', input: 'off' },
    });
  });

  it('answers JSON 404 for an unknown console path', async () => {
    const res = await call('/api/thruline/nope', { token: adminToken });
    expect(res.status).toBe(404);
    expect(res.body.error.type).toBe('not_found');
  });
});
