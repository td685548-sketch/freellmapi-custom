import { crc32 } from '../../custom/provider-accounts/kiro-wire.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { initDb, getDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { encrypt } from '../../lib/crypto.js';
import { parseProviderQuota, parseQuotaHeaders, quotaReset } from '../../custom/x-gateway/quota/adapters.js';
import { applyQuotaRouting, recordQuotaWindows, setQuotaTier } from '../../custom/x-gateway/quota/store.js';
import { accountRow, invalidateXGatewayKeyCache } from '../../custom/provider-accounts/store.js';
import { resolveCandidateRoutes } from '../../custom/x-gateway/router.js';
import { createCombo, setEnabled } from '../../custom/x-gateway/config.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { withQuotaTracking } from '../../custom/x-gateway/quota/tracking.js';
import { proxyFetch } from '../../lib/proxy.js';
import { up, down } from '../../db/migrations/20261107_140000_custom_x_gateway_quota.js';

describe('provider quota parsing', () => {
  it('does not fabricate values from null or missing provider fields', () => {
    expect(parseProviderQuota('claude', {})).toEqual([]);
    expect(parseProviderQuota('codex', { rate_limit: { primary_window: {} } })).toEqual([]);
    expect(parseQuotaHeaders(new Headers())).toEqual([]);
  });
  it('normalizes provider windows and preserves model scope', () => {
    expect(parseProviderQuota('claude', { five_hour: { utilization: 80, resets_at: '2026-11-08T00:00:00Z' },
      seven_day_opus: { utilization: 100 } })).toMatchObject([
      { remaining: 20, limit: 100, blocking: true }, { remaining: 0, blocking: false },
    ]);
    expect(parseProviderQuota('codex', { rate_limit: { primary_window: { used_percent: 32, reset_at: 1794096000 } } })[0])
      .toMatchObject({ remaining: 68, unit: '%', resetAt: new Date(1794096000000).toISOString() });
    expect(parseProviderQuota('github-copilot', { quota_snapshots: { chat: { entitlement: 100, remaining: 8 },
      premium_interactions: { entitlement: 100, remaining: 0 } } })).toMatchObject([{ remaining: 8, blocking: true }, { blocking: false }]);
    expect(parseProviderQuota('openrouter', { data: { limit: 10, usage: 3 } })[0]).toMatchObject({ remaining: 7, unit: 'USD' });
    expect(parseProviderQuota('deepseek', { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '2.5' }] })[0])
      .toMatchObject({ remaining: 2.5, limit: null });
  });
  it('parses compound resets and exact zero remaining without inventing totals', () => {
    const now = Date.now();
    expect(quotaReset('2m59.56s', now)).toBe(new Date(now + 179560).toISOString());
    expect(parseQuotaHeaders(new Headers({ 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '2m' }), 200, now)[0])
      .toMatchObject({ remaining: 0, limit: null, resetAt: new Date(now + 120000).toISOString() });
    expect(parseQuotaHeaders(new Headers({ 'anthropic-ratelimit-tokens-limit': '100', 'anthropic-ratelimit-tokens-remaining': '80' }))[0])
      .toMatchObject({ remaining: 80, limit: 100 });
  });
});

