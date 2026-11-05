import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { getDb, initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';

// Regression coverage for three isolation gaps: Playground conversations were
// shared by every account, personal keys skipped the per-user limit when sent
// as x-api-key / x-goog-api-key, and narrow revoke/quota grants could be used
// against accounts with broader authority.

describe('RBAC isolation', () => {
  let server: Server;
  let base: string;
  let ownerId: number, aliceId: number, bobId: number, delegateId: number, adminId: number;
  let aliceToken: string, bobToken: string, delegateToken: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    ownerId = createUser('owner-iso@example.com', 'Password123!').userId;
    aliceId = createUser('alice-iso@example.com', 'Password123!', 'member').userId;
    bobId = createUser('bob-iso@example.com', 'Password123!', 'member').userId;
    delegateId = createUser('delegate-iso@example.com', 'Password123!', 'member').userId;
    adminId = createUser('admin-iso@example.com', 'Password123!', 'admin').userId;
    getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['revoke_user_sessions', 'revoke_user_keys', 'edit_user_quotas']), delegateId);
    aliceToken = createSession(aliceId);
    bobToken = createSession(bobId);
    delegateToken = createSession(delegateId);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server?.close(); });

  async function hit(path: string, method: string, token: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  }

  describe('Playground conversations', () => {
    it('keeps each account\'s conversations private', async () => {
      const created = await hit('/api/conversations', 'POST', aliceToken, { title: 'secret', messages: [] });
      expect(created.status).toBe(201);
      const id = created.body.id;

      expect((await hit('/api/conversations', 'GET', bobToken)).body).toEqual([]);
      expect((await hit(`/api/conversations/${id}`, 'GET', bobToken)).status).toBe(404);
      expect((await hit(`/api/conversations/${id}`, 'PUT', bobToken, { title: 'pwned' })).status).toBe(404);
      expect((await hit(`/api/conversations/${id}`, 'DELETE', bobToken)).status).toBe(404);

      const mine = await hit('/api/conversations', 'GET', aliceToken);
      expect(mine.body.map((c: { id: number }) => c.id)).toEqual([id]);
      expect((await hit(`/api/conversations/${id}`, 'GET', aliceToken)).body.title).toBe('secret');
      expect((await hit(`/api/conversations/${id}`, 'DELETE', aliceToken)).status).toBe(200);
    });
  });

  describe('personal key limits', () => {
    it('applies the per-user RPM limit whichever header carries the key', async () => {
      const { key } = mintUserApiKey(bobId, 'limit-test');
      getDb().prepare('UPDATE user_api_keys SET rpm_limit = 1 WHERE user_id = ?').run(bobId);
      const first = await hit('/v1/models', 'GET', '', undefined, { 'x-api-key': key });
      expect(first.headers.get('x-ratelimit-limit-user-rpm')).toBe('1');
      const second = await hit('/v1/messages', 'POST', '', { model: 'x', max_tokens: 1, messages: [] }, { 'x-api-key': key });
      expect(second.status).toBe(429);
      expect(second.body.error.code).toBe('user_rate_limit_exceeded');
    });

    it('applies the limit on /v1beta and rejects a revoked key', async () => {
      const { key } = mintUserApiKey(aliceId, 'gemini');
      getDb().prepare('UPDATE user_api_keys SET rpm_limit = 1 WHERE user_id = ?').run(aliceId);
      const first = await hit('/v1beta/models', 'GET', '', undefined, { 'x-goog-api-key': key });
      expect(first.headers.get('x-ratelimit-limit-user-rpm')).toBe('1');
      expect((await hit(`/v1beta/models?key=${key}`, 'GET', '')).status).toBe(429);
      getDb().prepare('UPDATE user_api_keys SET revoked = 1 WHERE user_id = ?').run(aliceId);
      expect((await hit('/v1/models', 'GET', '', undefined, { 'x-api-key': key })).status).toBe(401);
    });
  });

  describe('delegated revoke and quota actions', () => {
    it('cannot be used against an account with broader authority', async () => {
      expect((await hit(`/api/admin/users/${adminId}/revoke-sessions`, 'POST', delegateToken)).status).toBe(403);
      expect((await hit(`/api/admin/users/${adminId}/revoke-keys`, 'POST', delegateToken)).status).toBe(403);
      expect((await hit(`/api/admin/users/${adminId}/quota`, 'PUT', delegateToken, { rpmLimit: 1 })).status).toBe(403);
    });

    it('still works against accounts the delegate covers', async () => {
      expect((await hit(`/api/admin/users/${aliceId}/revoke-sessions`, 'POST', delegateToken)).status).toBe(200);
      expect((await hit(`/api/admin/users/${aliceId}/revoke-keys`, 'POST', delegateToken)).status).toBe(200);
      expect((await hit(`/api/admin/users/${aliceId}/quota`, 'PUT', delegateToken, { rpmLimit: 5 })).status).toBe(200);
    });

    it('lets a full administrator act on any non-primary account', async () => {
      const adminToken = createSession(adminId);
      expect((await hit(`/api/admin/users/${bobId}/revoke-sessions`, 'POST', adminToken)).status).toBe(200);
      expect((await hit(`/api/admin/users/${ownerId}/revoke-sessions`, 'POST', adminToken)).status).toBe(403);
    });
  });
});
