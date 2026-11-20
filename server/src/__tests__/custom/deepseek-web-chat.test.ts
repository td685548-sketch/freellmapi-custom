// DeepSeek Web chat: credential parsing, cookie normalization, session
// validation, stale access-token cache recovery, and SSE completion.
//
// `proxyFetch` and `solveDeepSeekPowHeader` are mocked at the module boundary
// (no network, no DNS pinning, deterministic PoW header).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockProxyFetch = vi.hoisted(() => vi.fn());

vi.mock('../../lib/proxy.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  proxyFetch: mockProxyFetch,
}));

vi.mock('../../custom/provider-accounts/deepseek-pow.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  solveDeepSeekPowHeader: vi.fn(() => 'bW9ja19wb3c='),
}));

import { normalizeCookieInput } from '../../custom/provider-accounts/cookie-format.js';
import {
  DeepSeekWebChatError,
  clearDeepSeekWebTokenCache,
  describeEmptyCompletion,
  extractDeepSeekUserToken,
  parseDeepSeekCredential,
  streamDeepSeekWebChat,
} from '../../custom/provider-accounts/deepseek-web-chat.js';
import { WebCookieProvider } from '../../custom/provider-accounts/web-cookie.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of events) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function createDeepSeekProvider(): WebCookieProvider {
  return new WebCookieProvider({
    providerId: 'deepseek-web',
    name: 'DeepSeek Web',
    baseUrl: 'https://chat.deepseek.com',
  });
}

describe('parseDeepSeekCredential & extractDeepSeekUserToken', () => {
  it('parses raw, Bearer, Authorization, and Cookie userToken formats', () => {
    expect(parseDeepSeekCredential('tok_raw')).toEqual({ mode: 'token', userToken: 'tok_raw' });
    expect(extractDeepSeekUserToken('Bearer tok_bearer')).toBe('tok_bearer');
    expect(extractDeepSeekUserToken('Authorization: Bearer tok_auth')).toBe('tok_auth');
    expect(extractDeepSeekUserToken('Cookie: userToken=tok_cookie; __version=0')).toBe('tok_cookie');
    expect(extractDeepSeekUserToken('foo=1; userToken=tok_mid; bar=2')).toBe('tok_mid');
  });

  it('unwraps Local Storage JSON and double-encoded JSON userToken shapes', () => {
    expect(parseDeepSeekCredential('{"value":"tok_json","__version":"0"}')).toEqual({
      mode: 'token',
      userToken: 'tok_json',
    });
    expect(extractDeepSeekUserToken('"{\\"value\\":\\"tok_double\\"}"')).toBe('tok_double');
    expect(extractDeepSeekUserToken('{"value":"{\\"value\\":\\"tok_nested\\"}","__version":"0"}')).toBe('tok_nested');
  });

  it('recovers userToken from mangled value=<token>; __version=0 strings', () => {
    expect(
      parseDeepSeekCredential('value=/3sD+sicuX4MYqyO4yxIfo5hioLJMTrcrmmv2tXkDWCcXKl4DOBFBVmjXp7D0FMF; __version=0'),
    ).toEqual({
      mode: 'token',
      userToken: '/3sD+sicuX4MYqyO4yxIfo5hioLJMTrcrmmv2tXkDWCcXKl4DOBFBVmjXp7D0FMF',
    });
    expect(extractDeepSeekUserToken('value=tok_mangled; __version=0')).toBe('tok_mangled');
  });

  it('parses Cookie Editor JSON arrays for ds_session_id or userToken', () => {
    expect(
      parseDeepSeekCredential(
        JSON.stringify([
          { name: 'aws-waf-token', value: 'waf_1' },
          { name: 'ds_session_id', value: 'sess_xyz' },
        ]),
      ),
    ).toEqual({
      mode: 'cookie',
      cookieHeader: 'aws-waf-token=waf_1; ds_session_id=sess_xyz',
    });

    expect(
      parseDeepSeekCredential(
        JSON.stringify([{ name: 'userToken', value: '{"value":"tok_cookie_json"}' }]),
      ),
    ).toEqual({
      mode: 'token',
      userToken: 'tok_cookie_json',
    });
  });

  it('handles Playwright storageState localStorage and falls back to ds_session_id cookies', () => {
    expect(
      parseDeepSeekCredential(
        JSON.stringify({
          cookies: [{ name: 'aws-waf-token', value: 'waf_1' }],
          origins: [
            {
              origin: 'https://chat.deepseek.com',
              localStorage: [{ name: 'userToken', value: '{"value":"tok_state","__version":"0"}' }],
            },
          ],
        }),
      ),
    ).toEqual({
      mode: 'token',
      userToken: 'tok_state',
    });

    expect(
      parseDeepSeekCredential(
        JSON.stringify({
          cookies: [{ name: 'ds_session_id', value: 'sess_fallback' }],
          origins: [
            {
              origin: 'https://chat.deepseek.com',
              localStorage: [{ name: 'userToken', value: '{"value":{"id":"uuid-only"},"__version":"0"}' }],
            },
          ],
        }),
      ),
    ).toEqual({
      mode: 'cookie',
      cookieHeader: 'ds_session_id=sess_fallback',
    });
  });

  it('parses flat { ds_session_id } JSON objects into cookie mode', () => {
    expect(parseDeepSeekCredential('{"ds_session_id":"sess_123"}')).toEqual({
      mode: 'cookie',
      cookieHeader: 'ds_session_id=sess_123',
    });
  });

  it('throws 401 with ds_session_id guidance when Local Storage userToken only contains a user id', () => {
    expect(() =>
      parseDeepSeekCredential('{"value":{"id":"dd9b619e-3947-46ab-9eb8-d4b336884992"},"__version":"0"}'),
    ).toThrow(/ds_session_id/);
  });
});

