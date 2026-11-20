import type { Server } from 'node:http';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockProxyFetch = vi.hoisted(() => vi.fn());

vi.mock('../../lib/proxy.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  proxyFetch: mockProxyFetch,
}));

vi.mock('../../custom/provider-accounts/deepseek-pow.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  solveDeepSeekPowHeader: vi.fn(() => 'bW9ja19wb3c='),
}));

import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { clearDeepSeekWebTokenCache } from '../../custom/provider-accounts/deepseek-web-chat.js';
import {
  createApiKeyAccount,
  invalidateXGatewayKeyCache,
  setAccountStatus,
} from '../../custom/provider-accounts/store.js';
import { invalidateConfigCache, setEnabled } from '../../custom/x-gateway/config.js';
import {
  resetRouteHealth,
  resetSessionPins,
  resolveCandidateRoutes,
} from '../../custom/x-gateway/router.js';
import {
  DEFAULT_AUTO_STREAM_PEEK_TIMEOUT_MS,
  DEFAULT_WEB_COOKIE_STREAM_PEEK_TIMEOUT_MS,
  EmptyStreamError,
  StreamPeekTimeoutError,
  chunkHasReasoningContent,
  getAutoStreamPeekTimeoutMs,
  peekStreamForContent,
  reconstructStream,
  setAutoStreamPeekTimeoutMs,
} from '../../custom/x-gateway/stream-peek.js';

