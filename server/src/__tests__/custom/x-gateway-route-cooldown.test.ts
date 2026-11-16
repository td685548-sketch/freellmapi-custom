import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createCombo, invalidateConfigCache, setEnabled } from '../../custom/x-gateway/config.js';
import {
  clearAccountCooldown,
  getAccountCooldown,
  setAccountCooldown,
} from '../../custom/provider-accounts/auto-ping.js';
import { invalidateXGatewayKeyCache } from '../../custom/provider-accounts/store.js';
import {
  AUTH_COOLDOWN_MS,
  BACKOFF_BASE_MS,
  NOT_ALLOWED_COOLDOWN_MS,
  TRANSIENT_COOLDOWN_MS,
  classifyRouteError,
  recordCandidateFailure,
  recordCandidateSuccess,
  resetRouteBackoff,
} from '../../custom/x-gateway/route-cooldown.js';
import {
  resetRouteHealth,
  resetSessionPins,
  resolveCandidateRoutes,
} from '../../custom/x-gateway/router.js';
import { mintXGatewayClientKey } from '../../custom/x-gateway/client-keys.js';
import { createUser } from '../../services/auth.js';

process.env.ENCRYPTION_KEY = '0'.repeat(64);

let secret: { encrypted: string; iv: string; authTag: string } | null = null;

function seedAccount(provider: string, label: string, modelId: string): number {
  secret ??= encrypt(`sk-${label}`);
  const info = getDb().prepare(`INSERT INTO x_gateway_keys
    (provider,label,auth_method,encrypted_key,iv,auth_tag,models_json,status,enabled)
    VALUES (?,?,'api_key',?,?,?,?,'healthy',1)`)
    .run(
      provider,
      label,
      secret.encrypted,
      secret.iv,
      secret.authTag,
      JSON.stringify([{ id: modelId, name: modelId }]),
    );
  invalidateXGatewayKeyCache();
  return Number(info.lastInsertRowid);
}

