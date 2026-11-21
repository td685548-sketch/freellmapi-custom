import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createSession, createUser } from '../../services/auth.js';
import { decrypt } from '../../lib/crypto.js';
import {
  createApiKeyAccount,
  deleteAccount,
  accountRow,
  updateAccountCredential,
  invalidateXGatewayKeyCache,
} from '../../custom/provider-accounts/store.js';
import { clearOAuthRefreshState, resolveAccountCredential } from '../../custom/provider-accounts/oauth-lifecycle.js';
import { oauthCredentialForAccount } from '../../custom/provider-accounts/oauth-lifecycle.js';
import { serializeOAuthCredential, type OAuthCredential } from '../../custom/provider-accounts/oauth-credentials.js';
import { oauthDescriptor, refreshOAuthCredential } from '../../custom/provider-accounts/oauth-providers.js';
import {
  OPENCODE_DEVICE_CODE_URL,
  OPENCODE_DEVICE_TOKEN_URL,
  _resetOpenCodeConsoleLoginStateForTests,
  buildOpenCodeCredential,
  pollOpenCodeConsoleLogin,
  pollOpenCodeDeviceToken,
  requestOpenCodeDeviceCode,
  startOpenCodeConsoleLogin,
  disconnectOpenCodeConsoleLogin,
  openCodeConsoleLoginStatus,
  cancelOpenCodeConsoleLogin,
} from '../../custom/provider-accounts/opencode-oauth.js';
import { generateOpenCodeSessionId, OPENCODE_SESSION_RE, OpenCodeProvider, _resetOpenCodeStateForTests } from '../../custom/provider-accounts/opencode.js';
import { AccountError } from '../../custom/provider-accounts/http.js';

const mockProxyFetch = vi.hoisted(() => vi.fn());
vi.mock('../../lib/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/proxy.js')>()),
  proxyFetch: mockProxyFetch,
}));

const ACTOR = { userId: 1, sessionToken: 'test-session-token' };
const OTHER_ACTOR = { userId: 2, sessionToken: 'other-session-token' };

const DEVICE_CODE_PAYLOAD = {
  device_code: 'test-device-code',
  user_code: 'USER-CODE',
  verification_uri: 'https://opencode.ai/console/auth/device',
  verification_uri_complete: 'https://opencode.ai/console/auth/device?user_code=USER-CODE',
  expires_in: 600,
  interval: 1,
};

const TOKEN_PAYLOAD = {
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  expires_in: 3600,
  org_id: 'org_test123',
};

function fakeCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    v: 1,
    kind: 'opencode',
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + 3600_000,
    ...overrides,
  };
}