describe('normalizeCookieInput with DeepSeek Local Storage JSON', () => {
  it('unwraps {"value":"tok_123","__version":"0"} to tok_123 instead of value=tok_123; __version=0', () => {
    expect(normalizeCookieInput('{"value":"tok_123","__version":"0"}')).toBe('tok_123');
    expect(normalizeCookieInput('{"userToken":"tok_456","__version":"0"}')).toBe('tok_456');
  });
});

describe('WebCookieProvider.validateKey (deepseek-web)', () => {
  beforeEach(() => {
    clearDeepSeekWebTokenCache();
    mockProxyFetch.mockReset();
  });

  it('returns true and self-heals a mangled value=...; __version=0 credential', async () => {
    mockProxyFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://chat.deepseek.com/api/v0/users/current');
      expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok_healed');
      return jsonResponse(200, { code: 0, data: { biz_data: { token: 'access_1' } } });
    });

    const onCredentialUpdate = vi.fn();
    const result = await createDeepSeekProvider().validateKey(
      'value=tok_healed; __version=0',
      undefined,
      { onCredentialUpdate },
    );

    expect(result).toBe(true);
    expect(onCredentialUpdate).toHaveBeenCalledTimes(1);
    expect(onCredentialUpdate).toHaveBeenCalledWith('tok_healed');
  });

  it('returns valid:false when /api/v0/users/current rejects with code 40003', async () => {
    mockProxyFetch.mockResolvedValueOnce(
      jsonResponse(200, { code: 40003, msg: 'Authorization Failed (invalid token)' }),
    );

    const onCredentialUpdate = vi.fn();
    const result = await createDeepSeekProvider().validateKey(
      '{"value":"tok_expired","__version":"0"}',
      undefined,
      { onCredentialUpdate },
    );

    expect(result).toEqual({
      valid: false,
      error: expect.stringContaining('DeepSeek userToken is invalid or expired'),
    });
    expect(onCredentialUpdate).not.toHaveBeenCalled();
  });
});

