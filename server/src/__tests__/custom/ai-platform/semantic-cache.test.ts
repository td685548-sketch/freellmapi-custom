import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PILLARS } from '@freellmapi/shared/ai-platform.js';
import {
  DEFAULT_SEMANTIC_CACHE_CONFIG,
  SEMANTIC_CACHE_HEADER_NAME,
  SEMANTIC_CACHE_LIMITS,
  SEMANTIC_CACHE_SCORE_HEADER_NAME,
} from '@freellmapi/shared/ai-platform-semantic-cache.js';
import { createApp } from '../../../app.js';
import { getDb, initDb } from '../../../db/index.js';
import { resetFlagsCacheForTests } from '../../../custom/ai-platform/flags.js';
import { runPreRequest } from '../../../custom/ai-platform/pipeline.js';
import { publish, saveDraft } from '../../../custom/ai-platform/prompts/store.js';
import {
  canonicalJson,
  computePromptVersionHash,
  evaluateRequestContract,
  isTruncatedCompletion,
  outputContractOf,
  requestCarriesToolCalls,
  responseCarriesToolCalls,
} from '../../../custom/ai-platform/semantic-cache/contract.js';
import {
  flushSemanticCacheScope,
  getSemanticCacheSettings,
  getSemanticCacheStats,
  lookupSemanticCache,
  resetSemanticCacheForTests,
  sanitizeResponseForCache,
  setSemanticCacheEmbedderForTests,
  setSemanticCacheSettings,
  storeSemanticCacheEntry,
} from '../../../custom/ai-platform/semantic-cache/store.js';
import { hashClientProfileKey, mintClientProfileKey } from '../../../lib/system-prompt.js';
import { createSupportTenant } from '../../../custom/x-gateway/support-store.js';
import { createUser, createSession } from '../../../services/auth.js';
import { mintDashboardToken } from '../../helpers/auth.js';

function seedClientProfile(name: string): { id: number; rawKey: string } {
  const rawKey = mintClientProfileKey();
  const tokenHash = hashClientProfileKey(rawKey);
  const info = getDb()
    .prepare(
      `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, system_prompt, enabled)
       VALUES (?, ?, 'enc', 'iv', 'tag', NULL, 1)`,
    )
    .run(name, tokenHash);
  return { id: Number(info.lastInsertRowid), rawKey };
}

function makeMockExpressPair(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}) {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }

  const req = {
    method: opts.method ?? 'POST',
    originalUrl: opts.url ?? '/v1/chat/completions',
    url: opts.url ?? '/v1/chat/completions',
    path: (opts.url ?? '/v1/chat/completions').split('?')[0],
    headers,
    query: {},
    body: opts.body ?? {},
  } as unknown as Request;

  const outHeaders = new Map<string, string>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const chunks: string[] = [];
  let jsonPayload: unknown = undefined;

  const emit = (event: string) => {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) fn();
  };

  const resObj = {
    statusCode: 200,
    headersSent: false,
    writableFinished: false,
    req,
    status(code: number) {
      resObj.statusCode = code;
      return resObj;
    },
    setHeader(name: string, val: string) {
      outHeaders.set(name.toLowerCase(), String(val));
      return resObj;
    },
    getHeader(name: string) {
      return outHeaders.get(name.toLowerCase());
    },
    removeHeader(name: string) {
      outHeaders.delete(name.toLowerCase());
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return resObj;
    },
    once(event: string, fn: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]) => {
        resObj.off(event, wrapped);
        fn(...args);
      };
      return resObj.on(event, wrapped);
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
      return resObj;
    },
    write(chunk: unknown) {
      resObj.headersSent = true;
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return true;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined && typeof chunk !== 'function') {
        resObj.write(chunk);
      }
      resObj.headersSent = true;
      resObj.writableFinished = true;
      emit('finish');
      return resObj;
    },
    json(body: unknown) {
      resObj.headersSent = true;
      resObj.writableFinished = true;
      jsonPayload = body;
      emit('finish');
      return resObj;
    },
  };

  return {
    req,
    res: resObj as unknown as Response,
    getHeader: (name: string) => outHeaders.get(name.toLowerCase()),
    getJson: () => jsonPayload,
    getStreamText: () => chunks.join(''),
  };
}

