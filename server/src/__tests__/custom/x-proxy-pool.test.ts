import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'http';
import https from 'https';
import { EventEmitter } from 'events';
import express from 'express';
import { initDb } from '../../db/index.js';
import { createUser, createSession } from '../../services/auth.js';
import { setOutboundProxyUrl } from '../../custom/x-gateway/config.js';
import { createApiKeyAccount, accountRow, resolveXGatewayAccountProxy } from '../../custom/provider-accounts/store.js';
import {
  getProxyPoolConfig,
  isStrictProxyEnabled,
  listProxyPool,
  shouldBypassProxyPool,
} from '../../custom/x-gateway/proxy-pool.js';
import { applyProxyMode } from '../../lib/proxy.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireActionPermission } from '../../custom/permission-actions.js';
import { xProxyPoolRouter } from '../../custom/x-gateway/proxy-pool-router.js';
import { providerAccountsRouter } from '../../custom/provider-accounts/router.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/thruline/proxy-pool',
    requireAuth,
    requireActionPermission('manage_x_gateway'),
    xProxyPoolRouter,
  );
  app.use(
    '/api/thruline-accounts',
    requireAuth,
    requireActionPermission('manage_keys'),
    providerAccountsRouter,
  );
  return app;
}

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

    server = createTestApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    const fakeRequest = ((_opts: any, cb: any) => {
      const req = new EventEmitter() as any;
      req.write = () => {};
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter() as any;
        res.statusCode = 204;
        res.statusMessage = 'OK';
        res.headers = {};
        res.destroy = () => {};
        if (typeof cb === 'function') cb(res);
        setImmediate(() => res.emit('end'));
      };
      return req;
    }) as any;

    vi.spyOn(https, 'request').mockImplementation(fakeRequest);

    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      const urlStr = String(url);
      if (urlStr.startsWith(`http://127.0.0.1:${port}`)) return realFetch(url, init);

      if (urlStr === 'https://api.cloudflare.com/client/v4/accounts') {
        return new Response(JSON.stringify({ success: true, result: [{ id: 'cf-acc-999' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('api.cloudflare.com/client/v4/accounts/') && urlStr.includes('/workers/subdomain')) {
        return new Response(JSON.stringify({ success: true, result: { subdomain: 'my-team' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('api.cloudflare.com/client/v4/accounts/') && urlStr.includes('/workers/scripts/')) {
        return new Response(JSON.stringify({ success: true, result: { id: 'cf-worker' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr === 'https://api.vercel.com/v13/deployments') {
        return new Response(JSON.stringify({ id: 'dpl_test', url: 'vercel-test-relay.vercel.app' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

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
    const created = await requestX('/api/thruline/proxy-pool', {
      method: 'POST', key: adminSession, body: { name: 'Proxy A', proxyUrl: URL_A },
    });
    expect(created.status).toBe(201);
    expect(created.body.entry).toMatchObject({
      name: 'Proxy A', proxyUrl: 'http://usera:***@198.51.100.11:8080', enabled: true, boundAccounts: 0,
    });
    entryA = created.body.entry.id;

    const second = await requestX('/api/thruline/proxy-pool', {
      method: 'POST', key: adminSession, body: { name: 'Proxy B', proxyUrl: URL_B },
    });
    expect(second.status).toBe(201);
    entryB = second.body.entry.id;

    const list = await requestX('/api/thruline/proxy-pool', { key: adminSession });
    expect(list.status).toBe(200);
    expect(list.body.entries).toHaveLength(2);
    expect(JSON.stringify(list.body)).not.toContain('secreta');
    expect(JSON.stringify(list.body)).not.toContain('secretb');
  });

  it('rejects invalid URLs, duplicate names and bad ids', async () => {
    const badUrl = await requestX('/api/thruline/proxy-pool', {
      method: 'POST', key: adminSession, body: { name: 'Bad', proxyUrl: 'ftp://198.51.100.13:21' },
    });
    expect(badUrl.status).toBe(400);
    const dup = await requestX('/api/thruline/proxy-pool', {
      method: 'POST', key: adminSession, body: { name: 'proxy a', proxyUrl: URL_A },
    });
    expect(dup.status).toBe(409);
    const badId = await requestX('/api/thruline/proxy-pool/abc', { method: 'PATCH', key: adminSession, body: { name: 'X' } });
    expect(badId.status).toBe(400);
    const missing = await requestX('/api/thruline/proxy-pool/999999', { method: 'DELETE', key: adminSession });
    expect(missing.status).toBe(404);
  });

  it('gates reads at use_x_gateway and writes at edit_x_settings', async () => {
    const read = await requestX('/api/thruline/proxy-pool', { key: memberSession });
    expect(read.status).toBe(200);
    const write = await requestX('/api/thruline/proxy-pool', {
      method: 'POST', key: memberSession, body: { name: 'Member', proxyUrl: URL_A },
    });
    expect(write.status).toBe(403);
    const anonymous = await requestX('/api/thruline/proxy-pool');
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

    const disable = await requestX(`/api/thruline/proxy-pool/${entryA}`, {
      method: 'PATCH', key: adminSession, body: { enabled: false },
    });
    expect(disable.status).toBe(200);
    expect(disable.body.entry.enabled).toBe(false);
    expect(resolveXGatewayAccountProxy(accountRow(bound))).toBe(GATEWAY);

    const del = await requestX(`/api/thruline/proxy-pool/${entryA}`, { method: 'DELETE', key: adminSession });
    expect(del.status).toBe(200);
    expect(accountRow(bound).proxy_pool_id).toBeNull();
    expect(resolveXGatewayAccountProxy(accountRow(bound))).toBe(GATEWAY);

    setOutboundProxyUrl('');
    expect(resolveXGatewayAccountProxy(accountRow(bound))).toBeUndefined();
  });

  it('binds and unbinds accounts over the accounts API and exposes the pool name', async () => {
    const id = createApiKeyAccount({ provider: 'groq', key: 'gsk_bind', proxyPoolId: null });
    const bind = await requestX(`/api/thruline-accounts/${id}`, { method: 'PATCH', key: adminSession, body: { proxyPoolId: entryB } });
    expect(bind.status).toBe(200);
    expect(accountRow(id).proxy_pool_id).toBe(entryB);

    const list = await requestX('/api/thruline-accounts', { key: adminSession });
    const account = list.body.providers.flatMap((p: any) => p.accounts).find((a: any) => a.id === id);
    expect(account.proxyPoolId).toBe(entryB);
    expect(account.proxyPoolName).toBe('Proxy B');

    const badBind = await requestX(`/api/thruline-accounts/${id}`, { method: 'PATCH', key: adminSession, body: { proxyPoolId: 999999 } });
    expect(badBind.status).toBe(400);

    const unbind = await requestX(`/api/thruline-accounts/${id}`, { method: 'PATCH', key: adminSession, body: { proxyPoolId: null } });
    expect(unbind.status).toBe(200);
    expect(accountRow(id).proxy_pool_id).toBeNull();
  });

  it('tests an entry through the probe helper without leaking credentials', async () => {
    // HTTP entry: the probe rides global fetch (mockable); SOCKS entries use
    // http.request and would attempt a real connection.
    const created = await requestX('/api/thruline/proxy-pool', {
      method: 'POST', key: adminSession, body: { name: 'Probe', proxyUrl: 'http://userc:secretc@198.51.100.14:8080' },
    });
    const probeId = created.body.entry.id;
    const ok = await requestX(`/api/thruline/proxy-pool/${probeId}/test`, { method: 'POST', key: adminSession, body: {} });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.status).toBe(204);
    expect(typeof ok.body.latencyMs).toBe('number');

    vi.mocked(global.fetch).mockImplementationOnce(async () => { throw new Error('connect ECONNREFUSED userc:secretc@198.51.100.14:8080'); });
    const failed = await requestX(`/api/thruline/proxy-pool/${probeId}/test`, { method: 'POST', key: adminSession, body: {} });
    expect(failed.status).toBe(200);
    expect(failed.body.ok).toBe(false);
    expect(JSON.stringify(failed.body)).not.toContain('secretc');

    // When global proxy mode is fetch-relay, pool entries must still probe in forward mode
    applyProxyMode('fetch-relay');
    const inRelayMode = await requestX(`/api/thruline/proxy-pool/${probeId}/test`, { method: 'POST', key: adminSession, body: {} });
    expect(inRelayMode.status).toBe(200);
    expect(inRelayMode.body.ok).toBe(true);
    expect(inRelayMode.body.status).toBe(204);
    applyProxyMode('forward');
  });

  it('batch-imports proxies in multiple formats (URLs, host:port:user:pass, host:port)', async () => {
    const rawProxies = [
      '# comment line',
      'http://user1:pass1@198.51.100.21:8080',
      'socks5://user2:pass2@198.51.100.22:1080',
      '198.51.100.23:8080:user3:pass3',
      '198.51.100.24:3128',
      'bad_proxy_line_here',
    ].join('\n');

    const unauth = await requestX('/api/thruline/proxy-pool/batch-import', {
      method: 'POST',
      key: memberSession,
      body: { proxies: rawProxies },
    });
    expect(unauth.status).toBe(403);

    const res = await requestX('/api/thruline/proxy-pool/batch-import', {
      method: 'POST',
      key: adminSession,
      body: { proxies: rawProxies },
    });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.importedCount).toBe(4);
    expect(res.body.failedCount).toBe(1);
    expect(res.body.failed[0].line).toBe('bad_proxy_line_here');
    expect(res.body.imported).toHaveLength(4);

    // Verify secrets are masked
    expect(JSON.stringify(res.body)).not.toContain('pass1');
    expect(JSON.stringify(res.body)).not.toContain('pass2');
    expect(JSON.stringify(res.body)).not.toContain('pass3');
  });

  it('tests all enabled proxies in batch with health summary', async () => {
    const res = await requestX('/api/thruline/proxy-pool/test-all', {
      method: 'POST',
      key: adminSession,
      body: {},
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.healthy).toBe('number');
    expect(typeof res.body.unhealthy).toBe('number');
    expect(typeof res.body.latencyMs).toBe('number');
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBe(res.body.total);
    for (const item of res.body.results) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('ok');
    }
  });

  it('performs bulk actions: enable, disable, and delete', async () => {
    const p1 = await requestX('/api/thruline/proxy-pool', {
      method: 'POST',
      key: adminSession,
      body: { name: 'Bulk 1', proxyUrl: 'http://198.51.100.41:8080' },
    });
    const p2 = await requestX('/api/thruline/proxy-pool', {
      method: 'POST',
      key: adminSession,
      body: { name: 'Bulk 2', proxyUrl: 'http://198.51.100.42:8080' },
    });
    const id1 = p1.body.entry.id;
    const id2 = p2.body.entry.id;

    // Bulk disable
    const dis = await requestX('/api/thruline/proxy-pool/bulk-action', {
      method: 'POST',
      key: adminSession,
      body: { action: 'disable', ids: [id1, id2] },
    });
    expect(dis.status).toBe(200);
    expect(dis.body.affected).toBe(2);

    const list1 = await requestX('/api/thruline/proxy-pool', { key: adminSession });
    const entry1 = list1.body.entries.find((e: any) => e.id === id1);
    const entry2 = list1.body.entries.find((e: any) => e.id === id2);
    expect(entry1.enabled).toBe(false);
    expect(entry2.enabled).toBe(false);

    // Bulk enable
    const ena = await requestX('/api/thruline/proxy-pool/bulk-action', {
      method: 'POST',
      key: adminSession,
      body: { action: 'enable', ids: [id1, id2] },
    });
    expect(ena.status).toBe(200);
    expect(ena.body.affected).toBe(2);

    // Bulk delete
    const del = await requestX('/api/thruline/proxy-pool/bulk-action', {
      method: 'POST',
      key: adminSession,
      body: { action: 'delete', ids: [id1, id2] },
    });
    expect(del.status).toBe(200);
    expect(del.body.affected).toBe(2);

    const list2 = await requestX('/api/thruline/proxy-pool', { key: adminSession });
    expect(list2.body.entries.some((e: any) => e.id === id1 || e.id === id2)).toBe(false);
  });

  it('manages proxy pool config: noProxy bypass list and strictProxy flag', async () => {
    const initial = await requestX('/api/thruline/proxy-pool/config', { key: adminSession });
    expect(initial.status).toBe(200);
    expect(initial.body.config).toHaveProperty('noProxy');
    expect(initial.body.config).toHaveProperty('strictProxy');

    const update = await requestX('/api/thruline/proxy-pool/config', {
      method: 'POST',
      key: adminSession,
      body: {
        noProxy: ['openai.com', 'groq', 'api.anthropic.com'],
        strictProxy: true,
      },
    });
    expect(update.status).toBe(200);
    expect(update.body.config.strictProxy).toBe(true);
    expect(update.body.config.noProxy).toEqual(['openai.com', 'groq', 'api.anthropic.com']);

    // Check helper functions
    const conf = getProxyPoolConfig();
    expect(conf.strictProxy).toBe(true);
    expect(isStrictProxyEnabled()).toBe(true);
    expect(shouldBypassProxyPool('https://api.openai.com/v1/chat')).toBe(true);
    expect(shouldBypassProxyPool('groq')).toBe(true);
    expect(shouldBypassProxyPool('https://api.google.com/generate')).toBe(false);
  });

  it('deploys serverless relay workers to Cloudflare and Vercel and registers them in pool', async () => {
    // Check relay template endpoint
    const tmpl = await requestX('/api/thruline/proxy-pool/relay-template', { key: adminSession });
    expect(tmpl.status).toBe(200);
    expect(tmpl.body.cloudflare).toContain('fetch-relay-target');
    expect(tmpl.body.vercel).toContain('fetch-relay-target');

    // Deploy to Cloudflare
    const cfDeploy = await requestX('/api/thruline/proxy-pool/deploy-worker', {
      method: 'POST',
      key: adminSession,
      body: {
        provider: 'cloudflare',
        apiToken: 'cf_dummy_token_123',
        workerName: 'cf-unit-relay',
      },
    });

    expect(cfDeploy.status).toBe(201);
    expect(cfDeploy.body.ok).toBe(true);
    expect(cfDeploy.body.provider).toBe('cloudflare');
    expect(cfDeploy.body.url).toBe('https://cf-unit-relay.my-team.workers.dev');
    expect(cfDeploy.body.entry).toHaveProperty('id');
    expect(cfDeploy.body.entry.proxyUrl).toBe('https://cf-unit-relay.my-team.workers.dev');

    // Deploy to Vercel
    const vercelDeploy = await requestX('/api/thruline/proxy-pool/deploy-worker', {
      method: 'POST',
      key: adminSession,
      body: {
        provider: 'vercel',
        apiToken: 'vercel_dummy_token_456',
        workerName: 'vercel-unit-relay',
      },
    });

    expect(vercelDeploy.status).toBe(201);
    expect(vercelDeploy.body.ok).toBe(true);
    expect(vercelDeploy.body.provider).toBe('vercel');
    expect(vercelDeploy.body.url).toBe('https://vercel-test-relay.vercel.app');
    expect(vercelDeploy.body.entry).toHaveProperty('id');
  });
});
