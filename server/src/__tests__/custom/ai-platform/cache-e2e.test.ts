/**
 * T098 — Prompt Cache End-to-End HTTP Tests
 *
 * Covers:
 * 1. Forwarding `cache_control` intact to `explicit` destination across wires
 * 2. Stripping all `cache_control` when routed to `none` (`groq`) or `implicit` (`google`)
 * 3. Auto-placing breakpoints on tools & server system prompt while skipping volatile RAG blocks
 * 4. Failover across destination types (explicit attempt 503 -> none attempt stripped)
 * 5. Recording cache read/write tokens into stats (profile filter + unified profileId=0 direct)
 * 6. Zero-overhead / baseline parity when `promptCache` pillar flag is `false`
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { withPromptCacheRoute } from '../../../custom/ai-platform/prompt-cache/runtime.js';
import { defaultDbFactory, getDb, getUnifiedApiKey, initDb, setSetting } from '../../../db/index.js';
import { wrapTursoDatabase } from '../../../db/turso.js';
import { encrypt } from '../../../lib/crypto.js';
import { hashClientProfileKey } from '../../../lib/system-prompt.js';
import { BaseProvider } from '../../../providers/base.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setClaudeModelMap } from '../../../services/anthropic-map.js';
import { setKeyCacheTestOverride } from '../../../services/key-cache.js';
import { resetKnowledgeIndexes } from '../../../services/profile-knowledge.js';
import { getActiveProfileId } from '../../../services/profile-models.js';
import { clearAllCooldowns } from '../../../services/ratelimit.js';
import { clearAllPenalties, type RouteResult } from '../../../services/router.js';
import {
  startFakeProviderServer,
  type FakeProviderServer,
} from '../../helpers/ai-platform-fake-provider.js';

let appServer: http.Server | null = null;
let baseUrl = '';
let fakeProvider: FakeProviderServer;
const realFetch = global.fetch;

let primaryToken = '';
let unifiedKey = '';
let profileKey = '';
let profileId = 0;

function insertProfile(name: string, rawKey: string, systemPrompt: string | null = null): number {
  const res = getDb()
    .prepare(
      `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, system_prompt, enabled)
       VALUES (?, ?, 'enc', 'iv', 'tag', ?, 1)`,
    )
    .run(name, hashClientProfileKey(rawKey), systemPrompt);
  return Number(res.lastInsertRowid);
}

function seedModelsAndKeys(): void {
  setKeyCacheTestOverride(true);
  const db = getDb();

  for (const [platform, label, secret] of [
    ['openrouter', 'or-cache-e2e', 'sk-or-e2e-test'],
    ['groq', 'groq-cache-e2e', 'gsk_cache_e2e_test'],
    ['google', 'google-cache-e2e', 'AIzaCacheE2ETestKey'],
  ] as const) {
    const enc = encrypt(secret);
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES (?, ?, ?, ?, ?, 'healthy', 1)`,
    ).run(platform, label, enc.encrypted, enc.iv, enc.authTag);
  }

  // Ensure openrouter explicit model, groq none model, and google implicit model exist.
  db.prepare(
    `INSERT OR IGNORE INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools, source)
     VALUES
      ('openrouter', 'anthropic/claude-sonnet-4', 'Claude Sonnet 4 (OR)', 1, 8, 'Frontier', 60, 1000, NULL, NULL, '~10M', 200000, 1, 1, 1, 'discovered'),
      ('openrouter', 'openai/gpt-4o', 'GPT-4o (OR)', 2, 8, 'Frontier', 60, 1000, NULL, NULL, '~10M', 128000, 1, 1, 1, 'discovered'),
      ('groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 3, 10, 'Large', 30, 1000, 120000, NULL, '~10M', 128000, 1, 0, 1, 'catalog'),
      ('google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 2, 9, 'Large', 30, 1000, 1000000, NULL, '~10M', 1000000, 1, 1, 1, 'catalog')`,
  ).run();

  // Disable unrelated fallback_config & active profile_models rows and pin a clean explicit -> none -> implicit ladder.
  db.prepare(`UPDATE fallback_config SET enabled = 0`).run();
  const activeProfileId = getActiveProfileId(db);
  if (activeProfileId != null) {
    db.prepare(`UPDATE profile_models SET enabled = 0 WHERE profile_id = ?`).run(activeProfileId);
  }

  const upsertChain = (platform: string, modelId: string, priority: number) => {
    const row = db
      .prepare(`SELECT id FROM models WHERE platform = ? AND model_id = ? LIMIT 1`)
      .get(platform, modelId) as { id: number } | undefined;
    if (!row) throw new Error(`Missing model ${platform}/${modelId}`);
    db.prepare(
      `INSERT INTO fallback_config (model_db_id, priority, enabled)
       VALUES (?, ?, 1)
       ON CONFLICT(model_db_id) DO UPDATE SET priority = excluded.priority, enabled = 1`,
    ).run(row.id, priority);
    if (activeProfileId != null) {
      db.prepare(
        `INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(profile_id, model_db_id) DO UPDATE SET priority = excluded.priority, enabled = 1`,
      ).run(activeProfileId, row.id, priority);
    }
  };

  upsertChain('openrouter', 'anthropic/claude-sonnet-4', 1);
  upsertChain('groq', 'llama-3.3-70b-versatile', 2);
  upsertChain('google', 'gemini-2.5-flash', 3);

  setClaudeModelMap({ sonnet: 'anthropic/claude-sonnet-4' });
  setSetting('routing_strategy', 'priority');
}

async function adminCall(path: string, method = 'GET', body?: unknown) {
  const res = await realFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${primaryToken}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, any> | null,
  };
}

function collectCacheControlLocations(node: unknown, path = '$'): string[] {
  const found: string[] = [];
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      found.push(...collectCacheControlLocations(node[i], `${path}[${i}]`));
    }
    return found;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'cache_control') {
        found.push(path);
      } else {
        found.push(...collectCacheControlLocations(v, `${path}.${k}`));
      }
    }
  }
  return found;
}

describe('Prompt Cache E2E (T098)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.PROXY_RATE_LIMIT_RPM = '0';
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');

    fakeProvider = await startFakeProviderServer({
      kind: 'scripted',
      text: 'cache-e2e-ok',
      textChunks: ['cache-', 'e2e-ok'],
      usage: { promptTokens: 200, completionTokens: 20, totalTokens: 220 },
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await fakeProvider.close();
  });

  beforeEach(async () => {
    resetFlagsCacheForTests();
    resetKnowledgeIndexes();
    clearAllCooldowns();
    clearAllPenalties();
    fakeProvider.reset();

    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });
    seedModelsAndKeys();

    const app = createApp();
    appServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => appServer!.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;

    const ownerId = createUser('cache-owner@example.com', 'OwnerPass123!').userId;
    primaryToken = createSession(ownerId);
    unifiedKey = getUnifiedApiKey();
    profileKey = 'sk-cp-cache-e2e-profile-key-0001';
    profileId = insertProfile('cache-e2e-profile', profileKey);

    setFlags({ promptCache: true });

    vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.startsWith(baseUrl) || urlStr.startsWith(fakeProvider.url)) {
        return realFetch(input, init);
      }
      const parsed = new URL(urlStr);
      const targetUrl = `${fakeProvider.url}${parsed.pathname}${parsed.search}`;
      return realFetch(targetUrl, init);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (appServer) {
      await new Promise<void>((resolve) => appServer!.close(() => resolve()));
      appServer = null;
    }
    resetKnowledgeIndexes();
  });

  it('forwards caller cache_control intact to explicit destination across chat, anthropic, and responses wires', async () => {
    // 1. OpenAI chat completions -> OpenRouter Claude (explicit)
    const chatRes = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${profileKey}`,
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        messages: [
          {
            role: 'system',
            content: [{ type: 'text', text: 'System prefix', cache_control: { type: 'ephemeral' } }],
          },
          { role: 'user', content: 'Hello explicit chat' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
            cache_control: { type: 'ephemeral' },
          },
        ],
      }),
    });
    expect(chatRes.status).toBe(200);
    const chatUpstream = fakeProvider.requests.at(-1)?.bodyJson as Record<string, any>;
    expect(chatUpstream.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(chatUpstream.tools[0].cache_control).toEqual({ type: 'ephemeral' });

    // 2. Anthropic /v1/messages -> OpenRouter Claude (explicit)
    fakeProvider.clearRequests();
    const anthRes = await realFetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': profileKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        max_tokens: 128,
        system: [{ type: 'text', text: 'Anthropic cached system.', cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Anthropic cached user.', cache_control: { type: 'ephemeral' } }],
          },
        ],
        tools: [
          {
            name: 'lookup_sku',
            description: 'Lookup SKU',
            input_schema: { type: 'object', properties: { sku: { type: 'string' } } },
            cache_control: { type: 'ephemeral' },
          },
        ],
      }),
    });
    expect(anthRes.status).toBe(200);
    const anthUpstream = fakeProvider.requests.at(-1)?.bodyJson as Record<string, any>;
    expect(anthUpstream.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(anthUpstream.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(anthUpstream.tools[0].cache_control).toEqual({ type: 'ephemeral' });

    // 3. Responses /v1/responses -> OpenRouter Claude (explicit)
    fakeProvider.clearRequests();
    const respRes = await realFetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${profileKey}`,
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Responses cached user.', cache_control: { type: 'ephemeral' } }],
          },
        ],
        tools: [
          {
            type: 'function',
            name: 'check_stock',
            description: 'Check stock',
            parameters: { type: 'object', properties: {} },
            cache_control: { type: 'ephemeral' },
          },
        ],
      }),
    });
    expect(respRes.status).toBe(200);
    const respUpstream = fakeProvider.requests.at(-1)?.bodyJson as Record<string, any>;
    expect(respUpstream.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(respUpstream.tools[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('strips all cache_control when routed to none (groq) or implicit (google) destinations', async () => {
    const payload = {
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: 'System prefix', cache_control: { type: 'ephemeral' } }],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'User turn', cache_control: { type: 'ephemeral' } }],
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'search_docs',
            description: 'Search docs',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
          },
          cache_control: { type: 'ephemeral' },
        },
      ],
    };

    // Groq (none)
    const groqRes = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${profileKey}`,
      },
      body: JSON.stringify({ ...payload, model: 'llama-3.3-70b-versatile' }),
    });
    expect(groqRes.status).toBe(200);
    const groqUpstream = fakeProvider.requests.at(-1)?.bodyJson;
    expect(collectCacheControlLocations(groqUpstream)).toEqual([]);

    // OpenRouter openai/gpt-4o (implicit on OpenAI-compat wire)
    fakeProvider.clearRequests();
    const implicitOpenAiRes = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${profileKey}`,
      },
      body: JSON.stringify({ ...payload, model: 'openai/gpt-4o' }),
    });
    expect(implicitOpenAiRes.status).toBe(200);
    const implicitOpenAiUpstream = fakeProvider.requests.at(-1)?.bodyJson;
    expect(collectCacheControlLocations(implicitOpenAiUpstream)).toEqual([]);

    // Google (implicit)
    fakeProvider.clearRequests();
    const googleRes = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${profileKey}`,
      },
      body: JSON.stringify({ ...payload, model: 'gemini-2.5-flash' }),
    });
    expect(googleRes.status).toBe(200);
    const googleUpstream = fakeProvider.requests.at(-1)?.bodyJson;
    expect(collectCacheControlLocations(googleUpstream)).toEqual([]);
  });

  it('auto-places breakpoints on tools and long server system prompt while excluding volatile RAG passages', async () => {
    const putSettings = await adminCall('/api/ai-platform/prompt-cache/settings', 'PUT', {
      forward: true,
      autoBreakpoints: true,
    });
    expect(putSettings.status).toBe(200);

    const longSystemPrompt = 'Stable policy rules. '.repeat(250); // ~5250 chars > 1024 tokens
    const autoKey = 'sk-cp-cache-auto-bp-0001';
    const autoProfileId = insertProfile('auto-bp-profile', autoKey, longSystemPrompt);

    // Seed per-query knowledge on the profile so knowledge-inject marks it volatile
    await adminCall(`/api/client-profiles/${autoProfileId}/knowledge`, 'POST', {
      title: 'Shipping policy',
      content: 'Volatile shipping answer '.repeat(250), // long enough to trigger a breakpoint if NOT marked volatile!
    });
    await adminCall(`/api/client-profiles/${autoProfileId}/knowledge-settings`, 'PUT', {
      enabled: true,
      maxChars: 8000,
    });

    const longToolDesc = 'Detailed tool specification. '.repeat(200); // > 1024 tokens
    const res = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${autoKey}`,
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'Shipping policy?' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'order_lookup',
              description: longToolDesc,
              parameters: { type: 'object', properties: { id: { type: 'string' } } },
            },
          },
        ],
      }),
    });
    expect(res.status).toBe(200);

    const upstream = fakeProvider.requests.at(-1)?.bodyJson as Record<string, any>;
    // 1. Tool breakpoint placed
    expect(upstream.tools[0].cache_control).toEqual({ type: 'ephemeral' });

    // 2. Stable system prompt got a breakpoint, volatile knowledge block did NOT
    const systemMsgs = (upstream.messages as Array<{ role: string; content: unknown }>).filter(
      (m) => m.role === 'system',
    );
    expect(systemMsgs.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(systemMsgs[0]!.content)).toBe(true);
    expect((systemMsgs[0]!.content as Array<Record<string, unknown>>)[0]?.cache_control).toEqual({
      type: 'ephemeral',
    });

    // Volatile knowledge block must appear after the stable system prompt and carry NO cache_control
    const volatileMsg = systemMsgs.find((m) =>
      typeof m.content === 'string'
        ? m.content.includes('Volatile shipping answer')
        : JSON.stringify(m.content).includes('Volatile shipping answer'),
    );
    expect(volatileMsg).toBeDefined();
    expect(collectCacheControlLocations(volatileMsg)).toEqual([]);
  });

  it('strips cache_control on failover from explicit target (503) to none target (groq)', async () => {
    fakeProvider.enqueue(
      { kind: 'error', status: 503, message: 'OpenRouter temporary outage' },
      { kind: 'scripted', text: 'failover-groq-ok' },
    );

    const res = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${profileKey}`,
      },
      body: JSON.stringify({
        model: 'auto',
        messages: [
          {
            role: 'system',
            content: [{ type: 'text', text: 'System context', cache_control: { type: 'ephemeral' } }],
          },
          { role: 'user', content: 'Run failover test' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'ping_tool',
              description: 'Ping',
              parameters: { type: 'object', properties: {} },
            },
            cache_control: { type: 'ephemeral' },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe('failover-groq-ok');

    expect(fakeProvider.requests).toHaveLength(2);
    // Attempt 0: OpenRouter (explicit) received cache_control
    const attempt0 = fakeProvider.requests[0]!.bodyJson as Record<string, any>;
    expect(attempt0.model).toBe('anthropic/claude-sonnet-4');
    expect(attempt0.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(attempt0.tools[0].cache_control).toEqual({ type: 'ephemeral' });

    // Attempt 1: Groq (none) received body with all cache_control stripped
    const attempt1 = fakeProvider.requests[1]!.bodyJson as Record<string, any>;
    expect(attempt1.model).toBe('llama-3.3-70b-versatile');
    expect(collectCacheControlLocations(attempt1)).toEqual([]);
  });

  it('records cache read/write tokens across profile (non-stream + stream + anthropic) and unified (profileId=0) traffic', async () => {
    // 1. Profile non-stream OpenAI chat with cachedTokens
    fakeProvider.enqueue({
      kind: 'scripted',
      text: 'cached-chat-reply',
      usage: { promptTokens: 2000, completionTokens: 40, totalTokens: 2040, cachedTokens: 1500 },
    });
    const r1 = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${profileKey}` },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'Hi 1' }],
      }),
    });
    expect(r1.status).toBe(200);

    // 2. Profile non-stream Anthropic /v1/messages with cache_read + cache_creation
    fakeProvider.enqueue({
      kind: 'raw',
      status: 200,
      body: {
        id: 'chatcmpl-anth-cache',
        object: 'chat.completion',
        created: 1700000000,
        model: 'anthropic/claude-sonnet-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'anth-cache-ok' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 2000,
          completion_tokens: 50,
          total_tokens: 2050,
          cache_read_input_tokens: 1200,
          cache_creation_input_tokens: 300,
        },
      },
    });
    const r2 = await realFetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': profileKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Hi 2' }],
      }),
    });
    expect(r2.status).toBe(200);
    const r2Json = (await r2.json()) as { usage: Record<string, number> };
    expect(r2Json.usage.cache_read_input_tokens).toBe(1200);
    expect(r2Json.usage.cache_creation_input_tokens).toBe(300);

    // 3. Profile streaming OpenAI chat with cachedTokens
    fakeProvider.enqueue({
      kind: 'scripted',
      stream: true,
      textChunks: ['stream-', 'hit'],
      usage: { promptTokens: 1000, completionTokens: 20, totalTokens: 1020, cachedTokens: 800 },
    });
    const r3 = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${profileKey}` },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        stream: true,
        messages: [{ role: 'user', content: 'Hi 3' }],
      }),
    });
    expect(r3.status).toBe(200);
    await r3.text();

    // 4. Unified key non-stream OpenAI chat (profileId = 0 direct tracking)
    fakeProvider.enqueue({
      kind: 'scripted',
      text: 'unified-hit',
      usage: { promptTokens: 1000, completionTokens: 10, totalTokens: 1010, cachedTokens: 500 },
    });
    const r4 = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${unifiedKey}` },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'Hi 4' }],
      }),
    });
    expect(r4.status).toBe(200);

    // Query stats grouped by profile — must show profileId (3 requests, no double count!) and 0 (1 request)
    const statsProfile = await adminCall('/api/ai-platform/prompt-cache/stats?days=30&groupBy=profile');
    expect(statsProfile.status).toBe(200);
    const rows = statsProfile.body?.rows as Array<Record<string, any>>;
    const profRow = rows.find((r) => r.key === String(profileId));
    expect(profRow).toBeDefined();
    expect(profRow!.requests).toBe(3);
    expect(profRow!.requestsWithHit).toBe(3);
    expect(profRow!.cacheReadTokens).toBe(1500 + 1200 + 800);
    expect(profRow!.cacheWriteTokens).toBe(300);
    expect(profRow!.estSavedUsd).toBeGreaterThan(0);

    const unifiedRow = rows.find((r) => r.key === '0');
    expect(unifiedRow).toBeDefined();
    expect(unifiedRow!.requests).toBe(1);
    expect(unifiedRow!.cacheReadTokens).toBe(500);

    // Query stats grouped by model
    const statsModel = await adminCall('/api/ai-platform/prompt-cache/stats?days=30&groupBy=model');
    expect(statsModel.status).toBe(200);
    const modelRow = (statsModel.body?.rows as Array<Record<string, any>>).find(
      (r) => r.key === 'openrouter/anthropic/claude-sonnet-4',
    );
    expect(modelRow).toBeDefined();
    expect(modelRow!.requests).toBe(4);
    expect(modelRow!.cacheReadTokens).toBe(4000);
  });

  it('preserves baseline behavior and route identity when promptCache flag is false', async () => {
    setFlags({ promptCache: false });

    const dummyRoute = {
      provider: Object.create(BaseProvider.prototype),
      modelId: 'llama-3.3-70b-versatile',
      modelDbId: 1,
      apiKey: 'k',
      keyId: 1,
      keyLabel: null,
      platform: 'groq',
      displayName: 'Llama',
      contextWindow: 128000,
      endpointScope: '',
      rpdLimit: null,
      tpdLimit: null,
    } as RouteResult;
    expect(withPromptCacheRoute(dummyRoute)).toBe(dummyRoute);

    // Send request with cache_control to groq (none): when pillar is off, message-level cache_control block is NOT stripped
    const res = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${profileKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: [{ type: 'text', text: 'Untouched system block', cache_control: { type: 'ephemeral' } }],
          },
          { role: 'user', content: 'Hello baseline' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const upstream = fakeProvider.requests.at(-1)?.bodyJson as Record<string, any>;
    expect(upstream.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});
