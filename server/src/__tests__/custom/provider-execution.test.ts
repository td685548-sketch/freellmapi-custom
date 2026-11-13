import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { decrypt } from '../../lib/crypto.js';
import { proxyFetch } from '../../lib/proxy.js';
import { providerAccountsRouter } from '../../custom/provider-accounts/router.js';
import { accountRow, createApiKeyAccount, invalidateXGatewayKeyCache, updateAccountCredential } from '../../custom/provider-accounts/store.js';
import { clearOAuthRefreshState, resolveAccountCredential } from '../../custom/provider-accounts/oauth-lifecycle.js';
import { parseOAuthCredential, type OAuthCredential } from '../../custom/provider-accounts/oauth-credentials.js';
import { normalizeImportedCredential } from '../../custom/provider-accounts/oauth-providers.js';
import { resolveAccountProvider } from '../../custom/provider-accounts/execution.js';
import { crc32, decodeKiroFrame } from '../../custom/provider-accounts/kiro-wire.js';
import { xGatewayRouter, resetRouteHealth } from '../../custom/x-gateway/router.js';
import { createCombo, invalidateConfigCache, setEnabled } from '../../custom/x-gateway/config.js';
import { fetchAccountQuota, parseProviderQuota } from '../../custom/x-gateway/quota/adapters.js';
import { recordQuotaWindows } from '../../custom/x-gateway/quota/store.js';