describe('OpenCode Console OAuth device login', () => {
  let testUserId = 0;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'c'.repeat(64);
    initDb(':memory:');
    testUserId = createUser('opencode-oauth-device@example.test', 'AdminPass#1234').userId;
  });

  beforeEach(() => {
    mockProxyFetch.mockReset();
    _resetOpenCodeConsoleLoginStateForTests();
    _resetOpenCodeStateForTests();
    clearOAuthRefreshState();
  });

  it('mints client-shaped session ids (ses_ + 64 lowercase hex)', () => {
    const first = generateOpenCodeSessionId();
    const second = generateOpenCodeSessionId();
    expect(first).toMatch(OPENCODE_SESSION_RE);
    expect(first).toMatch(/^ses_[0-9a-f]{64}$/);
    expect(second).toMatch(OPENCODE_SESSION_RE);
    expect(first).not.toBe(second);
  });

  it('requests a device code with the CLI client id and org scope', async () => {
    mockProxyFetch.mockResolvedValueOnce(Response.json(DEVICE_CODE_PAYLOAD));
    const device = await requestOpenCodeDeviceCode();
    expect(device).toMatchObject({
      deviceCode: 'test-device-code',
      userCode: 'USER-CODE',
      verificationUriComplete: 'https://opencode.ai/console/auth/device?user_code=USER-CODE',
      expiresIn: 600,
      interval: 1,
    });
    expect(mockProxyFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockProxyFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(OPENCODE_DEVICE_CODE_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ client_id: 'opencode-cli', supports_org_scope: true });
  });

  it('polls pending, then persists the login on success', async () => {
    const accountId = createApiKeyAccount({ provider: 'opencode', key: 'no-auth', label: 'Free', userId: testUserId });
    invalidateXGatewayKeyCache();
    mockProxyFetch.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target === OPENCODE_DEVICE_CODE_URL) return Response.json(DEVICE_CODE_PAYLOAD);
      if (target === OPENCODE_DEVICE_TOKEN_URL) {
        const call = mockProxyFetch.mock.calls.filter(([u]) => String(u) === OPENCODE_DEVICE_TOKEN_URL).length;
        if (call === 1) return Response.json({ error: 'authorization_pending' });
        return Response.json(TOKEN_PAYLOAD);
      }
      throw new Error(`unexpected fetch ${target}`);
    });

    const start = await startOpenCodeConsoleLogin(accountId, ACTOR);
    expect(start).toMatchObject({
      flow: 'device_code',
      verificationUriComplete: DEVICE_CODE_PAYLOAD.verification_uri_complete,
      userCode: 'USER-CODE',
      interval: 1,
    });
    expect(start.attemptId).toMatch(/^[0-9a-f]{64}$/);
    expect(openCodeConsoleLoginStatus(accountId)).toMatchObject({ connected: false });

    // A different user cannot see or poll the attempt.
    await expect(pollOpenCodeConsoleLogin(start.attemptId, OTHER_ACTOR)).rejects.toBeInstanceOf(AccountError);

    const first = await pollOpenCodeConsoleLogin(start.attemptId, ACTOR);
    expect(first).toEqual({ status: 'pending', interval: 1 });
    // The second poll is throttled until the interval passes.
    expect(await pollOpenCodeConsoleLogin(start.attemptId, ACTOR)).toEqual({ status: 'pending', interval: 1 });

    await new Promise(resolve => setTimeout(resolve, 1100));
    const second = await pollOpenCodeConsoleLogin(start.attemptId, ACTOR);
    expect(second).toEqual({ status: 'connected', accountId });

    const row = accountRow(accountId);
    expect(row.auth_method).toBe('device_code');
    expect(row.subject).toBe('org_test123');
    const stored = oauthCredentialForAccount(row);
    expect(stored).toMatchObject({ kind: 'opencode', accessToken: 'test-access-token', refreshToken: 'test-refresh-token', orgId: 'org_test123' });
    expect(openCodeConsoleLoginStatus(accountId)).toMatchObject({ connected: true, identity: 'org_test123' });

    // Disconnect restores the keyless credential.
    expect(disconnectOpenCodeConsoleLogin(accountId)).toEqual({ connected: false });
    const cleared = accountRow(accountId);
    expect(cleared.auth_method).toBe('api_key');
    expect(cleared.subject).toBeNull();
    expect(decrypt(cleared.encrypted_key, cleared.iv, cleared.auth_tag)).toBe('no-auth');
    expect(openCodeConsoleLoginStatus(accountId)).toMatchObject({ connected: false });
    deleteAccount(accountId);
  });

  it('reports an expired device code instead of hanging', async () => {
    const accountId = createApiKeyAccount({ provider: 'opencode', key: 'no-auth', label: 'Free', userId: testUserId });
    invalidateXGatewayKeyCache();
    mockProxyFetch.mockImplementation(async (url: unknown) => {
      if (String(url) === OPENCODE_DEVICE_CODE_URL) return Response.json(DEVICE_CODE_PAYLOAD);
      return Response.json({ error: 'expired_token' });
    });
    const start = await startOpenCodeConsoleLogin(accountId, ACTOR);
    expect(await pollOpenCodeConsoleLogin(start.attemptId, ACTOR)).toEqual({ status: 'expired' });
    // The attempt is gone after a terminal poll.
    await expect(pollOpenCodeConsoleLogin(start.attemptId, ACTOR)).rejects.toMatchObject({ status: 404 });
    deleteAccount(accountId);
  });

  it('rejects a denied authorization with a 400, not a silent expiry', async () => {
    const accountId = createApiKeyAccount({ provider: 'opencode', key: 'no-auth', label: 'Free', userId: testUserId });
    invalidateXGatewayKeyCache();
    mockProxyFetch.mockImplementation(async (url: unknown) => {
      if (String(url) === OPENCODE_DEVICE_CODE_URL) return Response.json(DEVICE_CODE_PAYLOAD);
      return Response.json({ error: 'access_denied' });
    });
    const start = await startOpenCodeConsoleLogin(accountId, ACTOR);
    await expect(pollOpenCodeConsoleLogin(start.attemptId, ACTOR)).rejects.toMatchObject({
      status: 400,
      message: 'OpenCode Console authorization was denied.',
    });
    deleteAccount(accountId);
  });

  it('reports not logged in for accounts holding a plain key or a pasted CLI auth blob', () => {
    // Regression: the Console login dialog opens by reading this status. An
    // OpenCode Free account created before Console login existed stores a
    // plain personal key — or a pasted CLI auth.json blob — not an OAuth
    // credential. Status must answer { connected: false } for those instead
    // of failing, so the dialog can offer the device flow.
    const keyAccountId = createApiKeyAccount({ provider: 'opencode', key: 'opencode_sk_live_4f2a9c1e7b3d5a6f8e0c2b4a6d8f0a2c4e6', label: 'Luu Manh OpenCode', userId: testUserId });
    const blobAccountId = createApiKeyAccount({
      provider: 'opencode',
      key: JSON.stringify({ opencode: { type: 'oauth', access: 'ya29.fake-access-token', refresh: '1//fake-refresh-token', expires: Date.now() + 3600_000 } }),
      label: 'CLI auth.json',
      userId: testUserId,
    });
    invalidateXGatewayKeyCache();
    expect(openCodeConsoleLoginStatus(keyAccountId)).toMatchObject({ connected: false });
    expect(openCodeConsoleLoginStatus(blobAccountId)).toMatchObject({ connected: false });
    deleteAccount(keyAccountId);
    deleteAccount(blobAccountId);
  });

  it('refuses Console login for non-OpenCode accounts', async () => {
    const accountId = createApiKeyAccount({ provider: 'opencode-zen', key: 'test-key', label: 'Zen', userId: testUserId });
    invalidateXGatewayKeyCache();
    await expect(startOpenCodeConsoleLogin(accountId, ACTOR)).rejects.toMatchObject({
      status: 400,
      message: 'Only OpenCode Free accounts support Console login.',
    });
    expect(() => openCodeConsoleLoginStatus(accountId)).toThrow('Only OpenCode Free accounts support Console login.');
    deleteAccount(accountId);
  });

  it('cancels a pending attempt', async () => {
    const accountId = createApiKeyAccount({ provider: 'opencode', key: 'no-auth', label: 'Free', userId: testUserId });
    invalidateXGatewayKeyCache();
    mockProxyFetch.mockResolvedValueOnce(Response.json(DEVICE_CODE_PAYLOAD));
    const start = await startOpenCodeConsoleLogin(accountId, ACTOR);
    cancelOpenCodeConsoleLogin(start.attemptId, ACTOR);
    await expect(pollOpenCodeConsoleLogin(start.attemptId, ACTOR)).rejects.toMatchObject({ status: 404 });
    deleteAccount(accountId);
  });

  it('builds the stored credential from a device-token response', () => {
    const credential = buildOpenCodeCredential(
      { accessToken: 'test-access-token', refreshToken: 'test-refresh-token', expiresIn: 3600, orgId: 'org_test123' },
      1_000_000,
    );
    expect(credential).toMatchObject({
      v: 1, kind: 'opencode', accessToken: 'test-access-token', refreshToken: 'test-refresh-token',
      expiresAt: 1_000_000 + 3600_000, orgId: 'org_test123', subject: 'org_test123',
    });
  });

  it('maps the token poll result, including slow_down', async () => {
    mockProxyFetch.mockResolvedValueOnce(Response.json({ error: 'slow_down' }));
    expect(await pollOpenCodeDeviceToken('test-device-code')).toEqual({ error: 'slow_down' });
    mockProxyFetch.mockResolvedValueOnce(Response.json(TOKEN_PAYLOAD));
    expect(await pollOpenCodeDeviceToken('test-device-code')).toEqual({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresIn: 3600,
      orgId: 'org_test123',
    });
  });
});

