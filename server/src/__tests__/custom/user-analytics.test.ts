import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { setUserPermissions } from '../../services/users.js';
import { getUserUsage } from '../../services/user-quotas.js';
import { clampAnalyticsDays } from '../../services/user-analytics.js';

// Per-account analytics end to end: a request made with a personal key is attributed
// to the account (requests.user_id), its tokens are booked beside the request count,
// and the admin and self endpoints read it back. Unified-key traffic stays unattributed.

describe('per-user analytics', () => {
  let server: Server;
  let base: string;
  const realFetch = global.fetch;
  let adminToken: string;
  let memberId: number;
  let memberToken: string;
  let memberKey: string;
  let otherId: number;
  let otherToken: string;
  let delegateToken: string;

  const get = async (path: string, token?: string) => {
    const res = await realFetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const chat = async (key: string, stream = false) => {
    const res = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'auto', stream, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();
    await new Promise(r => setTimeout(r, 40)); // trailing bookkeeping lands after the response
    return res.status;
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const key = encrypt('gsk_user_analytics');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','a',?,?,?,'healthy',1)`)
      .run(key.encrypted, key.iv, key.authTag);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const admin = createUser('owner@example.com', 'OwnerPass123!');
    adminToken = createSession(admin.userId);
    const member = createUser('member@example.com', 'MemberPass123!', 'member');
    memberId = member.userId;
    memberToken = createSession(memberId);
    memberKey = mintUserApiKey(memberId, 'k').key;
    const other = createUser('other@example.com', 'OtherPass123!', 'member');
    otherId = other.userId;
    otherToken = createSession(otherId);
    const delegate = createUser('delegate@example.com', 'DelegatePass123!', 'member');
    delegateToken = createSession(delegate.userId);
    setUserPermissions(delegate.userId, ['view_users'], admin.userId);

    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.stream) {
        const sse = [
          { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
          { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
        ].map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); });

  it('attributes a personal-key request to its account and books the tokens', async () => {
    expect(await chat(memberKey)).toBe(200);
    const rows = getDb().prepare('SELECT user_id AS u, status, input_tokens AS i, output_tokens AS o FROM requests').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ u: memberId, status: 'success', i: 12, o: 2 });
    expect(getUserUsage(memberId)).toMatchObject({ requests: 1, tokens: 14 });
  });

  it('books streaming tokens too', async () => {
    expect(await chat(memberKey, true)).toBe(200);
    const usage = getUserUsage(memberId);
    expect(usage.requests).toBe(2);
    expect(usage.tokens).toBeGreaterThan(14);
  });

  it('leaves unified-key traffic unattributed', async () => {
    expect(await chat(getUnifiedApiKey())).toBe(200);
    const last = getDb().prepare('SELECT user_id AS u FROM requests ORDER BY id DESC LIMIT 1').get() as any;
    expect(last.u).toBeNull();
    expect(getUserUsage(memberId).requests).toBe(2);
  });

  it('reads the numbers back: admin by id, member for themselves', async () => {
    const db = getDb();
    const insert = db.prepare(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, created_at, user_id) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?)`);
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
    insert.run('cerebras', 'zai-glm-4.7', 'success', 100, 50, 400, daysAgo(2), memberId);
    insert.run('cerebras', 'zai-glm-4.7', 'error', 0, 0, 90, daysAgo(2), memberId);
    insert.run('groq', 'qwen/qwen3-32b', 'success', 10, 10, 200, daysAgo(40), memberId); // outside a 30 day window
    insert.run('groq', 'other-member-only-model', 'success', 999, 999, 1, daysAgo(1), otherId); // someone else's

    const admin = await get(`/api/admin/users/${memberId}/analytics?days=30`, adminToken);
    expect(admin.status).toBe(200);
    const a = admin.body.analytics;
    expect(a).toMatchObject({ userId: memberId, email: 'member@example.com', days: 30 });
    // 2 chats made with the key + the 2 seeded in-window rows; the 40 day old row and other's row are out.
    expect(a.totals.requests).toBe(4);
    expect(a.totals.errors).toBe(1);
    expect(a.totals.success).toBe(3);
    expect(a.totals.inputTokens).toBeGreaterThanOrEqual(12 + 100);
    expect(a.daily).toHaveLength(30);
    expect(a.daily.reduce((n: number, d: any) => n + d.requests, 0)).toBe(4);
    expect(a.models.find((m: any) => m.modelId === 'zai-glm-4.7')).toMatchObject({ platform: 'cerebras', requests: 2, errors: 1, tokens: 150 });
    expect(a.models.some((m: any) => m.modelId === 'other-member-only-model')).toBe(false);
    expect(typeof a.retainedSince).toBe('string');

    const wide = await get(`/api/admin/users/${memberId}/analytics?days=90`, adminToken);
    expect(wide.body.analytics.totals.requests).toBe(5);

    const self = await get('/api/user/analytics', memberToken);
    expect(self.status).toBe(200);
    expect(self.body.analytics.userId).toBe(memberId);
    expect(self.body.analytics.totals.requests).toBe(4);

    const theirs = await get('/api/user/analytics', otherToken);
    expect(theirs.body.analytics.totals.requests).toBe(1);
  });

  it('keeps the admin route behind manage_users / view_users', async () => {
    expect((await get(`/api/admin/users/${memberId}/analytics`, memberToken)).status).toBe(403);
    expect((await get(`/api/admin/users/${memberId}/analytics`, otherToken)).status).toBe(403);
    expect((await get(`/api/admin/users/${memberId}/analytics`)).status).toBe(401);
    expect((await get(`/api/admin/users/${memberId}/analytics`, delegateToken)).status).toBe(200);
    expect((await get('/api/user/analytics')).status).toBe(401);
  });

  it('rejects bad ids and clamps the window', async () => {
    expect((await get('/api/admin/users/abc/analytics', adminToken)).status).toBe(400);
    expect((await get('/api/admin/users/99999/analytics', adminToken)).status).toBe(404);
    expect((await get(`/api/admin/users/${memberId}/analytics?days=100000`, adminToken)).body.analytics.days).toBe(90);
    expect(clampAnalyticsDays('0')).toBe(1);
    expect(clampAnalyticsDays('nope')).toBe(30);
    expect(clampAnalyticsDays(undefined)).toBe(30);
  });
});
