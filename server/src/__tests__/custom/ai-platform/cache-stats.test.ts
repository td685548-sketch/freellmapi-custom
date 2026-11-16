import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import type { SessionUser } from '../../../services/auth.js';
import { installInterceptor } from '../../../custom/ai-platform/wire/interceptor.js';
import { promptCacheAdminRouter } from '../../../custom/ai-platform/prompt-cache/router.js';
import {
  cacheUsageFilter,
  estimateCacheSavingsMicroUsd,
  extractCacheUsage,
  getCacheStats,
  recordCacheUsage,
} from '../../../custom/ai-platform/prompt-cache/stats.js';

function makeHarness(originalUrl: string) {
  const reqEmitter = new EventEmitter();
  const resEmitter = new EventEmitter();
  const written: Buffer[] = [];
  const jsonOut: unknown[] = [];
  const headers: Record<string, string> = {};

  const req = Object.assign(reqEmitter, {
    method: 'POST',
    originalUrl,
    url: originalUrl,
  }) as unknown as Request;

  const resObj = Object.assign(resEmitter, {
    statusCode: 200,
    headersSent: false,
    writableFinished: false,
    destroyed: false,
    setHeader(name: string, val: string | string[]) {
      headers[name.toLowerCase()] = Array.isArray(val) ? val.join(', ') : String(val);
      return resObj;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    removeHeader(name: string) {
      delete headers[name.toLowerCase()];
    },
    write(chunk: string | Uint8Array, encOrCb?: BufferEncoding | (() => void), cb?: () => void) {
      const encoding = typeof encOrCb === 'string' ? encOrCb : 'utf8';
      const callback = typeof encOrCb === 'function' ? encOrCb : cb;
      written.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : typeof chunk === 'string'
            ? Buffer.from(chunk, encoding)
            : Buffer.from(chunk),
      );
      callback?.();
      return true;
    },
    end(chunk?: string | Uint8Array | (() => void), encOrCb?: BufferEncoding | (() => void), cb?: () => void) {
      let actualChunk: string | Uint8Array | undefined;
      let encoding: BufferEncoding = 'utf8';
      let callback: (() => void) | undefined;
      if (typeof chunk === 'function') callback = chunk;
      else {
        actualChunk = chunk;
        if (typeof encOrCb === 'function') callback = encOrCb;
        else if (typeof encOrCb === 'string') {
          encoding = encOrCb;
          callback = cb;
        }
      }
      if (actualChunk !== undefined) {
        written.push(
          Buffer.isBuffer(actualChunk)
            ? actualChunk
            : typeof actualChunk === 'string'
              ? Buffer.from(actualChunk, encoding)
              : Buffer.from(actualChunk),
        );
      }
      resObj.writableFinished = true;
      callback?.();
      resEmitter.emit('finish');
      return resObj;
    },
    json(body: unknown) {
      jsonOut.push(body);
      resObj.writableFinished = true;
      return resObj;
    },
  });

  return { req, res: resObj as unknown as Response, written, jsonOut, headers };
}

