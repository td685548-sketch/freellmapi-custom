import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { defaultDbFactory, getDb, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';
import { setUserPermissions } from '../../services/users.js';
import { resetQuotaCaches } from '../../services/usage-quotas.js';

// The dashboard's "send a test message" for a client profile: it makes a real chat call with the
// profile's own key through /v1 and reports what came back.

describe('client profile test message', () => {
  let server: Server;
  let base: string;
  const realFetch = global.fetch;
  const upstream: Array<{ model: string; text: string }> = [];
  let ownerId: number;
  let ownerToken: string;
  let memberToken: string;
  let delegateId: number;
  let delegateToken: string;
  let profileId: number;
  let profileKey: string;

  const call = async (path: string, token: string | undefined, method = 'GET', body?: unknown) => {
    const res = await realFetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) as any, raw: '' };
  };
  const test = (body: unknown = {}, id = profileId) => call(`/api/client-profiles/${id}/test`, ownerToken, 'POST', body);
  const put = (path: string, body: unknown) => call(`/api/client-profiles/${profileId}/${path}`, ownerToken, 'PUT', body);

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    setKeyCacheTestOverride(true);
    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });
    const key = encrypt('gsk_profile_test');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','t',?,?,?,'healthy',1)`)
      .run(key.encrypted, key.iv, key.authTag);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    ownerId = createUser('owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);
    memberToken = createSession(createUser('member@example.com', 'MemberPass123!', 'member').userId);
    delegateId = createUser('delegate@example.com', 'DelegatePass123!', 'member').userId;
    delegateToken = createSession(delegateId);
    const made = await call('/api/client-profiles', ownerToken, 'POST', { name: 'shop', systemPrompt: null });
    profileId = made.body.id;
    profileKey = made.body.key;
    await put('quota', { rpmLimit: null });

    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      const sent = JSON.parse(String(init?.body ?? '{}'));
      upstream.push({ model: sent.model, text: sent.messages?.at(-1)?.content });
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: sent.model, choices: [{ index: 0, message: { role: 'assistant', content: 'I am working.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setKeyCacheTestOverride(null); });
  afterEach(async () => {
    await put('restrictions', { allowedModels: [], maxTokens: null });
    await put('quota', { rpmLimit: null });
    await put('usage-quota', { dailyRequests: null, dailyTokens: null, monthlyRequests: null, monthlyTokens: null });
    await call(`/api/client-profiles/${profileId}`, ownerToken, 'PATCH', { enabled: true });
    getDb().prepare('DELETE FROM requests').run(); // a new allowance is seeded from the request log
    resetQuotaCaches();
    upstream.length = 0;
  });

  it('sends a real call with the profile key and reports the answer', async () => {
    const r = await test({ message: 'Is the key working?' });
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ status: 200, ok: true, reply: 'I am working.', usage: { inputTokens: 12, outputTokens: 4 }, error: null, retryAfter: null });
    expect(typeof r.body.result.model).toBe('string');
    expect(r.body.result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(upstream.at(-1)!.text).toBe('Is the key working?');
    expect(r.body.profileEnabled).toBe(true);
  });

  it('is a real call: it is attributed to the profile and counted against its allowance', async () => {
    await put('usage-quota', { dailyRequests: 10 });
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM requests WHERE profile_id = ?').get(profileId) as { n: number };
    await test();
    await test({ message: 'again' });
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM requests WHERE profile_id = ?').get(profileId) as { n: number }).n).toBe(before.n + 2);
    expect((await call(`/api/client-profiles/${profileId}/usage-quota`, ownerToken)).body.usage.day.requests).toBe(2);
  });

  it('never returns the key', async () => {
    const r = await realFetch(`${base}/api/client-profiles/${profileId}/test`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` }, body: '{}' });
    const text = await r.text();
    expect(text).not.toContain('sk-cp-');
    expect(text).not.toContain(profileKey);
  });

  it('shows what a restricted key would get', async () => {
    await put('restrictions', { allowedModels: ['llama-3.1-8b-instant'], maxTokens: 50 });
    const refused = await test({ model: 'llama-3.3-70b-versatile' });
    expect(refused.body.result).toMatchObject({ status: 403, ok: false, error: { code: 'model_not_allowed', type: 'permission_error' } });
    expect(upstream).toHaveLength(0);
    const fine = await test({ model: 'llama-3.1-8b-instant' });
    expect(fine.body.result).toMatchObject({ status: 200, ok: true, model: 'llama-3.1-8b-instant' });
    expect((await test({})).body.result).toMatchObject({ status: 200, model: 'llama-3.1-8b-instant' }); // auto stays inside the list
  });

  it('shows a refusal for rate or allowance, with the wait', async () => {
    await put('usage-quota', { dailyRequests: 1 });
    expect((await test()).body.result.ok).toBe(true);
    const full = (await test()).body.result;
    expect(full).toMatchObject({ status: 429, ok: false, error: { code: 'profile_quota_exceeded', type: 'insufficient_quota' } });
    expect(full.retryAfter).toBeGreaterThan(0);

    await put('usage-quota', { dailyRequests: null });
    await put('quota', { rpmLimit: 1 });
    resetQuotaCaches();
    // The first calls of this test file already used this minute's window, so the cap is hit at once or after one call.
    const results = [(await test()).body.result, (await test()).body.result];
    expect(results.some(x => x.status === 429 && x.error.code === 'profile_rate_limit_exceeded')).toBe(true);
  });

  it('reports a disabled profile as refused', async () => {
    await call(`/api/client-profiles/${profileId}`, ownerToken, 'PATCH', { enabled: false });
    const r = await test();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ profileEnabled: false, result: { ok: false, status: 401 } });
  });

  it('is limited to editors and validates its input', async () => {
    expect((await call(`/api/client-profiles/${profileId}/test`, memberToken, 'POST', {})).status).toBe(403);
    expect((await call(`/api/client-profiles/${profileId}/test`, undefined, 'POST', {})).status).toBe(401);
    setUserPermissions(delegateId, ['view_client_profiles'], ownerId);
    expect((await call(`/api/client-profiles/${profileId}/test`, delegateToken, 'POST', {})).status).toBe(403);
    setUserPermissions(delegateId, ['edit_client_profiles'], ownerId);
    expect((await call(`/api/client-profiles/${profileId}/test`, delegateToken, 'POST', {})).status).toBe(200);
    setUserPermissions(delegateId, [], ownerId);

    expect((await test({}, 99999)).status).toBe(404);
    expect((await call('/api/client-profiles/abc/test', ownerToken, 'POST', {})).status).toBe(400);
    for (const bad of [{ message: '' }, { message: 'x'.repeat(1001) }, { model: '' }, { model: 5 }, { nope: 1 }]) {
      expect((await test(bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });
});
