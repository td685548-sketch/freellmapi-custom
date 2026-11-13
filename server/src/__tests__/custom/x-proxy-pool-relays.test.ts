import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { getDb, initDb } from '../../db/index.js';
import { nodeSqliteFactory } from '../../db/node-sqlite.js';
import { createSession, createUser } from '../../services/auth.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireActionPermission } from '../../custom/permission-actions.js';
import { probeProxyUrl } from '../../lib/proxy.js';
import { xProxyPoolRouter } from '../../custom/x-gateway/proxy-pool-router.js';
import {
  DENO_RELAY_CODE, NETLIFY_RELAY_CODE, deployServerlessRelay,
  listProxyPool, proxyPoolEntryUrl, createProxyPoolEntry, MAX_POOL_ENTRIES,
} from '../../custom/x-gateway/proxy-pool.js';

vi.mock('../../lib/proxy.js', async importOriginal => ({
  ...await importOriginal<object>(), probeProxyUrl: vi.fn(async () => ({ ok: true, latencyMs: 7, status: 204 })),
}));

const realFetch = globalThis.fetch;
const upstream = vi.fn<typeof fetch>();
const denoBase = 'https://api.deno.com/v2';
const netlifyBase = 'https://api.netlify.com/api/v1';
const token = 'test-secret-cloud-token';
let server: Server;
let base: string;
let session: string;
let memberSession: string;

