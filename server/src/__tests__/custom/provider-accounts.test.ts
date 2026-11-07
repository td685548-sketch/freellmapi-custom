import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { getDb, getUnifiedApiKey, initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { providerAccountsRouter } from '../../custom/provider-accounts/router.js';
import { accountRow, invalidateXGatewayKeyCache } from '../../custom/provider-accounts/store.js';
import { X_GATEWAY_PROVIDERS, resolveXGatewayProvider } from '../../custom/provider-accounts/catalog.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import * as migration from '../../db/migrations/20261107_120000_custom_x_gateway_keys.js';
import {
  COPILOT_BASE_URL, COPILOT_TOKEN_URL, DEVICE_URL, GITHUB_TOKEN_URL, GITHUB_USER_URL, OPENROUTER_KEY_URL,
} from '../../custom/provider-accounts/http.js';
import { proxyFetch } from '../../lib/proxy.js';

vi.mock('../../lib/proxy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/proxy.js')>();
  return { ...actual, proxyFetch: vi.fn(actual.proxyFetch) };
});

const nativeFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const chatModel = (id = 'fixture-chat') => ({
  id, name: id, capabilities: { type: 'chat', supports: { tool_calls: true } },
  supported_endpoints: ['/chat/completions'], policy: { state: 'enabled' },
});
const fullPermissions = ['use_x_gateway', 'view_keys', 'add_keys', 'edit_keys', 'delete_keys', 'test_keys', 'manage_key_models'];
let server: ReturnType<ReturnType<typeof express>['listen']>;
let base: string;
let token: string;
let sameUserToken: string;
let otherToken: string;
let userId: number;
let personalApiKey: string;
let now = Date.now();
let githubId = 11;
let githubSecret = 'fixture-github-1';
let catalog: unknown;
let pollResult: unknown;
let handler: ((url: string, init?: RequestInit) => Promise<Response> | Response | undefined) | undefined;
let calls: Array<{ url: string; init?: RequestInit }>;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  migration.up(getDb());
  createUser('primary-accounts@test.dev', 'password123');
  userId = createUser('accounts@test.dev', 'password123', 'member').userId;
  token = createSession(userId);
  sameUserToken = createSession(userId);
  personalApiKey = mintUserApiKey(userId, 'X Test Key').key;
  const otherId = createUser('other-accounts@test.dev', 'password123', 'member').userId;
  getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(fullPermissions), otherId);
  otherToken = createSession(otherId);
  const app = express();
  app.use(express.json());
  app.use('/api/x-accounts', providerAccountsRouter);
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x-accounts`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => {
  now += 11 * 60_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const db = getDb();
  db.prepare('DELETE FROM x_gateway_keys').run();
  db.prepare('DELETE FROM api_keys').run();
  invalidateXGatewayKeyCache();
  db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(fullPermissions), userId);
  githubId = 11;
  githubSecret = `fixture-github-${now}`;
  catalog = { data: [chatModel()] };
  pollResult = undefined;
  handler = undefined;
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const custom = handler?.(url, init);
    if (custom !== undefined) return custom;
    if (url === DEVICE_URL) return json({ device_code: 'private-device-code', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    if (url === GITHUB_TOKEN_URL) return json(pollResult ?? { access_token: githubSecret, token_type: 'bearer' });
    if (url === GITHUB_USER_URL) return json({ id: githubId, login: 'not-persisted' });
    if (url === COPILOT_TOKEN_URL) return json({ token: `copilot-${githubId}`, expires_at: Math.floor(now / 1000) + 3600, endpoints: { api: 'https://evil.invalid' } });
    if (url === `${COPILOT_BASE_URL}/models`) return json(catalog);
    if (url === OPENROUTER_KEY_URL) return json({ key: 'fixture-openrouter-secret' });
    throw new Error(`Unmocked HTTP: ${url}`);
  });
});
afterEach(() => vi.restoreAllMocks());

async function call(method: string, path: string, body?: unknown, session: string | null = token, headers: Record<string, string> = {}) {
  const res = await nativeFetch(base + path, {
    method, headers: { ...(session ? { Authorization: `Bearer ${session}` } : {}), 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : null, raw };
}
function startOpenRouter(extra: Record<string, unknown> = {}, session = token) {
  return call('POST', '/auth/openrouter/start', { label: 'Router account', callbackUrl: 'https://dashboard.test/base/x/accounts/callback', ...extra }, session, { Origin: 'https://dashboard.test' });
}
async function connectGithub(extra: Record<string, unknown> = {}) {
  const start = await call('POST', '/auth/github-copilot/start', { label: 'Copilot account', ...extra });
  expect(start.status).toBe(200);
  now += start.body.interval * 1000;
  return call('POST', `/auth/${start.body.attemptId}/poll`, {});
}
function revoke(permission: string) {
  getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(fullPermissions.filter(p => p !== permission)), userId);
}

describe('provider account authorization', () => {
  it('validates PKCE callback origin and returns a server-owned S256 challenge', async () => {
    for (const callbackUrl of ['https://other.test/x/accounts/callback', 'https://u:p@dashboard.test/x/accounts/callback', 'https://dashboard.test/x/accounts/callback#fragment', 'https://dashboard.test/x/accounts/callback#', 'https://dashboard.test/wrong']) {
      expect((await startOpenRouter({ callbackUrl })).status).toBe(400);
    }
    expect((await call('POST', '/auth/unknown/start', { label: '' })).status).toBe(400);
    const start = await startOpenRouter();
    expect(start.status).toBe(200);
    expect(start.body.flow).toBe('oauth_pkce');
    expect(start.raw).not.toContain('verifier');
    const url = new URL(start.body.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
    const callback = new URL(url.searchParams.get('callback_url')!);
    expect(callback.pathname).toBe('/base/x/accounts/callback');
    expect(callback.searchParams.get('attemptId')).toBe(start.body.attemptId);
    expect(start.body.expiresAt).toBe(now + 600_000);
    expect(calls).toHaveLength(0);
    const complete = await call('POST', `/auth/${start.body.attemptId}/complete`, { code: 'browser-code' });
    expect(complete.status).toBe(200);
    const exchange = calls.find(c => c.url === OPENROUTER_KEY_URL)!;
    const payload = JSON.parse(String(exchange.init!.body));
    expect(payload.code).toBe('browser-code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(payload.code_verifier).digest('base64url'));
    expect(exchange.init!.redirect).toBe('error');
    expect(exchange.init!.signal).toBeInstanceOf(AbortSignal);
    const row = accountRow(complete.body.accountId);
    expect(row.platform).toBe('openrouter');
    expect(row.provider).toBe('openrouter');
    expect(row.subject).toBeNull();
    expect(decrypt(row.encrypted_key, row.iv, row.auth_tag)).toBe('fixture-openrouter-secret');
    expect(JSON.stringify(row)).not.toContain('fixture-openrouter-secret');
    expect(complete.body).toEqual({ status: 'connected', accountId: row.id });
    // Dedicated X Gateway key DB: api_keys table remains completely untouched
    expect(getDb().prepare('SELECT * FROM api_keys').all()).toHaveLength(0);
    expect(getDb().prepare('SELECT * FROM x_gateway_keys').all()).toHaveLength(1);
  });

  it('allows protocol+Host callback fallback, strictly validates request bodies and IDs', async () => {
    expect((await call('POST', '/auth/openrouter/start', { label: '', callbackUrl: base.replace('/api/x-accounts', '/x/accounts/callback') })).status).toBe(200);
    expect((await startOpenRouter({ injected: true })).status).toBe(400);
    expect((await startOpenRouter({ label: 'line\nbreak' })).status).toBe(400);
    expect((await call('PATCH', '/1garbage', { label: 'test' })).status).toBe(400);
    expect((await call('PATCH', '/1', { key: 'not-allowed' })).status).toBe(400);
    expect((await call('DELETE', '/1', { unexpected: true })).status).toBe(400);
  });

  it('binds attempts to both session and user, rejects replay, and expires attempts', async () => {
    const a = (await startOpenRouter()).body.attemptId;
    expect((await call('POST', `/auth/${a}/complete`, { code: 'code' }, sameUserToken)).status).toBe(404);
    expect((await call('POST', `/auth/${a}/complete`, { code: 'code' }, otherToken)).status).toBe(404);
    const otherId = (getDb().prepare('SELECT id FROM users WHERE email = ?').get('other-accounts@test.dev') as { id: number }).id;
    getDb().prepare('UPDATE sessions SET user_id = ? WHERE token_hash = ?').run(otherId, createHash('sha256').update(token).digest('hex'));
    expect((await call('POST', `/auth/${a}/complete`, { code: 'code' })).status).toBe(404);
    getDb().prepare('UPDATE sessions SET user_id = ? WHERE token_hash = ?').run(userId, createHash('sha256').update(token).digest('hex'));
    expect((await call('POST', `/auth/${a}/complete`, { code: 'code' })).status).toBe(200);
    expect((await call('POST', `/auth/${a}/complete`, { code: 'code' })).status).toBe(404);
    const expired = (await startOpenRouter()).body.attemptId;
    now += 600_000;
    expect((await call('POST', `/auth/${expired}/complete`, { code: 'code' })).status).toBe(404);
  });

  it('requires authentication and leaf permissions, rechecking revocation during exchange', async () => {
    expect((await call('GET', '/', undefined, null)).status).toBe(401);
    revoke('use_x_gateway');
    expect((await startOpenRouter()).status).toBe(403);
    getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(fullPermissions), userId);
    const a = (await startOpenRouter()).body.attemptId;
    revoke('add_keys');
    expect((await call('POST', `/auth/${a}/complete`, { code: 'code' })).status).toBe(403);
    expect(calls).toHaveLength(0);
    getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(fullPermissions), userId);
    handler = url => { if (url === OPENROUTER_KEY_URL) { revoke('add_keys'); return json({ key: 'secret-after-revoke' }); } };
    expect((await call('POST', `/auth/${a}/complete`, { code: 'code' })).status).toBe(403);
    expect(getDb().prepare('SELECT * FROM x_gateway_keys').all()).toHaveLength(0);
  });

  it('caps attempts and frees capacity on cancel and expiry', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await startOpenRouter()).body.attemptId);
    expect((await startOpenRouter()).status).toBe(429);
    expect((await call('DELETE', `/auth/${ids[0]}`)).status).toBe(204);
    expect((await call('POST', `/auth/${ids[0]}/complete`, { code: 'code' })).status).toBe(404);
    expect((await startOpenRouter()).status).toBe(200);
    now += 600_000;
    expect((await startOpenRouter()).status).toBe(200);
  });

  it('prevents simultaneous completion and cancellation while HTTP is in flight', async () => {
    const a = (await startOpenRouter()).body.attemptId;
    let release!: (r: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    handler = url => url === OPENROUTER_KEY_URL ? new Promise(resolve => { release = resolve; entered(); }) : undefined;
    const completion = call('POST', `/auth/${a}/complete`, { code: 'code' });
    await started;
    expect((await call('POST', `/auth/${a}/complete`, { code: 'code' })).status).toBe(409);
    expect((await call('DELETE', `/auth/${a}`)).status).toBe(204);
    release(json({ key: 'cancelled-secret' }));
    expect((await completion).status).toBe(410);
    expect(getDb().prepare('SELECT * FROM x_gateway_keys').all()).toHaveLength(0);
  });

  it.each([json({ key: 123 }), json({ error: 'SECRET-CREDENTIAL' }, 403), new Response('SECRET-CREDENTIAL')])('sanitizes malformed and failed provider responses', async response => {
    const a = (await startOpenRouter()).body.attemptId;
    handler = url => url === OPENROUTER_KEY_URL ? response : undefined;
    const out = await call('POST', `/auth/${a}/complete`, { code: 'code' });
    expect(out.status).toBe(502);
    expect(out.raw).not.toContain('SECRET-CREDENTIAL');
    expect((await call('POST', `/auth/${a}/complete`, { code: 'code' })).status).toBe(404);
  });
});

describe('GitHub Copilot device accounts', () => {
  it('requires model permission, validates device JSON and never returns device credentials', async () => {
    revoke('manage_key_models');
    expect((await call('POST', '/auth/github-copilot/start', { label: 'github' })).status).toBe(403);
    expect(calls).toHaveLength(0);
    getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(fullPermissions), userId);
    const start = await call('POST', '/auth/github-copilot/start', { label: 'github' });
    expect(start.body).toMatchObject({ flow: 'device_code', interval: 5, verificationUri: 'https://github.com/login/device', userCode: 'ABCD-1234' });
    expect(start.raw).not.toContain('private-device-code');
    const payload = JSON.parse(String(calls[0].init!.body));
    expect(payload).toEqual({ client_id: 'Iv1.b507a08c87ecfe98', scope: 'read:user' });
    expect(new Headers(calls[0].init!.headers).get('User-Agent')).toContain('FreeLLMAPI');
    handler = url => url === DEVICE_URL ? json({ verification_uri: 'https://evil.invalid' }) : undefined;
    expect((await call('POST', '/auth/github-copilot/start', { label: 'github' })).status).toBe(502);
  });

  it('enforces pending/slow_down intervals and single flight without double creation', async () => {
    const start = (await call('POST', '/auth/github-copilot/start', { label: 'github' })).body;
    const path = `/auth/${start.attemptId}/poll`;
    expect((await call('POST', path, {})).body).toEqual({ status: 'pending', interval: 5 });
    expect(calls.filter(c => c.url === GITHUB_TOKEN_URL)).toHaveLength(0);
    now += 5000;
    pollResult = { error: 'slow_down' };
    expect((await call('POST', path, {})).body).toEqual({ status: 'pending', interval: 10 });
    now += 10_000;
    pollResult = { error: 'authorization_pending' };
    expect((await call('POST', path, {})).body).toEqual({ status: 'pending', interval: 10 });
    now += 10_000;
    let release!: (r: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    handler = url => url === GITHUB_TOKEN_URL ? new Promise(r => { release = r; entered(); }) : undefined;
    const first = call('POST', path, {});
    await started;
    expect((await call('POST', path, {})).body.status).toBe('pending');
    release(json({ access_token: githubSecret, token_type: 'bearer' }));
    expect((await first).body.status).toBe('connected');
    expect((await call('POST', path, {})).status).toBe(404);
    expect(getDb().prepare('SELECT * FROM x_gateway_keys').all()).toHaveLength(1);
    expect(getDb().prepare('SELECT * FROM api_keys').all()).toHaveLength(0);
  });

  it.each(['access_denied', 'expired_token', 'unexpected'])('consumes %s attempts without saving', async error => {
    pollResult = { error };
    const out = await connectGithub();
    expect(out.status).toBe(error === 'unexpected' ? 502 : 400);
    expect(getDb().prepare('SELECT * FROM x_gateway_keys').all()).toHaveLength(0);
  });

  it('requires entitlement and skips messages-only, disabled, malformed and non-chat models', async () => {
    handler = url => url === COPILOT_TOKEN_URL ? json({ message: 'SECRET no entitlement' }, 403) : undefined;
    expect((await connectGithub()).status).toBe(502);
    handler = undefined;
    catalog = { data: [{ ...chatModel(), supported_endpoints: ['/v1/messages'] }, { ...chatModel(), capabilities: { type: 'embeddings' } }, { ...chatModel(), policy: { state: 'disabled' } }, { id: 'unknown-shape' }] };
    expect((await connectGithub()).status).toBe(502);
    expect(getDb().prepare('SELECT * FROM x_gateway_keys').all()).toHaveLength(0);
    catalog = { data: [chatModel(), { ...chatModel('not-chat'), supported_endpoints: ['/responses'] }] };
    const valid = await connectGithub();
    expect(valid.status).toBe(200);
    expect(JSON.parse(accountRow(valid.body.accountId).model_scope_json!)).toEqual(['fixture-chat']);
  });

  it('stores two encrypted accounts in x_gateway_keys, deduplicates stable identity, and reconnects only the selected identity', async () => {
    const first = await connectGithub();
    expect(first.status).toBe(200);
    expect((await connectGithub()).status).toBe(409);
    const firstRow = accountRow(first.body.accountId);
    expect(decrypt(firstRow.encrypted_key, firstRow.iv, firstRow.auth_tag)).toBe('x-copilot:' + githubSecret);
    expect(firstRow.subject).toBe('11');
    expect(JSON.stringify(firstRow)).not.toContain(githubSecret);
    githubId = 22; githubSecret = 'fixture-second-account';
    catalog = { data: [chatModel(), chatModel('only-second')] };
    const second = await connectGithub();
    expect(second.status).toBe(200);
    expect(second.body.accountId).not.toBe(first.body.accountId);
    expect((await connectGithub({ reconnectId: first.body.accountId })).status).toBe(409);
    expect(accountRow(firstRow.id).encrypted_key).toBe(firstRow.encrypted_key);
    githubId = 11; githubSecret = 'fixture-renewed';
    expect((await connectGithub({ reconnectId: firstRow.id })).body).toEqual({ status: 'connected', accountId: firstRow.id });
    expect(getDb().prepare('SELECT * FROM x_gateway_keys').all()).toHaveLength(2);
    expect(getDb().prepare('SELECT * FROM api_keys').all()).toHaveLength(0);
    expect((await startOpenRouter({ reconnectId: firstRow.id })).status).toBe(409);
    const list = await call('GET', '/');
    expect(list.status).toBe(200);
    expect(list.body.providers.length).toBe(X_GATEWAY_PROVIDERS.length);
    expect(list.body.providers.find((p: { id: string }) => p.id === 'github-copilot').accounts).toHaveLength(2);
    expect(list.raw).not.toContain('fixture-renewed');
    expect(list.raw).not.toContain('encrypted_key');
    expect(list.body.providers.some((p: { id: string }) => p.id === 'custom')).toBe(true);
    expect(list.body.providers.find((p: { id: string }) => p.id === 'openrouter').authMethods).toEqual(['api_key', 'oauth_pkce']);

    // Providers with keys in the main api_keys table are flagged with hasMainDbKey: true
    const enc = encrypt('main-db-groq-key');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq', 'Main Groq', ?, ?, ?, 'valid', 1)`).run(enc.encrypted, enc.iv, enc.authTag);
    const listWithMain = await call('GET', '/');
    expect(listWithMain.body.providers.find((p: { id: string }) => p.id === 'groq').hasMainDbKey).toBe(true);
    expect(listWithMain.body.providers.find((p: { id: string }) => p.id === 'openrouter').hasMainDbKey).toBeUndefined();
  });

  it('updates and deletes accounts directly in x_gateway_keys without touching api_keys or models', async () => {
    const first = await connectGithub();
    githubId = 22; githubSecret = 'another-account';
    const second = await connectGithub();
    expect((await call('PATCH', `/${first.body.accountId}`, { label: 'Renamed', enabled: false })).status).toBe(200);
    expect(accountRow(first.body.accountId).enabled).toBe(0);
    expect(accountRow(first.body.accountId).label).toBe('Renamed');
    expect((await call('DELETE', `/${first.body.accountId}`)).status).toBe(200);
    expect(getDb().prepare('SELECT * FROM x_gateway_keys WHERE id = ?').all(first.body.accountId)).toHaveLength(0);
    expect(accountRow(second.body.accountId).id).toBe(second.body.accountId);
  });

  it('health tests do not generate completions; explicit tests use only the selected scoped account', async () => {
    const account = (await connectGithub()).body.accountId;
    calls.length = 0;
    expect((await call('POST', `/${account}/test`, {})).body).toEqual({ ok: true });
    expect(calls.map(c => c.url)).toEqual([`${COPILOT_BASE_URL}/models`]);
    handler = (url, init) => {
      if (url === `${COPILOT_BASE_URL}/chat/completions`) {
        const body = JSON.parse(String(init!.body));
        expect(body.max_tokens).toBe(128);
        expect(body.model).toBe('fixture-chat');
        return json({ choices: [{ message: { role: 'assistant', content: 'SECRET-PROVIDER-REPLY' } }] });
      }
    };
    const result = await call('POST', `/${account}/test`, { message: 'hello', model: 'fixture-chat' });
    expect(result.body).toEqual({ ok: true });
    expect(result.raw).not.toContain('SECRET');
    expect((await call('POST', `/${account}/test`, { message: 'hello', model: 'ineligible' })).status).toBe(400);
    handler = url => url === `${COPILOT_BASE_URL}/models` ? new Response('not-json') : undefined;
    expect((await call('POST', `/${account}/test`, {})).body.ok).toBe(false);
    revoke('test_keys');
    expect((await call('POST', `/${account}/test`, {})).status).toBe(403);
  });

  it('forwards both saved credentials through the provider factory including streaming', async () => {
    const first = (await connectGithub()).body.accountId;
    githubId = 22; githubSecret = 'second-for-forwarding';
    const second = (await connectGithub()).body.accountId;
    const forwarded: string[] = [];
    handler = (url, init) => {
      if (url !== `${COPILOT_BASE_URL}/chat/completions`) return;
      forwarded.push(new Headers(init!.headers).get('Authorization')!);
      const body = JSON.parse(String(init!.body));
      expect(body.model).toBe('fixture-chat');
      if (body.stream) return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      return json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    };
    for (const id of [first, second]) {
      const row = accountRow(id);
      const provider = resolveXGatewayProvider(row.provider, row.base_url)!;
      const credential = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      expect((await provider.chatCompletion(credential, [{ role: 'user', content: 'hello' }], 'fixture-chat')).choices[0].message.content).toBe('ok');
      const chunks = [];
      for await (const chunk of provider.streamChatCompletion(credential, [{ role: 'user', content: 'hello' }], 'fixture-chat')) chunks.push(chunk);
      expect(chunks[0].choices[0].delta.content).toBe('ok');
    }
    expect(forwarded).toEqual(['Bearer copilot-11', 'Bearer copilot-11', 'Bearer copilot-22', 'Bearer copilot-22']);
    expect(calls.every(c => !c.url.includes('evil.invalid'))).toBe(true);
  });

  it('serves saved x_gateway_keys accounts through /x/v1 while isolating them from /v1 and recording token analytics', async () => {
    const first = (await connectGithub()).body.accountId;
    githubId = 22; githubSecret = 'stock-x-second';
    const second = (await connectGithub()).body.accountId;
    const forwarded: string[] = [];
    handler = (url, init) => {
      if (url !== `${COPILOT_BASE_URL}/chat/completions`) return;
      forwarded.push(new Headers(init!.headers).get('Authorization')!);
      return json({ id: 'test-chat', object: 'chat.completion', created: 1, model: 'fixture-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    };
    setEnabled(true);
    const app = createApp();
    const listener = await new Promise<ReturnType<typeof app.listen>>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const appBase = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
    try {
      // /v1 has no keys in api_keys, so it must NOT route through x_gateway_keys
      const v1Res = await nativeFetch(`${appBase}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getUnifiedApiKey()}` },
        body: JSON.stringify({ model: 'fixture-chat', messages: [{ role: 'user', content: 'hello' }], max_tokens: 8 }),
      });
      expect(v1Res.status).not.toBe(200);

      // /x/v1 routes through x_gateway_keys and records analytics in requests + x_gateway_key_monthly_usage
      for (const selected of [first, second]) {
        for (const id of [first, second]) expect((await call('PATCH', `/${id}`, { enabled: id === selected })).status).toBe(200);
        const result = await nativeFetch(`${appBase}/x/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${personalApiKey}` },
          body: JSON.stringify({ model: 'fixture-chat', messages: [{ role: 'user', content: 'hello' }], max_tokens: 8 }),
        });
        const body = await result.json() as { choices?: { message: { content: string } }[] };
        expect(result.status, JSON.stringify(body)).toBe(200);
        expect(body.choices?.[0].message.content).toBe('ok');
      }
      expect(forwarded).toEqual(['Bearer copilot-11', 'Bearer copilot-22']);
      const usageRows = getDb().prepare('SELECT key_id, requests, tokens FROM x_gateway_key_monthly_usage ORDER BY key_id').all() as Array<{ key_id: number; requests: number; tokens: number }>;
      expect(usageRows).toEqual([
        { key_id: first, requests: 1, tokens: 15 },
        { key_id: second, requests: 1, tokens: 15 },
      ]);
      const loggedReq = getDb().prepare("SELECT caller, user_id, key_id, input_tokens, output_tokens FROM requests WHERE caller = 'x-gateway' ORDER BY id DESC LIMIT 1").get() as { caller: string; user_id: number; key_id: number | null; input_tokens: number; output_tokens: number };
      expect(loggedReq).toEqual({ caller: 'x-gateway', user_id: userId, key_id: null, input_tokens: 10, output_tokens: 5 });
    } finally {
      await new Promise<void>(resolve => listener.close(() => resolve()));
    }
  });
});