describe('X account quota HTTP, routing and isolation', () => {
  let server: Server; let base: string; let admin: string; let reader: string; let denied: string; let apiKey: string;
  let first: number; let second: number; let third: number;
  const realFetch = global.fetch;
  const upstream = vi.fn();
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:');
    const owner = createUser('quota-admin@example.test', 'AdminPass123!');
    admin = createSession(owner.userId);
    apiKey = mintUserApiKey(owner.userId, 'Quota routing test').key;
    const user = createUser('quota-reader@example.test', 'MemberPass123!', 'member');
    getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run('["use_x_gateway","view_x_usage"]', user.userId);
    reader = createSession(user.userId);
    denied = createSession(createUser('quota-denied@example.test', 'MemberPass123!', 'member').userId);
    const secret = encrypt('gsk_quota_secret');
    const seed = (provider: string) => Number(getDb().prepare(`INSERT INTO x_gateway_keys
      (provider,label,auth_method,encrypted_key,iv,auth_tag,status,enabled) VALUES (?,'Quota account','api_key',?,?,?,'healthy',1)`)
      .run(provider, ...(provider === 'kiro' ? (() => { const value = encrypt(JSON.stringify({ v: 1, kind: 'kiro', accessToken: 'kiro-fixture', refreshToken: 'refresh-fixture', expiresAt: Date.now() + 86400000, region: 'us-east-1', authMethod: 'social' })); return [value.encrypted, value.iv, value.authTag]; })() : [secret.encrypted, secret.iv, secret.authTag])).lastInsertRowid);
    first = seed('groq'); second = seed('claude'); third = seed('kiro'); invalidateXGatewayKeyCache();
    server = createApp().listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    vi.spyOn(global, 'fetch').mockImplementation((url, init) => String(url).startsWith(base) ? realFetch(url, init) : upstream(url, init));
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); });
  const call = (path = '', token = reader, method = 'GET', body?: unknown) => fetch(`${base}/api/thruline/quota${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  it('enforces quota reads/refresh and settings writes independently', async () => {
    expect((await call('', '')).status).toBe(401);
    expect((await call('', denied)).status).toBe(403);
    expect((await call(`/${first}/refresh`, denied, 'POST')).status).toBe(403);
    expect((await call(`/${first}/tier`, reader, 'PUT', { tier: 'free' })).status).toBe(403);
    expect((await call(`/${first}/tier`, admin, 'PUT', { tier: 'free' })).status).toBe(200);
    expect((await call('/oops/refresh', admin, 'POST')).status).toBe(400);
    expect((await call('/999999/refresh', admin, 'POST')).status).toBe(404);
    expect((await call(`/${first}/tier`, admin, 'PUT', { tier: 'paid', secret: 'x' })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('refreshes actual headers, coalesces repeats and exposes no credentials', async () => {
    upstream.mockResolvedValue(new Response('{}', { headers: { 'x-ratelimit-limit-tokens': '500', 'x-ratelimit-remaining-tokens': '120', 'x-ratelimit-reset-tokens': '1h' } }));
    const results = await Promise.all([call(`/${first}/refresh`, reader, 'POST'), call(`/${first}/refresh`, reader, 'POST')]);
    expect(results.every(r => r.status === 200)).toBe(true); expect(upstream).toHaveBeenCalledTimes(1);
    const data = await (await call()).json();
    expect(data.accounts.find((a: { accountId: number }) => a.accountId === first).windows[0]).toMatchObject({ remaining: 120, limit: 500, source: 'header' });
    expect(JSON.stringify(data)).not.toMatch(/gsk_quota_secret|encrypted_key|auth_tag/);
  });
  it('uses subscription → cheap → free and skips only fresh account-wide exhaustion', () => {
    setQuotaTier(first, 'cheap'); setQuotaTier(second, 'subscription'); setQuotaTier(third, 'free');
    const accounts = [accountRow(first), accountRow(third), accountRow(second)];
    expect(applyQuotaRouting(accounts, true).map(a => a.id)).toEqual([second, first, third]);
    recordQuotaWindows(second, [{ id: 'five_hour', remaining: 0, limit: 100, resetAt: new Date(Date.now() + 60000).toISOString(), source: 'quota_api', unit: '%', blocking: true }]);
    expect(applyQuotaRouting(accounts, true).map(a => a.id)).toEqual([first, third]);
    expect(resolveCandidateRoutes('claude/claude-test').candidates).toEqual([]);
    expect(applyQuotaRouting(accounts, true, Date.now() + 61000).map(a => a.id)).toEqual([second, first, third]);
    expect(applyQuotaRouting(accounts, true, Date.now() + 600000).map(a => a.id)).toEqual([second, first, third]);
    createCombo('quota-order', [{ platform: 'kiro', modelId: 'free-model' }, { platform: 'groq', modelId: 'cheap-model' }]);
    expect(resolveCandidateRoutes('combo:quota-order').candidates.map(c => c.account.id)).toEqual([third, first]);
  });
  it('falls through all three tiers in a real auto chat request', async () => {
    setEnabled(true);
    getDb().prepare('DELETE FROM x_gateway_quota WHERE account_id = ?').run(second);
    const visited: string[] = [];
    upstream.mockImplementation(async (url) => {
      visited.push(String(url));
      if (String(url).includes('anthropic.com') || String(url).includes('groq.com')) return new Response('{"error":{"message":"Temporarily unavailable"}}', { status: 503 });
      // Kiro speaks AWS EventStream, not OpenAI Chat Completions JSON.
      const header = (name: string, value: string) => {
        const bytes = Buffer.from(value); const size = Buffer.alloc(2); size.writeUInt16BE(bytes.length);
        return Buffer.concat([Buffer.from([name.length]), Buffer.from(name), Buffer.from([7]), size, bytes]);
      };
      const event = (type: string, payload: unknown) => {
        const headers = Buffer.concat([header(':message-type', 'event'), header(':event-type', type)]);
        const data = Buffer.from(JSON.stringify(payload)); const frame = Buffer.alloc(16 + headers.length + data.length);
        frame.writeUInt32BE(frame.length); frame.writeUInt32BE(headers.length, 4); frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
        headers.copy(frame, 12); data.copy(frame, 12 + headers.length); frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4); return frame;
      };
      return new Response(Buffer.concat([event('assistantResponseEvent', { content: 'Free tier answered' }), event('messageStopEvent', { stopReason: 'end_turn' })]), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
    });
    const response = await fetch(`${base}/thruline/v1/chat/completions`, { method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'Hello' }] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-routed-via')).toContain('kiro/');
    expect((await response.json()).choices[0].message.content).toBe('Free tier answered');
    expect(visited[0]).toContain('anthropic.com');
    expect(visited[1]).toContain('groq.com');
    expect(visited).toHaveLength(3);
  });
  it('tracks 429 inference headers only in X account scope', async () => {
    upstream.mockResolvedValue(new Response('{}', { status: 429, headers: { 'retry-after': '30' } }));
    await withQuotaTracking(accountRow(third), 'model-a', undefined, () => proxyFetch('https://api.example.test/chat', {}, 'groq', 'unknown'));
    expect(applyQuotaRouting([accountRow(third)], false, Date.now(), 'model-a')).toEqual([]);
    expect(applyQuotaRouting([accountRow(third)], false, Date.now(), 'model-b')).toHaveLength(1);
    expect(() => withQuotaTracking(accountRow(third), 'model-a', undefined, () => undefined)).toThrow(/exhausted/);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM provider_quota_observations WHERE key_id = ?').get(third)).toMatchObject({ n: 0 });
  });
  it('keeps last known quota on provider failure and never probes custom endpoints', async () => {
    getDb().prepare('UPDATE x_gateway_quota SET checked_at = ? WHERE account_id = ?').run('2020-01-01T00:00:00Z', first);
    upstream.mockResolvedValue(new Response('secret_provider_payload', { status: 503 }));
    const response = await call(`/${first}/refresh`, reader, 'POST');
    const data = await response.json();
    expect(data.windows[0]).toMatchObject({ remaining: 120 });
    expect(data.error).toContain('refresh failed');
    expect(JSON.stringify(data)).not.toContain('secret_provider_payload');
    getDb().prepare('UPDATE x_gateway_keys SET base_url = ? WHERE id = ?').run('https://custom.example.test/v1', second);
    const before = upstream.mock.calls.length;
    const custom = await (await call(`/${second}/refresh`, reader, 'POST')).json();
    expect(custom.supported).toBe(false);
    expect(upstream.mock.calls.length).toBe(before);
  });
  it('roundtrips its migration and cascades account deletion without touching account data', () => {
    const db = getDb();
    db.prepare('DELETE FROM x_gateway_keys WHERE id = ?').run(third);
    expect(db.prepare('SELECT * FROM x_gateway_quota WHERE account_id = ?').get(third)).toBeUndefined();
    const before = db.prepare('SELECT COUNT(*) AS n FROM x_gateway_keys').get();
    down(db); up(db); up(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM x_gateway_keys').get()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM x_gateway_quota').get()).toMatchObject({ n: 0 });
  });
});