describe('9router-style error classification, backoff, and recovery', () => {
  beforeEach(() => {
    initDb(':memory:');
    invalidateConfigCache();
    invalidateXGatewayKeyCache();
    resetRouteHealth();
    resetRouteBackoff();
    resetSessionPins();
  });

  it('classifies rate-limit, auth, not-allowed, request-scoped 4xx, and transient errors', () => {
    expect(classifyRouteError(Object.assign(new Error('Too many requests'), { status: 429 }))).toMatchObject({
      shouldFallback: true,
      requestScoped: false,
      useBackoff: true,
      reason: 'rate_limit',
    });
    expect(classifyRouteError(new Error('Upstream quota exceeded for this key'))).toMatchObject({
      shouldFallback: true,
      requestScoped: false,
      useBackoff: true,
      reason: 'rate_limit',
    });
    expect(classifyRouteError(Object.assign(new Error('Invalid API key'), { status: 401 }))).toMatchObject({
      shouldFallback: true,
      requestScoped: false,
      cooldownMs: AUTH_COOLDOWN_MS,
    });
    expect(classifyRouteError(new Error('Request not allowed for this region'))).toMatchObject({
      shouldFallback: true,
      requestScoped: false,
      cooldownMs: NOT_ALLOWED_COOLDOWN_MS,
    });
    expect(classifyRouteError(Object.assign(new Error('Invalid JSON schema in messages'), { status: 400 }))).toMatchObject({
      shouldFallback: false,
      requestScoped: true,
      cooldownMs: 0,
      reason: 'request_scoped',
    });
    expect(classifyRouteError(Object.assign(new Error('Bad gateway'), { status: 502 }))).toMatchObject({
      shouldFallback: true,
      requestScoped: false,
      cooldownMs: TRANSIENT_COOLDOWN_MS,
      reason: 'transient',
    });
  });

  it('applies exponential backoff on 429s, preserves longer Retry-After, and resets on success', () => {
    const a = seedAccount('groq', 'g1', 'llama-3.3-70b-versatile');
    clearAccountCooldown(a);

    recordCandidateFailure(a, 'llama-3.3-70b-versatile', Object.assign(new Error('429'), { status: 429 }));
    const first = getAccountCooldown(a, 'llama-3.3-70b-versatile');
    expect(first.inCooldown).toBe(true);
    expect(first.remainingMs).toBeLessThanOrEqual(BACKOFF_BASE_MS);
    expect(first.remainingMs).toBeGreaterThan(1_000);

    recordCandidateFailure(a, 'llama-3.3-70b-versatile', Object.assign(new Error('429'), { status: 429 }));
    const second = getAccountCooldown(a, 'llama-3.3-70b-versatile');
    expect(second.remainingMs).toBeGreaterThan(2_500);
    expect(second.remainingMs).toBeLessThanOrEqual(BACKOFF_BASE_MS * 2);

    // Preserve a longer Retry-After cooldown already recorded by quota tracking.
    setAccountCooldown(a, 45_000, 'llama-3.3-70b-versatile', 'HTTP 429');
    recordCandidateFailure(a, 'llama-3.3-70b-versatile', Object.assign(new Error('429'), { status: 429 }));
    expect(getAccountCooldown(a, 'llama-3.3-70b-versatile').remainingMs).toBeGreaterThan(40_000);

    // Success clears cooldown and resets backoff level back to base.
    recordCandidateSuccess(a, 'llama-3.3-70b-versatile');
    expect(getAccountCooldown(a, 'llama-3.3-70b-versatile').inCooldown).toBe(false);
    recordCandidateFailure(a, 'llama-3.3-70b-versatile', Object.assign(new Error('429'), { status: 429 }));
    expect(getAccountCooldown(a, 'llama-3.3-70b-versatile').remainingMs).toBeLessThanOrEqual(BACKOFF_BASE_MS);
  });

  it('filters cooled-down candidates in resolveCandidateRoutes and reports allRateLimited', () => {
    const a = seedAccount('groq', 'g1', 'llama-3.3-70b-versatile');
    const b = seedAccount('groq', 'g2', 'llama-3.3-70b-versatile');
    clearAccountCooldown(a);
    clearAccountCooldown(b);

    setAccountCooldown(a, 20_000, 'llama-3.3-70b-versatile', '429');
    const partial = resolveCandidateRoutes('groq/llama-3.3-70b-versatile');
    expect(partial.candidates.map(c => c.account.id)).toEqual([b]);
    expect(partial.allRateLimited).toBeUndefined();

    setAccountCooldown(b, 15_000, 'llama-3.3-70b-versatile', '429');
    const none = resolveCandidateRoutes('groq/llama-3.3-70b-versatile');
    expect(none.candidates).toEqual([]);
    expect(none.allRateLimited).toBe(true);
    expect(none.retryAfterMs).toBeGreaterThan(10_000);
    expect(none.retryAfterMs).toBeLessThanOrEqual(15_000);

    clearAccountCooldown(a);
    clearAccountCooldown(b);
  });
});