describe('WebCookieProvider.chatCompletion (deepseek-web)', () => {
  beforeEach(() => {
    clearDeepSeekWebTokenCache();
    mockProxyFetch.mockReset();
  });

  it('refreshes accessToken via users/current when cached token hits code 40003 on chat_session/create', async () => {
    let usersCurrentCalls = 0;
    let createSessionCalls = 0;
    const sessionAuthHeaders: string[] = [];

    mockProxyFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;

      if (target.endsWith('/api/v0/users/current')) {
        usersCurrentCalls += 1;
        const token = usersCurrentCalls === 1 ? 'access_stale' : 'access_fresh';
        return jsonResponse(200, { code: 0, data: { biz_data: { token } } });
      }

      if (target.endsWith('/api/v0/chat_session/create')) {
        createSessionCalls += 1;
        sessionAuthHeaders.push(headers['Authorization'] ?? '');
        if (createSessionCalls === 2) {
          return jsonResponse(200, { code: 40003, msg: 'token expired' });
        }
        return jsonResponse(200, {
          code: 0,
          data: { biz_data: { chat_session: { id: `sess_${createSessionCalls}` } } },
        });
      }

      if (target.endsWith('/api/v0/chat/create_pow_challenge')) {
        return jsonResponse(200, {
          code: 0,
          data: {
            biz_data: {
              challenge: {
                algorithm: 'DeepSeekHashV1',
                challenge: 'a'.repeat(64),
                salt: 'salt1',
                signature: 'sig1',
                difficulty: 1,
                expire_at: 1700000000,
              },
            },
          },
        });
      }

      if (target.endsWith('/api/v0/chat/completion')) {
        return sseResponse([
          'data: {"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"ANSWER","content":"PONG"}]}}}',
          'data: [DONE]',
        ]);
      }

      if (target.endsWith('/api/v0/chat_session/delete')) {
        return jsonResponse(200, { code: 0 });
      }

      throw new Error(`Unexpected fetch URL: ${target}`);
    });

    const provider = createDeepSeekProvider();
    const messages = [{ role: 'user' as const, content: 'Ping' }];

    // First call populates tokenCache with `access_stale`.
    const first = await provider.chatCompletion('tok_user_1', messages, 'deepseek-chat');
    expect(first.choices[0].message.content).toBe('PONG');
    expect(usersCurrentCalls).toBe(1);

    // Second call uses cached `access_stale`, gets 40003 on chat_session/create,
    // exchanges for `access_fresh` via users/current, and retries chat_session/create.
    const second = await provider.chatCompletion('tok_user_1', messages, 'deepseek-chat');
    expect(second.choices[0].message.content).toBe('PONG');
    expect(usersCurrentCalls).toBe(2);
    expect(createSessionCalls).toBe(3);
    expect(sessionAuthHeaders).toEqual([
      'Bearer access_stale',
      'Bearer access_stale',
      'Bearer access_fresh',
    ]);
  });

  it('does not drop ds_session_id via onCredentialUpdate when Cookie Editor or storageState JSON has both userToken and ds_session_id', async () => {
    mockProxyFetch.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.endsWith('/api/v0/users/current')) {
        return jsonResponse(200, { code: 0, data: { biz_data: { token: 'access_ok' } } });
      }
      if (target.endsWith('/api/v0/chat_session/create')) {
        return jsonResponse(200, { code: 0, data: { biz_data: { chat_session: { id: 'sess_keep' } } } });
      }
      if (target.endsWith('/api/v0/chat/create_pow_challenge')) {
        return jsonResponse(200, {
          code: 0,
          data: {
            biz_data: {
              challenge: {
                algorithm: 'DeepSeekHashV1',
                challenge: 'a'.repeat(64),
                salt: 'salt1',
                signature: 'sig1',
                difficulty: 1,
                expire_at: 1700000000,
              },
            },
          },
        });
      }
      if (target.endsWith('/api/v0/chat/completion')) {
        return sseResponse([
          'data: {"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"ANSWER","content":"OK"}]}}}',
          'data: [DONE]',
        ]);
      }
      if (target.endsWith('/api/v0/chat_session/delete')) {
        return jsonResponse(200, { code: 0 });
      }
      throw new Error(`Unexpected fetch URL: ${target}`);
    });

    const cookieEditorWithBoth = JSON.stringify([
      { name: 'ds_session_id', value: 'sess_cookie_preserve' },
      { name: 'userToken', value: '{"value":"tok_in_cookie_json","__version":"0"}' },
    ]);
    const storageStateWithBoth = JSON.stringify({
      cookies: [{ name: 'ds_session_id', value: 'sess_storage_preserve' }],
      origins: [
        {
          origin: 'https://chat.deepseek.com',
          localStorage: [{ name: 'userToken', value: '{"value":"tok_in_storage","__version":"0"}' }],
        },
      ],
    });
    const flatJsonWithBoth = JSON.stringify({
      userToken: 'tok_flat_both',
      ds_session_id: 'sess_flat_preserve',
    });

    const provider = createDeepSeekProvider();
    for (const cred of [cookieEditorWithBoth, storageStateWithBoth, flatJsonWithBoth]) {
      const onCredentialUpdateValidate = vi.fn();
      const valid = await provider.validateKey(cred, undefined, { onCredentialUpdate: onCredentialUpdateValidate });
      expect(valid).toBe(true);
      expect(onCredentialUpdateValidate).not.toHaveBeenCalled();

      const onCredentialUpdateChat = vi.fn();
      const res = await provider.chatCompletion(
        cred,
        [{ role: 'user', content: 'Hi' }],
        'deepseek-chat',
        { onCredentialUpdate: onCredentialUpdateChat },
      );
      expect(res.choices[0].message.content).toBe('OK');
      expect(onCredentialUpdateChat).not.toHaveBeenCalled();
    }

    // By contrast, a token-only wrapped/mangled credential with no ds_session_id still normalizes via onCredentialUpdate.
    const onUpdateTokenOnly = vi.fn();
    await provider.chatCompletion(
      '{"value":"tok_only_json","__version":"0"}',
      [{ role: 'user', content: 'Hi' }],
      'deepseek-chat',
      { onCredentialUpdate: onUpdateTokenOnly },
    );
    expect(onUpdateTokenOnly).toHaveBeenCalledWith('tok_only_json');
  });

  it('recovers stale cached accessToken when create_pow_challenge fails with 40003 and deletes old session', async () => {
    let usersCurrentCalls = 0;
    let createSessionCalls = 0;
    let powCalls = 0;
    let completionCalls = 0;
    const deletedSessions: string[] = [];
    const powAuthHeaders: string[] = [];
    const completionAuthHeaders: string[] = [];

    mockProxyFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;

      if (target.endsWith('/api/v0/users/current')) {
        usersCurrentCalls += 1;
        return jsonResponse(200, {
          code: 0,
          data: { biz_data: { token: usersCurrentCalls === 1 ? 'access_stale_pow' : 'access_fresh_pow' } },
        });
      }
      if (target.endsWith('/api/v0/chat_session/create')) {
        createSessionCalls += 1;
        return jsonResponse(200, {
          code: 0,
          data: { biz_data: { chat_session: { id: `sess_${createSessionCalls}` } } },
        });
      }
      if (target.endsWith('/api/v0/chat/create_pow_challenge')) {
        powCalls += 1;
        powAuthHeaders.push(headers['Authorization'] ?? '');
        if (powCalls === 2) {
          return jsonResponse(200, { code: 40003, msg: 'invalid token on pow' });
        }
        return jsonResponse(200, {
          code: 0,
          data: {
            biz_data: {
              challenge: {
                algorithm: 'DeepSeekHashV1',
                challenge: 'a'.repeat(64),
                salt: 'salt1',
                signature: 'sig1',
                difficulty: 1,
                expire_at: 1700000000,
              },
            },
          },
        });
      }
      if (target.endsWith('/api/v0/chat/completion')) {
        completionCalls += 1;
        completionAuthHeaders.push(headers['Authorization'] ?? '');
        return sseResponse([
          'data: {"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"ANSWER","content":"RECOVERED_POW"}]}}}',
          'data: [DONE]',
        ]);
      }
      if (target.endsWith('/api/v0/chat_session/delete')) {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as { chat_session_id?: string };
        if (parsed.chat_session_id) deletedSessions.push(parsed.chat_session_id);
        return jsonResponse(200, { code: 0 });
      }
      throw new Error(`Unexpected fetch URL: ${target}`);
    });

    const provider = createDeepSeekProvider();
    const messages = [{ role: 'user' as const, content: 'Hello' }];

    // Turn 1 populates tokenCache with access_stale_pow.
    const first = await provider.chatCompletion('tok_pow_user', messages, 'deepseek-chat');
    expect(first.choices[0].message.content).toBe('RECOVERED_POW');

    // Turn 2 hits 40003 on create_pow_challenge -> clears cache, re-auths, deletes sess_2, recreates sess_3, retries PoW + completion.
    const second = await provider.chatCompletion('tok_pow_user', messages, 'deepseek-chat');
    expect(second.choices[0].message.content).toBe('RECOVERED_POW');
    expect(usersCurrentCalls).toBe(2);
    expect(createSessionCalls).toBe(3);
    expect(completionCalls).toBe(2);
    expect(powAuthHeaders).toEqual([
      'Bearer access_stale_pow',
      'Bearer access_stale_pow',
      'Bearer access_fresh_pow',
    ]);
    expect(completionAuthHeaders).toEqual([
      'Bearer access_stale_pow',
      'Bearer access_fresh_pow',
    ]);
    expect(deletedSessions).toContain('sess_2');
    expect(deletedSessions).toContain('sess_3');
  });

  it('recovers stale cached accessToken when /chat/completion fails with HTTP 401 or in-band SSE code 40003 before deltas', async () => {
    for (const mode of ['http_401', 'sse_40003'] as const) {
      clearDeepSeekWebTokenCache();
      let usersCurrentCalls = 0;
      let createSessionCalls = 0;
      let completionCalls = 0;
      const completionAuthHeaders: string[] = [];

      mockProxyFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
        const target = String(url);
        const headers = (init?.headers ?? {}) as Record<string, string>;

        if (target.endsWith('/api/v0/users/current')) {
          usersCurrentCalls += 1;
          return jsonResponse(200, {
            code: 0,
            data: { biz_data: { token: usersCurrentCalls === 1 ? 'access_stale_comp' : 'access_fresh_comp' } },
          });
        }
        if (target.endsWith('/api/v0/chat_session/create')) {
          createSessionCalls += 1;
          return jsonResponse(200, {
            code: 0,
            data: { biz_data: { chat_session: { id: `sess_${mode}_${createSessionCalls}` } } },
          });
        }
        if (target.endsWith('/api/v0/chat/create_pow_challenge')) {
          return jsonResponse(200, {
            code: 0,
            data: {
              biz_data: {
                challenge: {
                  algorithm: 'DeepSeekHashV1',
                  challenge: 'a'.repeat(64),
                  salt: 'salt1',
                  signature: 'sig1',
                  difficulty: 1,
                  expire_at: 1700000000,
                },
              },
            },
          });
        }
        if (target.endsWith('/api/v0/chat/completion')) {
          completionCalls += 1;
          completionAuthHeaders.push(headers['Authorization'] ?? '');
          if (completionCalls === 2) {
            if (mode === 'http_401') {
              return jsonResponse(401, { code: 40003, msg: 'token expired' });
            }
            return sseResponse(['data: {"code":40003,"msg":"userToken is invalid or expired"}']);
          }
          return sseResponse([
            `data: {"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"ANSWER","content":"OK_${mode}"}]}}}`,
            'data: [DONE]',
          ]);
        }
        if (target.endsWith('/api/v0/chat_session/delete')) {
          return jsonResponse(200, { code: 0 });
        }
        throw new Error(`Unexpected fetch URL: ${target}`);
      });

      const provider = createDeepSeekProvider();
      const messages = [{ role: 'user' as const, content: 'Hello' }];

      const first = await provider.chatCompletion(`tok_${mode}`, messages, 'deepseek-chat');
      expect(first.choices[0].message.content).toBe(`OK_${mode}`);

      const second = await provider.chatCompletion(`tok_${mode}`, messages, 'deepseek-chat');
      expect(second.choices[0].message.content).toBe(`OK_${mode}`);
      expect(usersCurrentCalls).toBe(2);
      expect(createSessionCalls).toBe(3);
      expect(completionCalls).toBe(3);
      expect(completionAuthHeaders).toEqual([
        'Bearer access_stale_comp',
        'Bearer access_stale_comp',
        'Bearer access_fresh_comp',
      ]);
    }
  });

  it('throws DeepSeekWebChatError with status 401 (not 502) and evicts tokenCache on unrecoverable SSE code 40003', async () => {
    let usersCurrentCalls = 0;
    mockProxyFetch.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.endsWith('/api/v0/users/current')) {
        usersCurrentCalls += 1;
        return jsonResponse(200, { code: 0, data: { biz_data: { token: `access_${usersCurrentCalls}` } } });
      }
      if (target.endsWith('/api/v0/chat_session/create')) {
        return jsonResponse(200, { code: 0, data: { biz_data: { chat_session: { id: 'sess_401' } } } });
      }
      if (target.endsWith('/api/v0/chat/create_pow_challenge')) {
        return jsonResponse(200, {
          code: 0,
          data: {
            biz_data: {
              challenge: {
                algorithm: 'DeepSeekHashV1',
                challenge: 'a'.repeat(64),
                salt: 'salt1',
                signature: 'sig1',
                difficulty: 1,
                expire_at: 1700000000,
              },
            },
          },
        });
      }
      if (target.endsWith('/api/v0/chat/completion')) {
        return sseResponse(['data: {"code":40003,"msg":"invalid token in sse"}']);
      }
      if (target.endsWith('/api/v0/chat_session/delete')) {
        return jsonResponse(200, { code: 0 });
      }
      throw new Error(`Unexpected fetch URL: ${target}`);
    });

    const consume = async () => {
      for await (const _delta of streamDeepSeekWebChat({
        credential: 'tok_sse_401',
        messages: [{ role: 'user', content: 'Hi' }],
        modelId: 'deepseek-chat',
      })) {
        // no-op
      }
    };

    await expect(consume()).rejects.toSatisfy(
      (err: unknown) => err instanceof DeepSeekWebChatError && err.status === 401 && /invalid token in sse/.test(err.message),
    );
    // Token cache was evicted, so a subsequent call must re-hit /api/v0/users/current.
    await expect(consume()).rejects.toSatisfy(
      (err: unknown) => err instanceof DeepSeekWebChatError && err.status === 401,
    );
    expect(usersCurrentCalls).toBe(2);
  });

  it('does not retry if SSE emits deltas before code 40003, and still throws 401', async () => {
    let usersCurrentCalls = 0;
    let completionCalls = 0;

    mockProxyFetch.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.endsWith('/api/v0/users/current')) {
        usersCurrentCalls += 1;
        return jsonResponse(200, { code: 0, data: { biz_data: { token: 'access_midstream' } } });
      }
      if (target.endsWith('/api/v0/chat_session/create')) {
        return jsonResponse(200, { code: 0, data: { biz_data: { chat_session: { id: 'sess_mid' } } } });
      }
      if (target.endsWith('/api/v0/chat/create_pow_challenge')) {
        return jsonResponse(200, {
          code: 0,
          data: {
            biz_data: {
              challenge: {
                algorithm: 'DeepSeekHashV1',
                challenge: 'a'.repeat(64),
                salt: 'salt1',
                signature: 'sig1',
                difficulty: 1,
                expire_at: 1700000000,
              },
            },
          },
        });
      }
      if (target.endsWith('/api/v0/chat/completion')) {
        completionCalls += 1;
        if (completionCalls === 1) {
          return sseResponse([
            'data: {"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"ANSWER","content":"WARM"}]}}}',
            'data: [DONE]',
          ]);
        }
        return sseResponse([
          'data: {"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"ANSWER","content":"PARTIAL"}]}}}',
          'data: {"code":40003,"msg":"expired midstream"}',
        ]);
      }
      if (target.endsWith('/api/v0/chat_session/delete')) {
        return jsonResponse(200, { code: 0 });
      }
      throw new Error(`Unexpected fetch URL: ${target}`);
    });

    const provider = createDeepSeekProvider();
    await provider.chatCompletion('tok_midstream', [{ role: 'user', content: 'Warm' }], 'deepseek-chat');

    const deltas: string[] = [];
    let caught: unknown;
    try {
      for await (const d of streamDeepSeekWebChat({
        credential: 'tok_midstream',
        messages: [{ role: 'user', content: 'Next' }],
        modelId: 'deepseek-chat',
      })) {
        if (d.content) deltas.push(d.content);
      }
    } catch (err) {
      caught = err;
    }

    expect(deltas).toEqual(['PARTIAL']);
    expect(caught).toBeInstanceOf(DeepSeekWebChatError);
    expect((caught as DeepSeekWebChatError).status).toBe(401);
    expect(usersCurrentCalls).toBe(1);
    expect(completionCalls).toBe(2);
  });
});

