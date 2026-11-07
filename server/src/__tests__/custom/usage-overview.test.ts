import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { getUsageOverview, resetUsageOverviewCache } from '../../services/usage-overview.js';
import { windowsAt } from '../../services/usage-quotas.js';

// The usage ranking: figures per account / client profile over a window (idle ones included),
// split behind two leaf permissions of the view_usage group.

describe('usage ranking', () => {
  let server: Server;
  let base: string;
  let ownerToken: string;
  let ownerId: number;
  let aliceId: number;
  let bobId: number;
  let shopId: number;
  let blogId: number;
  let viewerId: number;
  let viewerToken: string;
  let memberToken: string;

  const get = async (path: string, token?: string) => {
    const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const grant = (permissions: string[]) => {
    getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(permissions), viewerId);
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
    bobId = createUser('bob@example.com', 'BobPass123!', 'member').userId;
    createUser('idle@example.com', 'IdlePass123!', 'member');
    viewerId = createUser('viewer@example.com', 'ViewerPass123!', 'admin').userId;
    viewerToken = createSession(viewerId);
    memberToken = createSession(aliceId);
    mintUserApiKey(aliceId, 'k');

    const db = getDb();
    const profile = db.prepare("INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled, rpm_limit) VALUES (?, ?, 'e', 'i', 't', ?, ?)");
    shopId = Number(profile.run('Shop widget', 'h-shop', 1, 120).lastInsertRowid);
    blogId = Number(profile.run('Blog bot', 'h-blog', 0, null).lastInsertRowid);

    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
    const ins = db.prepare("INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, created_at, user_id, profile_id) VALUES ('groq','m',NULL,?,?,?,?,NULL,?,?,?)");
    // alice: 20 successes with latencies 100..2000 step 100, plus one error
    for (let i = 1; i <= 20; i++) ins.run('success', 10, 5, i * 100, ago(1), aliceId, null);
    ins.run('error', 0, 0, 50, ago(1), aliceId, null);
    // bob: one success, one canceled, and an old one outside a 7 day window
    ins.run('success', 100, 100, 300, ago(2), bobId, null);
    ins.run('canceled', 0, 0, 10, ago(2), bobId, null);
    ins.run('success', 999, 999, 999, ago(40), bobId, null);
    // profiles
    ins.run('success', 7, 3, 400, ago(1), null, shopId);
    ins.run('error', 0, 0, 20, ago(1), null, shopId);
    // unattributed traffic must show up nowhere
    ins.run('success', 5000, 5000, 1, ago(1), null, null);
  });
  afterAll(() => { server?.close(); });

  it('computes figures per account over the window, idle accounts included', () => {
    const o = getUsageOverview('account', 7);
    const by = Object.fromEntries(o.rows.map(r => [r.name, r]));
    expect(o.rows).toHaveLength(5);
    expect(by['alice@example.com']).toMatchObject({
      kind: 'account', id: aliceId, role: 'member', requests: 21, success: 20, errors: 1, canceled: 0,
      inputTokens: 200, outputTokens: 100, avgLatencyMs: 1050, p95LatencyMs: 1900,
    });
    expect(by['alice@example.com']!.rpmLimit).toBe(60);
    expect(by['bob@example.com']).toMatchObject({ requests: 2, success: 1, canceled: 1, inputTokens: 100, avgLatencyMs: 300, p95LatencyMs: 300 });
    expect(by['idle@example.com']).toMatchObject({ requests: 0, success: 0, avgLatencyMs: null, p95LatencyMs: null, lastRequestAt: null });
    expect(by['owner@example.com']!.role).toBe('admin');
    expect(getUsageOverview('account', 90).rows.find(r => r.id === bobId)!.requests).toBe(3);
  });

  it('computes figures per client profile', () => {
    const o = getUsageOverview('profile', 30);
    const by = Object.fromEntries(o.rows.map(r => [r.name, r]));
    expect(by['Shop widget']).toMatchObject({ kind: 'profile', id: shopId, enabled: true, requests: 2, success: 1, errors: 1, rpmLimit: 120, p95LatencyMs: 400 });
    expect(by['Blog bot']).toMatchObject({ enabled: false, requests: 0, rpmLimit: null });
    expect(by['Shop widget']).not.toHaveProperty('role');
    expect(blogId).toBeGreaterThan(0);
  });

  it('compares with the window of the same length just before', () => {
    const bob = getUsageOverview('account', 30).rows.find(r => r.id === bobId)!;
    expect(bob.previous).toEqual({ requests: 1, errors: 0, tokens: 1998 }); // the request 40 days ago
    const alice = getUsageOverview('account', 30).rows.find(r => r.id === aliceId)!;
    expect(alice.previous).toEqual({ requests: 0, errors: 0, tokens: 0 });
  });

  it('shows the fullest current allowance, and reuses figures for 30 seconds unless asked fresh', async () => {
    const db = getDb();
    const w = windowsAt(Date.now());
    db.prepare("INSERT INTO custom_usage_quotas (subject_kind, subject_id, daily_requests, daily_tokens, monthly_requests, monthly_tokens) VALUES ('profile', ?, 10, NULL, NULL, 1000)").run(shopId);
    db.prepare("INSERT INTO custom_usage_counters (subject_kind, subject_id, period, requests, tokens) VALUES ('profile', ?, ?, 4, 0), ('profile', ?, ?, 4, 900)").run(shopId, w.day, shopId, w.month);
    resetUsageOverviewCache();
    const first = getUsageOverview('profile', 30);
    const shop = first.rows.find(r => r.id === shopId)!;
    expect(shop.allowance).toEqual({ used: 0.9, period: 'month', metric: 'tokens' });
    expect(first.rows.find(r => r.id === blogId)!.allowance).toBeNull();

    const later = Date.now() + 5_000;
    expect(getUsageOverview('profile', 30, later).generatedAt).toBe(first.generatedAt); // nothing changed: reused
    expect((await get('/api/usage/profiles?days=30&fresh=1', ownerToken)).body.overview.generatedAt).not.toBe(first.generatedAt);
    const before = getUsageOverview('profile', 30, later);
    // a change in what it depends on (today's totals here) is seen at once
    db.prepare("UPDATE custom_usage_counters SET requests = 10 WHERE subject_kind = 'profile' AND subject_id = ? AND period = ?").run(shopId, w.day);
    expect(getUsageOverview('profile', 30, later).rows.find(r => r.id === shopId)!.allowance).toEqual({ used: 1, period: 'day', metric: 'requests' });
    // and nothing is reused past 30 seconds
    const reused = getUsageOverview('profile', 30, later);
    expect(getUsageOverview('profile', 30, later + 31_000).generatedAt).not.toBe(reused.generatedAt);
    expect(before.generatedAt).toBeTruthy();
    db.prepare('DELETE FROM custom_usage_counters').run();
    db.prepare('DELETE FROM custom_usage_quotas').run();
    resetUsageOverviewCache();
  });

  it('serves each kind only with its own permission', async () => {
    grant([]);
    expect((await get('/api/usage/accounts', viewerToken)).status).toBe(403);
    expect((await get('/api/usage/profiles', viewerToken)).status).toBe(403);

    grant(['view_usage_accounts']);
    const accounts = await get('/api/usage/accounts?days=7', viewerToken);
    expect(accounts.status).toBe(200);
    expect(accounts.body.overview).toMatchObject({ kind: 'account', days: 7 });
    expect(accounts.body.overview.rows.length).toBe(5);
    expect((await get('/api/usage/profiles', viewerToken)).status).toBe(403);

    grant(['view_usage_profiles']);
    expect((await get('/api/usage/profiles', viewerToken)).status).toBe(200);
    expect((await get('/api/usage/accounts', viewerToken)).status).toBe(403);

    grant(['view_usage']); // the parent grants both
    expect((await get('/api/usage/accounts', viewerToken)).status).toBe(200);
    expect((await get('/api/usage/profiles', viewerToken)).status).toBe(200);
  });

  it('refuses members and anonymous callers, and clamps the window', async () => {
    expect((await get('/api/usage/accounts', memberToken)).status).toBe(403);
    expect((await get('/api/usage/profiles', memberToken)).status).toBe(403);
    expect((await get('/api/usage/accounts')).status).toBe(401);
    expect((await get('/api/usage/accounts?days=100000', ownerToken)).body.overview.days).toBe(90);
    expect((await get('/api/usage/profiles?days=abc', ownerToken)).body.overview.days).toBe(30);
  });

  it('can be handed out through the permission editor', async () => {
    const res = await fetch(`${base}/api/admin/users/${viewerId}/permissions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ permissions: ['view_usage_accounts'] }),
    });
    expect(res.status).toBe(200);
    expect((await get('/api/usage/accounts', viewerToken)).status).toBe(200);
  });
});