function makeChunk(delta: { content?: string; reasoning_content?: string }, finishReason: string | null = null): ChatCompletionChunk {
  return {
    id: 'chunk_1',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'deepseek-reasoner',
    choices: [{ index: 0, delta: delta as any, finish_reason: finishReason as any }],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function delayedSseResponse(items: Array<{ delayMs: number; line: string }>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const item of items) {
        if (item.delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, item.delayMs));
        }
        controller.enqueue(encoder.encode(`${item.line}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('stream-peek & webCookie/sticky routing safeguards', () => {
  afterEach(() => {
    setAutoStreamPeekTimeoutMs(null);
  });

  describe('getAutoStreamPeekTimeoutMs', () => {
    it('uses 7s default for standard providers and 25s default for webCookie providers unless overridden', () => {
      expect(DEFAULT_AUTO_STREAM_PEEK_TIMEOUT_MS).toBe(7_000);
      expect(DEFAULT_WEB_COOKIE_STREAM_PEEK_TIMEOUT_MS).toBe(25_000);
      expect(getAutoStreamPeekTimeoutMs()).toBe(7_000);
      expect(getAutoStreamPeekTimeoutMs({ webCookie: false })).toBe(7_000);
      expect(getAutoStreamPeekTimeoutMs({ webCookie: true })).toBe(25_000);

      setAutoStreamPeekTimeoutMs(120);
      expect(getAutoStreamPeekTimeoutMs()).toBe(120);
      expect(getAutoStreamPeekTimeoutMs({ webCookie: true })).toBe(120);

      setAutoStreamPeekTimeoutMs(null);
      expect(getAutoStreamPeekTimeoutMs({ webCookie: true })).toBe(25_000);
    });
  });

  describe('peekStreamForContent reasoning progress & close handling', () => {
    it('extends the peek deadline while active reasoning_content chunks arrive before client content', async () => {
      async function* thinkingStream() {
        await new Promise(r => setTimeout(r, 35));
        yield makeChunk({ reasoning_content: 'step 1 ' });
        await new Promise(r => setTimeout(r, 35));
        yield makeChunk({ reasoning_content: 'step 2 ' });
        await new Promise(r => setTimeout(r, 35));
        yield makeChunk({ reasoning_content: 'step 3' });
        await new Promise(r => setTimeout(r, 35));
        yield makeChunk({ content: 'Final answer' });
        yield makeChunk({}, 'stop');
      }

      // Total elapsed before content is ~140ms (> 70ms timeoutMs), but each reasoning chunk arrives within 35ms.
      const peek = await peekStreamForContent(thinkingStream(), { timeoutMs: 70 });
      const collected: ChatCompletionChunk[] = [];
      for await (const chunk of reconstructStream(peek)) {
        collected.push(chunk);
      }

      expect(chunkHasReasoningContent(collected[0])).toBe(true);
      expect(collected.map(c => c.choices[0].delta.reasoning_content ?? c.choices[0].delta.content ?? '')).toEqual([
        'step 1 ',
        'step 2 ',
        'step 3',
        'Final answer',
        '',
      ]);
    });

    it('still times out and invokes onTimeout if stream stalls after a reasoning chunk', async () => {
      const onTimeout = vi.fn();
      async function* stalledAfterReasoning() {
        yield makeChunk({ reasoning_content: 'thinking...' });
        await new Promise(r => setTimeout(r, 200));
        yield makeChunk({ content: 'too late' });
      }

      await expect(
        peekStreamForContent(stalledAfterReasoning(), { timeoutMs: 45, onTimeout }),
      ).rejects.toBeInstanceOf(StreamPeekTimeoutError);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it('preserves allowReasoningOnlyOnClose semantics', async () => {
      async function* reasoningOnlyStream() {
        yield makeChunk({ reasoning_content: 'only thoughts' });
      }

      await expect(
        peekStreamForContent(reasoningOnlyStream(), { allowReasoningOnlyOnClose: false }),
      ).rejects.toBeInstanceOf(EmptyStreamError);

      const allowed = await peekStreamForContent(reasoningOnlyStream(), { allowReasoningOnlyOnClose: true });
      expect(allowed.hasMore).toBe(false);
      expect(allowed.headChunks).toHaveLength(1);
      expect(allowed.headChunks[0].choices[0].delta.reasoning_content).toBe('only thoughts');
    });
  });

  describe('router candidate filtering, webCookie peek timeout, and sticky fallback', () => {
    let server: Server;
    let port = 0;
    let adminToken = '';
    let adminUserId = 0;

    beforeAll(async () => {
      process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'd'.repeat(64);
      initDb(':memory:');
      const admin = createUser(`stream-peek-admin-${Date.now()}@example.test`, 'AdminPass#1234');
      adminUserId = admin.userId;
      adminToken = createSession(admin.userId);
      setEnabled(true, admin.userId);

      server = createApp().listen(0, '127.0.0.1');
      await new Promise<void>(resolve => server.once('listening', resolve));
      port = (server.address() as { port: number }).port;
    });

    beforeEach(() => {
      clearDeepSeekWebTokenCache();
      mockProxyFetch.mockReset();
      setAutoStreamPeekTimeoutMs(null);
      resetRouteHealth();
      resetSessionPins();
      getDb().prepare('DELETE FROM x_gateway_keys').run();
      invalidateXGatewayKeyCache();
      invalidateConfigCache();
    });

    afterAll(async () => {
      await new Promise<void>(resolve => server?.close(() => resolve()));
    });

    it('resolveCandidateRoutes excludes status="error" accounts when healthy accounts exist, and retains them when all are in error', () => {
      const idHealthy = createApiKeyAccount({
        provider: 'deepseek-web',
        key: 'tok_healthy',
        label: 'DS Healthy',
        authMethod: 'cookie',
        userId: adminUserId,
      });
      const idError = createApiKeyAccount({
        provider: 'deepseek-web',
        key: 'tok_error',
        label: 'DS Error',
        authMethod: 'cookie',
        userId: adminUserId,
      });
      setAccountStatus(idError, 'error');
      invalidateXGatewayKeyCache();

      const withHealthy = resolveCandidateRoutes('deepseek-web/auto');
      expect(withHealthy.candidates.map(c => c.account.id)).not.toContain(idError);
      expect(withHealthy.candidates.some(c => c.account.id === idHealthy)).toBe(true);

      setAccountStatus(idHealthy, 'error');
      invalidateXGatewayKeyCache();

      const allError = resolveCandidateRoutes('deepseek-web/auto');
      expect(allError.candidates.length).toBeGreaterThan(0);
      expect(allError.candidates.some(c => c.account.id === idHealthy)).toBe(true);
    });

    it('keeps deepseek-web reasoning stream pinned across >timeout reasoning progress and skips status="error" accounts on sticky fallback', async () => {
      const idHealthy = createApiKeyAccount({
        provider: 'deepseek-web',
        key: 'tok_ds_primary',
        label: 'DS Primary',
        authMethod: 'cookie',
        userId: adminUserId,
        models: [{ id: 'deepseek-reasoner', name: 'DeepSeek R1' }],
      });
      const idError = createApiKeyAccount({
        provider: 'deepseek-web',
        key: 'tok_ds_dead',
        label: 'DS Dead',
        authMethod: 'cookie',
        userId: adminUserId,
        models: [{ id: 'deepseek-reasoner', name: 'DeepSeek R1' }],
      });
      setAccountStatus(idError, 'error');
      invalidateXGatewayKeyCache();

      const attemptedAuths: string[] = [];
      let turn = 0;

      mockProxyFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
        const target = String(url);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const auth = headers['Authorization'] ?? '';

        if (target.endsWith('/api/v0/users/current')) {
          attemptedAuths.push(auth);
          if (auth === 'Bearer tok_ds_dead') {
            return jsonResponse(200, { code: 40003, msg: 'dead account invalid token' });
          }
          return jsonResponse(200, { code: 0, data: { biz_data: { token: 'access_primary' } } });
        }
        if (target.endsWith('/api/v0/chat_session/create')) {
          return jsonResponse(200, { code: 0, data: { biz_data: { chat_session: { id: `sess_${turn}` } } } });
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
          if (turn === 1) {
            return delayedSseResponse([
              { delayMs: 0, line: 'data: {"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"ANSWER","content":"Turn1 OK"}]}}}' },
              { delayMs: 0, line: 'data: [DONE]' },
            ]);
          }
          if (turn === 2) {
            // Reasoning chunks arrive every 30ms (total 90ms > 60ms peek timeout) before answer content.
            return delayedSseResponse([
              { delayMs: 30, line: 'data: {"v":{"response":{"thinking_enabled":true,"fragments":[{"type":"THINK","content":"R1 "}]}}}' },
              { delayMs: 30, line: 'data: {"v":{"response":{"thinking_enabled":true,"fragments":[{"type":"THINK","content":"R2 "}]}}}' },
              { delayMs: 30, line: 'data: {"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"ANSWER","content":"Turn2 Answer"}]}}}' },
              { delayMs: 0, line: 'data: [DONE]' },
            ]);
          }
          // Turn 3 simulates primary upstream failure (502); router must NOT expand sticky fallback onto status='error' idError.
          return jsonResponse(502, { code: 50000, msg: 'upstream temporary error' });
        }
        if (target.endsWith('/api/v0/chat_session/delete')) {
          return jsonResponse(200, { code: 0 });
        }
        throw new Error(`Unexpected fetch URL: ${target}`);
      });

      setAutoStreamPeekTimeoutMs(60);

      const postChat = (messages: Array<{ role: string; content: string }>) =>
        fetch(`http://127.0.0.1:${port}/api/thruline/playground/chat`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: 'deepseek-web/auto', messages }),
        });

      // Turn 1: pins idHealthy into autoSessionCache.
      turn = 1;
      const res1 = await postChat([{ role: 'user', content: 'Multi-turn start' }]);
      expect(res1.status).toBe(200);
      expect(await res1.text()).toContain('Turn1 OK');

      // Turn 2: sticky pin hits idHealthy; active reasoning progress exceeds 60ms total without timing out.
      turn = 2;
      const res2 = await postChat([
        { role: 'user', content: 'Multi-turn start' },
        { role: 'assistant', content: 'Turn1 OK' },
        { role: 'user', content: 'Follow-up thinking question' },
      ]);
      expect(res2.status).toBe(200);
      const body2 = await res2.text();
      expect(body2).toContain('R1 ');
      expect(body2).toContain('Turn2 Answer');

      // Turn 3: sticky pin fails with 502 on idHealthy; dead status='error' account idError is NEVER attempted.
      turn = 3;
      const res3 = await postChat([
        { role: 'user', content: 'Multi-turn start' },
        { role: 'assistant', content: 'Turn1 OK' },
        { role: 'user', content: 'Follow-up thinking question' },
        { role: 'assistant', content: 'Turn2 Answer' },
        { role: 'user', content: 'Third turn' },
      ]);
      expect(res3.status).toBe(502);
      const errJson = await res3.json() as { error?: { message?: string } };
      expect(errJson.error?.message).not.toContain('userToken is invalid or expired');
      expect(attemptedAuths).not.toContain('Bearer tok_ds_dead');
      expect(idHealthy).toBeGreaterThan(0);
    });
  });
});
