import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { initDb, getDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { setEnabled } from '../../custom/x-gateway/config.js';

describe('permission gates: console logs, path case and the proxy webhook', () => {
  let server: Server;
  let base: string;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    createUser('admin@example.com', 'AdminPass123!');
    const grant = (name: string, permissions: string[]) => {
      const user = createUser(`${name}@example.com`, 'MemberPass123!', 'member');
      getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(permissions), user.userId);
      tokens[name] = createSession(user.userId);
    };
    grant('gateway', ['use_x_gateway']);
    grant('logs', ['use_x_gateway', 'view_keys']);
    grant('reader', ['use_x_gateway', 'view_server_logs']);
    grant('cleaner', ['use_x_gateway', 'clear_server_logs']);
    grant('logsOnly', ['view_server_logs', 'clear_server_logs']);
    grant('profiles', ['view_client_profiles']);
    setEnabled(true);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); });

  const status = async (path: string, who?: string, method = 'GET') =>
    (await fetch(base + path, { method, headers: who ? { Authorization: `Bearer ${tokens[who]}` } : {} })).status;

  it('keeps the server console log away from signed-out callers and accounts without the page permission', async () => {
    expect(await status('/api/translator/console-logs')).toBe(401);
    expect(await status('/api/translator/console-logs/stream')).toBe(401);
    expect(await status('/api/translator/console-logs', undefined, 'DELETE')).toBe(401);
    expect(await status('/api/translator/console-logs', 'gateway')).toBe(403);
    expect(await status('/api/translator/console-logs', 'gateway', 'DELETE')).toBe(403);
  });

  it('reads the server console log with View server logs and clears it with Clear server logs only', async () => {
    // View keys opens the request log page, not the server console output.
    expect(await status('/api/translator/console-logs', 'logs')).toBe(403);
    expect(await status('/api/translator/console-logs/stream', 'logs')).toBe(403);
    expect(await status('/api/translator/console-logs', 'logs', 'DELETE')).toBe(403);
    expect(await status('/api/translator/console-logs', 'reader')).toBe(200);
    expect(await status('/api/translator/console-logs', 'reader', 'DELETE')).toBe(403);
    expect(await status('/api/translator/console-logs', 'cleaner')).toBe(403);
    expect(await status('/api/translator/console-logs/stream', 'cleaner')).toBe(403);
    expect(await status('/api/translator/console-logs', 'cleaner', 'DELETE')).toBe(204);
    // The log permissions alone do not open the Thruline console.
    expect(await status('/api/translator/console-logs', 'logsOnly')).toBe(403);
    expect(await status('/api/translator/console-logs', 'logsOnly', 'DELETE')).toBe(403);
  });

  it('resolves the same permission whatever the letter case of the path', async () => {
    expect(await status('/api/thruline/quota', 'gateway')).toBe(403);
    expect(await status('/api/thruline/Quota', 'gateway')).toBe(403);
    expect(await status('/api/X-Gateway/QUOTA', 'gateway')).toBe(403);
    expect(await status('/api/client-profiles/1/conversations/abc', 'profiles')).toBe(403);
    expect(await status('/api/client-profiles/1/Conversations/abc', 'profiles')).toBe(403);
    expect(await status('/api/Client-Profiles/1/Content-Filter/events', 'profiles')).toBe(403);
  });

  it('applies the same permissions at the pre-rename addresses', async () => {
    expect(await status('/api/x-gateway/quota', 'gateway')).toBe(403);
    expect(await status('/api/X-Gateway/Quota', 'gateway')).toBe(403);
    expect(await status('/api/x-gateway/keys', 'gateway')).toBe(200);
    expect(await status('/api/x-gateway/keys')).toBe(401);
    expect(await status('/api/x-accounts', 'gateway')).toBe(403);
    expect(await status('/api/x-accounts', 'logs')).toBe(200);
  });

  it('lets the proxy webhook reach its own token check at both addresses', async () => {
    for (const path of ['/api/proxy-webhook', '/api/thruline/proxy-webhook', '/api/x-gateway/proxy-webhook']) {
      const res = await fetch(`${base}${path}?token=wrong`, { method: 'POST' });
      expect(res.status).toBe(401);
      expect((await res.json() as { error: { code?: string } }).error.code).toBe('unauthorized');
    }
  });
});
