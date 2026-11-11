import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { initDb, getDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { encrypt } from '../../lib/crypto.js';
import { accountRow, invalidateXGatewayKeyCache } from '../../custom/provider-accounts/store.js';
import { withQuotaTracking } from '../../custom/x-gateway/quota/tracking.js';
import { applyQuotaRouting, recordQuotaWindows } from '../../custom/x-gateway/quota/store.js';
import {
  getAccountCooldown,
  getAllCooldowns,
  setAccountCooldown,
  clearAccountCooldown,
  getAvailability,
} from '../../custom/provider-accounts/auto-ping.js';
import { proxyFetch } from '../../lib/proxy.js';

describe('429 -> cooldown -> availability -> clear', () => {
  let server: Server;
  let base: string;
  let admin: string;
  let denied: string;
  let a: number;
  let b: number;
  const realFetch = global.fetch;
  const upstream = vi.fn();

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    admin = createSession(createUser('cooldown-admin@example.test', 'AdminPass123!').userId);
    denied = createSession(createUser('cooldown-denied@example.test', 'MemberPass123!', 'member').userId);
    const secret = encrypt('gsk_cooldown_secret');
    const seed = (provider: string, label: string) => Number(getDb().prepare(`INSERT INTO x_gateway_keys
      (provider,label,auth_method,encrypted_key,iv,auth_tag,status,enabled) VALUES (?,?,'api_key',?,?,?,'healthy',1)`)
      .run(provider, label, secret.encrypted, secret.iv, secret.authTag).lastInsertRowid);
    a = seed('groq', 'Groq main');
    b = seed('openrouter', 'OpenRouter main');
    invalidateXGatewayKeyCache();
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    vi.spyOn(global, 'fetch').mockImplementation((url, init) => String(url).startsWith(base) ? realFetch(url, init) : upstream(url, init));
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); });
  beforeEach(() => {
    clearAccountCooldown(a);
    clearAccountCooldown(b);
    getDb().prepare('DELETE FROM x_gateway_quota').run();
    upstream.mockReset();
  });

  const call = (path: string, token = admin, method = 'GET', body?: unknown) => fetch(`${base}/api/x-accounts${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const hit429 = (id: number, model: string, headers: Record<string, string> = { 'retry-after': '30' }) => {
    upstream.mockResolvedValue(new Response('{}', { status: 429, headers }));
    return withQuotaTracking(accountRow(id), model, undefined, () => proxyFetch('https://api.example.test/chat', {}, 'groq', 'unknown'));
  };

  it('records an instant cooldown with model and error from a 429 Retry-After', async () => {
    await hit429(a, 'model-a');
    const status = getAccountCooldown(a, 'model-a');
    expect(status.inCooldown).toBe(true);
    expect(status.modelId).toBe('model-a');
    expect(status.lastError).toContain('429');
    expect(status.remainingMs).toBeGreaterThan(25_000);
    expect(status.remainingMs).toBeLessThanOrEqual(30_000);
    // Other models of the same account are unaffected by a model-scoped cooldown.
    expect(getAccountCooldown(a, 'model-b').inCooldown).toBe(false);
    expect(getAllCooldowns()[a]).toBeDefined();
  });

  it('defaults to 60s when Retry-After is missing', async () => {
    await hit429(a, 'model-a', {});
    const { remainingMs } = getAccountCooldown(a, 'model-a');
    expect(remainingMs).toBeGreaterThan(55_000);
    expect(remainingMs).toBeLessThanOrEqual(60_000);
  });

  it('keeps legacy account-wide cooldown semantics', () => {
    setAccountCooldown(a, 5_000);
    expect(getAccountCooldown(a, 'any-model').inCooldown).toBe(true);
    clearAccountCooldown(a);
    expect(getAccountCooldown(a).inCooldown).toBe(false);
  });

  it('requires authentication and use_x_gateway permission', async () => {
    expect((await call('/availability', '')).status).toBe(401);
    expect((await call('/availability', denied)).status).toBe(403);
    expect((await call('/cooldowns/clear', denied, 'POST', {})).status).toBe(403);
    expect((await call('/auto-ping', denied)).status).toBe(403);
  });

  it('reports cooldown and quota-exhausted entries without duplicating a 429', async () => {
    await hit429(a, 'model-a');
    recordQuotaWindows(b, [{ id: 'requests', limit: 10, remaining: 0, resetAt: new Date(Date.now() + 120_000).toISOString(),
      unit: 'requests', blocking: true, source: 'header' }]);
    const data = await (await call('/availability')).json();
    expect(data.unavailableCount).toBe(2);
    expect(data.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: a, accountLabel: 'Groq main', provider: 'groq', model: 'model-a', status: 'cooldown' }),
      expect.objectContaining({ accountId: b, provider: 'openrouter', model: null, status: 'quota_exhausted' }),
    ]));
    for (const m of data.models) expect(m.remainingMs).toBeGreaterThan(0);
    expect(JSON.stringify(data)).not.toContain('gsk_cooldown_secret');
  });

  it('reports a 429 recorded only as a quota window as a cooldown', () => {
    recordQuotaWindows(a, [{ id: 'rate-limit-cooldown', limit: null, remaining: 0, resetAt: new Date(Date.now() + 60_000).toISOString(),
      unit: 'requests', blocking: true, source: 'header', modelId: 'model-z' }]);
    expect(getAvailability().models).toEqual([expect.objectContaining({ accountId: a, model: 'model-z', status: 'cooldown' })]);
  });

  it('clears one account/model, then everything', async () => {
    await hit429(a, 'model-a');
    await hit429(a, 'model-b');
    await hit429(b, 'model-a');
    expect(applyQuotaRouting([accountRow(a)], false, Date.now(), 'model-a')).toEqual([]);

    expect((await call('/cooldowns/clear', admin, 'POST', { accountId: 0 })).status).toBe(400);
    expect((await call('/cooldowns/clear', admin, 'POST', { bogus: 1 })).status).toBe(400);

    const one = await (await call('/cooldowns/clear', admin, 'POST', { accountId: a, model: 'model-a' })).json();
    expect(one.cleared.cooldowns).toBe(1);
    expect(getAccountCooldown(a, 'model-a').inCooldown).toBe(false);
    expect(getAccountCooldown(a, 'model-b').inCooldown).toBe(true);
    expect(applyQuotaRouting([accountRow(a)], false, Date.now(), 'model-a')).toHaveLength(1);
    expect(applyQuotaRouting([accountRow(a)], false, Date.now(), 'model-b')).toEqual([]);

    const byProvider = await (await call('/cooldowns/clear', admin, 'POST', { provider: 'openrouter' })).json();
    expect(byProvider.cleared.cooldowns).toBe(1);
    expect(getAccountCooldown(b).inCooldown).toBe(false);
    expect(getAccountCooldown(a, 'model-b').inCooldown).toBe(true);

    const all = await (await call('/cooldowns/clear', admin, 'POST', {})).json();
    expect(all.unavailableCount).toBe(0);
    expect((await (await call('/availability')).json()).models).toEqual([]);
    expect(applyQuotaRouting([accountRow(a)], false, Date.now(), 'model-b')).toHaveLength(1);
  });

  it('exposes aggregate auto-ping status and runs enabled schedules', async () => {
    const empty = await (await call('/auto-ping')).json();
    expect(empty).toMatchObject({ enabled: false, activeSchedules: 0, lastRunAt: null, schedules: [] });

    expect((await call(`/${a}/auto-ping`, admin, 'PUT', { mode: 'reset' })).status).toBe(200);
    const status = await (await call('/auto-ping')).json();
    expect(status).toMatchObject({ enabled: true, activeSchedules: 1 });
    expect(status.schedules[0].accountId).toBe(a);

    // groq has no key-validation probe configured in tests: the ping resolves without throwing.
    upstream.mockResolvedValue(new Response('{}', { status: 200 }));
    const run = await (await call('/auto-ping/run', admin, 'POST')).json();
    expect(run.ran).toBe(1);
    expect(run.results[0].accountId).toBe(a);
    expect((await (await call('/auto-ping')).json()).lastRunAt).not.toBeNull();

    await call(`/${a}/auto-ping`, admin, 'PUT', { mode: 'off' });
    expect((await (await call('/auto-ping/run', admin, 'POST')).json()).ran).toBe(0);
  });
});