describe('prompt-cache/stats', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
  });

  it('extracts cache usage across all 4 wire protocols', () => {
    expect(
      extractCacheUsage('openai-chat', {
        prompt_tokens: 1500,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 1000 },
      }),
    ).toEqual({
      inputTokens: 1500,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
    });

    // Anthropic: inputTokens is total = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
    expect(
      extractCacheUsage('anthropic', {
        input_tokens: 200,
        cache_read_input_tokens: 1200,
        cache_creation_input_tokens: 300,
        output_tokens: 40,
      }),
    ).toEqual({
      inputTokens: 1700,
      cacheReadTokens: 1200,
      cacheWriteTokens: 300,
    });

    // Anthropic message_delta with only output_tokens returns null
    expect(extractCacheUsage('anthropic', { output_tokens: 40 })).toBeNull();

    expect(
      extractCacheUsage('responses', {
        input_tokens: 900,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 600 },
      }),
    ).toEqual({
      inputTokens: 900,
      cacheReadTokens: 600,
      cacheWriteTokens: 0,
    });

    expect(
      extractCacheUsage('gemini', {
        promptTokenCount: 2000,
        candidatesTokenCount: 30,
        cachedContentTokenCount: 1500,
      }),
    ).toEqual({
      inputTokens: 2000,
      cacheReadTokens: 1500,
      cacheWriteTokens: 0,
    });

    expect(extractCacheUsage('openai-chat', null)).toBeNull();
  });

  it('estimates cache savings in micro-USD using x-gateway pricing and clamps >= 0', () => {
    // claude-sonnet-4-6: input=3.0, cached=0.3, cache_creation=3.75 ($/1M tokens)
    // 1,000,000 read tokens -> savings = 1_000_000 * (3.0 - 0.3) = 2,700,000 micro-USD
    expect(estimateCacheSavingsMicroUsd('anthropic', 'claude-sonnet-4-6', 1_000_000, 0)).toBe(2_700_000);

    // Writing 1,000,000 tokens with 0 reads costs extra (3.75 - 3.0 = 0.75), clamped >= 0
    expect(estimateCacheSavingsMicroUsd('anthropic', 'claude-sonnet-4-6', 0, 1_000_000)).toBe(0);

    // Combined read + write: 1,000,000 * 2.7 - 200,000 * 0.75 = 2,550,000
    expect(estimateCacheSavingsMicroUsd('anthropic', 'claude-sonnet-4-6', 1_000_000, 200_000)).toBe(2_550_000);

    // Free model -> 0
    expect(estimateCacheSavingsMicroUsd('openrouter', 'meta/llama:free', 100_000, 0)).toBe(0);
  });

  it('aggregates stats by day, profile, and model with hitRate, requestHitRate, and estSavedUsd', () => {
    const today = new Date().toISOString().slice(0, 10);
    recordCacheUsage({
      day: today,
      profileId: 1,
      platform: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 1000,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    });
    recordCacheUsage({
      day: today,
      profileId: 1,
      platform: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    recordCacheUsage({
      day: today,
      profileId: 2,
      platform: 'openai',
      model: 'gpt-4o',
      inputTokens: 2000,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
    });

    const byDay = getCacheStats({ days: 7, groupBy: 'day' });
    expect(byDay.days).toBe(7);
    expect(byDay.groupBy).toBe('day');
    expect(byDay.rows).toHaveLength(1);
    expect(byDay.rows[0]).toMatchObject({
      key: today,
      requests: 3,
      requestsWithHit: 2,
      inputTokens: 4000,
      cacheReadTokens: 1800,
      cacheWriteTokens: 0,
    });
    expect(byDay.rows[0]!.hitRate).toBeCloseTo(1800 / 4000, 6);
    expect(byDay.rows[0]!.requestHitRate).toBeCloseTo(2 / 3, 6);
    // claude-sonnet-4-6: 800 * 2.7 = 2160 microUSD; gpt-4o (2.5 - 1.25 = 1.25): 1000 * 1.25 = 1250 microUSD -> 3410 microUSD = 0.00341 USD
    expect(byDay.rows[0]!.estSavedUsd).toBeCloseTo(0.00341, 6);

    const byProfile = getCacheStats({ days: 30, groupBy: 'profile' });
    expect(byProfile.rows.map((r) => r.key).sort()).toEqual(['1', '2']);
    const p1 = byProfile.rows.find((r) => r.key === '1')!;
    expect(p1.requests).toBe(2);
    expect(p1.requestsWithHit).toBe(1);
    expect(p1.hitRate).toBeCloseTo(800 / 2000, 6);
    expect(p1.requestHitRate).toBeCloseTo(0.5, 6);

    const byModel = getCacheStats({ days: 30, groupBy: 'model' });
    expect(byModel.rows.map((r) => r.key).sort()).toEqual([
      'anthropic/claude-sonnet-4-6',
      'openai/gpt-4o',
    ]);
  });

  it('records once per response via cacheUsageFilter, prefers upstream cache tokens, and attaches protocol cache fields', () => {
    // 1) Anthropic non-stream where route stripped cache fields, upstream context provides them
    const hAnthropic = makeHarness('/v1/messages');
    hAnthropic.res.setHeader('X-Routed-Via', 'anthropic/claude-sonnet-4-6');
    const anthropicFilter = cacheUsageFilter(1, 'anthropic', {
      res: hAnthropic.res,
      getUpstreamUsage: () => ({
        inputTokens: 1500,
        cacheReadTokens: 1000,
        cacheWriteTokens: 200,
      }),
    });
    installInterceptor(hAnthropic.req, hAnthropic.res, 'anthropic', [anthropicFilter]);
    hAnthropic.res.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 300, output_tokens: 10 },
    });

    const outBody = hAnthropic.jsonOut[0] as Record<string, unknown>;
    expect(outBody.usage).toEqual({
      input_tokens: 300,
      output_tokens: 10,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 200,
    });

    // 2) Gemini non-stream attaching cachedContentTokenCount + resolving route via getRoute
    const hGemini = makeHarness('/v1beta/models/gemini-2.5-flash:generateContent');
    const geminiFilter = cacheUsageFilter(2, 'gemini', {
      res: hGemini.res,
      getRoute: () => ({ platform: 'gemini', modelId: 'gemini-2.5-flash' }),
      getUpstreamUsage: () => ({
        inputTokens: 2000,
        cacheReadTokens: 1600,
        cacheWriteTokens: 0,
      }),
    });
    installInterceptor(hGemini.req, hGemini.res, 'gemini', [geminiFilter]);
    hGemini.res.json({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
      usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 5 },
    });
    expect((hGemini.jsonOut[0] as Record<string, unknown>).usageMetadata).toEqual({
      promptTokenCount: 2000,
      candidatesTokenCount: 5,
      cachedContentTokenCount: 1600,
    });

    // 3) Anthropic SSE streaming: message_start placeholder followed by message_delta + end()
    let streamUpstream: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null = null;
    const hStream = makeHarness('/v1/messages');
    hStream.res.setHeader('X-Routed-Via', 'anthropic/claude-sonnet-4-6');
    const streamFilter = cacheUsageFilter(3, 'anthropic', {
      res: hStream.res,
      getUpstreamUsage: () => streamUpstream,
    });
    installInterceptor(hStream.req, hStream.res, 'anthropic', [streamFilter]);
    hStream.res.write(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":500,"output_tokens":0}}}\n\n',
    );
    hStream.res.write(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    );
    streamUpstream = { inputTokens: 1200, cacheReadTokens: 900, cacheWriteTokens: 0 };
    hStream.res.write(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":300,"output_tokens":12}}\n\n',
    );
    hStream.res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    hStream.res.end();

    const stats = getCacheStats({ days: 1, groupBy: 'profile' });
    expect(stats.rows.find((r) => r.key === '1')).toMatchObject({
      requests: 1,
      requestsWithHit: 1,
      inputTokens: 1500,
      cacheReadTokens: 1000,
      cacheWriteTokens: 200,
    });
    expect(stats.rows.find((r) => r.key === '2')).toMatchObject({
      requests: 1,
      requestsWithHit: 1,
      inputTokens: 2000,
      cacheReadTokens: 1600,
      cacheWriteTokens: 0,
    });
    expect(stats.rows.find((r) => r.key === '3')).toMatchObject({
      requests: 1,
      requestsWithHit: 1,
      inputTokens: 1200,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    });
  });

  it('exposes GET /prompt-cache/stats with query validation and permission checks', async () => {
    recordCacheUsage({
      profileId: 1,
      platform: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 500,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
    });

    let activeUser: SessionUser | undefined = {
      userId: 1,
      email: 'viewer@example.com',
      role: 'member',
      isPrimary: false,
      permissions: ['view_prompt_cache'],
    };
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request & { user?: SessionUser }).user = activeUser;
      next();
    });
    app.use('/api/ai-platform', promptCacheAdminRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const ok = await fetch(`${baseUrl}/api/ai-platform/prompt-cache/stats?days=7&groupBy=model`);
      expect(ok.status).toBe(200);
      const okJson = (await ok.json()) as { days: number; groupBy: string; rows: Array<{ key: string }> };
      expect(okJson.days).toBe(7);
      expect(okJson.groupBy).toBe('model');
      expect(okJson.rows[0]?.key).toBe('anthropic/claude-sonnet-4-6');

      const badDays = await fetch(`${baseUrl}/api/ai-platform/prompt-cache/stats?days=999`);
      expect(badDays.status).toBe(400);

      const badGroup = await fetch(`${baseUrl}/api/ai-platform/prompt-cache/stats?groupBy=invalid`);
      expect(badGroup.status).toBe(400);

      activeUser = {
        userId: 2,
        email: 'other@example.com',
        role: 'member',
        isPrimary: false,
        permissions: ['view_retrieval'],
      };
      const forbidden = await fetch(`${baseUrl}/api/ai-platform/prompt-cache/stats`);
      expect(forbidden.status).toBe(403);
      const errJson = (await forbidden.json()) as { error: { code: string } };
      expect(errJson.error.code).toBe('missing_permission');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