describe('OpenCode Console token refresh', () => {
  let testUserId = 0;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'c'.repeat(64);
    initDb(':memory:');
    testUserId = createUser('opencode-oauth-refresh@example.test', 'AdminPass#1234').userId;
  });

  beforeEach(() => {
    mockProxyFetch.mockReset();
    _resetOpenCodeConsoleLoginStateForTests();
    _resetOpenCodeStateForTests();
    clearOAuthRefreshState();
  });

  it('refreshes an expired login through the shared lifecycle and persists it', async () => {
    const accountId = createApiKeyAccount({ provider: 'opencode', key: 'no-auth', label: 'Free', userId: testUserId });
    invalidateXGatewayKeyCache();
    updateAccountCredential(accountId, fakeCredential({ expiresAt: Date.now() - 1000 }));
    mockProxyFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(OPENCODE_DEVICE_TOKEN_URL);
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'test-refresh-token', client_id: 'opencode-cli' });
      return Response.json({ access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 3600 });
    });
    const resolved = await resolveAccountCredential(accountRow(accountId));
    const credential = JSON.parse(resolved) as OAuthCredential;
    expect(credential).toMatchObject({ kind: 'opencode', accessToken: 'new-access-token', refreshToken: 'new-refresh-token' });
    expect(credential.expiresAt).toBeGreaterThan(Date.now());
    // The rotated credential is persisted, not just held in memory.
    const stored = oauthCredentialForAccount(accountRow(accountId));
    expect(stored?.accessToken).toBe('new-access-token');
    deleteAccount(accountId);
  });

  it('treats invalid_grant as signed out and does not retry', async () => {
    const accountId = createApiKeyAccount({ provider: 'opencode', key: 'no-auth', label: 'Free', userId: testUserId });
    invalidateXGatewayKeyCache();
    updateAccountCredential(accountId, fakeCredential({ expiresAt: Date.now() - 1000 }));
    mockProxyFetch.mockResolvedValue(Response.json({ error: 'invalid_grant' }, { status: 400 }));
    await expect(resolveAccountCredential(accountRow(accountId))).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('Reconnect this account'),
    });
    expect(accountRow(accountId).status).toBe('error');
    const callsAfterFirst = mockProxyFetch.mock.calls.length;
    await expect(resolveAccountCredential(accountRow(accountId))).rejects.toMatchObject({ status: 401 });
    expect(mockProxyFetch.mock.calls.length).toBe(callsAfterFirst);
    deleteAccount(accountId);
  });

  it('refreshes directly through the opencode descriptor', async () => {
    const descriptor = oauthDescriptor('opencode');
    expect(descriptor).toMatchObject({ kind: 'opencode', clientId: 'opencode-cli', refreshEncoding: 'json' });
    mockProxyFetch.mockResolvedValueOnce(Response.json({ access_token: 'direct-new-access', refresh_token: 'direct-new-refresh', expires_in: 1800 }));
    const next = await refreshOAuthCredential(descriptor!, fakeCredential({ expiresAt: Date.now() - 1000 }));
    expect(next).toMatchObject({ accessToken: 'direct-new-access', refreshToken: 'direct-new-refresh' });
    expect(next.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('OpenCode free lane sends the Console token when logged in', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'c'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    mockProxyFetch.mockReset();
    _resetOpenCodeConsoleLoginStateForTests();
    _resetOpenCodeStateForTests();
    clearOAuthRefreshState();
  });

  function sseResponse(): Response {
    const chunk = {
      id: 'test', object: 'chat.completion.chunk', created: 1, model: 'some-model',
      choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  async function runStream(apiKey: string): Promise<{ headers: Record<string, string>; text: string }> {
    mockProxyFetch.mockResolvedValue(sseResponse());
    const provider = new OpenCodeProvider({ providerId: 'opencode' });
    const chunks: Array<{ choices?: Array<{ delta?: { content?: string } }> }> = [];
    for await (const chunk of provider.streamChatCompletion(apiKey, [{ role: 'user', content: 'hi' }], 'some-model')) {
      chunks.push(chunk);
    }
    const [, init] = mockProxyFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    return { headers, text: chunks.map(c => c.choices?.[0]?.delta?.content ?? '').join('') };
  }

  it('sends Bearer <access_token> and x-org-id for a logged-in account', async () => {
    const { headers, text } = await runStream(serializeOAuthCredential(fakeCredential({ orgId: 'org_test123' })));
    expect(headers.Authorization).toBe('Bearer test-access-token');
    expect(headers['x-org-id']).toBe('org_test123');
    expect(headers['User-Agent']).toBe('opencode/latest/2.0.26/cli');
    expect(headers['x-opencode-session-id']).toMatch(/^ses_[0-9a-f]{64}$/);
    expect(text).toBe('hello');
  });

  it('keeps Bearer public when the account is not logged in', async () => {
    const { headers, text } = await runStream('no-auth');
    expect(headers.Authorization).toBe('Bearer public');
    expect(headers['x-org-id']).toBeUndefined();
    expect(text).toBe('hello');
  });

  it('falls back to Bearer public when the stored token is already expired', async () => {
    const { headers } = await runStream(serializeOAuthCredential(fakeCredential({ expiresAt: Date.now() - 1000 })));
    expect(headers.Authorization).toBe('Bearer public');
  });
});

describe('OpenCode Console OAuth routes', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'c'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    mockProxyFetch.mockReset();
    _resetOpenCodeConsoleLoginStateForTests();
    _resetOpenCodeStateForTests();
    clearOAuthRefreshState();
  });

  afterAll(() => {
    mockProxyFetch.mockReset();
  });

  it('starts, polls and cancels a login through the HTTP routes', async () => {
    const user = createUser('opencode-oauth@example.test', 'AdminPass#1234');
    const session = createSession(user.userId);
    const accountId = createApiKeyAccount({ provider: 'opencode', key: 'no-auth', label: 'Free', userId: user.userId });
    invalidateXGatewayKeyCache();
    mockProxyFetch.mockImplementation(async (url: unknown) => {
      if (String(url) === OPENCODE_DEVICE_CODE_URL) return Response.json(DEVICE_CODE_PAYLOAD);
      return Response.json({ error: 'authorization_pending' });
    });
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const realFetch = globalThis.fetch.bind(globalThis);
    try {
      const call = (path: string, method: string) => realFetch(`http://127.0.0.1:${port}${path}`, {
        method, headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
      });
      const startRes = await call(`/api/thruline-accounts/opencode-oauth/${accountId}/start`, 'POST');
      expect(startRes.status).toBe(201);
      const start = await startRes.json() as { attemptId: string; userCode: string; verificationUriComplete: string };
      expect(start.userCode).toBe('USER-CODE');
      expect(start.verificationUriComplete).toContain('opencode.ai/console');

      const statusRes = await call(`/api/thruline-accounts/opencode-oauth/${accountId}/status`, 'GET');
      expect(statusRes.status).toBe(200);
      expect(await statusRes.json()).toMatchObject({ connected: false });

      const pollRes = await call(`/api/thruline-accounts/opencode-oauth/${start.attemptId}/poll`, 'POST');
      expect(pollRes.status).toBe(200);
      expect(await pollRes.json()).toEqual({ status: 'pending', interval: 1 });

      const cancelRes = await call(`/api/thruline-accounts/opencode-oauth/${start.attemptId}`, 'DELETE');
      expect(cancelRes.status).toBe(204);

      const goneRes = await call(`/api/thruline-accounts/opencode-oauth/${start.attemptId}/poll`, 'POST');
      expect(goneRes.status).toBe(404);

      const badRes = await call('/api/thruline-accounts/opencode-oauth/999999/status', 'GET');
      expect(badRes.status).toBe(404);

      // An account holding a plain personal key (created before Console
      // login existed) answers { connected: false } instead of failing.
      const plainId = createApiKeyAccount({ provider: 'opencode', key: 'opencode_sk_live_4f2a9c1e7b3d5a6f8e0c2b4a6d8f0a2c4e6', label: 'Plain key', userId: user.userId });
      invalidateXGatewayKeyCache();
      const plainRes = await call(`/api/thruline-accounts/opencode-oauth/${plainId}/status`, 'GET');
      expect(plainRes.status).toBe(200);
      expect(await plainRes.json()).toMatchObject({ connected: false });
      deleteAccount(plainId);
    } finally {
      deleteAccount(accountId);
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('rejects unauthenticated route calls', async () => {
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/thruline-accounts/opencode-oauth/1/status`);
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