function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function deploy(provider: 'deno' | 'netlify', extra: Record<string, unknown> = {}) {
  return request('/deploy-worker', { provider, apiToken: token, workerName: 'web-relay', ...extra });
}
function request(path: string, body?: unknown, auth = session) {
  return realFetch(`${base}/api/thruline/proxy-pool${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function denoReady(host = 'web-relay.team.deno.net') {
  return { id: 'revision-1', status: 'succeeded', timelines: [{ context: 'Production', hostnames: [host] }] };
}
function mockDeno() {
  upstream.mockImplementation(async (url, init) => {
    if (String(url) === `${denoBase}/apps` && init?.method === 'POST') return json({ id: 'app-1', slug: 'web-relay' });
    if (String(url) === `${denoBase}/apps/app-1/deploy`) return json(denoReady(), 202);
    if (String(url) === `${denoBase}/apps/app-1` && init?.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`Unexpected mock URL: ${url}`);
  });
}
function mockNetlify(requireUpload = true) {
  upstream.mockImplementation(async (url, init) => {
    const path = String(url).slice(netlifyBase.length);
    if (path === '/sites' && init?.method === 'POST') return json({ id: 'site-1', ssl_url: 'https://web-relay.netlify.app' });
    if (path === '/sites/site-1/deploys') {
      const manifest = JSON.parse(String(init?.body));
      return json({ id: 'deploy-1', state: 'uploading', required: requireUpload ? Object.values(manifest.files) : [], required_functions: requireUpload ? Object.values(manifest.functions) : [] });
    }
    if (path.startsWith('/deploys/deploy-1/') && init?.method === 'PUT') return new Response(null, { status: 204 });
    if (path === '/deploys/deploy-1') return json({ id: 'deploy-1', state: 'ready' });
    if (path === '/sites/site-1' && init?.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`Unexpected mock URL: ${url}`);
  });
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  // Exercise a real SQLite database without requiring a platform-specific
  // native addon on Node 22.13+. Node 20 keeps the regular production factory.
  const [major, minor] = process.versions.node.split('.').map(Number);
  initDb(':memory:', major > 22 || (major === 22 && minor >= 13) ? { factory: nodeSqliteFactory } : undefined);
  session = createSession(createUser('relay-admin@example.com', 'RelayTestPassword!').userId);
  const member = createUser('relay-member@example.com', 'RelayTestPassword!', 'member');
  getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run('["use_x_gateway"]', member.userId);
  memberSession = createSession(member.userId);
  const app = express();
  app.use(express.json());
  app.use('/api/thruline/proxy-pool', requireAuth, requireActionPermission('manage_x_gateway'), xProxyPoolRouter);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      base = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});
beforeEach(() => {
  getDb().prepare('DELETE FROM x_gateway_proxy_pool').run();
  upstream.mockReset();
  vi.mocked(probeProxyUrl).mockClear();
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    if (String(url).startsWith(`${base}/`)) return realFetch(url, init);
    return upstream(url, init);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

describe('serverless relay management over HTTP', () => {
  it('returns all four templates without tokens or deploy permissions', async () => {
    const response = await request('/relay-template', undefined, memberSession);
    expect(response.status).toBe(200);
    const scripts = await response.json();
    expect(Object.keys(scripts).sort()).toEqual(['cloudflare', 'deno', 'netlify', 'vercel']);
    expect(scripts.deno).toContain('Deno.serve(async (request)');
    expect(scripts.netlify).toContain('exports.handler');
    for (const script of Object.values(scripts)) {
      expect(script).toContain('fetch-relay-target');
      expect(script).toContain('fetch-relay-authorization');
      expect(script).not.toContain(token);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it('deploys Deno inline code and stores the actual production URL encrypted', async () => {
    mockDeno();
    const response = await deploy('deno', { orgDomain: 'team' });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, provider: 'deno', workerName: 'web-relay', url: 'https://web-relay.team.deno.net', entry: { name: 'deno-web-relay', enabled: true } });
    expect(proxyPoolEntryUrl(body.entry.id)).toBe(body.url);
    const row = getDb().prepare('SELECT proxy_encrypted FROM x_gateway_proxy_pool WHERE id = ?').get(body.entry.id) as { proxy_encrypted: string };
    expect(row.proxy_encrypted).not.toContain('deno.net');
    const [url, init] = upstream.mock.calls[1];
    expect(url).toBe(`${denoBase}/apps/app-1/deploy`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ production: true, assets: { 'main.ts': { content: DENO_RELAY_CODE, encoding: 'utf-8' } } });
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(JSON.stringify(body)).not.toContain(token);
  });
  it('supports Deno-provided deno.dev hostnames and optional orgDomain', async () => {
    upstream.mockResolvedValueOnce(json({ id: 'app-1', slug: 'web-relay' })).mockResolvedValueOnce(json(denoReady('web-relay.deno.dev')));
    const response = await deploy('deno');
    expect(response.status).toBe(201);
    expect((await response.json()).url).toBe('https://web-relay.deno.dev');
  });
  it('waits for Deno to succeed before creating an entry', async () => {
    upstream.mockResolvedValueOnce(json({ id: 'app-1' })).mockResolvedValueOnce(json({ id: 'revision-1', status: 'building' }))
      .mockImplementationOnce(async () => {
        expect(listProxyPool()).toHaveLength(0);
        return json(denoReady());
      });
    expect((await deploy('deno')).status).toBe(201);
    expect(upstream.mock.calls[2][0]).toBe(`${denoBase}/revisions/revision-1`);
  });
  it('deploys a Netlify function ZIP using digest uploads and registers its function URL', async () => {
    mockNetlify();
    const response = await deploy('netlify');
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ provider: 'netlify', url: 'https://web-relay.netlify.app/.netlify/functions/relay' });
    expect(proxyPoolEntryUrl(body.entry.id)).toBe(body.url);
    const manifest = JSON.parse(String(upstream.mock.calls[1][1]?.body));
    const upload = upstream.mock.calls.find(([url]) => String(url).includes('/functions/relay?runtime=js'))!;
    expect(upload[1]?.method).toBe('PUT');
    const zip = Buffer.from(upload[1]!.body as Uint8Array);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.toString()).toContain('relay.js');
    expect(zip.toString()).toContain(NETLIFY_RELAY_CODE);
    expect(createHash('sha256').update(zip).digest('hex')).toBe(manifest.functions.relay);
    expect(upstream.mock.calls.some(([url]) => String(url).endsWith('/files/index.html'))).toBe(true);
    expect(upstream.mock.calls.at(-1)![0]).toBe(`${netlifyBase}/deploys/deploy-1`);
  });
  it('honors Netlify digest deduplication', async () => {
    mockNetlify(false);
    expect((await deploy('netlify')).status).toBe(201);
    expect(upstream.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });
  it.each(['deno', 'netlify'] as const)('retains unique pool names after repeated %s deployments', async provider => {
    if (provider === 'deno') mockDeno(); else mockNetlify(false);
    const a = await (await deploy(provider)).json();
    const b = await (await deploy(provider)).json();
    expect(a.entry.name).toBe(`${provider}-web-relay`);
    expect(b.entry.name).toBe(`${provider}-web-relay-2`);
  });
  it.each(['deno', 'netlify'] as const)('reports %s authentication errors without leaking a token or creating an entry', async provider => {
    upstream.mockResolvedValueOnce(json({ error: { message: `Invalid token: ${token}` } }, 403));
    const response = await deploy(provider);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.message).toContain('(403)');
    expect(JSON.stringify(body)).not.toContain(token);
    expect(listProxyPool()).toHaveLength(0);
  });
  it('does not overwrite an existing Netlify site when the name is taken', async () => {
    upstream.mockResolvedValueOnce(json({ message: 'Site name already exists' }, 422));
    const response = await deploy('netlify');
    expect(response.status).toBe(409);
    expect((await response.json()).error.message).toContain('already exists');
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('cleans up only the newly-created Deno app when deployment fails', async () => {
    upstream.mockResolvedValueOnce(json({ id: 'app-1' })).mockResolvedValueOnce(json({ error: { message: 'Build failed' } }, 500))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const response = await deploy('deno');
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toContain('Build failed');
    expect(upstream.mock.calls.at(-1)).toMatchObject([`${denoBase}/apps/app-1`, { method: 'DELETE' }]);
    expect(listProxyPool()).toHaveLength(0);
  });
  it('reports failed Netlify deploy states and removes the new site', async () => {
    upstream.mockResolvedValueOnce(json({ id: 'site-1', ssl_url: 'https://web-relay.netlify.app' }))
      .mockResolvedValueOnce(json({ id: 'deploy-1', state: 'error', error_message: 'Function build failed' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const response = await deploy('netlify');
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toContain('Function build failed');
    expect(upstream.mock.calls.at(-1)).toMatchObject([`${netlifyBase}/sites/site-1`, { method: 'DELETE' }]);
    expect(listProxyPool()).toHaveLength(0);
  });
  it('reports a Netlify function upload rejection before registering the relay', async () => {
    upstream.mockImplementation(async (url, init) => {
      const path = String(url).slice(netlifyBase.length);
      if (path === '/sites' && init?.method === 'POST') return json({ id: 'site-1', ssl_url: 'https://web-relay.netlify.app' });
      if (path === '/sites/site-1/deploys') {
        const manifest = JSON.parse(String(init?.body));
        return json({ id: 'deploy-1', required: [], required_functions: [manifest.functions.relay] });
      }
      if (init?.method === 'PUT') return json({ message: 'Invalid function bundle' }, 400);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error('Unexpected API call');
    });
    const response = await deploy('netlify');
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('Invalid function bundle');
    expect(listProxyPool()).toHaveLength(0);
  });
  it('checks pool capacity before creating cloud resources', async () => {
    for (let i = 0; i < MAX_POOL_ENTRIES; i++) createProxyPoolEntry(`existing-${i}`, `https://proxy-${i}.example`);
    expect((await deploy('deno')).status).toBe(400);
    expect((await deploy('netlify')).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('keeps existing Cloudflare and Vercel deploys compatible', async () => {
    upstream.mockImplementation(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/workers/subdomain')) return json({ result: { subdomain: 'team' } });
      if (path.includes('/workers/scripts/')) return json({ success: true });
      if (path === 'https://api.vercel.com/v13/deployments') return json({ url: 'web-relay.vercel.app' });
      throw new Error(`Unexpected API call: ${init?.method}`);
    });
    for (const provider of ['cloudflare', 'vercel']) {
      const response = await request('/deploy-worker', { provider, workerName: 'web-relay', accountId: 'cf-account', apiToken: token });
      expect(response.status).toBe(201);
      expect((await response.json()).provider).toBe(provider);
    }
    expect(listProxyPool()).toHaveLength(2);
  });
  it.each(['deno', 'netlify'] as const)('handles malformed and unreachable %s APIs', async provider => {
    upstream.mockResolvedValueOnce(new Response('invalid JSON'));
    expect((await deploy(provider)).status).toBe(502);
    upstream.mockRejectedValueOnce(new Error(`Request failed: ${token}`));
    const response = await deploy(provider);
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain(token);
    expect(listProxyPool()).toHaveLength(0);
  });
  it('rejects invalid inputs and users without edit permission before calling a cloud API', async () => {
    expect((await deploy('deno', { apiToken: '' })).status).toBe(400);
    expect((await deploy('deno', { orgDomain: 'https://not-a-domain/' })).status).toBe(400);
    expect((await deploy('deno', { workerName: 'a' })).status).toBe(400);
    expect((await request('/deploy-worker', { provider: 'other', apiToken: token, workerName: 'web-relay' })).status).toBe(400);
    expect((await request('/deploy-worker', { provider: 'netlify', apiToken: token, workerName: 'web-relay' }, memberSession)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each(['https://web-relay.team.deno.net', 'https://web-relay.deno.dev', 'https://web-relay.netlify.app/.netlify/functions/relay'])('probes %s using the Fetch Relay protocol', async url => {
    const entry = createProxyPoolEntry('relay-probe', url);
    expect((await request(`/${entry.id}/test`, {})).status).toBe(200);
    expect(vi.mocked(probeProxyUrl).mock.calls[0]).toMatchObject([url, { mode: 'fetch-relay' }]);
  });
});

describe('deployed relay script behavior', () => {
  it('Deno relays stream bodies, preserve provider authorization and strip relay credentials', async () => {
    let handler!: (request: Request) => Promise<Response>;
    const fetchMock = vi.fn(async () => new Response('data: hello\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
    runInNewContext(DENO_RELAY_CODE, { Deno: { serve: (fn: typeof handler) => { handler = fn; } }, Response, Request, Headers, URL, fetch: fetchMock });
    expect((await handler(new Request('https://relay.test/'))).status).toBe(200);
    const result = await handler(new Request('https://relay.test/', {
      method: 'POST', body: 'payload', headers: { 'fetch-relay-target': 'https://provider.test/chat', 'fetch-relay-authorization': 'relay-secret', Authorization: 'Bearer provider-secret', Host: 'relay.test' },
    }));
    expect(await result.text()).toBe('data: hello\n\n');
    const call = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(call[0])).toBe('https://provider.test/chat');
    expect(new Headers(call[1].headers).get('authorization')).toBe('Bearer provider-secret');
    expect(new Headers(call[1].headers).has('fetch-relay-authorization')).toBe(false);
    expect(new Headers(call[1].headers).has('fetch-relay-target')).toBe(false);
    expect(new Headers(call[1].headers).has('host')).toBe(false);
    expect(call[1].redirect).toBe('manual');
    expect(await new Response(call[1].body).text()).toBe('payload');
    expect((await handler(new Request('https://relay.test/', { headers: { 'fetch-relay-target': 'file:///etc/passwd' } }))).status).toBe(400);
  });
  it('Netlify round-trips binary bodies and strips hop/relay headers', async () => {
    const exports: { handler?: (event: unknown) => Promise<any> } = {};
    const bytes = Buffer.from([0, 255, 128, 42]);
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 201, headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Content-Length': '1000' } }));
    runInNewContext(NETLIFY_RELAY_CODE, { exports, URL, Buffer, fetch: fetchMock });
    const result = await exports.handler!({ httpMethod: 'POST', body: bytes.toString('base64'), isBase64Encoded: true,
      headers: { 'Fetch-Relay-Target': 'https://provider.test/media', 'Fetch-Relay-Authorization': 'relay-secret', Host: 'relay.test', Authorization: 'Bearer provider-secret' } });
    expect(result.statusCode).toBe(201);
    expect(result.isBase64Encoded).toBe(true);
    expect(Buffer.from(result.body, 'base64')).toEqual(bytes);
    expect(result.headers['content-encoding']).toBeUndefined();
    expect(result.headers['content-length']).toBeUndefined();
    const call = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(call[1].body).toEqual(bytes);
    const forwarded = new Headers(call[1].headers);
    expect(forwarded.get('authorization')).toBe('Bearer provider-secret');
    expect(forwarded.has('fetch-relay-target')).toBe(false);
    expect(forwarded.has('fetch-relay-authorization')).toBe(false);
    expect(forwarded.has('host')).toBe(false);
    expect((await exports.handler!({ headers: {} })).statusCode).toBe(200);
    expect((await exports.handler!({ headers: { 'fetch-relay-target': 'invalid' } })).statusCode).toBe(400);
  });
  it('returns safe 502s when deployed script fetches fail', async () => {
    const exports: { handler?: (event: unknown) => Promise<any> } = {};
    runInNewContext(NETLIFY_RELAY_CODE, { exports, URL, Buffer, fetch: async () => { throw new Error(token); } });
    const result = await exports.handler!({ headers: { 'fetch-relay-target': 'https://provider.test/' } });
    expect(result.statusCode).toBe(502);
    expect(result.body).not.toContain(token);
  });
  it('bounds pending Deno deployments and never registers them as ready', async () => {
    vi.useFakeTimers();
    upstream.mockResolvedValueOnce(json({ id: 'app-1' })).mockResolvedValueOnce(json({ id: 'revision-1', status: 'building' }))
      .mockImplementation(async (_url, init) => init?.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ id: 'revision-1', status: 'building' }));
    const pending = expect(deployServerlessRelay({ provider: 'deno', apiToken: token, workerName: 'web-relay' })).rejects.toThrow(/did not succeed/);
    await vi.runAllTimersAsync();
    await pending;
    expect(listProxyPool()).toHaveLength(0);
  });
});
