import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { defaultDbFactory, getDb, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { setUserPermissions } from '../../services/users.js';
import { resetQuotaCaches, setQuotaClock } from '../../services/usage-quotas.js';

// Daily / monthly allowances on the Turso-style path (batched writes, SELECT cache): they stop a
// subject at its limit, survive a restart, count a request once it is admitted, hand failed ones
// back, and cost nothing for subjects without a limit.

describe('daily / monthly usage allowances', () => {
  const sql: string[] = [];
  let tracing = false;
  let server: Server;
  let base: string;
  const realFetch = global.fetch;
  let upstreamFails = false;
  let ownerId: number;
  let ownerToken: string;
  let userId: number;
  let userToken: string;
  let userKey: string;
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
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) as any };
  };
  const chat = async (key: string) => {
    const res = await call('/v1/chat/completions', key, 'POST', { model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    await new Promise(r => setTimeout(r, 25));
    return res;
  };
  const setUserQuota = (body: unknown, id = userId) => call(`/api/admin/users/${id}/usage-quota`, ownerToken, 'PUT', body);
  const setProfileQuota = (body: unknown, id = profileId) => call(`/api/client-profiles/${id}/usage-quota`, ownerToken, 'PUT', body);
  const clearAll = async () => {
    await setUserQuota({ dailyRequests: null, dailyTokens: null, monthlyRequests: null, monthlyTokens: null });
    await setProfileQuota({ dailyRequests: null, dailyTokens: null, monthlyRequests: null, monthlyTokens: null });
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    getDb().prepare('DELETE FROM requests').run(); // a new limit is seeded from the request log
    upstreamFails = false;
    resetQuotaCaches();
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    setKeyCacheTestOverride(true);
    initDb(':memory:', {
      factory: () => {
        const raw = defaultDbFactory()(':memory:');
        const prepare = raw.prepare.bind(raw);
        raw.prepare = (text: string) => {
          const stmt = prepare(text);
          const note = <T>(run: () => T): T => { if (tracing) sql.push(text.replace(/\s+/g, ' ').trim()); return run(); };
          return { get: (...a: unknown[]) => note(() => stmt.get(...a)), all: (...a: unknown[]) => note(() => stmt.all(...a)), run: (...a: unknown[]) => note(() => stmt.run(...a)) };
        };
        return wrapTursoDatabase(raw, true);
      },
    });
    const key = encrypt('gsk_quota');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','q',?,?,?,'healthy',1)`)
      .run(key.encrypted, key.iv, key.authTag);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    ownerId = createUser('owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);
    userId = createUser('member@example.com', 'MemberPass123!', 'member').userId;
    userToken = createSession(userId);
    userKey = mintUserApiKey(userId, 'k').key;
    expect((await call(`/api/admin/users/${userId}/quota`, ownerToken, 'PUT', { rpmLimit: 1000 })).status).toBe(200); // the per-minute cap is not what is under test
    delegateId = createUser('delegate@example.com', 'DelegatePass123!', 'member').userId;
    delegateToken = createSession(delegateId);
    const made = await call('/api/client-profiles', ownerToken, 'POST', { name: 'shop', systemPrompt: null });
    profileId = made.body.id;
    profileKey = made.body.key;

    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      if (upstreamFails) return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setKeyCacheTestOverride(null); setQuotaClock(null); });
  afterEach(async () => { setQuotaClock(null); await clearAll(); });

  it('stops an account at its daily request limit, with the details a client needs', async () => {
    expect((await setUserQuota({ dailyRequests: 3 })).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await chat(userKey)).status).toBe(200);
    const denied = await chat(userKey);
    expect(denied.status).toBe(429);
    expect(denied.body.error).toMatchObject({ type: 'insufficient_quota', code: 'user_quota_exceeded', period: 'daily', metric: 'requests', limit: 3, used: 3 });
    expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(new Date(denied.body.error.resets_at).getTime()).toBeGreaterThan(Date.now());
    const state = (await call(`/api/admin/users/${userId}/usage-quota`, ownerToken)).body;
    expect(state).toMatchObject({ tracked: true, quota: { dailyRequests: 3 }, usage: { day: { requests: 3 }, month: { requests: 3 } } });
  });

  it('hands back a request that failed upstream', async () => {
    await setUserQuota({ dailyRequests: 2 });
    upstreamFails = true;
    expect((await chat(userKey)).status).toBeGreaterThanOrEqual(400);
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    upstreamFails = false;
    expect((await call(`/api/admin/users/${userId}/usage-quota`, ownerToken)).body.usage.day.requests).toBe(0);
    expect((await chat(userKey)).status).toBe(200);
    expect((await chat(userKey)).status).toBe(200);
    expect((await chat(userKey)).status).toBe(429);
  });

  it('stops the next request once a token limit is reached', async () => {
    await setUserQuota({ dailyTokens: 20 });
    expect((await chat(userKey)).status).toBe(200); // 14 used
    expect((await chat(userKey)).status).toBe(200); // 28: over, but this one was admitted
    const denied = await chat(userKey);
    expect(denied.status).toBe(429);
    expect(denied.body.error).toMatchObject({ metric: 'tokens', period: 'daily', limit: 20 });
    expect((await call(`/api/admin/users/${userId}/usage-quota`, ownerToken)).body.usage.day.tokens).toBe(28);
  });

  it('limits a client profile by month and keeps it apart from accounts', async () => {
    await setProfileQuota({ monthlyRequests: 2 });
    expect((await chat(profileKey)).status).toBe(200);
    expect((await chat(profileKey)).status).toBe(200);
    const denied = await chat(profileKey);
    expect(denied.status).toBe(429);
    expect(denied.body.error).toMatchObject({ code: 'profile_quota_exceeded', period: 'monthly', metric: 'requests', limit: 2 });
    expect((await chat(userKey)).status).toBe(200); // the account has no limit
  });

  it('counts a request when it is admitted, so a burst cannot slip under the limit', async () => {
    await setUserQuota({ dailyRequests: 5 });
    const results = await Promise.all(Array.from({ length: 25 }, () => call('/v1/chat/completions', userKey, 'POST', { model: 'auto', messages: [{ role: 'user', content: 'hi' }] })));
    expect(results.filter(r => r.status === 200)).toHaveLength(5);
    expect(results.filter(r => r.status === 429)).toHaveLength(20);
  });

  it('keeps the totals across a restart', async () => {
    await setUserQuota({ dailyRequests: 3 });
    await chat(userKey); await chat(userKey);
    resetQuotaCaches(); // what a restart forgets
    expect((await call(`/api/admin/users/${userId}/usage-quota`, ownerToken)).body.usage.day.requests).toBe(2);
    expect((await chat(userKey)).status).toBe(200);
    expect((await chat(userKey)).status).toBe(429);
    const row = getDb().prepare("SELECT requests FROM custom_usage_counters WHERE subject_kind = 'user' AND subject_id = ? AND period LIKE 'd%'").get(userId) as any;
    expect(row.requests).toBe(3);
  });

  it('starts a fresh day, and a fresh month, when the window rolls over', async () => {
    const at = (iso: string) => setQuotaClock(() => Date.parse(iso));
    at('2026-01-30T12:00:00Z');
    await setUserQuota({ dailyRequests: 1, monthlyRequests: 3 });
    expect((await chat(userKey)).status).toBe(200);
    const day = await chat(userKey);
    expect(day.status).toBe(429);
    expect(day.body.error).toMatchObject({ period: 'daily', resets_at: '2026-01-31T00:00:00.000Z' });

    at('2026-01-31T09:00:00Z'); // a new day, the same month
    expect((await chat(userKey)).status).toBe(200);
    expect((await chat(userKey)).status).toBe(429);

    at('2026-02-01T00:00:05Z'); // a new month: the month's allowance is back too
    expect((await call(`/api/admin/users/${userId}/usage-quota`, ownerToken)).body.usage).toEqual({ day: { requests: 0, tokens: 0 }, month: { requests: 0, tokens: 0 } });
    expect((await chat(userKey)).status).toBe(200);
  });

  it('refuses by month once the month is full, whatever the day', async () => {
    const at = (iso: string) => setQuotaClock(() => Date.parse(iso));
    at('2026-03-10T08:00:00Z');
    await setUserQuota({ dailyRequests: 5, monthlyRequests: 2 });
    expect((await chat(userKey)).status).toBe(200);
    expect((await chat(userKey)).status).toBe(200);
    const month = await chat(userKey);
    expect(month.status).toBe(429);
    expect(month.body.error).toMatchObject({ period: 'monthly', metric: 'requests', resets_at: '2026-04-01T00:00:00.000Z' });
    at('2026-03-11T08:00:00Z');
    expect((await chat(userKey)).status).toBe(429);
  });

  it('counts what was already used today when a limit is first set', async () => {
    const insert = getDb().prepare("INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, created_at, user_id) VALUES ('groq','m',NULL,?,?,?,10,NULL,datetime('now'),?)");
    insert.run('success', 100, 50, userId); insert.run('success', 10, 5, userId); insert.run('error', 0, 0, userId);
    await setUserQuota({ dailyRequests: 2 });
    const state = (await call(`/api/admin/users/${userId}/usage-quota`, ownerToken)).body;
    expect(state.usage.day).toEqual({ requests: 2, tokens: 165 });
    expect((await chat(userKey)).status).toBe(429);
  });

  it('lifts every limit when all are cleared, and merges partial updates', async () => {
    await setUserQuota({ dailyRequests: 1, monthlyTokens: 1000 });
    expect((await setUserQuota({ dailyRequests: 5 })).body.quota).toEqual({ dailyRequests: 5, dailyTokens: null, monthlyRequests: null, monthlyTokens: 1000 });
    expect((await setUserQuota({ dailyRequests: null, monthlyTokens: null })).body).toMatchObject({ tracked: false, quota: { dailyRequests: null, monthlyTokens: null } });
    for (let i = 0; i < 4; i++) expect((await chat(userKey)).status).toBe(200);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM custom_usage_quotas WHERE subject_id = ? AND subject_kind = 'user'").get(userId)).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM custom_usage_counters WHERE subject_id = ? AND subject_kind = 'user'").get(userId)).toEqual({ n: 0 });
  });

  it('costs a subject without a limit at most one lookup per half minute and no writes', async () => {
    await clearAll();
    tracing = true; sql.length = 0;
    for (let i = 0; i < 5; i++) expect((await chat(userKey)).status).toBe(200);
    tracing = false;
    expect(sql.filter(s => /custom_usage_quotas/.test(s))).toHaveLength(1);
    expect(sql.filter(s => /custom_usage_counters/.test(s))).toHaveLength(0);
  });

  it('touches the database once per request for a subject with a limit once warm', async () => {
    await setUserQuota({ dailyRequests: 100 });
    await chat(userKey);
    tracing = true; sql.length = 0;
    for (let i = 0; i < 4; i++) expect((await chat(userKey)).status).toBe(200);
    tracing = false;
    expect(sql.filter(s => /custom_usage_quotas/.test(s)).length).toBeLessThanOrEqual(1);
    expect(sql.filter(s => /SELECT .* FROM custom_usage_counters/.test(s))).toHaveLength(0);
    expect(sql.filter(s => /INSERT INTO custom_usage_counters/.test(s))).toHaveLength(4); // one upsert per successful request
  });

  describe('permissions and validation', () => {
    it('refuses members and anonymous callers on the admin routes; members read only their own', async () => {
      expect((await call(`/api/admin/users/${userId}/usage-quota`, userToken)).status).toBe(403);
      expect((await call(`/api/admin/users/${userId}/usage-quota`, userToken, 'PUT', { dailyRequests: 5 })).status).toBe(403);
      expect((await call(`/api/admin/users/${userId}/usage-quota`, undefined)).status).toBe(401);
      expect((await call('/api/user/usage-quota', undefined)).status).toBe(401);
      await setUserQuota({ dailyRequests: 7 });
      const own = await call('/api/user/usage-quota', userToken);
      expect(own.status).toBe(200);
      expect(own.body).toMatchObject({ tracked: true, quota: { dailyRequests: 7 } });
      expect((await call('/api/user/usage-quota', delegateToken)).body.tracked).toBe(false);
    });

    it('splits reading and changing between view_users and edit_user_quotas', async () => {
      setUserPermissions(delegateId, ['view_users'], ownerId);
      expect((await call(`/api/admin/users/${userId}/usage-quota`, delegateToken)).status).toBe(200);
      expect((await call(`/api/admin/users/${userId}/usage-quota`, delegateToken, 'PUT', { dailyRequests: 5 })).status).toBe(403);
      setUserPermissions(delegateId, ['edit_user_quotas'], ownerId);
      expect((await call(`/api/admin/users/${userId}/usage-quota`, delegateToken)).status).toBe(403);
      expect((await call(`/api/admin/users/${userId}/usage-quota`, delegateToken, 'PUT', { dailyRequests: 5 })).status).toBe(200);
      setUserPermissions(delegateId, [], ownerId);
    });

    it('guards client profiles with the profile permissions', async () => {
      expect((await call(`/api/client-profiles/${profileId}/usage-quota`, userToken)).status).toBe(403);
      setUserPermissions(delegateId, ['view_client_profiles'], ownerId);
      expect((await call(`/api/client-profiles/${profileId}/usage-quota`, delegateToken)).status).toBe(200);
      expect((await call(`/api/client-profiles/${profileId}/usage-quota`, delegateToken, 'PUT', { dailyRequests: 5 })).status).toBe(403);
      setUserPermissions(delegateId, ['edit_client_profiles'], ownerId);
      expect((await call(`/api/client-profiles/${profileId}/usage-quota`, delegateToken, 'PUT', { dailyRequests: 5 })).status).toBe(200);
      setUserPermissions(delegateId, [], ownerId);
    });

    it('protects the primary admin and rejects unknown subjects and bad input', async () => {
      expect((await setUserQuota({ dailyRequests: 5 }, ownerId)).status).toBe(403);
      expect((await setUserQuota({ dailyRequests: 5 }, 99999)).status).toBe(404);
      expect((await call('/api/admin/users/abc/usage-quota', ownerToken)).status).toBe(400);
      expect((await call('/api/client-profiles/99999/usage-quota', ownerToken)).status).toBe(404);
      expect((await setProfileQuota({ dailyRequests: 5 }, 99999)).status).toBe(404);
      for (const bad of [{ dailyRequests: 0 }, { dailyRequests: -1 }, { dailyRequests: 1.5 }, { dailyRequests: '5' }, { dailyTokens: 1e13 }, { nope: 1 }, { dailyRequests: [] }]) {
        expect((await setUserQuota(bad)).status, JSON.stringify(bad)).toBe(400);
        expect((await setProfileQuota(bad)).status, JSON.stringify(bad)).toBe(400);
      }
    });
  });
});
