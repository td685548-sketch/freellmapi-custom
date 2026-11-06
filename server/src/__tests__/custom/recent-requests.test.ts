import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { setUserPermissions } from '../../services/users.js';

// Recent requests of one client profile / account: newest first, paged, errors-only filter, the attempt
// chain behind a request, and nobody else's rows.

describe('recent requests per profile and account', () => {
  let server: Server;
  let base: string;
  let ownerId: number;
  let ownerToken: string;
  let aliceId: number;
  let aliceToken: string;
  let bobId: number;
  let bobToken: string;
  let delegateId: number;
  let delegateToken: string;
  let shopId: number;
  let blogId: number;
  const ids: Record<string, number> = {};

  const get = async (path: string, token?: string) => {
    const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    ownerId = createUser('owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);
    aliceId = createUser('alice@example.com', 'AlicePass123!', 'member').userId;
    aliceToken = createSession(aliceId);
    bobId = createUser('bob@example.com', 'BobPass123!', 'member').userId;
    bobToken = createSession(bobId);
    delegateId = createUser('delegate@example.com', 'DelegatePass123!', 'member').userId;
    delegateToken = createSession(delegateId);

    const db = getDb();
    const profile = db.prepare("INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag) VALUES (?, ?, 'e', 'i', 't')");
    shopId = Number(profile.run('shop', 'h1').lastInsertRowid);
    blogId = Number(profile.run('blog', 'h2').lastInsertRowid);
    const ins = db.prepare(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, requested_model, created_at, user_id, profile_id)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`);
    const add = (name: string, status: string, profileId: number | null, userId: number | null, error: string | null = null) => {
      ids[name] = Number(ins.run('groq', `m-${name}`, status, 10, 2, 100, error, null, userId, profileId).lastInsertRowid);
    };
    for (let i = 0; i < 7; i++) add(`shop${i}`, i % 3 === 0 ? 'error' : 'success', shopId, null, i % 3 === 0 ? `Upstream 503 #${i}` : null);
    add('blog0', 'success', blogId, null);
    add('alice0', 'success', null, aliceId);
    add('alice1', 'error', null, aliceId, 'rate limited');
    add('bob0', 'success', null, bobId);
    const att = db.prepare("INSERT INTO request_attempts (request_id, ordinal, platform, model_id, key_ordinal, key_label, outcome, start_offset_ms, duration_ms, error_summary) VALUES (?, ?, ?, ?, 0, ?, ?, 0, ?, ?)");
    att.run(ids.shop6, 0, 'groq', 'llama-3.3-70b-versatile', 'groq-1', 'rate_limited', 40, '429 from groq');
    att.run(ids.shop6, 1, 'cerebras', 'zai-glm-4.7', 'cb-1', 'ok', 300, null);
  });
  afterAll(() => { server?.close(); });

  it('lists a profile\'s requests newest first, a page at a time', async () => {
    const first = await get(`/api/client-profiles/${shopId}/requests?limit=3`, ownerToken);
    expect(first.status).toBe(200);
    expect(first.body.requests.map((r: any) => r.modelId)).toEqual(['m-shop6', 'm-shop5', 'm-shop4']);
    expect(first.body.requests[0]).toMatchObject({ status: 'error', platform: 'groq', latencyMs: 100, inputTokens: 10, outputTokens: 2, error: 'Upstream 503 #6', requestedModel: null });
    expect(first.body.nextBefore).toBe(ids.shop4);
    const second = await get(`/api/client-profiles/${shopId}/requests?limit=3&before=${first.body.nextBefore}`, ownerToken);
    expect(second.body.requests.map((r: any) => r.modelId)).toEqual(['m-shop3', 'm-shop2', 'm-shop1']);
    const last = await get(`/api/client-profiles/${shopId}/requests?limit=3&before=${second.body.nextBefore}`, ownerToken);
    expect(last.body).toEqual({ requests: [expect.objectContaining({ modelId: 'm-shop0' })], nextBefore: null });
  });

  it('filters to errors and never shows another subject\'s rows', async () => {
    const errors = await get(`/api/client-profiles/${shopId}/requests?status=error`, ownerToken);
    expect(errors.body.requests.map((r: any) => r.modelId)).toEqual(['m-shop6', 'm-shop3', 'm-shop0']);
    const blog = await get(`/api/client-profiles/${blogId}/requests`, ownerToken);
    expect(blog.body.requests.map((r: any) => r.modelId)).toEqual(['m-blog0']);
  });

  it('shows the attempt chain of a request, only through its own subject', async () => {
    const chain = await get(`/api/client-profiles/${shopId}/requests/${ids.shop6}/attempts`, ownerToken);
    expect(chain.body.attempts).toEqual([
      { ordinal: 0, platform: 'groq', modelId: 'llama-3.3-70b-versatile', keyLabel: 'groq-1', outcome: 'rate_limited', durationMs: 40, error: '429 from groq' },
      { ordinal: 1, platform: 'cerebras', modelId: 'zai-glm-4.7', keyLabel: 'cb-1', outcome: 'ok', durationMs: 300, error: null },
    ]);
    expect((await get(`/api/client-profiles/${blogId}/requests/${ids.shop6}/attempts`, ownerToken)).status).toBe(404);
    expect((await get(`/api/client-profiles/${shopId}/requests/${ids.shop5}/attempts`, ownerToken)).body.attempts).toEqual([]);
  });

  it('serves accounts to admins and each member their own', async () => {
    const admin = await get(`/api/admin/users/${aliceId}/requests`, ownerToken);
    expect(admin.body.requests.map((r: any) => r.modelId)).toEqual(['m-alice1', 'm-alice0']);
    const own = await get('/api/user/requests', aliceToken);
    expect(own.body.requests.map((r: any) => r.modelId)).toEqual(['m-alice1', 'm-alice0']);
    expect((await get('/api/user/requests?status=error', aliceToken)).body.requests).toHaveLength(1);
    expect((await get('/api/user/requests', bobToken)).body.requests.map((r: any) => r.modelId)).toEqual(['m-bob0']);
    expect((await get(`/api/user/requests/${ids.alice0}/attempts`, bobToken)).status).toBe(404); // not bob's
    expect((await get(`/api/user/requests/${ids.alice0}/attempts`, aliceToken)).status).toBe(200);
  });

  it('is guarded by the existing permissions', async () => {
    expect((await get(`/api/admin/users/${aliceId}/requests`, bobToken)).status).toBe(403);
    expect((await get(`/api/client-profiles/${shopId}/requests`, aliceToken)).status).toBe(403);
    expect((await get('/api/user/requests')).status).toBe(401);
    setUserPermissions(delegateId, ['view_users'], ownerId);
    expect((await get(`/api/admin/users/${aliceId}/requests`, delegateToken)).status).toBe(200);
    expect((await get(`/api/admin/users/${aliceId}/requests/${ids.alice0}/attempts`, delegateToken)).status).toBe(200);
    expect((await get(`/api/client-profiles/${shopId}/requests`, delegateToken)).status).toBe(403);
    setUserPermissions(delegateId, ['view_client_profiles'], ownerId);
    expect((await get(`/api/client-profiles/${shopId}/requests`, delegateToken)).status).toBe(200);
    setUserPermissions(delegateId, [], ownerId);
  });

  it('validates ids and paging', async () => {
    expect((await get('/api/client-profiles/99999/requests', ownerToken)).status).toBe(404);
    expect((await get('/api/admin/users/99999/requests', ownerToken)).status).toBe(404);
    expect((await get('/api/client-profiles/abc/requests', ownerToken)).status).toBe(400);
    expect((await get(`/api/client-profiles/${shopId}/requests?before=x`, ownerToken)).status).toBe(400);
    expect((await get(`/api/client-profiles/${shopId}/requests/abc/attempts`, ownerToken)).status).toBe(400);
    expect((await get(`/api/client-profiles/${shopId}/requests?limit=100000`, ownerToken)).body.requests).toHaveLength(7);
    expect((await get(`/api/client-profiles/${shopId}/requests?limit=0`, ownerToken)).body.requests).toHaveLength(1);
  });
});
