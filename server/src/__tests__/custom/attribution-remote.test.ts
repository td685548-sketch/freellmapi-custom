import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { defaultDbFactory, getDb, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';
import { mintUserApiKey } from '../../services/user-keys.js';

// The way production runs on Turso: batched writes (values inlined into one script) and the
// short-lived SELECT cache. The other usage tests run on a plain local database, where neither is
// active, so this one proves attribution and the read-after-write behaviour of the new pages hold
// on the remote path too.

describe('user / profile attribution on the remote-style database', () => {
  let server: Server;
  let base: string;
  const realFetch = global.fetch;
  let ownerToken: string;
  let memberId: number;
  let memberKey: string;
  let profileId: number;
  let profileKey: string;

  const call = async (path: string, token: string, method = 'GET', body?: unknown) => {
    const res = await realFetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const chat = async (key: string) => {
    const res = await call('/v1/chat/completions', key, 'POST', { model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    await new Promise(r => setTimeout(r, 40));
    return res;
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    setKeyCacheTestOverride(true);
    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });
    const key = encrypt('gsk_remote_attr');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','r',?,?,?,'healthy',1)`)
      .run(key.encrypted, key.iv, key.authTag);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    ownerToken = createSession(createUser('owner@example.com', 'OwnerPass123!').userId);
    memberId = createUser('member@example.com', 'MemberPass123!', 'member').userId;
    memberKey = mintUserApiKey(memberId, 'k').key;
    const made = await call('/api/client-profiles', ownerToken, 'POST', { name: 'remote-shop', systemPrompt: null });
    profileId = made.body.id;
    profileKey = made.body.key;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setKeyCacheTestOverride(null); });

  it('writes user_id and profile_id through the batched, inlined INSERT', async () => {
    expect((await chat(memberKey)).status).toBe(200);
    expect((await chat(profileKey)).status).toBe(200);
    expect((await chat(profileKey)).status).toBe(200);
    const rows = getDb().prepare('SELECT user_id AS u, profile_id AS p, status FROM requests ORDER BY id').all() as any[];
    expect(rows).toEqual([
      { u: memberId, p: null, status: 'success' },
      { u: null, p: profileId, status: 'success' },
      { u: null, p: profileId, status: 'success' },
    ]);
  });

  it('shows fresh numbers right after a request, despite the SELECT cache', async () => {
    const read = async () => (await call(`/api/admin/users/${memberId}/analytics`, ownerToken)).body.analytics.totals.requests;
    const before = await read();
    await chat(memberKey);
    expect(await read()).toBe(before + 1);

    const rank = async () => (await call('/api/usage/profiles', ownerToken)).body.overview.rows.find((r: any) => r.id === profileId).requests;
    const ranked = await rank();
    await chat(profileKey);
    expect(await rank()).toBe(ranked + 1);

    const monthly = (await call('/api/user/usage', createSession(memberId))).body.usage;
    expect(monthly.requests).toBeGreaterThanOrEqual(2);
    expect(monthly.tokens).toBeGreaterThanOrEqual(28);
  });

  it('applies a changed cap, a disabled key and a lifted cap at once', async () => {
    // A fresh profile: the per-minute window already holds the requests the others made.
    const made = (await call('/api/client-profiles', ownerToken, 'POST', { name: 'capped', systemPrompt: null })).body;
    expect((await call(`/api/client-profiles/${made.id}/quota`, ownerToken, 'PUT', { rpmLimit: 1 })).status).toBe(200);
    expect((await chat(made.key)).status).toBe(200);
    expect((await chat(made.key)).status).toBe(429);

    expect((await call(`/api/client-profiles/${made.id}/quota`, ownerToken, 'PUT', { rpmLimit: null })).status).toBe(200);
    expect((await chat(made.key)).status).toBe(200);

    expect((await call(`/api/client-profiles/${made.id}`, ownerToken, 'PATCH', { enabled: false })).status).toBe(200);
    expect((await chat(made.key)).status).toBe(401);
    expect((await call(`/api/client-profiles/${made.id}`, ownerToken, 'PATCH', { enabled: true })).status).toBe(200);
    expect((await chat(made.key)).status).toBe(200);
  });

  it('stops counting a deleted profile key', async () => {
    const extra = (await call('/api/client-profiles', ownerToken, 'POST', { name: 'doomed', systemPrompt: null })).body;
    expect((await chat(extra.key)).status).toBe(200);
    expect((await call(`/api/client-profiles/${extra.id}`, ownerToken, 'DELETE')).status).toBeLessThan(300);
    expect((await chat(extra.key)).status).toBe(401);
    expect((await call('/api/usage/profiles', ownerToken)).body.overview.rows.some((r: any) => r.id === extra.id)).toBe(false);
  });
});
