import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

interface CapturedProviderCall {
  modelId: string;
  messages: unknown[];
  options: Record<string, unknown>;
}

const capturedCalls: CapturedProviderCall[] = [];

const chatCompletion = vi.fn(
  async (_apiKey: string, messages: unknown[], modelId: string, options: Record<string, unknown> = {}) => {
    capturedCalls.push(JSON.parse(JSON.stringify({ modelId, messages, options })) as CapturedProviderCall);
    return {
      id: 'chatcmpl_reg_1',
      object: 'chat.completion',
      created: 1700000000,
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'baseline reply' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
    };
  },
);

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
const { appendTurn } = await import('../../../services/profile-conversations.js');

describe('context-budget disabled regression across all 4 surfaces (SC-006)', () => {
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

  function seedStoredConversation(convKey: string): void {
    const convSettings = {
      enabled: true,
      ttlHours: 168,
      maxMessages: 20,
      maxChars: 12000,
      summarize: false,
    };
    const cid1 = appendTurn(
      profileId,
      convKey,
      null,
      null,
      [{ role: 'user', content: 'Stored turn 1 user' }],
      'Stored turn 1 assistant',
      convSettings,
    );
    appendTurn(
      profileId,
      convKey,
      null,
      cid1,
      [{ role: 'user', content: 'Stored turn 2 user' }],
      'Stored turn 2 assistant',
      convSettings,
    );
  }

  async function runAllFourSurfaces(convPrefix: string) {
    const convChat = `${convPrefix}-chat`;
    const convAnthropic = `${convPrefix}-anth`;
    seedStoredConversation(convChat);
    seedStoredConversation(convAnthropic);

    // 1. /v1/chat/completions
    capturedCalls.length = 0;
    const chatRes = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-conversation-id': convChat },
      body: {
        model: 'auto',
        max_tokens: 256,
        messages: [
          { role: 'system', content: 'App chat instructions.' },
          { role: 'user', content: 'Current chat question' },
        ],
      },
    });
    const chatPayload = JSON.stringify(capturedCalls[0]);

    // 2. /v1/messages (Anthropic)
    capturedCalls.length = 0;
    const anthRes = await requestJson('/v1/messages', {
      token: profileKey,
      headers: {
        'x-conversation-id': convAnthropic,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: 'auto',
        max_tokens: 256,
        system: 'App anthropic instructions.',
        messages: [{ role: 'user', content: 'Current anthropic question' }],
      },
    });
    const anthPayload = JSON.stringify(capturedCalls[0]);

    // 3. /v1/responses
    capturedCalls.length = 0;
    const respRes = await requestJson('/v1/responses', {
      token: profileKey,
      body: {
        model: 'auto',
        max_output_tokens: 256,
        instructions: 'Responses app instructions.',
        input: 'Current responses question',
      },
    });
    const respPayload = JSON.stringify(capturedCalls[0]);

    // 4. Gemini :generateContent
    capturedCalls.length = 0;
    const gemRes = await requestJson('/v1beta/models/auto:generateContent', {
      headers: { 'x-goog-api-key': profileKey },
      body: {
        systemInstruction: { parts: [{ text: 'Gemini app instructions.' }] },
        contents: [{ role: 'user', parts: [{ text: 'Current gemini question' }] }],
        generationConfig: { maxOutputTokens: 256 },
      },
    });
    const gemPayload = JSON.stringify(capturedCalls[0]);

    return {
      chat: { res: chatRes, payload: chatPayload },
      anthropic: { res: anthRes, payload: anthPayload },
      responses: { res: respRes, payload: respPayload },
      gemini: { res: gemRes, payload: gemPayload },
    };
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    vi.stubEnv('PROXY_RATE_LIMIT_RPM', '0');
    setKeyCacheTestOverride(true);
    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });

    const enc = encrypt('gsk_reg_test');
    const db = getDb();
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES ('groq', 'reg-key', ?, ?, ?, 'healthy', 1)`,
    ).run(enc.encrypted, enc.iv, enc.authTag);
    db.prepare('UPDATE models SET enabled = 0').run();
    db.prepare('UPDATE fallback_config SET enabled = 0').run();
    db.prepare('UPDATE profile_models SET enabled = 0').run();
    const inserted = db
      .prepare(
        `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, context_window, enabled)
         VALUES ('groq', 'reg-model-32k', 'Regression 32k', 1, 1, 'Medium', 32768, 1)`,
      )
      .run();
    const modelDbId = Number(inserted.lastInsertRowid);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(modelDbId);
    const profiles = db.prepare('SELECT id FROM profiles').all() as Array<{ id: number }>;
    for (const p of profiles) {
      db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)').run(
        p.id,
        modelDbId,
      );
    }
    setRoutingStrategy('priority');
    invalidateModelListingCache();

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const ownerId = createUser('reg-owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);

    const created = await requestJson('/api/client-profiles', {
      method: 'POST',
      token: ownerToken,
      body: { name: 'reg-profile', systemPrompt: 'Enforced profile prompt.' },
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
        maxMessages: 20,
        maxChars: 12000,
        summarize: false,
      },
    });
  });

  afterEach(() => {
    clearAllCooldowns();
    capturedCalls.length = 0;
    chatCompletion.mockClear();
    const db = getDb();
    db.prepare('DELETE FROM custom_conversation_messages').run();
    db.prepare('DELETE FROM custom_conversations').run();
    db.prepare('DELETE FROM custom_context_policies').run();
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setKeyCacheTestOverride(null);
  });

  it('produces byte-for-byte identical provider payloads, no X-FreeLLM-Context header, and unchanged X-Conversation-History when policy is disabled', async () => {
    // Run with default inherited policy (enabled: false, no row in custom_context_policies)
    const inheritedOff = await runAllFourSurfaces('inherited');

    // Run with an explicit disabled policy row
    saveContextPolicy(profileId, { enabled: false, preset: 'balanced' });
    const explicitOff = await runAllFourSurfaces('explicit');

    for (const key of ['chat', 'anthropic', 'responses', 'gemini'] as const) {
      expect(inheritedOff[key].res.status).toBe(200);
      expect(explicitOff[key].res.status).toBe(200);
      expect(inheritedOff[key].res.headers.get('x-freellm-context')).toBeNull();
      expect(explicitOff[key].res.headers.get('x-freellm-context')).toBeNull();
      expect(Buffer.from(inheritedOff[key].payload, 'utf8').equals(Buffer.from(explicitOff[key].payload, 'utf8'))).toBe(
        true,
      );
    }

    // Stored conversation surfaces keep exact X-Conversation-History count
    expect(inheritedOff.chat.res.headers.get('x-conversation-history')).toBe('4');
    expect(explicitOff.chat.res.headers.get('x-conversation-history')).toBe('4');
    expect(inheritedOff.anthropic.res.headers.get('x-conversation-history')).toBe('4');
    expect(explicitOff.anthropic.res.headers.get('x-conversation-history')).toBe('4');

    // Verify exact pre-021 baseline messages on all 4 surfaces
    const chatParsed = JSON.parse(inheritedOff.chat.payload) as CapturedProviderCall;
    expect(chatParsed.messages).toEqual([
      { role: 'system', content: 'Enforced profile prompt.' },
      { role: 'system', content: 'App chat instructions.' },
      { role: 'user', content: 'Stored turn 1 user' },
      { role: 'assistant', content: 'Stored turn 1 assistant' },
      { role: 'user', content: 'Stored turn 2 user' },
      { role: 'assistant', content: 'Stored turn 2 assistant' },
      { role: 'user', content: 'Current chat question' },
    ]);

    const anthParsed = JSON.parse(inheritedOff.anthropic.payload) as CapturedProviderCall;
    expect(anthParsed.messages).toEqual([
      { role: 'system', content: 'Enforced profile prompt.' },
      { role: 'system', content: 'App anthropic instructions.' },
      { role: 'user', content: 'Stored turn 1 user' },
      { role: 'assistant', content: 'Stored turn 1 assistant' },
      { role: 'user', content: 'Stored turn 2 user' },
      { role: 'assistant', content: 'Stored turn 2 assistant' },
      { role: 'user', content: 'Current anthropic question' },
    ]);

    const respParsed = JSON.parse(inheritedOff.responses.payload) as CapturedProviderCall;
    expect(respParsed.messages).toEqual([
      { role: 'system', content: 'Enforced profile prompt.' },
      { role: 'system', content: 'Responses app instructions.' },
      { role: 'user', content: 'Current responses question' },
    ]);

    const gemParsed = JSON.parse(inheritedOff.gemini.payload) as CapturedProviderCall;
    expect(gemParsed.messages).toEqual([
      { role: 'system', content: 'Enforced profile prompt.' },
      { role: 'system', content: 'Gemini app instructions.' },
      { role: 'user', content: [{ type: 'text', text: 'Current gemini question' }] },
    ]);
  });
});