describe('empty DeepSeek completions explain themselves (system instruction turns)', () => {
  beforeEach(() => {
    mockProxyFetch.mockReset();
    clearDeepSeekWebTokenCache();
  });

  function mockCompletion(events: string[]) {
    mockProxyFetch.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.endsWith('/api/v0/users/current')) {
        return jsonResponse(200, { code: 0, data: { biz_data: { token: 'access_1' } } });
      }
      if (target.endsWith('/api/v0/chat_session/create')) {
        return jsonResponse(200, { code: 0, data: { biz_data: { chat_session: { id: 'sess_sys' } } } });
      }
      if (target.endsWith('/api/v0/chat/create_pow_challenge')) {
        return jsonResponse(200, {
          code: 0,
          data: {
            biz_data: {
              challenge: {
                algorithm: 'DeepSeekHashV1',
                challenge: 'a'.repeat(64),
                salt: 's',
                signature: 'sig',
                difficulty: 1,
                expire_at: 1700000000,
              },
            },
          },
        });
      }
      if (target.endsWith('/api/v0/chat/completion')) return sseResponse(events);
      if (target.endsWith('/api/v0/chat_session/delete')) return jsonResponse(200, { code: 0 });
      throw new Error(`Unexpected fetch URL: ${target}`);
    });
  }

  const consumeWithSystem = async () => {
    for await (const _delta of streamDeepSeekWebChat({
      credential: 'tok_sys',
      messages: [
        { role: 'system', content: 'Always answer as a pirate.' },
        { role: 'user', content: 'Hi' },
      ],
      modelId: 'deepseek-v4-pro',
    })) {
      // no-op
    }
  };

  it('reports a content filter instead of blaming an expired userToken', async () => {
    mockCompletion(['data: {"p":"response/status","o":"SET","v":"CONTENT_FILTER"}']);
    await expect(consumeWithSystem()).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DeepSeekWebChatError &&
        err.status === 502 &&
        /filtered this prompt/.test(err.message) &&
        !/expired/.test(err.message),
    );
  });

  it('includes a DeepSeek hint when the stream carried one', async () => {
    mockCompletion(['data: {"type":"hint","content":"The server is busy, please try again later."}']);
    await expect(consumeWithSystem()).rejects.toSatisfy(
      (err: unknown) => err instanceof DeepSeekWebChatError && /server is busy/.test(err.message),
    );
  });

  it('still falls back to the userToken advice when DeepSeek reported nothing', () => {
    expect(describeEmptyCompletion('', '')).toMatch(/userToken is valid and not expired/);
    expect(describeEmptyCompletion('FINISHED', '')).toMatch(/userToken is valid and not expired/);
    expect(describeEmptyCompletion('INCOMPLETE', '')).toMatch(/status INCOMPLETE/);
  });
});