describe('x-gateway HTTP cooldown skipping, recovery, and request-scoped 4xx', () => {
  let server: Server;
  let base: string;
  let apiKey: string;
  const realFetch = global.fetch;
  const upstream = vi.fn();

  beforeAll(async () => {
    initDb(':memory:');
    invalidateConfigCache();
    invalidateXGatewayKeyCache();
    const { userId } = createUser('rot-admin@example.test', 'AdminPass123!', 'admin');
    apiKey = mintXGatewayClientKey(userId, 'rot-key').key;
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    vi.spyOn(global, 'fetch').mockImplementation((url, init) =>
      String(url).startsWith(base) ? realFetch(url, init) : upstream(url, init),
    );
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    initDb(':memory:');
    invalidateConfigCache();
    invalidateXGatewayKeyCache();
    resetRouteHealth();
    resetRouteBackoff();
    resetSessionPins();
    setEnabled(true);
    const { userId } = createUser('rot-admin@example.test', 'AdminPass123!', 'admin');
    apiKey = mintXGatewayClientKey(userId, 'rot-key').key;
    upstream.mockReset();
  });

  const chat = (model: string) =>
    realFetch(`${base}/thruline/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    });

  const okResponse = (model: string) =>
    new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('cools down a 429 account, skips it on subsequent requests, and returns 503 with Retry-After when all cool down', async () => {
    const a = seedAccount('groq', 'groq-1', 'llama-3.3-70b-versatile');
    const b = seedAccount('openai', 'openai-1', 'gpt-5.4-mini');
    clearAccountCooldown(a);
    clearAccountCooldown(b);
    createCombo('failover', [
      { platform: 'groq', modelId: 'llama-3.3-70b-versatile' },
      { platform: 'openai', modelId: 'gpt-5.4-mini' },
    ], undefined, { strategy: 'fallback' });

    upstream.mockImplementation(async (url: string) => {
      if (String(url).includes('groq.com')) {
        return new Response(JSON.stringify({ error: { message: 'rate limit' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '20' },
        });
      }
      return okResponse('gpt-5.4-mini');
    });

    // First request tries groq (429), fails over to openai (200).
    const res1 = await chat('combo:failover');
    expect(res1.status).toBe(200);
    expect(res1.headers.get('x-routed-via')).toBe('openai/gpt-5.4-mini');
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(getAccountCooldown(a, 'llama-3.3-70b-versatile').inCooldown).toBe(true);

    // Second request skips cooled-down groq immediately (only 1 upstream call).
    upstream.mockClear();
    const res2 = await chat('combo:failover');
    expect(res2.status).toBe(200);
    expect(res2.headers.get('x-routed-via')).toBe('openai/gpt-5.4-mini');
    expect(upstream).toHaveBeenCalledTimes(1);

    // Put openai in cooldown too -> 503 all_rate_limited with Retry-After.
    setAccountCooldown(b, 12_000, 'gpt-5.4-mini', '429');
    const res3 = await chat('combo:failover');
    expect(res3.status).toBe(503);
    expect(Number(res3.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    const body3 = await res3.json() as { error: { code: string; retry_after_ms: number } };
    expect(body3.error.code).toBe('all_rate_limited');
    expect(body3.error.retry_after_ms).toBeGreaterThan(0);

    clearAccountCooldown(a);
    clearAccountCooldown(b);
  });

  it('skips same-provider rotation on request-scoped 400 without cooling down, while still falling back across combo providers', async () => {
    const g1 = seedAccount('groq', 'groq-1', 'llama-3.3-70b-versatile');
    const g2 = seedAccount('groq', 'groq-2', 'llama-3.3-70b-versatile');
    const o1 = seedAccount('openai', 'openai-1', 'gpt-5.4-mini');
    clearAccountCooldown(g1);
    clearAccountCooldown(g2);
    clearAccountCooldown(o1);

    createCombo('cross-provider', [
      { platform: 'groq', modelId: 'llama-3.3-70b-versatile' },
      { platform: 'openai', modelId: 'gpt-5.4-mini' },
    ], undefined, { strategy: 'fallback' });

    upstream.mockImplementation(async (url: string) => {
      if (String(url).includes('groq.com')) {
        return new Response(JSON.stringify({ error: { message: 'Invalid request parameter' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return okResponse('gpt-5.4-mini');
    });

    const res = await chat('combo:cross-provider');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-routed-via')).toBe('openai/gpt-5.4-mini');
    // Called g1 (400), skipped g2 (same provider), called o1 (200) -> 2 calls total.
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(getAccountCooldown(g1, 'llama-3.3-70b-versatile').inCooldown).toBe(false);
    expect(getAccountCooldown(g2, 'llama-3.3-70b-versatile').inCooldown).toBe(false);
  });
});
