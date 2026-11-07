import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { defaultDbFactory, getDb, getUnifiedApiKey, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';
import { setUserPermissions } from '../../services/users.js';
import { resetEndUserCounters } from '../../services/end-user-quotas.js';
import { resetQuotaCaches } from '../../services/usage-quotas.js';

// End users of a client key: a web app names its visitor (X-End-User, or the OpenAI `user` field), the
// request is attributed to that visitor, usage can be read per visitor, and each visitor can get an
// allowance of their own.

describe('end users behind a client key', () => {
  let server: Server;
  let base: string;
  const realFetch = global.fetch;
  let ownerId: number;
  let ownerToken: string;
  let memberToken: string;
  let delegateId: number;
  let delegateToken: string;
  let profileId: number;
  let profileKey: string;

  const call = async (path: string, token: string | undefined, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const res = await realFetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const chat = async (endUser?: string, extra: Record<string, unknown> = {}, key = profileKey) => {
    const r = await call('/v1/chat/completions', key, 'POST', { model: 'auto', messages: [{ role: 'user', content: 'hi' }], ...extra }, endUser !== undefined ? { 'x-end-user': endUser } : {});
    await new Promise(res => setTimeout(res, 20));
    return r;
  };
  const lastEndUser = () => (getDb().prepare('SELECT end_user AS e FROM requests ORDER BY id DESC LIMIT 1').get() as { e: string | null }).e;
  const euQuota = (body: unknown) => call(`/api/client-profiles/${profileId}/end-user-quota`, ownerToken, 'PUT', body);

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    setKeyCacheTestOverride(true);
    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });
    const key = encrypt('gsk_end_users');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','e',?,?,?,'healthy',1)`)
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
    await call(`/api/client-profiles/${profileId}/quota`, ownerToken, 'PUT', { rpmLimit: null });
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setKeyCacheTestOverride(null); });
  afterEach(async () => {
    await euQuota({ dailyRequests: null, dailyTokens: null, monthlyRequests: null, monthlyTokens: null });
    await call(`/api/client-profiles/${profileId}/usage-quota`, ownerToken, 'PUT', { dailyRequests: null });
    getDb().prepare('DELETE FROM requests').run();
    resetEndUserCounters(); resetQuotaCaches();
  });

  it('records the end user from the header or the OpenAI user field, header first', async () => {
    await chat('alice');
    expect(lastEndUser()).toBe('alice');
    await chat(undefined, { user: 'bob' });
    expect(lastEndUser()).toBe('bob');
    await chat('carol', { user: 'bob' });
    expect(lastEndUser()).toBe('carol');
    await chat('  dave  ');
    expect(lastEndUser()).toBe('dave');
    await chat('x'.repeat(129));
    expect(lastEndUser()).toBeNull();
    await chat(undefined, { user: 42 });
    expect(lastEndUser()).toBeNull();
    await chat();
    expect(lastEndUser()).toBeNull();
  });

  it('only records end users of client keys', async () => {
    await chat('alice', {}, getUnifiedApiKey());
    expect(lastEndUser()).toBeNull();
  });

  it('reads usage per end user', async () => {
    await chat('alice'); await chat('alice'); await chat('bob'); await chat();
    const r = await call(`/api/client-profiles/${profileId}/end-users?days=7`, ownerToken);
    expect(r.status).toBe(200);
    expect(r.body.overview).toMatchObject({ days: 7, unattributedRequests: 1, quota: { dailyRequests: null } });
    expect(r.body.overview.endUsers.map((e: any) => [e.endUser, e.requests, e.tokens])).toEqual([['alice', 2, 8], ['bob', 1, 4]]);
    expect(r.body.overview.endUsers[0]).toMatchObject({ success: 2, errors: 0, today: null, month: null });
    const recent = await call(`/api/client-profiles/${profileId}/requests?endUser=alice`, ownerToken);
    expect(recent.body.requests.map((x: any) => x.endUser)).toEqual(['alice', 'alice']);
  });

  it('gives every end user their own allowance', async () => {
    await call(`/api/client-profiles/${profileId}/usage-quota`, ownerToken, 'PUT', { dailyRequests: 100 });
    expect((await euQuota({ dailyRequests: 2 })).body.quota).toMatchObject({ dailyRequests: 2, dailyTokens: null });
    expect((await chat('alice')).status).toBe(200);
    expect((await chat('alice')).status).toBe(200);
    const refused = await chat('alice');
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatchObject({ code: 'end_user_quota_exceeded', type: 'insufficient_quota', period: 'daily', metric: 'requests', limit: 2, used: 2 });
    expect((await chat('bob')).status).toBe(200);
    expect((await chat()).status).toBe(200); // no end user: only the key's own limits apply
    // The refused request did not touch the key's own allowance.
    expect((await call(`/api/client-profiles/${profileId}/usage-quota`, ownerToken)).body.usage.day.requests).toBe(4);
    const overview = (await call(`/api/client-profiles/${profileId}/end-users`, ownerToken)).body.overview;
    expect(overview.endUsers.find((e: any) => e.endUser === 'alice').today).toEqual({ requests: 2, tokens: 8 });
  });

  it('keeps the totals across a restart and counts what was used before the allowance was set', async () => {
    await chat('alice'); await chat('alice'); // before any allowance
    await euQuota({ dailyRequests: 3 });
    expect((await chat('alice')).status).toBe(200);
    resetEndUserCounters(); // what a restart forgets
    expect((await chat('alice')).status).toBe(429);
  });

  it('caps tokens per end user too', async () => {
    await euQuota({ dailyTokens: 6 });
    expect((await chat('alice')).status).toBe(200); // 4
    expect((await chat('alice')).status).toBe(200); // 8, over, but admitted
    expect((await chat('alice')).body.error).toMatchObject({ code: 'end_user_quota_exceeded', metric: 'tokens' });
  });

  it('is guarded by the profile permissions and validates its input', async () => {
    expect((await call(`/api/client-profiles/${profileId}/end-users`, memberToken)).status).toBe(403);
    expect((await call(`/api/client-profiles/${profileId}/end-user-quota`, memberToken, 'PUT', { dailyRequests: 1 })).status).toBe(403);
    setUserPermissions(delegateId, ['view_client_profiles'], ownerId);
    expect((await call(`/api/client-profiles/${profileId}/end-users`, delegateToken)).status).toBe(200);
    expect((await call(`/api/client-profiles/${profileId}/end-user-quota`, delegateToken)).status).toBe(200);
    expect((await call(`/api/client-profiles/${profileId}/end-user-quota`, delegateToken, 'PUT', { dailyRequests: 1 })).status).toBe(403);
    setUserPermissions(delegateId, ['edit_client_profiles'], ownerId);
    expect((await call(`/api/client-profiles/${profileId}/end-user-quota`, delegateToken, 'PUT', { dailyRequests: 1 })).status).toBe(200);
    setUserPermissions(delegateId, [], ownerId);
    expect((await call('/api/client-profiles/99999/end-users', ownerToken)).status).toBe(404);
    expect((await call('/api/client-profiles/99999/end-user-quota', ownerToken, 'PUT', { dailyRequests: 1 })).status).toBe(404);
    for (const bad of [{ dailyRequests: 0 }, { dailyRequests: 1.5 }, { dailyRequests: '2' }, { other: 1 }]) {
      expect((await euQuota(bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });
});
