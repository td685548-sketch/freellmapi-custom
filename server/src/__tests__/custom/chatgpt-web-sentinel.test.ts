// ChatGPT Web Sentinel token rotation.
//
// Regression tests for the 401 `token_expired` failure at
// /backend-api/sentinel/chat-requirements/prepare: the session endpoint can
// hand back an access token that is already expired, and the old code threw
// immediately instead of re-exchanging the cookie for a fresh token.
// `proxyFetch` is mocked at the module boundary (no network, no DNS pinning).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockProxyFetch = vi.hoisted(() => vi.fn());

vi.mock('../../lib/proxy.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  proxyFetch: mockProxyFetch,
}));

import {
  clearChatGptWebCaches,
  fetchSentinelHeaders,
  fetchUsableChatGptWebAccessToken,
  mergeChatGptWebResponseCookies,
} from '../../custom/provider-accounts/chatgpt-web-image.js';
import { runChatGptWebChat } from '../../custom/provider-accounts/chatgpt-web-chat.js';
import {
  resetChatGptWebKeepAliveForTests,
  rotateChatGptWebAccountsOnce,
} from '../../custom/provider-accounts/chatgpt-web-keepalive.js';
import {
  getAccountCooldown,
  setAccountCooldown,
  stopAutoPingWorker,
} from '../../custom/provider-accounts/auto-ping.js';
import {
  accountRow,
  createApiKeyAccount,
  setAccountStatus,
} from '../../custom/provider-accounts/store.js';
import { WebCookieProvider } from '../../custom/provider-accounts/web-cookie.js';
import { getDb, initDb } from '../../db/index.js';
import { decrypt } from '../../lib/crypto.js';

const BASE_URL = 'https://chatgpt.com';
const USER_AGENT = 'test-agent';
const COOKIE = '__Secure-next-auth.session-token=abc';
const TOKEN_EXPIRED_BODY = JSON.stringify({
  error: {
    message: 'Provided authentication token is expired. Please try signing in again.',
    type: 'invalid_request_error',
    code: 'token_expired',
  },
});

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const makeJwt = (expiresInSeconds: number): string =>
  `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds })}.signature`;

type MockResponseSpec = { status: number; body: unknown; setCookies?: string[] } | 'html403';
type MockSessionSpec = string | { accessToken: string; setCookies?: string[] };

function makeHeaders(setCookies?: string[], extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  for (const cookie of setCookies ?? []) {
    headers.append('set-cookie', cookie);
  }
  return headers;
}

function jsonResponse(status: number, body: unknown, setCookies?: string[]): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = makeHeaders(setCookies);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response;
}

function htmlResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: makeHeaders(undefined, { 'content-type': 'text/html' }),
    text: async () => '<!doctype html><html><body>challenge</body></html>',
    json: async () => {
      throw new Error('not json');
    },
  } as unknown as Response;
}

function sseResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    headers: makeHeaders(undefined, { 'content-type': 'text/event-stream' }),
    text: async () => text,
    json: async () => ({}),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
  } as unknown as Response;
}

