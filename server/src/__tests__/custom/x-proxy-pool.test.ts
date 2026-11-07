import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'http';
import { initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { setOutboundProxyUrl } from '../../custom/x-gateway/config.js';
import { createApiKeyAccount, accountRow, resolveXGatewayAccountProxy } from '../../custom/provider-accounts/store.js';
import { listProxyPool } from '../../custom/x-gateway/proxy-pool.js';

describe('X Gateway Proxy Pool', () => {
  let server: Server;
  let base: string;
  let adminSession: string;
  let memberSession: string;
  const realFetch = global.fetch;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    const admin = createUser('admin@example.com', 'AdminPass123!');
    adminSession = createSession(admin.userId);
    const member = createUser('member@example.com', 'MemberPass123!', 'member');
    memberSession = createSession(member.userId);
    // Member may use the gateway but holds no settings/key leaves.
    const { getDb } = await import('../../db/index.js');
    getDb().prepare("UPDATE users SET permissions = '[\"use_x_gateway\"]' WHERE id = ?").run(member.userId);

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(`http://127.0.0.1:${port}`)) return realFetch(url, init);
      return new Response(null, { status: 204 });
    });
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
  });

  async function requestX(path: string, opts: { method?: string; body?: unknown; key?: string } = {}) {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.key) headers['Authorization'] = `Bearer ${opts.key}`;
    const res = await realFetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  }

  const URL_A = 'http://usera:secreta@198.51.100.11:8080';
  const URL_B = 'socks5://userb:secretb@198.51.100.12:1080';
  const GATEWAY = 'http://198.51.100.1:9090';
  let entryA: number;
  let entryB: number;

  it('creates entries with masked URLs and lists them', async () => {
    const created = await requestX('/api/x-gateway/proxy-pool', {
      method: 'POST', key: adminSession, body: { name: 'Proxy A', proxyUrl: URL_A },
    });
    expect(created.status).toBe(201);
    expect(created.body.entry).toMatchObject({
      name: 'Proxy A', proxyUrl: 'http://usera:***@198.51.100.11:8080', enabled: true, boundAccounts: 0,
    });
    entryA = created.body.entry.id;

    const second = await requestX('/api/x-gateway/proxy-pool', {
      method: 'POST', key: adminSession, body: { name: 'Proxy B', proxyUrl: URL_B },
    });
    expect(second.status).toBe(201);
    entryB = second.body.entry.id;

    const list = await requestX('/api/x-gateway/proxy-pool', { key: adminSession });
    expect(list.status).toBe(200);
    expect(list.body.entries).toHaveLength(2);
    expect(JSON.stringify(list.body)).not.toContain('secreta');
    expect(JSON.stringify(list.body)).not.toContain('secretb');
  });

  it('rejects invalid URLs, duplicate names and bad ids', async () => {
    const badUrl = await requestX('/api/x-gateway/proxy-pool', {
      method: 'POST', key: adminSession, body: { name: 'Bad', proxyUrl: 'ftp://198.51.100.13:21' },
    });
    expect(badUrl.status).toBe(400);
    const dup = await requestX('/api/x-gateway/proxy-pool', {
      method: 'POST', key: adminSession, body: { name: 'proxy a', proxyUrl: URL_A },
    });
    expect(dup.status).toBe(409);
    const badId = await requestX('/api/x-gateway/proxy-pool/abc', { method: 'PATCH', key: adminSession, body: { name: 'X' } });
    expect(badId.status).toBe(400);
    const missing = await requestX('/api/x-gateway/proxy-pool/999999', { method: 'DELETE', key: adminSession });
    expect(missing.status).toBe(404);
  });

  it('gates reads at use_x_gateway and writes at edit_x_settings', async () => {
    const read = await requestX('/api/x-gateway/proxy-pool', { key: memberSession });
    expect(read.status).toBe(200);
    const write = await requestX('/api/x-gateway/proxy-pool', {
      method: 'POST', key: memberSession, body: { name: 'Member', proxyUrl: URL_A },
    });
    expect(write.status).toBe(403);
    const anonymous = await requestX('/api/x-gateway/proxy-pool');
    expect(anonymous.status).toBe(401);
  });

  it('auto-assigns new accounts round-robin across enabled entries', () => {
    setOutboundProxyUrl(GATEWAY);
    const ids = [1, 2, 3, 4].map(n => createApiKeyAccount({ provider: 'groq', key: `gsk_auto_${n}`, label: `auto-${n}` }));
    const bound = ids.map(id => accountRow(id).proxy_pool_id);
    expect(bound.filter(id => id === entryA)).toHaveLength(2);
    expect(bound.filter(id => id === entryB)).toHaveLength(2);
    for (const id of ids) {
      const row = accountRow(id);
      expect(resolveXGatewayAccountProxy(row)).toBe(row.proxy_pool_id === entryA ? URL_A : URL_B);
    }
    const counts = listProxyPool().map(e => e.boundAccounts);
    expect(counts).toEqual([2, 2]);
  });

  it('keeps priority: explicit URL > pool > gateway > direct', () => {
    const explicit = createApiKeyAccount({ provider: 'groq', key: 'gsk_explicit', proxyUrl: 'http://203.0.113.5:8080' });
    expect(accountRow(explicit).proxy_pool_id).toBeNull();
    expect(resolveXGatewayAccountProxy(accountRow(explicit))).toBe('http://203.0.113.5:8080');

    const optedOut = createApiKeyAccount({ provider: 'groq', key: 'gsk_optout', proxyPoolId: null });
    expect(accountRow(optedOut).proxy_pool_id).toBeNull();
    expect(resolveXGatewayAccountProxy(accountRow(optedOut))).toBe(GATEWAY);

    const pinned = createApiKeyAccount({ provider: 'groq', key: 'gsk_pinned', proxyPoolId: entryB });
    expect(resolveXGatewayAccountProxy(accountRow(pinned))).toBe(URL_B);
    expect(() => createApiKeyAccount({ provider: 'groq', key: 'gsk_badpool', proxyPoolId: 999999 })).toThrow();
  });

  it('falls back to the gateway when a bound entry is disabled, then unbinds on delete', async () => {
    const bound = createApiKeyAccount({ provider: 'groq', key: 'gsk_bound', proxyPoolId: entryA });
    expect(resolveXGatewayAccountProxy(accountRow(bound))).toBe(URL_A);

    const disable = await requestX(`/api/x-gateway/proxy-pool/${entryA}`, {
      method: 'PATCH', key: adminSession, body: { enabled: false },
    });
    expect(disable.status).toBe(200);
    expect(disable.body.entry.enabled).toBe(false);
    expect(resolveXGatewayAccountProxy(accountRow(bound))).toBe(GATEWAY);

    const del = await requestX(`/api/x-gateway/proxy-pool/${entryA}`, { method: 'DELETE', key: adminSession });
    expect(del.status).toBe(200);
    expect(accountRow(bound).proxy_pool_id).toBeNull();
    expect(resolveXGatewayAccountProxy(accountRow(bound))).toBe(GATEWAY);

    setOutboundProxyUrl('');
    expect(resolveXGatewayAccountProxy(accountRow(bound))).toBeUndefined();
  });

  it('binds and unbinds accounts over the accounts API and exposes the pool name', async () => {
    const id = createApiKeyAccount({ provider: 'groq', key: 'gsk_bind', proxyPoolId: null });
    const bind = await requestX(`/api/x-accounts/${id}`, { method: 'PATCH', key: adminSession, body: { proxyPoolId: entryB } });
    expect(bind.status).toBe(200);
    expect(accountRow(id).proxy_pool_id).toBe(entryB);

    const list = await requestX('/api/x-accounts', { key: adminSession });
    const account = list.body.providers.flatMap((p: any) => p.accounts).find((a: any) => a.id === id);
    expect(account.proxyPoolId).toBe(entryB);
    expect(account.proxyPoolName).toBe('Proxy B');

    const badBind = await requestX(`/api/x-accounts/${id}`, { method: 'PATCH', key: adminSession, body: { proxyPoolId: 999999 } });
    expect(badBind.status).toBe(400);

    const unbind = await requestX(`/api/x-accounts/${id}`, { method: 'PATCH', key: adminSession, body: { proxyPoolId: null } });
    expect(unbind.status).toBe(200);
    expect(accountRow(id).proxy_pool_id).toBeNull();
  });

  it('tests an entry through the probe helper without leaking credentials', async () => {
    // HTTP entry: the probe rides global fetch (mockable); SOCKS entries use
    // http.request and would attempt a real connection.
    const created = await requestX('/api/x-gateway/proxy-pool', {
      method: 'POST', key: adminSession, body: { name: 'Probe', proxyUrl: 'http://userc:secretc@198.51.100.14:8080' },
    });
    const probeId = created.body.entry.id;
    const ok = await requestX(`/api/x-gateway/proxy-pool/${probeId}/test`, { method: 'POST', key: adminSession, body: {} });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.status).toBe(204);
    expect(typeof ok.body.latencyMs).toBe('number');

    vi.mocked(global.fetch).mockImplementationOnce(async () => { throw new Error('connect ECONNREFUSED userc:secretc@198.51.100.14:8080'); });
    const failed = await requestX(`/api/x-gateway/proxy-pool/${probeId}/test`, { method: 'POST', key: adminSession, body: {} });
    expect(failed.status).toBe(200);
    expect(failed.body.ok).toBe(false);
    expect(JSON.stringify(failed.body)).not.toContain('secretc');
  });
});