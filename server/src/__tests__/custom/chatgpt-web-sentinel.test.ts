// ChatGPT Web Sentinel token rotation.
//
// Regression tests for the 401 `token_expired` failure at
// /backend-api/sentinel/chat-requirements/prepare: the session endpoint can
// hand back an access token that is already expired, and the old code threw
// immediately instead of re-exchanging the cookie for a fresh token.
// `proxyFetch` is mocked at the module boundary (no network, no DNS pinning).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockProxyFetch = vi.hoisted(() => vi.fn());

vi.mock('../../lib/proxy.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  proxyFetch: mockProxyFetch,
}));

import {
  fetchSentinelHeaders,
  fetchUsableChatGptWebAccessToken,
} from '../../custom/provider-accounts/chatgpt-web-image.js';
import { runChatGptWebChat } from '../../custom/provider-accounts/chatgpt-web-chat.js';
import { WebCookieProvider } from '../../custom/provider-accounts/web-cookie.js';

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

type MockResponseSpec = { status: number; body: unknown } | 'html403';

function jsonResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response;
}

function htmlResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: { get: () => 'text/html' },
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
    headers: { get: () => 'text/event-stream' },
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
  let sessionTokens: string[];
  let prepareResponses: MockResponseSpec[];

  function setupMock(): void {
    calls = [];
    sessionTokens = [];
    prepareResponses = [];
    mockProxyFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/api/auth/session')) {
        const token = sessionTokens.shift() ?? makeJwt(3600);
        return jsonResponse(200, { accessToken: token });
      }
      if (u.endsWith('/backend-api/sentinel/chat-requirements/prepare')) {
        const next = prepareResponses.shift();
        if (next === 'html403') return htmlResponse(403);
        if (next) return jsonResponse(next.status, next.body);
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
    mockProxyFetch.mockReset();
    setupMock();
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

    it('returns valid:false when the session is fine but Sentinel prepare is 401', async () => {
      sessionTokens = [makeJwt(3600)];
      prepareResponses = [{ status: 401, body: TOKEN_EXPIRED_BODY }];

      const result = await provider().validateKey(COOKIE);

      expect(result).toEqual({ valid: false, error: expect.stringContaining('session expired') });
      expect(prepareCalls()).toBe(1);
    });

    it('returns true when the session and Sentinel prepare both succeed', async () => {
      sessionTokens = [makeJwt(3600)];
      prepareResponses = [{ status: 200, body: { prepare_token: 'prepare-token' } }];

      await expect(provider().validateKey(COOKIE)).resolves.toBe(true);
      expect(prepareCalls()).toBe(1);
    });
  });
});
