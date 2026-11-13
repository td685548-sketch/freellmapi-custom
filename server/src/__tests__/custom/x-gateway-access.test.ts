import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'http';
import { initDb, getDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { mintUserApiKey, revokeUserApiKey } from '../../services/user-keys.js';
import { mintXGatewayClientKey, revokeXGatewayClientKey } from '../../custom/x-gateway/client-keys.js';
import { setEnabled, setOutboundProxyUrl } from '../../custom/x-gateway/config.js';
import { createApiKeyAccount, accountRow, resolveXGatewayAccountProxy } from '../../custom/provider-accounts/store.js';
import { resolveXGatewayProvider } from '../../custom/provider-accounts/catalog.js';
import { AnthropicWireProvider, WebCookieProvider, buildWebSessionHeaders, extractWebResponseText } from '../../custom/provider-accounts/web-cookie.js';
import { encrypt } from '../../lib/crypto.js';

describe('X Gateway Access Control (US1 / Phase 3)', () => {
  let server: Server;
  let base: string;
  let adminUserId: number;
  let adminSessionToken: string;
  let adminKey: string;
  let memberKey: string;
  let delegatedKey: string;
  let delegatedUserId: number;
  let revokedKey: string;
  const realFetch = global.fetch;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    // Seed a dedicated X Gateway provider key so chat completions can succeed
    const key = encrypt('gsk_access_test');
    getDb()
      .prepare(
        `INSERT INTO x_gateway_keys (provider, label, auth_method, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq', 'test-key', 'api_key', ?, ?, ?, 'healthy', 1)`
      )
      .run(key.encrypted, key.iv, key.authTag);

    // 1. Primary admin (first user)
    const admin = createUser('admin@example.com', 'AdminPass123!');
    adminUserId = admin.userId;
    adminSessionToken = createSession(admin.userId);
    const adminKeyObj = mintUserApiKey(admin.userId, 'Admin Key');
    adminKey = adminKeyObj.key;

    // 2. Member without gateway permission
    const member = createUser('member@example.com', 'MemberPass123!', 'member');
    memberKey = mintUserApiKey(member.userId, 'Member Key').key;

    // 3. Member with delegated use_x_gateway permission
    const delegated = createUser('delegated@example.com', 'DelegatedPass123!', 'member');
    delegatedUserId = delegated.userId;
    getDb().prepare("UPDATE users SET permissions = '[\"use_x_gateway\"]' WHERE id = ?").run(delegatedUserId);
    delegatedKey = mintUserApiKey(delegatedUserId, 'Delegated Key').key;

    // 4. Revoked key
    const revokedKeyObj = mintUserApiKey(admin.userId, 'Revoked Key');
    revokedKey = revokedKeyObj.key;
    revokeUserApiKey(admin.userId, revokedKeyObj.id);

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    // Mock upstream fetch for successful chat completions
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(`http://127.0.0.1:${port}`)) return realFetch(url, init);
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: Date.now(),
          model: 'llama-3.3-70b',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hello from mock provider!' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
  });

  async function requestX(
    path: string,
    opts: { method?: string; body?: unknown; key?: string } = {}
  ) {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.key) headers['Authorization'] = `Bearer ${opts.key}`;

    const res = await realFetch(`${base}${path}`, {
      method: opts.method ?? 'POST',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  }

  const validChatPayload = {
    model: 'auto',
    messages: [{ role: 'user', content: 'hello' }],
  };

  it('answers 404 when gateway is switched off (leaks nothing)', async () => {
    setEnabled(false);

    // With no key
    const anon = await requestX('/thruline/v1/chat/completions', { body: validChatPayload });
    expect(anon.status).toBe(404);
    expect(anon.body).toEqual({ error: { message: 'Not found', type: 'not_found' } });

    // With admin key
    const asAdmin = await requestX('/thruline/v1/chat/completions', { key: adminKey, body: validChatPayload });
    expect(asAdmin.status).toBe(404);
    expect(asAdmin.body).toEqual({ error: { message: 'Not found', type: 'not_found' } });

    // With invalid key
    const asInvalid = await requestX('/thruline/v1/chat/completions', { key: 'invalid-key', body: validChatPayload });
    expect(asInvalid.status).toBe(404);
    expect(asInvalid.body).toEqual({ error: { message: 'Not found', type: 'not_found' } });

    // With revoked key
    const asRevoked = await requestX('/thruline/v1/chat/completions', { key: revokedKey, body: validChatPayload });
    expect(asRevoked.status).toBe(404);
    expect(asRevoked.body).toEqual({ error: { message: 'Not found', type: 'not_found' } });

    // Models endpoint when off
    const models = await requestX('/thruline/v1/models', { method: 'GET', key: adminKey });
    expect(models.status).toBe(404);
    expect(models.body).toEqual({ error: { message: 'Not found', type: 'not_found' } });
  });

  describe('When gateway is enabled', () => {
    beforeAll(() => {
      setEnabled(true);
    });

    it('rejects anonymous caller with 401 authentication_error', async () => {
      const res = await requestX('/thruline/v1/chat/completions', { body: validChatPayload });
      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe('authentication_error');
    });

    it('rejects unknown key with 401 authentication_error', async () => {
      const res = await requestX('/thruline/v1/chat/completions', { key: 'sk-flm-unknownkey999', body: validChatPayload });
      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe('authentication_error');
    });

    it('rejects non-personal key with 401 authentication_error', async () => {
      const res = await requestX('/thruline/v1/chat/completions', { key: 'invalid-bearer-token', body: validChatPayload });
      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe('authentication_error');
    });

    it('rejects revoked key with 401 authentication_error', async () => {
      const res = await requestX('/thruline/v1/chat/completions', { key: revokedKey, body: validChatPayload });
      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe('authentication_error');
    });

    it('rejects member without use_x_gateway with 403 permission_error', async () => {
      const res = await requestX('/thruline/v1/chat/completions', { key: memberKey, body: validChatPayload });
      expect(res.status).toBe(403);
      expect(res.body.error.type).toBe('permission_error');
      expect(res.body.error.message).toMatch(/use_x_gateway/);
    });

    it('allows primary administrator with 200 and sets X-Gateway header', async () => {
      const res = await requestX('/thruline/v1/chat/completions', { key: adminKey, body: validChatPayload });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-gateway')).toBe('x');
      expect(res.headers.get('x-output-saver-applied')).toBe('');
      expect(res.headers.get('x-input-tokens-saved')).toBe('0');
      expect(res.body.choices[0].message.content).toBe('Hello from mock provider!');
    });

    it('allows delegated holder of use_x_gateway with 200', async () => {
      const res = await requestX('/thruline/v1/chat/completions', { key: delegatedKey, body: validChatPayload });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-gateway')).toBe('x');
      expect(res.body.choices[0].message.content).toBe('Hello from mock provider!');
    });

    it('refuses account with 403 on the next call if permission is revoked (no caching)', async () => {
      // First call succeeds
      const first = await requestX('/thruline/v1/chat/completions', { key: delegatedKey, body: validChatPayload });
      expect(first.status).toBe(200);

      // Demote the account by removing permission
      getDb().prepare("UPDATE users SET permissions = '[]' WHERE id = ?").run(delegatedUserId);

      // Next call must immediately fail with 403 without restarting server
      const next = await requestX('/thruline/v1/chat/completions', { key: delegatedKey, body: validChatPayload });
      expect(next.status).toBe(403);
      expect(next.body.error.type).toBe('permission_error');

      // Re-grant for subsequent tests if needed
      getDb().prepare("UPDATE users SET permissions = '[\"use_x_gateway\"]' WHERE id = ?").run(delegatedUserId);
    });

    it('allows primary administrator on GET /thruline/v1/models', async () => {
      const res = await requestX('/thruline/v1/models', { method: 'GET', key: adminKey });
      expect(res.status).toBe(200);
      expect(res.body.object).toBe('list');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('returns JSON 404 (never HTML) for unmatched paths under /thruline/v1', async () => {
      const res = await requestX('/thruline/v1/nonexistent-endpoint', { method: 'GET', key: adminKey });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { message: 'Not found', type: 'not_found' } });
    });

    it('supports dedicated X Gateway API keys (sk-xgw-...) on /thruline/v1 while rejecting them on /v1', async () => {
      // Mint via console endpoint
      const createRes = await requestX('/api/thruline/keys', {
        method: 'POST',
        key: adminSessionToken,
        body: { name: 'Cursor X Key' },
      });
      expect(createRes.status).toBe(201);
      expect(createRes.body.key).toMatch(/^sk-xgw-/);
      const xKey = createRes.body.key as string;
      const xKeyId = createRes.body.id as number;

      // List keys via console endpoint
      const listRes = await requestX('/api/thruline/keys', {
        method: 'GET',
        key: adminSessionToken,
      });
      expect(listRes.status).toBe(200);
      expect(listRes.body.keys.some((k: { id: number; name: string }) => k.id === xKeyId && k.name === 'Cursor X Key')).toBe(true);

      // Works on /thruline/v1/chat/completions and attributes usage to user
      const chatRes = await requestX('/thruline/v1/chat/completions', {
        key: xKey,
        body: validChatPayload,
      });
      expect(chatRes.status).toBe(200);
      expect(chatRes.headers.get('x-gateway')).toBe('x');

      // Rejected on main /v1/models endpoint
      const mainRes = await requestX('/v1/models', {
        method: 'GET',
        key: xKey,
      });
      expect(mainRes.status).toBe(401);
      expect(mainRes.body.error.message).toMatch(/scoped exclusively to \/thruline\/v1/);

      // Revoking key immediately blocks subsequent /thruline/v1 calls
      const delRes = await requestX(`/api/thruline/keys/${xKeyId}`, {
        method: 'DELETE',
        key: adminSessionToken,
      });
      expect(delRes.status).toBe(200);

      const afterRevoke = await requestX('/thruline/v1/chat/completions', {
        key: xKey,
        body: validChatPayload,
      });
      expect(afterRevoke.status).toBe(401);

      // Also verify direct service helpers
      const directKey = mintXGatewayClientKey(adminUserId, 'Direct X Key');
      expect(directKey.key).toMatch(/^sk-xgw-/);
      expect(revokeXGatewayClientKey(adminUserId, directKey.id)).toBe(true);
    });

    it('supports gateway-wide and per-account outbound proxy configuration for X Gateway', async () => {
      // Configure gateway-wide outbound proxy via console endpoint
      const saveProxyRes = await requestX('/api/thruline/proxy', {
        method: 'PUT',
        key: adminSessionToken,
        body: { proxyUrl: 'socks5://proxyuser:proxypass@198.51.100.10:1080' },
      });
      expect(saveProxyRes.status).toBe(200);
      expect(saveProxyRes.body).toEqual({
        proxyUrl: 'socks5://proxyuser:***@198.51.100.10:1080',
        configured: true,
      });

      const proxyGetRes = await requestX('/api/thruline/proxy', {
        method: 'GET',
        key: adminSessionToken,
      });
      expect(proxyGetRes.status).toBe(200);
      expect(proxyGetRes.body).toEqual({
        proxyUrl: 'socks5://proxyuser:***@198.51.100.10:1080',
        configured: true,
      });

      // Account without per-account proxy inherits X Gateway outbound proxy
      const inheritedId = createApiKeyAccount({
        provider: 'groq',
        key: 'gsk_inherited_proxy',
        label: 'Inherited Proxy Account',
      });
      expect(resolveXGatewayAccountProxy(accountRow(inheritedId))).toBe(
        'socks5://proxyuser:proxypass@198.51.100.10:1080',
      );

      // Account with per-account proxy overrides X Gateway outbound proxy
      const overrideId = createApiKeyAccount({
        provider: 'groq',
        key: 'gsk_override_proxy',
        label: 'Override Proxy Account',
        proxyUrl: 'http://acctuser:acctpass@203.0.113.5:8080',
      });
      expect(resolveXGatewayAccountProxy(accountRow(overrideId))).toBe(
        'http://acctuser:acctpass@203.0.113.5:8080',
      );

      // Clear gateway-wide proxy so mock fetch in other tests is unaffected
      setOutboundProxyUrl('');
      expect(resolveXGatewayAccountProxy(accountRow(inheritedId))).toBeUndefined();
    });

    it('supports Anthropic Messages API (/thruline/v1/messages, /thruline/v1/messages/count_tokens, and anthropic-version /thruline/v1/models)', async () => {
      // 1. Anthropic /thruline/v1/messages
      const msgRes = await requestX('/thruline/v1/messages', {
        key: adminKey,
        body: {
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 512,
          system: 'You are a helpful coding assistant.',
          messages: [{ role: 'user', content: 'Write a hello world' }],
        },
      });
      expect(msgRes.status).toBe(200);
      expect(msgRes.headers.get('x-gateway')).toBe('x');
      expect(msgRes.body.type).toBe('message');
      expect(msgRes.body.role).toBe('assistant');
      expect(msgRes.body.content[0]).toEqual({
        type: 'text',
        text: 'Hello from mock provider!',
      });

      // 2. Anthropic /thruline/v1/messages/count_tokens
      const countRes = await requestX('/thruline/v1/messages/count_tokens', {
        key: adminKey,
        body: {
          model: 'claude-sonnet-4-5-20250929',
          messages: [{ role: 'user', content: 'Count these tokens please' }],
        },
      });
      expect(countRes.status).toBe(200);
      expect(typeof countRes.body.input_tokens).toBe('number');
      expect(countRes.body.input_tokens).toBeGreaterThan(0);

      // 3. Anthropic GET /thruline/v1/models with anthropic-version header
      const modelsRes = await realFetch(`${base}/thruline/v1/models`, {
        method: 'GET',
        headers: {
          'x-api-key': adminKey,
          'anthropic-version': '2023-06-01',
        },
      });
      expect(modelsRes.status).toBe(200);
      const modelsBody = await modelsRes.json();
      expect(modelsBody.has_more).toBe(false);
      expect(modelsBody.data.some((m: { id: string; type: string }) => m.id === 'claude-sonnet-4-5-20250929' && m.type === 'model')).toBe(true);
    });

    it('supports OpenAI Responses API (/thruline/v1/responses) and Legacy Completions (/thruline/v1/completions)', async () => {
      // 1. OpenAI Responses API for Codex CLI
      const respRes = await requestX('/thruline/v1/responses', {
        key: adminKey,
        body: {
          model: 'auto',
          instructions: 'Reply concisely.',
          input: 'Hello Codex!',
        },
      });
      expect(respRes.status).toBe(200);
      expect(respRes.headers.get('x-gateway')).toBe('x');
      expect(respRes.body.object).toBe('response');
      expect(respRes.body.status).toBe('completed');
      expect(respRes.body.output_text).toBe('Hello from mock provider!');

      // 2. Legacy Completions API for Continue.dev autocomplete
      const cmplRes = await requestX('/thruline/v1/completions', {
        key: adminKey,
        body: {
          model: 'auto',
          prompt: 'function add(a, b) {',
          suffix: '}',
          max_tokens: 64,
        },
      });
      expect(cmplRes.status).toBe(200);
      expect(cmplRes.body.object).toBe('text_completion');
      expect(cmplRes.body.choices[0].text).toBe('Hello from mock provider!');
    });

    it('resolves WebCookieProvider for webCookie providers and AnthropicWireProvider for Anthropic-wire providers', () => {
      const grokWeb = resolveXGatewayProvider('grok-web');
      expect(grokWeb).toBeInstanceOf(WebCookieProvider);

      const chatgptWeb = resolveXGatewayProvider('chatgpt-web');
      expect(chatgptWeb).toBeInstanceOf(WebCookieProvider);

      const claudeProvider = resolveXGatewayProvider('claude');
      expect(claudeProvider).toBeInstanceOf(AnthropicWireProvider);

      const glmProvider = resolveXGatewayProvider('glm');
      expect(glmProvider).toBeInstanceOf(AnthropicWireProvider);

      // Verify cookie header normalization and web response extraction
      const grokHeaders = buildWebSessionHeaders('grok-web', 'my_raw_sso_token');
      expect(grokHeaders['Cookie']).toBe('sso=my_raw_sso_token');

      const fullCookieHeaders = buildWebSessionHeaders('grok-web', 'sso=abc; sso-rw=def');
      expect(fullCookieHeaders['Cookie']).toBe('sso=abc; sso-rw=def');

      expect(
        extractWebResponseText({ result: { response: { token: 'Grok token ' } } }),
      ).toBe('Grok token ');
      expect(
        extractWebResponseText({ message: { content: { parts: ['ChatGPT part'] } } }),
      ).toBe('ChatGPT part');
    });
  });
});