vi.mock('../../lib/proxy.js', async original => ({ ...await original<typeof import('../../lib/proxy.js')>(), proxyFetch: vi.fn() }));
const fetchHttp = globalThis.fetch;
let upstream: Server; let gateway: Server; let upstreamUrl: string; let base: string;
let session: string; let otherSession: string; let apiKey: string; let userId: number;
let requests: Array<{ path: string; target: string; headers: Record<string, any>; body: any }>;
let behavior: 'ok' | '401' | 'refresh-error' | '429' | 'hold' | 'truncated' = 'ok';
let refreshes = 0; let upstreamClosed = false;
const fixture = mkdtempSync(join(tmpdir(), 'x-subscriptions-'));
let database: string;
const json = (res: express.Response, data: unknown, status = 200) => res.status(status).json(data);
const cred = (kind: OAuthCredential['kind'], expired = false): OAuthCredential => ({ v: 1, kind, accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: Date.now() + (expired ? -1 : 86_400_000), projectId: 'fixture-project', accountId: 'fixture-account', region: 'us-east-1', authMethod: 'builder-id', clientId: 'private-client', clientSecret: 'private-client-secret' });
function frame(type: string, payload: unknown): Buffer {
  const headers = Buffer.concat(Object.entries({ ':message-type': 'event', ':event-type': type }).map(([name, value]) => {
    const bytes = Buffer.from(value); const size = Buffer.alloc(2); size.writeUInt16BE(bytes.length);
    return Buffer.concat([Buffer.from([name.length]), Buffer.from(name), Buffer.from([7]), size, bytes]);
  }));
  const body = Buffer.from(JSON.stringify(payload)); const buffer = Buffer.alloc(16 + headers.length + body.length);
  buffer.writeUInt32BE(buffer.length); buffer.writeUInt32BE(headers.length, 4); buffer.writeUInt32BE(crc32(buffer.subarray(0, 8)), 8);
  headers.copy(buffer, 12); body.copy(buffer, 12 + headers.length); buffer.writeUInt32BE(crc32(buffer.subarray(0, -4)), buffer.length - 4); return buffer;
}
function sse(res: express.Response, events: unknown[]) {
  res.type('text/event-stream');
  // Real HTTP response split inside UTF-8/data lines; final event has no newline.
  const data = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}`).join('\r\n\r\n'));
  res.write(data.subarray(0, 13)); res.end(data.subarray(13));
}
beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  const app = express(); app.use(express.json()); app.use(express.urlencoded({ extended: false }));
  app.use((req, res) => {
    const target = String(req.headers['x-fixture-target'] ?? '');
    requests.push({ path: req.path, target, headers: req.headers, body: req.body });
    if (req.path.endsWith('/client/register')) return json(res, { clientId: 'private-client', clientSecret: 'private-client-secret' });
    if (req.path.endsWith('/device_authorization')) return json(res, { deviceCode: 'private-device', userCode: 'ABCD-1234', verificationUri: 'https://view.awsapps.com/start', interval: 5, expiresIn: 600 });
    if (req.path.endsWith('/token')) {
      refreshes++;
      if (behavior === 'refresh-error') return json(res, { error: 'invalid_grant', error_description: 'private-refresh must never leave server' }, 400);
      return target.includes('amazonaws.com') ? json(res, { accessToken: 'rotated-access', refreshToken: 'rotated-refresh', expiresIn: 3600 }) : json(res, { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 });
    }
    if (req.path.endsWith('/userinfo')) return json(res, { email: 'google-fixture@test.dev' });
    if (req.path.endsWith(':loadCodeAssist')) return json(res, { cloudaicompanionProject: 'google-project' });
    if (req.path.endsWith('/usage')) return json(res, { rate_limit: { primary_window: { used_percent: 25 } } });
    if (req.path.endsWith(':retrieveUserQuota')) return json(res, { buckets: [{ modelId: 'gemini-2.5-flash', remainingFraction: .5 }] });
    if (req.path.endsWith('/getUsageLimits')) return json(res, { usageBreakdownList: [{ resourceType: 'AGENTIC_REQUEST', usageLimitWithPrecision: 10, currentUsageWithPrecision: 4 }] });
    if (behavior === '401' && req.headers.authorization !== 'Bearer rotated-access') return json(res, { error: 'private-access' }, 401);
    if (behavior === '429' && target.includes('chatgpt.com')) { res.set('Retry-After', '60'); return json(res, { error: 'quota exhausted' }, 429); }
    if (behavior === 'hold') {
      res.type('text/event-stream'); res.write('data: {"type":"response.output_text.delta","delta":"first"}\n\n');
      res.on('close', () => { upstreamClosed = true; }); return;
    }
    if (behavior === 'truncated') { res.type('text/event-stream').end('data: {broken'); return; }
    if (req.path.endsWith('/responses')) return sse(res, [{ type: 'response.output_text.delta', delta: 'Xin chào' }, { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }]);
    if (req.path.includes('streamGenerateContent')) return sse(res, [{ response: { candidates: [{ content: { parts: [{ text: 'Xin chào' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } } }]);
    if (req.path.endsWith('/generateAssistantResponse')) {
      res.type('application/vnd.amazon.eventstream');
      const binary = Buffer.concat([frame('assistantResponseEvent', { content: 'Xin chào' }), frame('messageStopEvent', { stopReason: 'end_turn' })]);
      res.write(binary.subarray(0, 5)); res.end(binary.subarray(5)); return;
    }
    if (req.path.endsWith('/messages')) return json(res, { id: 'msg_fixture', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Xin chào' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } });
    json(res, { error: 'Unknown fixture request' }, 500);
  });
  upstream = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const appGateway = express(); appGateway.use(express.json()); appGateway.use('/api/thruline-accounts', providerAccountsRouter); appGateway.use('/thruline/v1', xGatewayRouter);
  gateway = await new Promise(resolve => { const server = appGateway.listen(0, '127.0.0.1', () => resolve(server)); });
  base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
});
beforeEach(() => {
  vi.stubEnv('GEMINI_CLIENT_ID', 'fixture-client'); vi.stubEnv('GEMINI_CLIENT_SECRET', 'fixture-secret');
  try { getDb().close(); } catch {}
  try { getDb().close(); } catch {}
  database = join(fixture, Math.random().toString(36).slice(2) + '.db'); initDb(database); clearOAuthRefreshState(); invalidateConfigCache(); invalidateXGatewayKeyCache(); resetRouteHealth(); setEnabled(true);
  createUser('primary-fixture@test.dev', 'password123');
  userId = createUser('provider-owner@test.dev', 'password123', 'admin').userId; session = createSession(userId); otherSession = createSession(userId);
  apiKey = mintUserApiKey(userId, 'fixture').key;
  requests = []; refreshes = 0; upstreamClosed = false; behavior = 'ok';
  vi.mocked(proxyFetch).mockImplementation((url, init) => {
    const target = new URL(String(url));
    return fetchHttp(upstreamUrl + target.pathname + target.search, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), 'x-fixture-target': target.origin } });
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { gateway.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise<void>(r => gateway.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]); getDb().close(); getDb().close(); initDb(':memory:'); rmSync(fixture, { recursive: true, force: true }); });
function account(kind: OAuthCredential['kind'], expired = false): number {
  return createApiKeyAccount({ provider: kind, key: JSON.stringify(cred(kind, expired)), models: [{ id: kind === 'codex' ? 'gpt-5.4' : kind === 'gemini-cli' ? 'gemini-2.5-flash' : 'claude-sonnet-4-5', name: 'fixture' }] });
}
async function call(path: string, body: unknown, token = session) { return fetchHttp(base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
async function chat(provider: string, stream = false) { return call('/thruline/v1/chat/completions', { model: `${provider}/${provider === 'codex' ? 'gpt-5.4' : provider === 'gemini-cli' ? 'gemini-2.5-flash' : 'claude-sonnet-4-5'}`, messages: [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'Hi' }], stream }, apiKey); }

describe('native subscription execution through real HTTP gateway and upstream', () => {
  it.each(['codex', 'claude', 'gemini-cli', 'kiro'] as const)('%s uses native protocol, encrypted credential and selected model', async kind => {
    const id = account(kind); const response = await chat(kind); const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200); expect(body.choices[0].message.content).toBe('Xin chào');
    const request = requests.at(-1)!; expect(request.headers.authorization).toBe('Bearer private-access'); expect(JSON.stringify(request)).not.toContain('private-refresh');
    if (kind === 'codex') { expect(request.target).toBe('https://chatgpt.com'); expect(request.path).toBe('/backend-api/codex/responses'); expect(request.body).toMatchObject({ model: 'gpt-5.4', stream: true, store: false }); expect(request.body.input[0].content[0].type).toBe('input_text'); }
    if (kind === 'claude') { expect(request.path).toBe('/v1/messages'); expect(request.headers['x-api-key']).toBeUndefined(); expect(request.headers['anthropic-beta']).toContain('oauth-2025'); expect(request.headers['anthropic-beta']).toContain('claude-code-20250219'); expect(request.body.system[0].text).toContain('You are Claude Code'); expect(request.body.system[1].text).toBe('Be concise.'); }
    if (kind === 'gemini-cli') { expect(request.path).toContain(':streamGenerateContent'); expect(request.body).toMatchObject({ project: 'fixture-project', model: 'gemini-2.5-flash', request: { contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] } }); }
    if (kind === 'kiro') { expect(request.target).toBe('https://codewhisperer.us-east-1.amazonaws.com'); expect(request.body.conversationState.currentMessage.userInputMessage.modelId).toBe('claude-sonnet-4.5'); }
    expect(accountRow(id).encrypted_key).not.toContain('private');
  });
  it('pins Claude OAuth to Anthropic while preserving legacy API-key custom endpoints', async () => {
    const id = account('claude'); getDb().prepare('UPDATE x_gateway_keys SET base_url = ? WHERE id = ?').run('https://legacy-gateway.example/v1', id); invalidateXGatewayKeyCache();
    expect((await chat('claude')).status).toBe(200); expect(requests.at(-1)?.target).toBe('https://api.anthropic.com');
    const legacy = createApiKeyAccount({ provider: 'custom', key: 'legacy-fixture', baseUrl: 'https://legacy-gateway.example/v1' });
    getDb().prepare('UPDATE x_gateway_keys SET provider = ? WHERE id = ?').run('claude', legacy);
    await resolveAccountProvider(accountRow(legacy))!.chatCompletion('', [{ role: 'user', content: 'Hi' }], 'claude-sonnet-4-5');
    expect(requests.at(-1)?.target).toBe('https://legacy-gateway.example'); expect(requests.at(-1)?.headers['x-api-key']).toBe('legacy-fixture');
  });
  it.each(['codex', 'claude', 'gemini-cli', 'kiro'] as const)('%s preserves native tool replay IDs and error results over HTTP', async kind => {
    const id = account(kind); const row = accountRow(id); const provider = resolveAccountProvider(row)!;
    await provider.chatCompletion('', [{ role: 'user', content: 'Run tool' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call_A', type: 'function', function: { name: 'fixture_tool', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call_A', content: 'tool failed', is_error: true }], kind === 'codex' ? 'gpt-5.4' : kind === 'gemini-cli' ? 'gemini-2.5-flash' : 'claude-sonnet-4-5', { tools: [{ type: 'function', function: { name: 'fixture_tool', parameters: { type: 'object', properties: {} } } }] });
    const body = requests.at(-1)!.body;
    if (kind === 'codex') expect(body.input.find((item: any) => item.type === 'function_call_output')).toMatchObject({ call_id: 'call_A', output: 'tool failed' });
    if (kind === 'claude') expect(body.messages.find((item: any) => Array.isArray(item.content) && item.content.some((part: any) => part.type === 'tool_result')).content[0]).toMatchObject({ tool_use_id: 'call_A', is_error: true });
    if (kind === 'gemini-cli') expect(body.request.contents.at(-1).parts[0].functionResponse).toMatchObject({ name: 'fixture_tool', response: { error: 'tool failed' } });
    if (kind === 'kiro') expect(body.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults[0]).toMatchObject({ toolUseId: 'call_A', status: 'error' });
  });
  it.each(['codex', 'gemini-cli', 'kiro'] as const)('%s streams valid Chat Completion SSE', async kind => {
    account(kind); const response = await chat(kind, true); const body = await response.text(); expect(response.status).toBe(200); expect(body).toContain('Xin chào'); expect(body).toContain('[DONE]');
  });
  it('refreshes once for concurrent expired requests and persists rotation across DB reopen', async () => {
    const id = account('codex', true); const stale = accountRow(id);
    await Promise.all(Array.from({ length: 12 }, () => resolveAccountCredential(stale)));
    expect(refreshes).toBe(1); const saved = accountRow(id); expect(parseOAuthCredential(decrypt(saved.encrypted_key, saved.iv, saved.auth_tag))?.refreshToken).toBe('rotated-refresh');
    clearOAuthRefreshState(); getDb().close(); initDb(database); const restored = parseOAuthCredential(await resolveAccountCredential(accountRow(id))); expect(restored?.accessToken).toBe('rotated-access'); expect(refreshes).toBe(1);
  });
  it.each(['codex', 'claude', 'gemini-cli', 'kiro'] as const)('%s refreshes with the correct token endpoint before inference', async kind => {
    account(kind, true); const response = await chat(kind); expect(response.status).toBe(200); expect(refreshes).toBe(1);
    const request = requests.find(r => r.path.endsWith('/token'))!;
    if (kind === 'kiro') expect(request.body).toMatchObject({ grantType: 'refresh_token', clientSecret: 'private-client-secret' });
    else expect(request.body.grant_type).toBe('refresh_token');
    expect(requests.at(-1)?.headers.authorization).toBe('Bearer rotated-access');
  });
  it('retries an initial 401 exactly once with a fresh token', async () => {
    account('codex'); behavior = '401'; expect((await chat('codex')).status).toBe(200); expect(refreshes).toBe(1); expect(requests.filter(r => r.path.endsWith('/responses'))).toHaveLength(2);
  });
  it('does not overwrite a credential reconnected during refresh', async () => {
    const id = account('codex', true); const promise = resolveAccountCredential(accountRow(id));
    updateAccountCredential(id, { ...cred('codex'), accessToken: 'new-login' });
    expect(parseOAuthCredential(await promise)?.accessToken).toBe('new-login');
    expect(parseOAuthCredential(await resolveAccountCredential(accountRow(id)))?.accessToken).toBe('new-login');
  });
  it('does not mark a reconnected account failed when its old refresh is rejected', async () => {
    const id = account('codex', true); behavior = 'refresh-error';
    const promise = resolveAccountCredential(accountRow(id));
    updateAccountCredential(id, { ...cred('codex'), accessToken: 'new-login' });
    expect(parseOAuthCredential(await promise)?.accessToken).toBe('new-login');
    expect(accountRow(id).status).toBe('unknown');
  });
  it('redacts permanent refresh failure and suppresses repeated refresh', async () => {
    const id = account('codex', true); behavior = 'refresh-error';
    await expect(resolveAccountCredential(accountRow(id))).rejects.toThrow('Reconnect');
    await expect(resolveAccountCredential(accountRow(id))).rejects.toThrow('Reconnect'); expect(refreshes).toBe(1); expect(accountRow(id).status).toBe('error');
    const response = await chat('codex'); expect(await response.text()).not.toContain('private-refresh');
  });
  it('rejects malformed/truncated upstream SSE instead of reporting success', async () => {
    const id = account('codex'); behavior = 'truncated'; await expect(resolveAccountProvider(accountRow(id))!.chatCompletion('', [{ role: 'user', content: 'Hi' }], 'gpt-5.4')).rejects.toThrow('malformed');
  });
  it('fallback handles exhausted quota without sending subscription credentials to a generic endpoint', async () => {
    account('codex'); account('gemini-cli'); behavior = '429'; createCombo('subscription-fallback', [{ platform: 'codex', modelId: 'gpt-5.4' }, { platform: 'gemini-cli', modelId: 'gemini-2.5-flash' }], undefined, { strategy: 'fallback' });
    const response = await call('/thruline/v1/chat/completions', { model: 'combo:subscription-fallback', messages: [{ role: 'user', content: 'Hi' }] }, apiKey);
    expect(response.status).toBe(200); expect(response.headers.get('x-routed-via')).toContain('gemini-cli'); expect(requests.some(r => r.path.includes('/chat/completions'))).toBe(false);
  });
  it('skips accounts with fresh exhausted provider quota', async () => {
    const id = account('codex'); recordQuotaWindows(id, [{ id: 'primary_window', limit: 100, remaining: 0, resetAt: new Date(Date.now() + 60000).toISOString(), unit: '%', blocking: true, source: 'quota_api' }]);
    expect((await chat('codex')).status).toBe(503); expect(requests).toHaveLength(0);
  });
  it('cancels the upstream stream on client disconnect', async () => {
    account('codex'); behavior = 'hold'; const controller = new AbortController();
    const response = await fetchHttp(base + '/thruline/v1/chat/completions', { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'codex/gpt-5.4', messages: [{ role: 'user', content: 'Hi' }], stream: true }) });
    await response.body!.getReader().read(); controller.abort(); await vi.waitFor(() => expect(upstreamClosed).toBe(true));
  });
  it('applies a native inference timeout', async () => {
    const id = account('codex'); behavior = 'hold'; await expect(resolveAccountProvider(accountRow(id))!.chatCompletion('', [{ role: 'user', content: 'Hi' }], 'gpt-5.4', { timeoutMs: 100 })).rejects.toThrow();
  }, 10000);
});

describe('browser imports, headless OAuth and capability honesty', () => {
  it('imports full CLI JSON without losing refresh and keeps status unknown', async () => {
    const response = await call('/api/thruline-accounts/subscriptions/import', { provider: 'codex', label: 'browser', credential: JSON.stringify({ tokens: { access_token: 'access', refresh_token: 'refresh', account_id: 'account' } }) });
    const data = await response.json(); expect(response.status).toBe(200); expect(data.status).toBe('unknown'); expect(JSON.stringify(data)).not.toContain('refresh');
    const row = accountRow(data.id); const stored = parseOAuthCredential(decrypt(row.encrypted_key, row.iv, row.auth_tag)); expect(stored?.refreshToken).toBe('refresh'); expect(stored?.expiresAt).toBeLessThanOrEqual(Date.now()); expect(requests).toHaveLength(0);
  });
  it('rejects mismatched kind, raw subscription keys and custom token destinations', () => {
    expect(normalizeImportedCredential('claude', JSON.stringify(cred('codex')))).toBeNull(); expect(() => createApiKeyAccount({ provider: 'codex', key: 'plain-api-key' })).toThrow('JSON');
    expect(() => createApiKeyAccount({ provider: 'codex', key: JSON.stringify(cred('codex')), baseUrl: 'https://untrusted.invalid' })).toThrow('official');
  });
  it('normalizes Claude, Gemini and Kiro exports including Kiro registration', () => {
    expect(JSON.parse(normalizeImportedCredential('claude', JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600000 } }))!).kind).toBe('claude');
    expect(JSON.parse(normalizeImportedCredential('gemini-cli', JSON.stringify({ access_token: 'a', refresh_token: 'r', expiry_date: Date.now() + 3600000 }))!).kind).toBe('gemini-cli');
    expect(JSON.parse(normalizeImportedCredential('kiro', JSON.stringify({ accessToken: 'a', refreshToken: 'r', clientId: 'id', clientSecret: 'secret' }))!)).toMatchObject({ authMethod: 'builder-id', clientId: 'id', clientSecret: 'secret' });
  });
  it('binds PKCE completion to session/state and saves encrypted rotated tokens without claiming healthy', async () => {
    const start = await call('/api/thruline-accounts/subscriptions/start', { provider: 'codex', label: 'login' }); const a = await start.json(); expect(start.status).toBe(200);
    expect(a.authorizationUrl).toContain('code_challenge='); expect(JSON.stringify(a)).not.toContain('code_verifier');
    expect((await call(`/api/thruline-accounts/subscriptions/${a.attemptId}/complete`, { code: `http://localhost:1455/auth/callback?code=fixture&state=${a.attemptId}` }, otherSession)).status).toBe(404);
    expect((await call(`/api/thruline-accounts/subscriptions/${a.attemptId}/complete`, { code: 'fixture#wrong-state' })).status).toBe(400);
    const response = await call(`/api/thruline-accounts/subscriptions/${a.attemptId}/complete`, { code: `http://localhost:1455/auth/callback?code=fixture&state=${a.attemptId}` }); const data = await response.json(); expect(response.status).toBe(200); expect(data.verified).toBe(false); expect(accountRow(data.id).status).toBe('unknown');
  });
  it('Kiro device flow never returns registration secrets and persists them encrypted', async () => {
    const response = await call('/api/thruline-accounts/subscriptions/start', { provider: 'kiro', label: 'device' }); const data = await response.json(); expect(response.status).toBe(200); expect(data.userCode).toBe('ABCD-1234'); expect(JSON.stringify(data)).not.toMatch(/private|clientSecret|deviceCode/);
    expect((await call(`/api/thruline-accounts/subscriptions/${data.attemptId}/poll`, {})).status).toBe(200); expect(refreshes).toBe(0);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000);
    const poll = await call(`/api/thruline-accounts/subscriptions/${data.attemptId}/poll`, {}); const saved = await poll.json(); expect(saved.status).toBe('saved'); const row = accountRow(saved.id); expect(parseOAuthCredential(decrypt(row.encrypted_key, row.iv, row.auth_tag))?.clientSecret).toBe('private-client-secret');
  });
  it('uses a registered public Google callback and does not infer it from request host', async () => {
    vi.stubEnv('GEMINI_CLIENT_ID', 'configured-client'); vi.stubEnv('GEMINI_CLIENT_SECRET', 'configured-secret'); vi.stubEnv('PUBLIC_APP_URL', 'https://fixture.onrender.com');
    const response = await call('/api/thruline-accounts/subscriptions/start', { provider: 'gemini-cli', label: 'google' }); const body = await response.json(); expect(response.status).toBe(200); expect(new URL(body.authorizationUrl).searchParams.get('redirect_uri')).toBe('https://fixture.onrender.com/thruline/accounts/callback'); expect(JSON.stringify(body)).not.toContain('configured-secret'); vi.unstubAllEnvs();
  });
  it('completes registered Google browser OAuth and resolves project metadata through HTTP', async () => {
    vi.stubEnv('PUBLIC_APP_URL', 'https://fixture.onrender.com');
    const start = await call('/api/thruline-accounts/subscriptions/start', { provider: 'gemini-cli', label: 'google-complete' });
    const a = await start.json();
    const response = await call(`/api/thruline-accounts/subscriptions/${a.attemptId}/complete`, { code: `https://fixture.onrender.com/thruline/accounts/callback?code=fixture&state=${a.attemptId}` });
    const data = await response.json(); expect(response.status).toBe(200); expect(data.verified).toBe(false);
    const row = accountRow(data.id); const stored = parseOAuthCredential(decrypt(row.encrypted_key, row.iv, row.auth_tag));
    expect(stored?.projectId).toBe('google-project'); expect(stored?.email).toBe('google-fixture@test.dev');
  });
  it('permission checks apply to imports and after OAuth has started', async () => {
    const start = await call('/api/thruline-accounts/subscriptions/start', { provider: 'claude', label: 'permissions' }); const a = await start.json();
    getDb().prepare("UPDATE users SET role = 'member', permissions = '[]' WHERE id = ?").run(userId);
    expect((await call('/api/thruline-accounts/subscriptions/import', { provider: 'codex', label: 'denied', credential: JSON.stringify(cred('codex')) })).status).toBe(403);
    expect((await call(`/api/thruline-accounts/subscriptions/${a.attemptId}/complete`, { code: `fixture#${a.attemptId}` })).status).toBe(403); expect(requests).toHaveLength(0);
  });
  it('does not send subscription JSON to unsupported media APIs', async () => {
    account('codex'); const response = await call('/thruline/v1/embeddings', { model: 'codex/gpt-5.4', input: 'Hi' }, apiKey); expect(response.status).not.toBe(200); expect(requests).toHaveLength(0);
  });
  it.each(['codex', 'gemini-cli', 'kiro'] as const)('%s quota uses the native credential and provider protocol', async kind => {
    const id = account(kind); const result = await fetchAccountQuota(accountRow(id)); expect(result).toHaveLength(1); expect(requests.at(-1)?.headers.authorization).toBe('Bearer private-access'); expect(JSON.stringify(requests.at(-1))).not.toContain('private-refresh');
  });
  it('distinguishes unknown quota and model buckets from account exhaustion', () => {
    expect(parseProviderQuota('kiro', {})).toEqual([]); expect(parseProviderQuota('gemini-cli', { buckets: [{ modelId: 'flash', remainingFraction: 0 }] })[0]).toMatchObject({ remaining: 0, blocking: false });
  });
  it('rejects corrupt or truncated AWS EventStream frames', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const valid = frame('assistantResponseEvent', { content: 'Hi' }); expect(decodeKiroFrame(valid).payload.content).toBe('Hi'); valid[valid.length - 5] ^= 1; expect(() => decodeKiroFrame(valid)).toThrow('integrity'); expect(() => decodeKiroFrame(valid.subarray(0, 10))).toThrow('length');
  });
});
