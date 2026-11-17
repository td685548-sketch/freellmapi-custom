import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@freellmapi/shared/types.js';

interface RecordedAttempt {
  modelId: string;
  messages: ChatMessage[];
}

const recordedAttempts: RecordedAttempt[] = [];

const chatCompletion = vi.fn(async (_apiKey: string, messages: ChatMessage[], modelId: string) => {
  recordedAttempts.push({
    modelId,
    messages: JSON.parse(JSON.stringify(messages)) as ChatMessage[],
  });
  if (modelId === 'large-131k') {
    throw Object.assign(new Error('Upstream 503 service unavailable'), {
      status: 503,
      providerRejection: 'upstream' as const,
    });
  }
  return {
    id: `chatcmpl_${modelId}`,
    object: 'chat.completion',
    created: 1700000000,
    model: modelId,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok from 8k fallback' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1200, completion_tokens: 8, total_tokens: 1208 },
  };
});

const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'groq', chatCompletion, streamChatCompletion } as any;

vi.mock('../../../providers/index.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
  };
});

const { createApp } = await import('../../../app.js');
const { defaultDbFactory, getDb, initDb } = await import('../../../db/index.js');
const { wrapTursoDatabase } = await import('../../../db/turso.js');
const { encrypt } = await import('../../../lib/crypto.js');
const { createSession, createUser } = await import('../../../services/auth.js');
const { setKeyCacheTestOverride } = await import('../../../services/key-cache.js');
const { invalidateModelListingCache } = await import('../../../services/model-listing.js');
const { clearAllCooldowns } = await import('../../../services/ratelimit.js');
const { setRoutingStrategy } = await import('../../../services/router.js');
const { saveContextPolicy } = await import('../../../custom/context-budget/policy.js');
const { estimateMessagesTokens } = await import('../../../custom/context-budget/estimate.js');
const { appendTurn } = await import('../../../services/profile-conversations.js');