describe('Spec 030 — Multi-Scope Semantic Response Cache', () => {
  let adminToken: string;
  let profileOneId: number;
  let profileOneKey: string;
  let profileTwoId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
  });

  beforeEach(() => {
    initDb(':memory:');
    resetFlagsCacheForTests();
    resetSemanticCacheForTests();
    adminToken = mintDashboardToken('semcache-admin@example.com');

    const p1 = seedClientProfile('SemCache Profile 1');
    profileOneId = p1.id;
    profileOneKey = p1.rawKey;

    const p2 = seedClientProfile('SemCache Profile 2');
    profileTwoId = p2.id;
  });

  afterEach(() => {
    resetSemanticCacheForTests();
    resetFlagsCacheForTests();
    vi.restoreAllMocks();
  });

  it('preserves the frozen 6-element PILLARS tuple and defaults semantic cache to disabled', () => {
    expect(PILLARS).toEqual([
      'prompts',
      'retrieval',
      'promptCache',
      'mcpClient',
      'outputGuard',
      'orchestrator',
    ]);
    expect(SEMANTIC_CACHE_LIMITS.defaultMinSimilarity).toBe(0.94);
    expect(SEMANTIC_CACHE_LIMITS.defaultMaxTemperature).toBe(0.2);
    expect(SEMANTIC_CACHE_LIMITS.defaultTtlSeconds).toBe(3600);
    expect(SEMANTIC_CACHE_LIMITS.defaultMaxEntries).toBe(1000);
    expect(DEFAULT_SEMANTIC_CACHE_CONFIG.enabled).toBe(false);

    const settings = getSemanticCacheSettings({ kind: 'profile', id: String(profileOneId) });
    expect(settings.enabled).toBe(false);
    expect(settings.minSimilarity).toBe(0.94);
    expect(settings.maxTemperature).toBe(0.2);
  });

  it('computes deterministic outputContractOf across response controls and generation params', () => {
    expect(outputContractOf({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })).toBeNull();
    expect(outputContractOf({ top_p: 1, n: 1, presence_penalty: 0, frequency_penalty: 0 })).toBeNull();

    const c1 = outputContractOf({
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { b: 1, a: 2 } } }],
      tool_choice: 'auto',
      response_format: { type: 'json_object' },
      text: { format: { type: 'json_schema', name: 'out' } },
      reasoning_effort: 'high',
      thinking: { type: 'enabled', budget_tokens: 2048 },
      seed: 42,
      max_tokens: 512,
      stop: ['END'],
      modalities: ['text'],
    });
    expect(c1).not.toBeNull();
    expect(c1?.tool_choice).toBe('auto');
    expect(c1?.response_format).toEqual({ type: 'json_object' });
    expect(c1?.text_format).toEqual({ type: 'json_schema', name: 'out' });
    expect(c1?.reasoning_effort).toBe('high');
    expect(c1?.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(c1?.seed).toBe(42);
    expect(c1?.max_tokens).toBe(512);
    expect(c1?.stop).toEqual(['END']);
    expect(c1?.modalities).toEqual(['text']);

    // Key-order invariance via canonicalJson
    expect(canonicalJson({ b: 2, a: { y: 1, x: 0 } })).toBe('{"a":{"x":0,"y":1},"b":2}');
  });

  it('enforces safety bypasses for temperature, headers, tool_calls, truncation, and unisolated personal vars', () => {
    const scope = { kind: 'profile' as const, id: String(profileOneId) };
    const enabledCfg = { ...DEFAULT_SEMANTIC_CACHE_CONFIG, enabled: true };

    // 1. Temperature > maxTemperature (0.2)
    const highTemp = evaluateRequestContract({
      scope,
      wire: 'openai-chat',
      model: 'gpt-4o-mini',
      body: { temperature: 0.7, messages: [{ role: 'user', content: 'Hello' }] },
      settings: enabledCfg,
    });
    expect(highTemp.bypassed).toBe(true);
    expect(highTemp.bypassReason).toBe('temperature_too_high');

    // 2. X-FreeLLM-Cache: off & semantic-off, Cache-Control: no-store
    for (const hdr of ['off', 'semantic-off']) {
      const offRes = evaluateRequestContract({
        scope,
        wire: 'openai-chat',
        model: 'gpt-4o-mini',
        body: { temperature: 0, messages: [{ role: 'user', content: 'Hello' }] },
        headers: { 'x-freellm-cache': hdr },
        settings: enabledCfg,
      });
      expect(offRes.bypassed).toBe(true);
      expect(offRes.bypassReason).toBe('cache_header_off');
    }

    const noStore = evaluateRequestContract({
      scope,
      wire: 'openai-chat',
      model: 'gpt-4o-mini',
      body: { temperature: 0, messages: [{ role: 'user', content: 'Hello' }] },
      headers: { 'cache-control': 'private, no-store' },
      settings: enabledCfg,
    });
    expect(noStore.bypassed).toBe(true);
    expect(noStore.bypassReason).toBe('cache_control_no_store');

    // 3. Request with tool_calls / function_call
    expect(
      requestCarriesToolCalls({
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
          },
        ],
      }),
    ).toBe(true);

    // 4. Response with tool_calls or truncated length
    expect(
      responseCarriesToolCalls({
        choices: [{ message: { role: 'assistant', tool_calls: [{ id: '1' }] }, finish_reason: 'tool_calls' }],
      }),
    ).toBe(true);
    expect(
      isTruncatedCompletion({
        choices: [{ message: { role: 'assistant', content: 'cut...' }, finish_reason: 'length' }],
      }),
    ).toBe(true);

    // 5. Personal x-freellm-vars without endUser isolation -> BYPASSED
    const unisolatedVars = evaluateRequestContract({
      scope,
      wire: 'openai-chat',
      model: 'gpt-4o-mini',
      body: { temperature: 0, messages: [{ role: 'user', content: 'Account summary?' }] },
      headers: { 'x-freellm-vars': JSON.stringify({ plan: 'enterprise' }) },
      endUser: 'alice',
      settings: { ...enabledCfg, isolateByEndUser: false },
    });
    expect(unisolatedVars.bypassed).toBe(true);
    expect(unisolatedVars.bypassReason).toBe('personal_vars_unisolated');

    // When isolateByEndUser: true AND endUser is present -> allowed and scoped to user:alice
    const isolatedVars = evaluateRequestContract({
      scope,
      wire: 'openai-chat',
      model: 'gpt-4o-mini',
      body: { temperature: 0, messages: [{ role: 'user', content: 'Account summary?' }] },
      headers: { 'x-freellm-vars': JSON.stringify({ plan: 'enterprise' }) },
      endUser: 'alice',
      settings: { ...enabledCfg, isolateByEndUser: true },
    });
    expect(isolatedVars.bypassed).toBe(false);
    expect(isolatedVars.endUserScope).toBe('user:alice');

    // Thinking content stripped before storage
    const sanitized = sanitizeResponseForCache({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Clean answer',
            reasoning_content: 'Secret chain of thought',
          },
        },
      ],
    });
    expect((sanitized.choices as Array<{ message: Record<string, unknown> }>)[0]!.message).toEqual({
      role: 'assistant',
      content: 'Clean answer',
    });
  });

  it('serves Tier-1 EXACT_HIT, Tier-2 SEMANTIC_HIT via Float32 cosine similarity, and invalidates on prompt publish', async () => {
    const scope = { kind: 'profile' as const, id: String(profileOneId) };
    const settings = setSemanticCacheSettings(scope, {
      enabled: true,
      semanticEnabled: true,
      minSimilarity: 0.94,
      maxTemperature: 0.2,
      ttlSeconds: 3600,
      persistToDb: true,
    });

    // Deterministic 3D embeddings:
    // q1 = [1, 0, 0]
    // q2 (paraphrase) = [0.98, 0.198997, 0] -> dot product ~ 0.98 >= 0.94
    // q3 (unrelated)  = [0, 1, 0] -> dot product = 0 < 0.94
    setSemanticCacheEmbedderForTests(async (_model, inputs) => {
      const text = inputs[0] ?? '';
      let vec = [0, 0, 1];
      if (text.includes('reset my API key')) vec = [1, 0, 0];
      else if (text.includes('rotate my API key')) vec = [0.98, 0.198997, 0];
      else if (text.includes('billing invoice')) vec = [0, 1, 0];
      return {
        family: 'test-embed-v1',
        platform: 'google',
        modelId: 'test-embed-v1',
        dimensions: 3,
        vectors: [vec],
        inputTokens: 5,
      };
    });

    const contract1 = evaluateRequestContract({
      scope,
      wire: 'openai-chat',
      model: 'gpt-4o-mini',
      body: { temperature: 0, messages: [{ role: 'user', content: 'How do I reset my API key?' }] },
      settings,
    });

    const miss1 = await lookupSemanticCache(contract1, settings);
    expect(miss1.status).toBe('MISS');
    expect(miss1.queryVector).not.toBeNull();

    storeSemanticCacheEntry({
      contract: contract1,
      settings,
      response: {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Open Keys -> Rotate.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      },
      tokensSaved: 20,
      queryVector: miss1.queryVector,
      embeddingModel: miss1.embeddingModel,
      embeddingDims: miss1.embeddingDims,
    });

    // Exact match -> Tier-1 EXACT_HIT
    const exactHit = await lookupSemanticCache(contract1, settings);
    expect(exactHit.status).toBe('EXACT_HIT');
    expect(exactHit.score).toBe(1);

    // Paraphrase -> Tier-2 SEMANTIC_HIT
    const contract2 = evaluateRequestContract({
      scope,
      wire: 'openai-chat',
      model: 'gpt-4o-mini',
      body: { temperature: 0.1, messages: [{ role: 'user', content: 'Steps to rotate my API key?' }] },
      settings,
    });
    const semHit = await lookupSemanticCache(contract2, settings);
    expect(semHit.status).toBe('SEMANTIC_HIT');
    expect(semHit.score).toBeGreaterThanOrEqual(0.94);
    expect(
      (semHit.response?.choices as Array<{ message: { content: string } }>)[0]?.message.content,
    ).toBe('Open Keys -> Rotate.');

    // Unrelated query -> MISS
    const contract3 = evaluateRequestContract({
      scope,
      wire: 'openai-chat',
      model: 'gpt-4o-mini',
      body: { temperature: 0, messages: [{ role: 'user', content: 'Download billing invoice' }] },
      settings,
    });
    const unrelatedMiss = await lookupSemanticCache(contract3, settings);
    expect(unrelatedMiss.status).toBe('MISS');

    // Different output contract (json_object) -> MISS even with identical text!
    const jsonFormatContract = evaluateRequestContract({
      scope,
      wire: 'openai-chat',
      model: 'gpt-4o-mini',
      body: {
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: 'How do I reset my API key?' }],
      },
      settings,
    });
    expect(jsonFormatContract.contractHash).not.toBe(contract1.contractHash);
    expect((await lookupSemanticCache(jsonFormatContract, settings)).status).toBe('MISS');

    // Cross-scope isolation: profileTwoId must MISS
    const otherScope = { kind: 'profile' as const, id: String(profileTwoId) };
    const otherSettings = setSemanticCacheSettings(otherScope, { enabled: true, semanticEnabled: true });
    const otherContract = evaluateRequestContract({
      scope: otherScope,
      wire: 'openai-chat',
      model: 'gpt-4o-mini',
      body: { temperature: 0, messages: [{ role: 'user', content: 'How do I reset my API key?' }] },
      settings: otherSettings,
    });
    expect((await lookupSemanticCache(otherContract, otherSettings)).status).toBe('MISS');

    // Stats check on profileOneId
    const { stats } = getSemanticCacheStats(scope);
    expect(stats.exactHits).toBe(1);
    expect(stats.semanticHits).toBe(1);
    expect(stats.misses).toBe(3);
    expect(stats.tokensSavedEst).toBe(40);
    expect(stats.entriesCount).toBe(1);

    // Publishing a new prompt version automatically changes promptVersionHash and invalidates stale hits!
    const oldPromptHash = computePromptVersionHash(scope);
    saveDraft(scope, { body: 'You are v2 support assistant.', revision: 1 }, null);
    publish(scope, 2, null);
    const newPromptHash = computePromptVersionHash(scope);
    expect(newPromptHash).not.toBe(oldPromptHash);

    const postPublishContract = evaluateRequestContract({
      scope,
      wire: 'openai-chat',
      model: 'gpt-4o-mini',
      body: { temperature: 0, messages: [{ role: 'user', content: 'How do I reset my API key?' }] },
      settings,
    });
    expect((await lookupSemanticCache(postPublishContract, settings)).status).toBe('MISS');
  });

  it('falls back cleanly to Tier-1 Exact Contract Hash when no embedding provider is configured', async () => {
    const scope = { kind: 'profile' as const, id: String(profileOneId) };
    setSemanticCacheSettings(scope, {
      enabled: true,
      semanticEnabled: true,
    });
    // Ensure no test embedder and no enabled provider keys
    setSemanticCacheEmbedderForTests(null);

    const pair1 = makeMockExpressPair({
      body: {
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [{ role: 'user', content: 'What is 2 + 2?' }],
      },
    });
    const gateProfile = { id: profileOneId, name: 'P1' } as Parameters<typeof runPreRequest>[2];

    const pre1 = await runPreRequest(pair1.req, pair1.res, gateProfile, null);
    expect(pre1).toBe('continue');
    expect(pair1.getHeader(SEMANTIC_CACHE_HEADER_NAME)).toBe('MISS');

    // Simulate upstream completion
    pair1.res.json({
      id: 'chatcmpl-exact',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: '4' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
    });

    // Second identical request hits Tier-1 Exact Contract Hash without embeddings
    const pair2 = makeMockExpressPair({
      body: {
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [{ role: 'user', content: 'What is 2 + 2?' }],
      },
    });
    const pre2 = await runPreRequest(pair2.req, pair2.res, gateProfile, null);
    expect(pre2).toBe('handled');
    expect(pair2.getHeader(SEMANTIC_CACHE_HEADER_NAME)).toBe('EXACT_HIT');
    expect(pair2.getHeader(SEMANTIC_CACHE_SCORE_HEADER_NAME)).toBeUndefined();
    expect(
      ((pair2.getJson() as { choices: Array<{ message: { content: string } }> }).choices[0]?.message
        .content),
    ).toBe('4');

    // Streaming caller against the same cached entry receives SSE stream with EXACT_HIT
    const pairStream = makeMockExpressPair({
      body: {
        model: 'gpt-4o-mini',
        temperature: 0,
        stream: true,
        messages: [{ role: 'user', content: 'What is 2 + 2?' }],
      },
    });
    const preStream = await runPreRequest(pairStream.req, pairStream.res, gateProfile, null);
    expect(preStream).toBe('handled');
    expect(pairStream.getHeader(SEMANTIC_CACHE_HEADER_NAME)).toBe('EXACT_HIT');
    expect(pairStream.getStreamText()).toContain('"content":"4"');
    expect(pairStream.getStreamText()).toContain('[DONE]');
  });

  it('serves management endpoints under /api/ai-platform/semantic-cache with RBAC and cleans up on profile delete', async () => {
    const { tenant } = createSupportTenant({ name: 'Tenant Cache Scope' });
    setSemanticCacheEmbedderForTests(async (_m, inputs) => ({
      family: 'test-embed',
      platform: 'google',
      modelId: 'test-embed',
      dimensions: 2,
      vectors: [inputs[0]?.includes('refund') ? [1, 0] : [0.99, 0.141]],
      inputTokens: 4,
    }));

    // Create viewer-only and unauthorized member tokens
    const db = getDb();
    const viewerUser = createUser('viewer-cache@example.com', 'Password123!');
    db.prepare('UPDATE users SET role = ?, is_primary = 0, permissions = ? WHERE id = ?').run(
      'member',
      JSON.stringify(['view_prompt_cache']),
      viewerUser.userId,
    );
    const viewerToken = createSession(viewerUser.userId);

    const noPermUser = createUser('noperm-cache@example.com', 'Password123!');
    db.prepare('UPDATE users SET role = ?, is_primary = 0, permissions = ? WHERE id = ?').run(
      'member',
      JSON.stringify(['view_ai_platform']),
      noPermUser.userId,
    );
    const noPermToken = createSession(noPermUser.userId);

    const app = createApp();
    const server: Server = app.listen(0, '127.0.0.1');
    if (!server.listening) {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    }
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1. Unauthorized member gets 403
      const forbiddenRes = await fetch(
        `${base}/api/ai-platform/semantic-cache/profile/${profileOneId}/settings`,
        { headers: { Authorization: `Bearer ${noPermToken}` } },
      );
      expect(forbiddenRes.status).toBe(403);

      // 2. Viewer can GET settings, cannot PUT settings (403)
      const viewerGet = await fetch(
        `${base}/api/ai-platform/semantic-cache/profile/${profileOneId}/settings`,
        { headers: { Authorization: `Bearer ${viewerToken}` } },
      );
      expect(viewerGet.status).toBe(200);

      const viewerPut = await fetch(
        `${base}/api/ai-platform/semantic-cache/profile/${profileOneId}/settings`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${viewerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ enabled: true }),
        },
      );
      expect(viewerPut.status).toBe(403);

      // 3. Admin enables semantic cache on profile & support-tenant
      const putRes = await fetch(
        `${base}/api/ai-platform/semantic-cache/profile/${profileOneId}/settings`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            enabled: true,
            semanticEnabled: true,
            minSimilarity: 0.95,
            maxTemperature: 0.3,
          }),
        },
      );
      expect(putRes.status).toBe(200);
      const putBody = (await putRes.json()) as { settings: { enabled: boolean; minSimilarity: number } };
      expect(putBody.settings.enabled).toBe(true);
      expect(putBody.settings.minSimilarity).toBe(0.95);

      // Seed an entry on profileOneId to test lookup-preview, stats, flush, and profile delete trigger
      const scope = { kind: 'profile' as const, id: String(profileOneId) };
      const curSettings = getSemanticCacheSettings(scope);
      const contract = evaluateRequestContract({
        scope,
        wire: 'openai-chat',
        model: 'auto',
        body: { temperature: 0, messages: [{ role: 'user', content: 'How do I request a refund?' }] },
        settings: curSettings,
      });
      storeSemanticCacheEntry({
        contract,
        settings: curSettings,
        response: {
          id: 'chatcmpl-refund',
          object: 'chat.completion',
          model: 'gpt-4o-mini',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Visit Billing -> Refund within 30 days.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
        },
        tokensSaved: 22,
        queryVector: new Float32Array([1, 0]),
        embeddingModel: 'test-embed',
        embeddingDims: 2,
      });

      // 4. Lookup preview returns SEMANTIC_HIT for paraphrased query without mutating metrics
      const previewRes = await fetch(
        `${base}/api/ai-platform/semantic-cache/profile/${profileOneId}/lookup-preview`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${viewerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: 'Can I get my money back?',
            model: 'auto',
            wire: 'openai-chat',
            temperature: 0,
          }),
        },
      );
      expect(previewRes.status).toBe(200);
      const previewJson = (await previewRes.json()) as {
        status: string;
        score: number;
        cachedResponsePreview: string;
      };
      expect(previewJson.status).toBe('SEMANTIC_HIT');
      expect(previewJson.score).toBeGreaterThanOrEqual(0.95);
      expect(previewJson.cachedResponsePreview).toContain('Visit Billing -> Refund');

      // Verify support-tenant URL slug works too
      const tenantStats = await fetch(
        `${base}/api/ai-platform/semantic-cache/support-tenant/${tenant.id}/stats`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );
      expect(tenantStats.status).toBe(200);

      // 5. Stats check before flush (metrics untouched by lookup-preview)
      const statsRes = await fetch(
        `${base}/api/ai-platform/semantic-cache/profile/${profileOneId}/stats`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );
      expect(statsRes.status).toBe(200);
      const statsJson = (await statsRes.json()) as {
        stats: { entriesCount: number; semanticHits: number };
      };
      expect(statsJson.stats.entriesCount).toBe(1);
      expect(statsJson.stats.semanticHits).toBe(0);

      // 6. Flush endpoint removes entries
      const flushRes = await fetch(
        `${base}/api/ai-platform/semantic-cache/profile/${profileOneId}/flush`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ resetMetrics: true }),
        },
      );
      expect(flushRes.status).toBe(200);
      const flushJson = (await flushRes.json()) as { deletedEntries: number; metricsReset: boolean };
      expect(flushJson.deletedEntries).toBe(1);
      expect(flushJson.metricsReset).toBe(true);

      // 7. Re-insert and verify client_profiles DELETE trigger cleans up semantic cache rows
      storeSemanticCacheEntry({
        contract,
        settings: curSettings,
        response: {
          choices: [{ index: 0, message: { role: 'assistant', content: 'Cached' }, finish_reason: 'stop' }],
        },
        tokensSaved: 10,
      });
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS cnt FROM custom_ai_semantic_cache_entries WHERE scope_kind = 'profile' AND scope_id = ?",
            )
            .get(String(profileOneId)) as { cnt: number }
        ).cnt,
      ).toBe(1);

      db.prepare('DELETE FROM client_profiles WHERE id = ?').run(profileOneId);
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS cnt FROM custom_ai_semantic_cache_entries WHERE scope_kind = 'profile' AND scope_id = ?",
            )
            .get(String(profileOneId)) as { cnt: number }
        ).cnt,
      ).toBe(0);
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS cnt FROM custom_ai_semantic_cache_settings WHERE scope_kind = 'profile' AND scope_id = ?",
            )
            .get(String(profileOneId)) as { cnt: number }
        ).cnt,
      ).toBe(0);

      // Ensure unused variable warning avoided for profileOneKey
      expect(profileOneKey.startsWith('sk-cp-')).toBe(true);
      flushSemanticCacheScope({ kind: 'profile', id: String(profileTwoId) });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