it('supports adding 9Router API key accounts via POST /api/x-accounts, monthly usage, action permissions, and OpenRouter reconnect', async () => {
  const created = await call('POST', '/', { provider: 'openrouter', key: 'ordinary-openrouter-key', label: 'Existing API key' });
  expect(created.status).toBe(201);
  const ordinary = created.body.id as number;
  getDb().prepare('UPDATE x_gateway_keys SET monthly_request_cap = 100, monthly_token_cap = 1000 WHERE id = ?').run(ordinary);
  getDb().prepare('INSERT INTO x_gateway_key_monthly_usage (key_id, month, requests, tokens) VALUES (?, ?, 7, 42)').run(ordinary, new Date().toISOString().slice(0, 7));
  const list = (await call('GET', '/')).body;
  const account = list.providers.find((p: { id: string }) => p.id === 'openrouter').accounts[0];
  expect(account).toMatchObject({ id: ordinary, authMethod: 'api_key', identity: null, monthlyUsage: { requests: 7, tokens: 42 }, monthlyRequestCap: 100, monthlyTokenCap: 1000 });
  expect(list.permissions).toEqual({ add: true, edit: true, delete: true, test: true, manageModels: true });
  revoke('edit_keys');
  expect((await call('PATCH', `/${ordinary}`, { enabled: false })).status).toBe(403);
  expect((await startOpenRouter({ reconnectId: ordinary })).status).toBe(403);
  revoke('view_keys');
  expect((await call('GET', '/')).status).toBe(403);
  revoke('delete_keys');
  expect((await call('DELETE', `/${ordinary}`)).status).toBe(403);
  getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(fullPermissions.filter(p => p !== 'add_keys')), userId);
  const reconnect = (await startOpenRouter({ reconnectId: ordinary })).body.attemptId;
  expect((await call('POST', `/auth/${reconnect}/complete`, { code: 'replace-grant' })).body).toEqual({ status: 'connected', accountId: ordinary });
  const row = accountRow(ordinary);
  expect(row.auth_method).toBe('oauth_pkce');
  expect(row.subject).toBeNull();
  expect(decrypt(row.encrypted_key, row.iv, row.auth_tag)).toBe('fixture-openrouter-secret');
  expect(getDb().prepare('SELECT * FROM x_gateway_keys').all()).toHaveLength(1);
  expect(getDb().prepare('SELECT * FROM api_keys').all()).toHaveLength(0);
});