describe('ChatGPT Web Sentinel token rotation', () => {
  let calls: string[];
  let callLog: Array<{ url: string; headers: Record<string, string> }>;
  let sessionTokens: MockSessionSpec[];
  let prepareResponses: MockResponseSpec[];

  function setupMock(): void {
    calls = [];
    callLog = [];
    sessionTokens = [];
    prepareResponses = [];
    mockProxyFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      callLog.push({
        url: u,
        headers: ((init?.headers as Record<string, string> | undefined) ?? {}),
      });
      if (u.includes('/api/auth/session')) {
        const next = sessionTokens.shift();
        if (typeof next === 'object' && next !== null) {
          return jsonResponse(200, { accessToken: next.accessToken }, next.setCookies);
        }
        return jsonResponse(200, { accessToken: next ?? makeJwt(3600) });
      }
      if (u.endsWith('/backend-api/sentinel/chat-requirements/prepare')) {
        const next = prepareResponses.shift();
        if (next === 'html403') return htmlResponse(403);
        if (next) return jsonResponse(next.status, next.body, next.setCookies);
        return jsonResponse(200, { prepare_token: 'prepare-token' });
      }
      if (u.endsWith('/backend-api/sentinel/chat-requirements')) {
        return jsonResponse(200, { token: 'requirements-token' });
      }
      if (u.endsWith('/backend-api/f/conversation/prepare')) {
        return jsonResponse(200, { conduit_token: '' });
      }
      if (u.endsWith('/backend-api/f/conversation')) {
        return sseResponse('data: {"conversation_id":"11111111-2222-3333-4444-555555555555"}\n\n');
      }
      if (u.includes('/backend-api/conversation/')) {
        return jsonResponse(200, {
          mapping: {
            node1: {
              message: {
                author: { role: 'assistant' },
                metadata: { is_complete: true },
                content: { content_type: 'text', parts: ['Hello from ChatGPT'] },
              },
            },
          },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
  }

  const count = (suffix: string): number => calls.filter((u) => u.endsWith(suffix)).length;
  const sessionCalls = (): number => count('/api/auth/session');
  const prepareCalls = (): number => count('/backend-api/sentinel/chat-requirements/prepare');
  const requirementsCalls = (): number => count('/backend-api/sentinel/chat-requirements');

  beforeEach(() => {
    clearChatGptWebCaches();
    resetChatGptWebKeepAliveForTests();
    mockProxyFetch.mockReset();
    setupMock();
  });

  afterAll(() => {
    stopAutoPingWorker();
  });

  describe('fetchSentinelHeaders', () => {
    const headers = (accessToken: string) => ({
      baseUrl: BASE_URL,
      accessToken,
      cookie: COOKIE,
      userAgent: USER_AGENT,
      platform: 'custom' as const,
    });

    it('retries prepare once with a freshly exchanged token and succeeds', async () => {
      sessionTokens = [makeJwt(3600)];
      prepareResponses = [
        { status: 401, body: TOKEN_EXPIRED_BODY },
        { status: 200, body: { prepare_token: 'prepare-token-2' } },
      ];

      const tokens = await fetchSentinelHeaders(headers(makeJwt(3600)));

      expect(tokens['OpenAI-Sentinel-Chat-Requirements-Token']).toBe('requirements-token');
      expect(sessionCalls()).toBe(1);
      expect(prepareCalls()).toBe(2);
      expect(requirementsCalls()).toBe(1);
    });

    it('fails with an actionable session-expired error when the retry also returns token_expired', async () => {
      sessionTokens = [makeJwt(3600)];
      prepareResponses = [
        { status: 401, body: TOKEN_EXPIRED_BODY },
        { status: 401, body: TOKEN_EXPIRED_BODY },
      ];

      let caught: unknown;
      try {
        await fetchSentinelHeaders(headers(makeJwt(3600)));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain('session expired');
      expect((caught as { status?: unknown }).status).toBe(401);
      // Bounded: exactly one re-exchange and one retried prepare, no loop.
      expect(sessionCalls()).toBe(1);
      expect(prepareCalls()).toBe(2);
      expect(requirementsCalls()).toBe(0);
    });

    it('does not retry a 403 Cloudflare challenge and keeps the Cloudflare message', async () => {
      prepareResponses = ['html403'];

      await expect(fetchSentinelHeaders(headers(makeJwt(3600)))).rejects.toThrow('Cloudflare/Sentinel');
      expect(sessionCalls()).toBe(0);
      expect(prepareCalls()).toBe(1);
    });

    it('does not retry a non-expired 401', async () => {
      prepareResponses = [
        { status: 401, body: JSON.stringify({ error: { message: 'Invalid token', code: 'invalid_token' } }) },
      ];

      await expect(fetchSentinelHeaders(headers(makeJwt(3600)))).rejects.toThrow('HTTP 401');
      expect(sessionCalls()).toBe(0);
      expect(prepareCalls()).toBe(1);
    });
  });

  describe('fetchUsableChatGptWebAccessToken (JWT exp guard)', () => {
    const args = () => [COOKIE, USER_AGENT, BASE_URL, 'custom' as const] as const;

    it('returns a long-lived token after a single session exchange', async () => {
      const token = makeJwt(3600);
      sessionTokens = [token];

      await expect(fetchUsableChatGptWebAccessToken(...args())).resolves.toBe(token);
      expect(sessionCalls()).toBe(1);
    });

    it('re-exchanges once when the first token expires in 30s, then returns the fresh token', async () => {
      const fresh = makeJwt(3600);
      sessionTokens = [makeJwt(30), fresh];

      await expect(fetchUsableChatGptWebAccessToken(...args())).resolves.toBe(fresh);
      expect(sessionCalls()).toBe(2);
    });

    it('throws session-expired without calling prepare when both exchanges mint near-expiry tokens', async () => {
      sessionTokens = [makeJwt(30), makeJwt(45)];

      await expect(fetchUsableChatGptWebAccessToken(...args())).rejects.toThrow('session expired');
      expect(sessionCalls()).toBe(2);
      expect(prepareCalls()).toBe(0);
    });

    it('treats opaque (non-JWT) tokens as usable', async () => {
      sessionTokens = ['opaque-token-value'];

      await expect(fetchUsableChatGptWebAccessToken(...args())).resolves.toBe('opaque-token-value');
      expect(sessionCalls()).toBe(1);
    });
  });

  describe('runChatGptWebChat', () => {
    it('recovers from an expired token at Sentinel and completes the turn', async () => {
      sessionTokens = [makeJwt(3600), makeJwt(3600)];
      prepareResponses = [
        { status: 401, body: TOKEN_EXPIRED_BODY },
        { status: 200, body: { prepare_token: 'prepare-token-2' } },
      ];

      const text = await runChatGptWebChat({
        credential: COOKIE,
        messages: [{ role: 'user', content: 'Hi' }],
        platform: 'custom',
      });

      expect(text).toBe('Hello from ChatGPT');
      expect(sessionCalls()).toBe(2);
      expect(prepareCalls()).toBe(2);
      expect(requirementsCalls()).toBe(1);
    });

    it('fails before prepare when the session only mints near-expiry tokens', async () => {
      sessionTokens = [makeJwt(30), makeJwt(30)];

      await expect(
        runChatGptWebChat({
          credential: COOKIE,
          messages: [{ role: 'user', content: 'Hi' }],
          platform: 'custom',
        }),
      ).rejects.toThrow('session expired');
      expect(prepareCalls()).toBe(0);
    });
  });

  describe('WebCookieProvider.validateKey (chatgpt-web)', () => {
    const provider = () =>
      new WebCookieProvider({ providerId: 'chatgpt-web', name: 'ChatGPT Web', baseUrl: BASE_URL });

    it('rotates on 401 token_expired at Sentinel prepare and returns true when the retry succeeds', async () => {
      sessionTokens = [
        { accessToken: makeJwt(3600), setCookies: ['__Secure-next-auth.session-token=rotated-1; Path=/; Secure'] },
        makeJwt(3600),
      ];
      prepareResponses = [
        { status: 401, body: TOKEN_EXPIRED_BODY },
        { status: 200, body: { prepare_token: 'prepare-token-2' } },
      ];
      const onCredentialUpdate = vi.fn();

      const result = await provider().validateKey(COOKIE, undefined, { onCredentialUpdate });

      expect(result).toBe(true);
      expect(sessionCalls()).toBe(2);
      expect(prepareCalls()).toBe(2);
      expect(onCredentialUpdate).toHaveBeenCalledWith('__Secure-next-auth.session-token=rotated-1');
    });

    it('returns valid:false when Sentinel prepare returns token_expired on both attempts', async () => {
      sessionTokens = [makeJwt(3600), makeJwt(3600)];
      prepareResponses = [
        { status: 401, body: TOKEN_EXPIRED_BODY },
        { status: 401, body: TOKEN_EXPIRED_BODY },
      ];

      const result = await provider().validateKey(COOKIE);

      expect(result).toEqual({ valid: false, error: expect.stringContaining('session expired') });
      expect(sessionCalls()).toBe(2);
      expect(prepareCalls()).toBe(2);
    });

    it('re-exchanges when /api/auth/session first returns a near-expiry JWT and then a valid JWT', async () => {
      const fresh = makeJwt(3600);
      sessionTokens = [
        { accessToken: makeJwt(30), setCookies: ['__Secure-next-auth.session-token=rotated-jwt; Path=/; Secure'] },
        fresh,
      ];
      prepareResponses = [{ status: 200, body: { prepare_token: 'prepare-token' } }];
      const onCredentialUpdate = vi.fn();

      await expect(provider().validateKey(COOKIE, undefined, { onCredentialUpdate })).resolves.toBe(true);
      expect(sessionCalls()).toBe(2);
      expect(prepareCalls()).toBe(1);
      expect(onCredentialUpdate).toHaveBeenCalledWith('__Secure-next-auth.session-token=rotated-jwt');
    });

    it('returns true when the session and Sentinel prepare both succeed', async () => {
      sessionTokens = [makeJwt(3600)];
      prepareResponses = [{ status: 200, body: { prepare_token: 'prepare-token' } }];

      await expect(provider().validateKey(COOKIE)).resolves.toBe(true);
      expect(prepareCalls()).toBe(1);
    });
  });

  describe('Set-Cookie rotation, token handoff & auto-reconnect', () => {
    it('merges Set-Cookie headers across /api/auth/session, handles chunked transitions, and refuses to delete the last session cookie', () => {
      const unchunkedRes = {
        headers: makeHeaders(['__Secure-next-auth.session-token=single-new; Path=/; Secure; HttpOnly']),
      } as unknown as Response;
      const fromChunked = mergeChatGptWebResponseCookies(
        '__Secure-next-auth.session-token.0=c0; __Secure-next-auth.session-token.1=c1; oai-sc=keep',
        unchunkedRes,
      );
      expect(fromChunked.changed).toBe(true);
      expect(fromChunked.nextHeader).toBe('oai-sc=keep; __Secure-next-auth.session-token=single-new');

      const chunkedRes = {
        headers: makeHeaders([
          '__Secure-next-auth.session-token.0=chunk-a; Path=/; Secure',
          '__Secure-next-auth.session-token.1=chunk-b; Path=/; Secure',
        ]),
      } as unknown as Response;
      const toChunked = mergeChatGptWebResponseCookies(
        '__Secure-next-auth.session-token=single-new; oai-sc=keep',
        chunkedRes,
      );
      expect(toChunked.changed).toBe(true);
      expect(toChunked.nextHeader).toBe(
        'oai-sc=keep; __Secure-next-auth.session-token.0=chunk-a; __Secure-next-auth.session-token.1=chunk-b',
      );

      const signOutRes = {
        headers: makeHeaders(['__Secure-next-auth.session-token=; Max-Age=0; Path=/; Secure']),
      } as unknown as Response;
      const protectedResult = mergeChatGptWebResponseCookies(COOKIE, signOutRes);
      expect(protectedResult.changed).toBe(false);
      expect(protectedResult.nextHeader).toBe(COOKIE);
    });

    it('propagates rotated Set-Cookie from /api/auth/session to subsequent exchanges and invokes onCredentialUpdate', async () => {
      const nearExpiry = makeJwt(20);
      const valid = makeJwt(3600);
      const onCredentialUpdate = vi.fn();
      sessionTokens = [
        { accessToken: nearExpiry, setCookies: ['__Secure-next-auth.session-token=fresh-cookie; Path=/; Secure'] },
        valid,
      ];

      const token = await fetchUsableChatGptWebAccessToken(
        COOKIE,
        USER_AGENT,
        BASE_URL,
        'custom',
        undefined,
        onCredentialUpdate,
      );

      expect(token).toBe(valid);
      expect(onCredentialUpdate).toHaveBeenCalledTimes(1);
      expect(onCredentialUpdate).toHaveBeenCalledWith('__Secure-next-auth.session-token=fresh-cookie');
      expect(callLog[1]?.headers.Cookie).toBe('__Secure-next-auth.session-token=fresh-cookie');
    });

    it('runChatGptWebChat sends the refreshed accessToken and rotated Cookie on prepare and conversation after Sentinel 401 recovery', async () => {
      const staleAccess = makeJwt(3600);
      const freshAccess = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 7200, jti: 'fresh' })}.signature`;
      const onCredentialUpdate = vi.fn();
      sessionTokens = [
        { accessToken: staleAccess, setCookies: ['__Secure-next-auth.session-token=cookie-v2; Path=/; Secure'] },
        { accessToken: freshAccess, setCookies: ['__Secure-next-auth.session-token=cookie-v3; Path=/; Secure'] },
      ];
      prepareResponses = [
        { status: 401, body: TOKEN_EXPIRED_BODY },
        { status: 200, body: { prepare_token: 'prepare-token-2' } },
      ];

      const text = await runChatGptWebChat({
        credential: COOKIE,
        messages: [{ role: 'user', content: 'Hi' }],
        platform: 'custom',
        onCredentialUpdate,
      });

      expect(text).toBe('Hello from ChatGPT');
      const convPrepare = callLog.find((c) => c.url.endsWith('/backend-api/f/conversation/prepare'));
      const convTurn = callLog.find((c) => c.url.endsWith('/backend-api/f/conversation'));
      expect(convPrepare?.headers.Authorization).toBe(`Bearer ${freshAccess}`);
      expect(convPrepare?.headers.Cookie).toBe('__Secure-next-auth.session-token=cookie-v3');
      expect(convTurn?.headers.Authorization).toBe(`Bearer ${freshAccess}`);
      expect(convTurn?.headers.Cookie).toBe('__Secure-next-auth.session-token=cookie-v3');
      expect(onCredentialUpdate).toHaveBeenLastCalledWith('__Secure-next-auth.session-token=cookie-v3');
    });

    it('rotateChatGptWebAccountsOnce persists rotated cookies and automatically reconnects error accounts to healthy', async () => {
      process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'c'.repeat(64);
      initDb(':memory:');
      try {
        const accountId = createApiKeyAccount({
          provider: 'chatgpt-web',
          key: COOKIE,
          label: 'Auto Reconnect ChatGPT',
        });
        setAccountStatus(accountId, 'error');
        setAccountCooldown(accountId, 60_000, undefined, 'ChatGPT Web session expired');

        sessionTokens = [
          {
            accessToken: makeJwt(3600),
            setCookies: ['__Secure-next-auth.session-token=auto-rotated-cookie; Path=/; Secure'],
          },
        ];
        prepareResponses = [{ status: 200, body: { prepare_token: 'prepare-ok' } }];

        const rotatedCount = await rotateChatGptWebAccountsOnce();

        expect(rotatedCount).toBe(1);
        const updated = accountRow(accountId);
        expect(updated.status).toBe('healthy');
        expect(getAccountCooldown(accountId).inCooldown).toBe(false);
        expect(decrypt(updated.encrypted_key, updated.iv, updated.auth_tag)).toBe(
          '__Secure-next-auth.session-token=auto-rotated-cookie',
        );
      } finally {
        getDb().close();
      }
    });
  });
});
