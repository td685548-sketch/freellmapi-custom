import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { up as profileUsageUp } from '../../db/migrations/20261106_000002_custom_profile_usage.js';

// Per-client-profile usage and cap: a request made with an `sk-cp-…` key is attributed to
// its profile (requests.profile_id), the profile's per-minute cap answers 429 past the
// limit, and the analytics/quota routes sit behind the same gate as the profile CRUD.

describe('client profile usage and limit', () => {
  let server: Server;
  let base: string;
  const realFetch = global.fetch;
  let adminToken: string;
  let memberToken: string;

  const call = async (path: string, token: string | undefined, method = 'GET', body?: unknown) => {
    const res = await realFetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) as any };
  };
  const chat = async (key: string) => {
    const res = await call('/v1/chat/completions', key, 'POST', { model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    await new Promise(r => setTimeout(r, 30));
    return res;
  };
  const makeProfile = async (name: string) => {
    const res = await call('/api/client-profiles', adminToken, 'POST', { name, systemPrompt: null });
    expect(res.status).toBe(201);
    return res.body as { id: number; key: string };
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const key = encrypt('gsk_profile_usage');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','p',?,?,?,'healthy',1)`)
      .run(key.encrypted, key.iv, key.authTag);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    adminToken = createSession(createUser('owner@example.com', 'OwnerPass123!').userId);
    memberToken = createSession(createUser('member@example.com', 'MemberPass123!', 'member').userId);
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); });

  it('attributes a profile-key request to its profile and nobody else', async () => {
    const p = await makeProfile('shop');
    expect((await chat(p.key)).status).toBe(200);
    const row = getDb().prepare('SELECT profile_id AS p, user_id AS u FROM requests ORDER BY id DESC LIMIT 1').get() as any;
    expect(row).toEqual({ p: p.id, u: null });
  });

  it('new profiles default to 60 requests per minute', async () => {
    const p = await makeProfile('defaults');
    const a = await call(`/api/client-profiles/${p.id}/analytics`, adminToken);
    expect(a.status).toBe(200);
    expect(a.body.analytics).toMatchObject({ profileId: p.id, name: 'defaults', enabled: true, rpmLimit: 60 });
  });

  it('answers 429 past the cap, with rate-limit headers, and only for that profile', async () => {
    const limited = await makeProfile('limited');
    const other = await makeProfile('other');
    expect((await call(`/api/client-profiles/${limited.id}/quota`, adminToken, 'PUT', { rpmLimit: 2 })).status).toBe(200);

    const first = await chat(limited.key);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-limit-profile-rpm')).toBe('2');
    expect(first.headers.get('x-ratelimit-remaining-profile-rpm')).toBe('1');
    expect((await chat(limited.key)).status).toBe(200);
    const blocked = await chat(limited.key);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('profile_rate_limit_exceeded');

    expect((await chat(other.key)).status).toBe(200); // another profile is unaffected

    // Clearing the cap lifts it.
    expect((await call(`/api/client-profiles/${limited.id}/quota`, adminToken, 'PUT', { rpmLimit: null })).status).toBe(200);
    expect((await chat(limited.key)).status).toBe(200);
  });

  it('a disabled profile key is still refused by authentication, not attributed', async () => {
    const p = await makeProfile('off');
    await call(`/api/client-profiles/${p.id}`, adminToken, 'PATCH', { enabled: false });
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM requests WHERE profile_id = ?').get(p.id) as any;
    expect((await chat(p.key)).status).toBe(401);
    const after = getDb().prepare('SELECT COUNT(*) AS n FROM requests WHERE profile_id = ?').get(p.id) as any;
    expect(after.n).toBe(before.n);
  });

  it('reads usage back per profile', async () => {
    const p = await makeProfile('metrics');
    const q = await makeProfile('metrics-2');
    await chat(p.key); await chat(p.key); await chat(q.key);
    const a = await call(`/api/client-profiles/${p.id}/analytics?days=7`, adminToken);
    expect(a.status).toBe(200);
    expect(a.body.analytics.days).toBe(7);
    expect(a.body.analytics.totals).toMatchObject({ requests: 2, success: 2, errors: 0, inputTokens: 24, outputTokens: 4 });
    expect(a.body.analytics.daily).toHaveLength(7);
    // Auto routing may spread the two requests over several models; they all sum to this profile's two.
    const models = a.body.analytics.models as Array<{ platform: string; requests: number }>;
    expect(models.every(m => m.platform === 'groq')).toBe(true);
    expect(models.reduce((n, m) => n + m.requests, 0)).toBe(2);
  });

  it('sits behind the profile permissions and validates input', async () => {
    const p = await makeProfile('guarded');
    expect((await call(`/api/client-profiles/${p.id}/analytics`, memberToken)).status).toBe(403);
    expect((await call(`/api/client-profiles/${p.id}/quota`, memberToken, 'PUT', { rpmLimit: 5 })).status).toBe(403);
    expect((await call(`/api/client-profiles/${p.id}/analytics`, undefined)).status).toBe(401);
    expect((await call('/api/client-profiles/abc/analytics', adminToken)).status).toBe(400);
    expect((await call('/api/client-profiles/99999/analytics', adminToken)).status).toBe(404);
    expect((await call('/api/client-profiles/99999/quota', adminToken, 'PUT', { rpmLimit: 5 })).status).toBe(404);
    for (const bad of [0, 1001, 1.5, 'x']) {
      expect((await call(`/api/client-profiles/${p.id}/quota`, adminToken, 'PUT', { rpmLimit: bad })).status).toBe(400);
    }
  });

  it('the migration leaves existing profiles unlimited and defaults new ones to 60', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE client_profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL);
      CREATE TABLE requests (id INTEGER PRIMARY KEY, created_at TEXT);
      INSERT INTO client_profiles (name, token_hash) VALUES ('old', 'h1');
    `);
    profileUsageUp(db as any);
    profileUsageUp(db as any); // idempotent
    db.prepare("INSERT INTO client_profiles (name, token_hash) VALUES ('new', 'h2')").run();
    const rows = db.prepare('SELECT name, rpm_limit AS rpm FROM client_profiles ORDER BY id').all();
    expect(rows).toEqual([{ name: 'old', rpm: null }, { name: 'new', rpm: 60 }]);
    expect((db.prepare('PRAGMA table_info(requests)').all() as any[]).some(c => c.name === 'profile_id')).toBe(true);
  });
});
