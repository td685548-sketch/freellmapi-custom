import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'http';
import { initDb, getDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser } from '../../services/auth.js';
import { mintUserApiKey, revokeUserApiKey } from '../../services/user-keys.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import { encrypt } from '../../lib/crypto.js';

describe('X Gateway Access Control (US1 / Phase 3)', () => {
  let server: Server;
  let base: string;
  let adminKey: string;
  let memberKey: string;
  let delegatedKey: string;
  let delegatedUserId: number;
  let revokedKey: string;
  const realFetch = global.fetch;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    // Seed a dedicated X Gateway provider key so chat completions can succeed
    const key = encrypt('gsk_access_test');
    getDb()
      .prepare(
        `INSERT INTO x_gateway_keys (provider, label, auth_method, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq', 'test-key', 'api_key', ?, ?, ?, 'healthy', 1)`
      )
      .run(key.encrypted, key.iv, key.authTag);

    // 1. Primary admin (first user)
    const admin = createUser('admin@example.com', 'AdminPass123!');
    const adminKeyObj = mintUserApiKey(admin.userId, 'Admin Key');
    adminKey = adminKeyObj.key;

    // 2. Member without gateway permission
    const member = createUser('member@example.com', 'MemberPass123!', 'member');
    memberKey = mintUserApiKey(member.userId, 'Member Key').key;

    // 3. Member with delegated use_x_gateway permission
    const delegated = createUser('delegated@example.com', 'DelegatedPass123!', 'member');
    delegatedUserId = delegated.userId;
    getDb().prepare("UPDATE users SET permissions = '[\"use_x_gateway\"]' WHERE id = ?").run(delegatedUserId);
    delegatedKey = mintUserApiKey(delegatedUserId, 'Delegated Key').key;

    // 4. Revoked key
    const revokedKeyObj = mintUserApiKey(admin.userId, 'Revoked Key');
    revokedKey = revokedKeyObj.key;
    revokeUserApiKey(admin.userId, revokedKeyObj.id);

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    // Mock upstream fetch for successful chat completions
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(`http://127.0.0.1:${port}`)) return realFetch(url, init);
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: Date.now(),
          model: 'llama-3.3-70b',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hello from mock provider!' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
  });

  async function requestX(
    path: string,
    opts: { method?: string; body?: unknown; key?: string } = {}
  ) {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.key) headers['Authorization'] = `Bearer ${opts.key}`;

    const res = await realFetch(`${base}${path}`, {
      method: opts.method ?? 'POST',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  }

  const validChatPayload = {
    model: 'auto',
    messages: [{ role: 'user', content: 'hello' }],
  };

  it('answers 404 when gateway is switched off (leaks nothing)', async () => {
    setEnabled(false);

    // With no key
    const anon = await requestX('/x/v1/chat/completions', { body: validChatPayload });
    expect(anon.status).toBe(404);
    expect(anon.body).toEqual({ error: { message: 'Not found', type: 'not_found' } });

    // With admin key
    const asAdmin = await requestX('/x/v1/chat/completions', { key: adminKey, body: validChatPayload });
    expect(asAdmin.status).toBe(404);
    expect(asAdmin.body).toEqual({ error: { message: 'Not found', type: 'not_found' } });

    // With invalid key
    const asInvalid = await requestX('/x/v1/chat/completions', { key: 'invalid-key', body: validChatPayload });
    expect(asInvalid.status).toBe(404);
    expect(asInvalid.body).toEqual({ error: { message: 'Not found', type: 'not_found' } });

    // With revoked key
    const asRevoked = await requestX('/x/v1/chat/completions', { key: revokedKey, body: validChatPayload });
    expect(asRevoked.status).toBe(404);
    expect(asRevoked.body).toEqual({ error: { message: 'Not found', type: 'not_found' } });

    // Models endpoint when off
    const models = await requestX('/x/v1/models', { method: 'GET', key: adminKey });
    expect(models.status).toBe(404);
    expect(models.body).toEqual({ error: { message: 'Not found', type: 'not_found' } });
  });

  describe('When gateway is enabled', () => {
    beforeAll(() => {
      setEnabled(true);
    });

    it('rejects anonymous caller with 401 authentication_error', async () => {
      const res = await requestX('/x/v1/chat/completions', { body: validChatPayload });
      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe('authentication_error');
    });

    it('rejects unknown key with 401 authentication_error', async () => {
      const res = await requestX('/x/v1/chat/completions', { key: 'sk-flm-unknownkey999', body: validChatPayload });
      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe('authentication_error');
    });

    it('rejects non-personal key with 401 authentication_error', async () => {
      const res = await requestX('/x/v1/chat/completions', { key: 'invalid-bearer-token', body: validChatPayload });
      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe('authentication_error');
    });

    it('rejects revoked key with 401 authentication_error', async () => {
      const res = await requestX('/x/v1/chat/completions', { key: revokedKey, body: validChatPayload });
      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe('authentication_error');
    });

    it('rejects member without use_x_gateway with 403 permission_error', async () => {
      const res = await requestX('/x/v1/chat/completions', { key: memberKey, body: validChatPayload });
      expect(res.status).toBe(403);
      expect(res.body.error.type).toBe('permission_error');
      expect(res.body.error.message).toMatch(/use_x_gateway/);
    });

    it('allows primary administrator with 200 and sets X-Gateway header', async () => {
      const res = await requestX('/x/v1/chat/completions', { key: adminKey, body: validChatPayload });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-gateway')).toBe('x');
      expect(res.headers.get('x-output-saver-applied')).toBe('');
      expect(res.headers.get('x-input-tokens-saved')).toBe('0');
      expect(res.body.choices[0].message.content).toBe('Hello from mock provider!');
    });

    it('allows delegated holder of use_x_gateway with 200', async () => {
      const res = await requestX('/x/v1/chat/completions', { key: delegatedKey, body: validChatPayload });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-gateway')).toBe('x');
      expect(res.body.choices[0].message.content).toBe('Hello from mock provider!');
    });

    it('refuses account with 403 on the next call if permission is revoked (no caching)', async () => {
      // First call succeeds
      const first = await requestX('/x/v1/chat/completions', { key: delegatedKey, body: validChatPayload });
      expect(first.status).toBe(200);

      // Demote the account by removing permission
      getDb().prepare("UPDATE users SET permissions = '[]' WHERE id = ?").run(delegatedUserId);

      // Next call must immediately fail with 403 without restarting server
      const next = await requestX('/x/v1/chat/completions', { key: delegatedKey, body: validChatPayload });
      expect(next.status).toBe(403);
      expect(next.body.error.type).toBe('permission_error');

      // Re-grant for subsequent tests if needed
      getDb().prepare("UPDATE users SET permissions = '[\"use_x_gateway\"]' WHERE id = ?").run(delegatedUserId);
    });

    it('allows primary administrator on GET /x/v1/models', async () => {
      const res = await requestX('/x/v1/models', { method: 'GET', key: adminKey });
      expect(res.status).toBe(200);
      expect(res.body.object).toBe('list');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('returns JSON 404 (never HTML) for unmatched paths under /x/v1', async () => {
      const res = await requestX('/x/v1/nonexistent-endpoint', { method: 'GET', key: adminKey });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { message: 'Not found', type: 'not_found' } });
    });
  });
});
