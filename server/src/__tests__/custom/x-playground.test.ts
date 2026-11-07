import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { createCombo, setEnabled } from '../../custom/x-gateway/config.js';
import { encrypt } from '../../lib/crypto.js';

describe('session-authenticated X Playground', () => {
  let server: Server;
  let base: string;
  let token: string;
  let denied: string;
  const realFetch = global.fetch;
  const upstream = vi.fn();
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    createUser('play-admin@example.test', 'AdminPass123!');
    const user = createUser('play-user@example.test', 'MemberPass123!', 'member');
    getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run('["use_x_gateway"]', user.userId);
    token = createSession(user.userId);
    denied = createSession(createUser('play-denied@example.test', 'MemberPass123!', 'member').userId);
    const key = encrypt('gsk_playground_secret');
    getDb().prepare(`INSERT INTO x_gateway_keys (provider,label,auth_method,encrypted_key,iv,auth_tag,status,enabled)
      VALUES ('groq','Private account','api_key',?,?,?,'healthy',1)`).run(key.encrypted, key.iv, key.authTag);
    createCombo('quick', [{ platform: 'groq', modelId: 'llama-3.3-70b-versatile' }]);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    vi.spyOn(global, 'fetch').mockImplementation((url, init) =>
      String(url).startsWith(base) ? realFetch(url, init) : upstream(url, init));
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); });
  const body = { model: 'combo:quick', messages: [{ role: 'user', content: 'Hello' }] };
  const call = (path: string, auth = token, data?: unknown) => fetch(`${base}/api/x-gateway/playground/${path}`, {
    method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  });
  it('requires a session and use_x_gateway for catalog and chat', async () => {
    for (const path of ['models', 'chat']) {
      expect((await call(path, '', path === 'chat' ? body : undefined)).status).toBe(401);
      expect((await call(path, denied, path === 'chat' ? body : undefined)).status).toBe(403);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it('provides safe model choices without view_keys and refuses disabled chat', async () => {
    setEnabled(false);
    const res = await call('models');
    expect(res.status).toBe(200);
    const catalog = await res.json();
    expect(catalog.enabled).toBe(false);
    expect(catalog.models.some((m: { id: string }) => m.id === 'combo:quick')).toBe(true);
    expect(JSON.stringify(catalog)).not.toMatch(/gsk_playground_secret|Private account|encrypted_key/);
    expect((await call('chat', token, body)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('rejects invalid settings and remote image URLs before dispatch', async () => {
    setEnabled(true);
    for (const invalid of [
      { ...body, temperature: 3 }, { ...body, max_tokens: 0 }, { ...body, messages: [] },
      { ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1/private' } }] }] },
    ]) expect((await call('chat', token, invalid)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('streams via the real gateway handler with settings, context, images and accounting', async () => {
    upstream.mockImplementation(async (_url, init) => {
      const sent = JSON.parse(init.body);
      expect(sent.model).toBe('llama-3.3-70b-versatile');
      expect(sent.temperature).toBe(0.4);
      expect(sent.messages).toHaveLength(3);
      return new Response('data: {"choices":[{"delta":{"content":"Hello web"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const res = await call('chat', token, { ...body, temperature: 0.4, max_tokens: 512, messages: [
      { role: 'system', content: 'Be concise' }, { role: 'assistant', content: 'Earlier reply' },
      { role: 'user', content: [{ type: 'text', text: 'Describe' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] },
    ] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-routed-via')).toContain('groq/');
    const stream = await res.text();
    expect(stream).toContain('Hello web');
    expect(stream).toContain('[DONE]');
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM requests WHERE caller = 'x-gateway'").get()).toMatchObject({ n: 1 });
  });
});