it('roundtrips the x_gateway_keys migration with unique identities and cascade on x_gateway_key_monthly_usage', async () => {
  const secret = encrypt('secret-1');
  const firstId = Number(getDb().prepare(`INSERT INTO x_gateway_keys (provider, label, subject, auth_method, encrypted_key, iv, auth_tag) VALUES ('github-copilot', 'A', '11', 'device_code', ?, ?, ?)`).run(secret.encrypted, secret.iv, secret.authTag).lastInsertRowid);
  getDb().prepare(`INSERT INTO x_gateway_key_monthly_usage (key_id, month, requests, tokens) VALUES (?, '2026-11', 5, 50)`).run(firstId);
  expect(() => getDb().prepare(`INSERT INTO x_gateway_keys (provider, label, subject, auth_method, encrypted_key, iv, auth_tag) VALUES ('github-copilot', 'B', '11', 'device_code', ?, ?, ?)`).run(secret.encrypted, secret.iv, secret.authTag)).toThrow();
  getDb().prepare('DELETE FROM x_gateway_keys WHERE id = ?').run(firstId);
  expect(getDb().prepare('SELECT * FROM x_gateway_key_monthly_usage WHERE key_id = ?').all(firstId)).toHaveLength(0);
  migration.down(getDb());
  migration.up(getDb());
  migration.up(getDb());
  expect(getDb().prepare('SELECT * FROM x_gateway_keys').all()).toHaveLength(0);
});

describe('provider account transport', () => {
  it('sends OAuth/device exchanges through the proxy-aware transport, not raw fetch', async () => {
    vi.mocked(proxyFetch).mockClear();
    const start = await call('POST', '/auth/github-copilot/start', { label: 'Proxy fixture' });
    expect(start.status).toBe(200);
    expect(proxyFetch).toHaveBeenCalledWith(DEVICE_URL, expect.objectContaining({ method: 'POST', redirect: 'error' }), undefined, 'unknown');
    now += start.body.interval * 1000;
    const poll = await call('POST', `/auth/${start.body.attemptId}/poll`, {});
    expect(poll.status).toBe(200);
    expect(proxyFetch).toHaveBeenCalledWith(GITHUB_TOKEN_URL, expect.objectContaining({ method: 'POST' }), undefined, 'unknown');
    expect(proxyFetch).toHaveBeenCalledWith(COPILOT_TOKEN_URL, expect.anything(), undefined, 'unknown');
  });
});