describe('context-budget surface fallback & refit across /v1/chat/completions and /v1/messages (T019)', () => {
  let server: Server;
  let baseUrl: string;
  const realFetch = global.fetch;
  let ownerToken: string;
  let profileId: number;
  let profileKey: string;

  async function requestJson(
    path: string,
    opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const res = await realFetch(`${baseUrl}${path}`, {
      method: opts.method ?? 'POST',
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, headers: res.headers, body };
  }

  function seed200Turns(convKey: string): void {
    const convSettings = {
      enabled: true,
      ttlHours: 168,
      maxMessages: 100,
      maxChars: 100_000,
      summarize: false,
    };
    let convId: number | null = null;
    const pad = 'detail '.repeat(55); // ~400 chars (~100 tokens) per message -> 100 candidate msgs ~10,000+ tokens
    for (let t = 0; t < 200; t++) {
      convId = appendTurn(
        profileId,
        convKey,
        null,
        convId,
        [{ role: 'user', content: `Turn ${t} user ${pad}` }],
        `Turn ${t} assistant ${pad}`,
        convSettings,
      );
    }
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    vi.stubEnv('PROXY_RATE_LIMIT_RPM', '0');
    setKeyCacheTestOverride(true);
    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });

    const encGroq = encrypt('gsk_surf_groq');
    const encCerebras = encrypt('csk_surf_cerebras');
    const db = getDb();
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES ('groq', 'surf-groq', ?, ?, ?, 'healthy', 1)`,
    ).run(encGroq.encrypted, encGroq.iv, encGroq.authTag);
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES ('cerebras', 'surf-cerebras', ?, ?, ?, 'healthy', 1)`,
    ).run(encCerebras.encrypted, encCerebras.iv, encCerebras.authTag);

    db.prepare('UPDATE models SET enabled = 0').run();
    db.prepare('UPDATE fallback_config SET enabled = 0').run();
    db.prepare('UPDATE profile_models SET enabled = 0').run();
    const largeRes = db
      .prepare(
        `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, context_window, enabled)
         VALUES ('groq', 'large-131k', 'Large 131k', 1, 1, 'Large', 131072, 1)`,
      )
      .run();
    const smallRes = db
      .prepare(
        `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, context_window, enabled)
         VALUES ('cerebras', 'small-8k', 'Small 8k', 10, 10, 'Small', 8192, 1)`,
      )
      .run();
    const largeId = Number(largeRes.lastInsertRowid);
    const smallId = Number(smallRes.lastInsertRowid);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(largeId);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)').run(smallId);
    const profiles = db.prepare('SELECT id FROM profiles').all() as Array<{ id: number }>;
    for (const p of profiles) {
      db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)').run(
        p.id,
        largeId,
      );
      db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 2, 1)').run(
        p.id,
        smallId,
      );
    }
    setRoutingStrategy('priority');
    invalidateModelListingCache();

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const ownerId = createUser('surf-owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);

    const created = await requestJson('/api/client-profiles', {
      method: 'POST',
      token: ownerToken,
      body: { name: 'surf-profile', systemPrompt: 'You are a helpful assistant.' },
    });
    profileId = created.body.id;
    profileKey = created.body.key;

    await requestJson(`/api/client-profiles/${profileId}/quota`, {
      method: 'PUT',
      token: ownerToken,
      body: { rpmLimit: null },
    });
    await requestJson(`/api/client-profiles/${profileId}/conversation-settings`, {
      method: 'PUT',
      token: ownerToken,
      body: {
        enabled: true,
        ttlHours: 168,
        maxMessages: 100,
        maxChars: 100_000,
        summarize: false,
      },
    });
  });

  afterEach(() => {
    clearAllCooldowns();
    recordedAttempts.length = 0;
    chatCompletion.mockClear();
    const db = getDb();
    db.prepare('DELETE FROM custom_conversation_messages').run();
    db.prepare('DELETE FROM custom_conversations').run();
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setKeyCacheTestOverride(null);
  });

  it('refits a 200-turn server conversation on /v1/chat/completions when 131k primary returns 503 and falls back to 8192', async () => {
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 16000,
      outputReserveTokens: 1024,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 25,
      dropBlockTurns: 4,
      summarize: false,
      clientHistoryMode: 'passthrough',
    });
    seed200Turns('surf-chat-200');

    const res = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-conversation-id': 'surf-chat-200' },
      body: {
        model: 'auto',
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Summarize the latest topic.' },
        ],
      },
    });

    expect(res.status).toBe(200);
    expect(recordedAttempts).toHaveLength(2);
    expect(recordedAttempts[0]!.modelId).toBe('large-131k');
    expect(recordedAttempts[1]!.modelId).toBe('small-8k');

    const effective8kBudget = Math.floor((8192 - 1024) * 0.9);
    const smallAttemptTokens = estimateMessagesTokens(recordedAttempts[1]!.messages, { platform: 'cerebras' });
    expect(smallAttemptTokens).toBeLessThanOrEqual(effective8kBudget);
    expect(recordedAttempts[1]!.messages.length).toBeLessThan(recordedAttempts[0]!.messages.length);

    // X-Conversation-History reflects actual history messages sent to the serving 8k model
    const historySentCount = recordedAttempts[1]!.messages.filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && m.content !== 'Summarize the latest topic.',
    ).length;
    expect(res.headers.get('x-conversation-history')).toBe(String(historySentCount));

    const ctxHeader = res.headers.get('x-freellm-context');
    if (ctxHeader !== null) {
      expect(ctxHeader).toMatch(/\brefits=1\b/);
    }
  });

  it('refits a 200-turn server conversation on /v1/messages when 131k primary returns 503 and falls back to 8192', async () => {
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 16000,
      outputReserveTokens: 1024,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 25,
      dropBlockTurns: 4,
      summarize: false,
      clientHistoryMode: 'passthrough',
    });
    seed200Turns('surf-anth-200');

    const res = await requestJson('/v1/messages', {
      token: profileKey,
      headers: {
        'x-conversation-id': 'surf-anth-200',
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: 'auto',
        max_tokens: 1024,
        system: 'Be concise.',
        messages: [{ role: 'user', content: 'Summarize the latest topic.' }],
      },
    });

    expect(res.status).toBe(200);
    expect(recordedAttempts).toHaveLength(2);
    expect(recordedAttempts[0]!.modelId).toBe('large-131k');
    expect(recordedAttempts[1]!.modelId).toBe('small-8k');

    const effective8kBudget = Math.floor((8192 - 1024) * 0.9);
    const smallAttemptTokens = estimateMessagesTokens(recordedAttempts[1]!.messages, { platform: 'cerebras' });
    expect(smallAttemptTokens).toBeLessThanOrEqual(effective8kBudget);
    expect(recordedAttempts[1]!.messages.length).toBeLessThan(recordedAttempts[0]!.messages.length);

    const historySentCount = recordedAttempts[1]!.messages.filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && m.content !== 'Summarize the latest topic.',
    ).length;
    expect(res.headers.get('x-conversation-history')).toBe(String(historySentCount));

    const ctxHeader = res.headers.get('x-freellm-context');
    if (ctxHeader !== null) {
      expect(ctxHeader).toMatch(/\brefits=1\b/);
    }
  });
});
