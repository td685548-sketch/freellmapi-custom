import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@freellmapi/shared/types.js';

interface RecordedAttempt {
  modelId: string;
  messages: ChatMessage[];
}

const recordedAttempts: RecordedAttempt[] = [];
let failLargeWith503 = false;

const chatCompletion = vi.fn(async (_apiKey: string, messages: ChatMessage[], modelId: string) => {
  recordedAttempts.push({
    modelId,
    messages: JSON.parse(JSON.stringify(messages)) as ChatMessage[],
  });
  if (failLargeWith503 && modelId === 'large-131k') {
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
        message: { role: 'assistant', content: `ok from ${modelId}` },
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
const { resetModelFailureWindows } = await import('../../../lib/fallback-loop.js');
const { clearAllPenalties, setRoutingStrategy } = await import('../../../services/router.js');
const { clearContextPolicyCache, saveContextPolicy } = await import('../../../custom/context-budget/policy.js');
const { estimateMessagesTokens } = await import('../../../custom/context-budget/estimate.js');
const {
  getKnowledgeTokenCap,
  isShingleDuplicate,
  knowledgeCandidateMaxChars,
  prepareContextBudget,
  registerHistory,
  registerKnowledge,
  selectPassagesWithinTokens,
} = await import('../../../custom/context-budget/gate.js');
const { fitContextForRoute } = await import('../../../custom/context-budget/hooks.js');
const { getRegistry } = await import('../../../custom/context-budget/registry.js');
const { contentToString } = await import('../../../lib/content.js');

function parseContextHeader(raw: string | null): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

describe('client-sent history modes across all 4 surfaces (T055 / US5)', () => {
  let server: Server;
  let baseUrl: string;
  const realFetch = global.fetch;
  let ownerToken: string;
  let profileId: number;
  let profileKey: string;
  let largeModelId: number;
  let smallModelId: number;

  const PAD = 'context padding token words '.repeat(10); // ~280 chars (~70 tokens) per msg

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

  function setLargeModelEnabled(enabled: boolean): void {
    const db = getDb();
    db.prepare('UPDATE models SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, largeModelId);
    db.prepare('UPDATE fallback_config SET enabled = ? WHERE model_db_id = ?').run(enabled ? 1 : 0, largeModelId);
    db.prepare('UPDATE profile_models SET enabled = ? WHERE model_db_id = ?').run(enabled ? 1 : 0, largeModelId);
    invalidateModelListingCache();
  }

  function buildOpenAi200History(opts: { withToolPairAtIdx?: number; withTrailingTools?: boolean } = {}): ChatMessage[] {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'App system instructions.' }];
    for (let i = 0; i < 99; i++) {
      msgs.push({ role: 'user', content: `Client user turn ${i} ${PAD}` });
      if (opts.withToolPairAtIdx === i) {
        msgs.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: 'lookup_order', arguments: `{"turn":${i}}` } }],
        });
        msgs.push({ role: 'tool', tool_call_id: `call_${i}`, content: `Tool result ${i} ${PAD}` });
      } else {
        msgs.push({ role: 'assistant', content: `Client assistant turn ${i} ${PAD}` });
      }
    }
    msgs.push({ role: 'user', content: 'Final client question now.' });
    if (opts.withTrailingTools) {
      msgs.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_tail', type: 'function', function: { name: 'final_lookup', arguments: '{"id":42}' } }],
      });
      msgs.push({ role: 'tool', tool_call_id: 'call_tail', content: 'Final tool output 42' });
    }
    return msgs;
  }

  function buildAnthropic200History() {
    const msgs: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
    for (let i = 0; i < 99; i++) {
      msgs.push({ role: 'user', content: `Anthropic user turn ${i} ${PAD}` });
      if (i === 95) {
        msgs.push({
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_95', name: 'lookup', input: { turn: i } }],
        });
        msgs.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_95', content: `Anthropic tool result 95 ${PAD}` }],
        });
        msgs.push({ role: 'assistant', content: `Anthropic post-tool answer 95 ${PAD}` });
      } else {
        msgs.push({ role: 'assistant', content: `Anthropic assistant turn ${i} ${PAD}` });
      }
    }
    msgs.push({ role: 'user', content: 'Final anthropic question.' });
    return msgs;
  }

  function buildResponses200History() {
    const input: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 99; i++) {
      input.push({ role: 'user', content: `Responses user turn ${i} ${PAD}` });
      if (i === 95) {
        input.push({
          type: 'function_call',
          call_id: 'fc_95',
          name: 'lookup',
          arguments: '{"turn":95}',
        });
        input.push({
          type: 'function_call_output',
          call_id: 'fc_95',
          output: `Responses tool output 95 ${PAD}`,
        });
      } else {
        input.push({ role: 'assistant', content: `Responses assistant turn ${i} ${PAD}` });
      }
    }
    input.push({ role: 'user', content: 'Final responses question.' });
    return input;
  }

  function buildGemini200History() {
    const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];
    for (let i = 0; i < 99; i++) {
      contents.push({ role: 'user', parts: [{ text: `Gemini user turn ${i} ${PAD}` }] });
      contents.push({ role: 'model', parts: [{ text: `Gemini model turn ${i} ${PAD}` }] });
    }
    contents.push({ role: 'user', parts: [{ text: 'Final gemini question.' }] });
    return contents;
  }

  function assertToolPairsIntact(messages: readonly ChatMessage[]): void {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        const next = messages[i + 1];
        expect(next?.role, `tool_calls at ${i} must be followed by tool result`).toBe('tool');
      }
      if (m.role === 'tool') {
        let j = i - 1;
        while (j >= 0 && messages[j]!.role === 'tool') j--;
        const caller = j >= 0 ? messages[j] : undefined;
        expect(caller?.role, `tool at ${i} must have preceding assistant(tool_calls)`).toBe('assistant');
        expect((caller?.tool_calls?.length ?? 0) > 0).toBe(true);
      }
    }
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    vi.stubEnv('PROXY_RATE_LIMIT_RPM', '0');
    setKeyCacheTestOverride(true);
    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });

    const encGroq = encrypt('gsk_ch_groq');
    const encCerebras = encrypt('csk_ch_cerebras');
    const db = getDb();
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES ('groq', 'ch-groq', ?, ?, ?, 'healthy', 1)`,
    ).run(encGroq.encrypted, encGroq.iv, encGroq.authTag);
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES ('cerebras', 'ch-cerebras', ?, ?, ?, 'healthy', 1)`,
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
    largeModelId = Number(largeRes.lastInsertRowid);
    smallModelId = Number(smallRes.lastInsertRowid);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(largeModelId);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)').run(smallModelId);
    const profiles = db.prepare('SELECT id FROM profiles').all() as Array<{ id: number }>;
    for (const p of profiles) {
      db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)').run(
        p.id,
        largeModelId,
      );
      db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 2, 1)').run(
        p.id,
        smallModelId,
      );
    }
    setRoutingStrategy('priority');
    db.prepare("UPDATE profiles SET routing_strategy = 'priority'").run();
    invalidateModelListingCache();

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const ownerId = createUser('ch-owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);

    const created = await requestJson('/api/client-profiles', {
      method: 'POST',
      token: ownerToken,
      body: { name: 'ch-profile', systemPrompt: 'Enforced profile prompt.' },
    });
    profileId = created.body.id;
    profileKey = created.body.key;

    await requestJson(`/api/client-profiles/${profileId}/quota`, {
      method: 'PUT',
      token: ownerToken,
      body: { rpmLimit: null },
    });
  });

  afterEach(() => {
    failLargeWith503 = false;
    setLargeModelEnabled(true);
    clearAllCooldowns();
    clearAllPenalties();
    resetModelFailureWindows();
    clearContextPolicyCache();
    recordedAttempts.length = 0;
    chatCompletion.mockClear();
    const db = getDb();
    db.prepare('DELETE FROM custom_context_policies').run();
    db.prepare('DELETE FROM custom_context_reports').run();
    db.prepare('DELETE FROM custom_conversation_messages').run();
    db.prepare('DELETE FROM custom_conversations').run();
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setKeyCacheTestOverride(null);
  });

  it('passthrough forwards client 200-message history verbatim, reports client_dropped=0, and lets router exclude too-small models', async () => {
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 4000,
      outputReserveTokens: 1024,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 25,
      dropBlockTurns: 4,
      summarize: true,
      clientHistoryMode: 'passthrough',
    });

    const msgs = buildOpenAi200History();
    const okRes = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-session-id': 'ch-passthrough-ok' },
      body: { model: 'auto', messages: msgs },
    });
    expect(okRes.status).toBe(200);
    expect(recordedAttempts).toHaveLength(1);
    expect(recordedAttempts[0]!.modelId).toBe('large-131k');
    // Profile prompt prepended + exact 200 client messages untouched
    expect(recordedAttempts[0]!.messages).toHaveLength(msgs.length + 1);
    expect(recordedAttempts[0]!.messages[1]!.content).toBe(msgs[0]!.content);
    expect(recordedAttempts[0]!.messages.at(-1)!.content).toBe('Final client question now.');

    const header = parseContextHeader(okRes.headers.get('x-freellm-context'));
    expect(header.client_dropped).toBe('0');

    // Now disable the 131k model so only small-8k exists: passthrough must NOT trim, so router rejects
    recordedAttempts.length = 0;
    setLargeModelEnabled(false);
    const failRes = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-session-id': 'ch-passthrough-fail' },
      body: { model: 'auto', messages: msgs },
    });
    expect(failRes.status).toBeGreaterThanOrEqual(400);
    expect(recordedAttempts).toHaveLength(0);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM custom_conversations').get()).toEqual({ n: 0 });
  });

  it('trim_on_overflow trims oldest client turns to fit the small 8k model window while ignoring maxInputTokens', async () => {
    setLargeModelEnabled(false); // only small-8k (8192) is available; 200 msgs (~14k tokens) exceed it
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 2500, // intentionally lower than 8k window budget (6451); trim_on_overflow must ignore this
      outputReserveTokens: 1024,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 25,
      dropBlockTurns: 4,
      summarize: true,
      clientHistoryMode: 'trim_on_overflow',
    });

    const msgs = buildOpenAi200History({ withToolPairAtIdx: 95, withTrailingTools: true });
    const res = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-session-id': 'ch-enforce-budget' },
      body: { model: 'auto', messages: msgs },
    });

    expect(res.status).toBe(200);
    expect(recordedAttempts).toHaveLength(1);
    expect(recordedAttempts[0]!.modelId).toBe('small-8k');

    const sent = recordedAttempts[0]!.messages;
    const totalTokens = estimateMessagesTokens(sent);
    const windowBudget = Math.floor((8192 - 1024) * 0.9); // 6451
    expect(totalTokens).toBeLessThanOrEqual(windowBudget);
    // Confirms key cap (2500) was ignored in trim_on_overflow mode
    expect(totalTokens).toBeGreaterThan(2500);

    // Mandatory system instructions, final user turn, and trailing tool chain preserved
    expect(sent.some((m) => m.role === 'system' && String(m.content).includes('Enforced profile prompt.'))).toBe(true);
    expect(sent.some((m) => m.role === 'system' && String(m.content).includes('App system instructions.'))).toBe(true);
    expect(sent.some((m) => m.role === 'user' && m.content === 'Final client question now.')).toBe(true);
    expect(sent.at(-2)?.role).toBe('assistant');
    expect(sent.at(-2)?.tool_calls?.[0]?.id).toBe('call_tail');
    expect(sent.at(-1)?.role).toBe('tool');
    expect(sent.at(-1)?.content).toBe('Final tool output 42');
    assertToolPairsIntact(sent);

    const header = parseContextHeader(res.headers.get('x-freellm-context'));
    expect(Number(header.budget)).toBe(windowBudget);
    expect(Number(header.client_dropped)).toBeGreaterThan(0);

    // Also verify trim_on_overflow succeeds on /v1/messages, /v1/responses, and Gemini :generateContent when only 8k is available
    for (const [label, path, headers, body] of [
      [
        'anthropic',
        '/v1/messages',
        { 'anthropic-version': '2023-06-01', 'x-session-id': 'ch-trim-anth' },
        { model: 'auto', max_tokens: 1024, system: 'Anthropic system.', messages: buildAnthropic200History() },
      ],
      [
        'responses',
        '/v1/responses',
        { 'x-session-id': 'ch-trim-resp' },
        { model: 'auto', max_output_tokens: 1024, instructions: 'Responses system.', input: buildResponses200History() },
      ],
      [
        'gemini',
        '/v1beta/models/auto:generateContent',
        { 'x-goog-api-key': profileKey, 'x-session-id': 'ch-trim-gem' },
        {
          systemInstruction: { parts: [{ text: 'Gemini system.' }] },
          contents: buildGemini200History(),
          generationConfig: { maxOutputTokens: 1024 },
        },
      ],
    ] as const) {
      recordedAttempts.length = 0;
      const surfaceRes = await requestJson(path, {
        ...(label === 'gemini' ? {} : { token: profileKey }),
        headers: headers as Record<string, string>,
        body,
      });
      expect(surfaceRes.status, `${label} trim_on_overflow`).toBe(200);
      expect(recordedAttempts, `${label} attempts`).toHaveLength(1);
      expect(recordedAttempts[0]!.modelId).toBe('small-8k');
      expect(estimateMessagesTokens(recordedAttempts[0]!.messages)).toBeLessThanOrEqual(windowBudget);
      assertToolPairsIntact(recordedAttempts[0]!.messages);
      const h = parseContextHeader(surfaceRes.headers.get('x-freellm-context'));
      expect(Number(h.client_dropped), `${label} client_dropped`).toBeGreaterThan(0);
    }

    expect(getDb().prepare('SELECT COUNT(*) AS n FROM custom_conversations').get()).toEqual({ n: 0 });
  });

  it('enforce_budget caps client history to effective budget, preserves tool pairs, and creates no summary', async () => {
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 4000,
      outputReserveTokens: 1024,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 25,
      dropBlockTurns: 4,
      summarize: true, // even with summarize=true, client-sent history must never create summaries
      clientHistoryMode: 'enforce_budget',
    });

    const msgs = buildOpenAi200History({ withToolPairAtIdx: 95, withTrailingTools: true });
    const res = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-session-id': 'ch-enforce-budget' },
      body: { model: 'auto', messages: msgs },
    });

    expect(res.status).toBe(200);
    expect(recordedAttempts).toHaveLength(1);
    const sent = recordedAttempts[0]!.messages;
    expect(estimateMessagesTokens(sent)).toBeLessThanOrEqual(4000);
    assertToolPairsIntact(sent);
    expect(sent.some((m) => m.role === 'user' && m.content === 'Final client question now.')).toBe(true);
    expect(sent.at(-1)?.content).toBe('Final tool output 42');

    const header = parseContextHeader(res.headers.get('x-freellm-context'));
    expect(Number(header.budget)).toBe(4000);
    expect(Number(header.client_dropped)).toBeGreaterThan(0);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM custom_conversations').get()).toEqual({ n: 0 });
  });

  it('refits 200 client-sent messages on 131k -> 8k failover with refits=1 across all 4 surfaces in enforce_budget mode', async () => {
    failLargeWith503 = true;
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
      clientHistoryMode: 'enforce_budget',
    });

    // 1. /v1/chat/completions
    recordedAttempts.length = 0;
    const chatRes = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-session-id': 'ch-failover-chat' },
      body: { model: 'auto', messages: buildOpenAi200History({ withToolPairAtIdx: 95 }) },
    });
    expect(chatRes.status).toBe(200);
    expect(recordedAttempts.map((a) => a.modelId)).toEqual(['large-131k', 'small-8k']);
    const chatSent = recordedAttempts[1]!.messages;
    const expected8kBudget = Math.floor((8192 - 1024) * 0.9);
    expect(estimateMessagesTokens(chatSent)).toBeLessThanOrEqual(expected8kBudget);
    assertToolPairsIntact(chatSent);
    expect(chatSent.at(-1)!.content).toBe('Final client question now.');
    const chatHeader = parseContextHeader(chatRes.headers.get('x-freellm-context'));
    expect(chatHeader.refits).toBe('1');
    expect(Number(chatHeader.client_dropped)).toBeGreaterThan(0);

    // 2. /v1/messages (Anthropic)
    clearAllCooldowns();
    clearAllPenalties();
    resetModelFailureWindows();
    recordedAttempts.length = 0;
    const anthRes = await requestJson('/v1/messages', {
      token: profileKey,
      headers: { 'anthropic-version': '2023-06-01', 'x-session-id': 'ch-failover-anth' },
      body: {
        model: 'auto',
        max_tokens: 512,
        system: 'Anthropic system instruction.',
        messages: buildAnthropic200History(),
      },
    });
    expect(anthRes.status).toBe(200);
    expect(recordedAttempts.map((a) => a.modelId)).toEqual(['large-131k', 'small-8k']);
    const anthSent = recordedAttempts[1]!.messages;
    const expectedAnthBudget = Math.floor((8192 - 512) * 0.9);
    expect(estimateMessagesTokens(anthSent)).toBeLessThanOrEqual(expectedAnthBudget);
    assertToolPairsIntact(anthSent);
    expect(anthSent.at(-1)!.content).toBe('Final anthropic question.');
    const anthHeader = parseContextHeader(anthRes.headers.get('x-freellm-context'));
    expect(anthHeader.refits).toBe('1');
    expect(Number(anthHeader.client_dropped)).toBeGreaterThan(0);

    // 3. /v1/responses (OpenAI Responses API)
    clearAllCooldowns();
    clearAllPenalties();
    resetModelFailureWindows();
    recordedAttempts.length = 0;
    const respRes = await requestJson('/v1/responses', {
      token: profileKey,
      headers: { 'x-session-id': 'ch-failover-resp' },
      body: {
        model: 'auto',
        max_output_tokens: 512,
        instructions: 'Responses system instruction.',
        input: buildResponses200History(),
      },
    });
    expect(respRes.status).toBe(200);
    expect(recordedAttempts.map((a) => a.modelId)).toEqual(['large-131k', 'small-8k']);
    const respSent = recordedAttempts[1]!.messages;
    expect(estimateMessagesTokens(respSent)).toBeLessThanOrEqual(expectedAnthBudget);
    assertToolPairsIntact(respSent);
    expect(respSent.at(-1)!.content).toBe('Final responses question.');
    const respHeader = parseContextHeader(respRes.headers.get('x-freellm-context'));
    expect(respHeader.refits).toBe('1');
    expect(Number(respHeader.client_dropped)).toBeGreaterThan(0);

    // 4. Gemini :generateContent
    clearAllCooldowns();
    clearAllPenalties();
    resetModelFailureWindows();
    recordedAttempts.length = 0;
    const gemRes = await requestJson('/v1beta/models/auto:generateContent', {
      headers: { 'x-goog-api-key': profileKey, 'x-session-id': 'ch-failover-gem' },
      body: {
        systemInstruction: { parts: [{ text: 'Gemini system instruction.' }] },
        contents: buildGemini200History(),
        generationConfig: { maxOutputTokens: 512 },
      },
    });
    expect(gemRes.status).toBe(200);
    expect(recordedAttempts.map((a) => a.modelId)).toEqual(['large-131k', 'small-8k']);
    const gemSent = recordedAttempts[1]!.messages;
    expect(estimateMessagesTokens(gemSent)).toBeLessThanOrEqual(expectedAnthBudget);
    expect(gemSent.at(-1)!.role).toBe('user');
    expect(contentToString(gemSent.at(-1)!.content)).toBe('Final gemini question.');
    const gemHeader = parseContextHeader(gemRes.headers.get('x-freellm-context'));
    expect(gemHeader.refits).toBe('1');
    expect(Number(gemHeader.client_dropped)).toBeGreaterThan(0);

    expect(getDb().prepare('SELECT COUNT(*) AS n FROM custom_conversations').get()).toEqual({ n: 0 });
  });

  it('provides T053/T054 knowledge token cap, shingle dedup, whole-passage selection, and citation header removal', () => {
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 2000,
      outputReserveTokens: 512,
      safetyMarginPct: 10,
      summarySharePct: 10,
      knowledgeSharePct: 10,
      dropBlockTurns: 2,
      summarize: false,
      clientHistoryMode: 'passthrough',
    });

    const req = { body: { messages: [{ role: 'user', content: 'hi' }] } } as any;
    const registry = prepareContextBudget(req, profileId)!;
    expect(registry).toBeTruthy();
    registry.mandatoryTokens = 500;

    // provisionalBudget = 2000 (since maxWindow=131072 -> winBudget > 2000)
    // cap = floor((2000 - 500) * 0.10) = 150
    const cap = getKnowledgeTokenCap(req);
    expect(cap).toBe(150);
    expect(knowledgeCandidateMaxChars(cap!)).toBe(600);

    const dupText = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
    registerHistory(req, [{ id: 1, role: 'user', content: dupText }]);
    expect(isShingleDuplicate(dupText, [dupText])).toBe(true);

    const selected = selectPassagesWithinTokens(
      [
        { text: dupText, score: 0.99 }, // >= 80% shingle overlap -> skipped
        { text: 'unrelated short knowledge passage '.repeat(4), score: 0.9 }, // fits within 150 tokens
        { text: 'too huge passage '.repeat(80), score: 0.8 }, // exceeds 150 tokens -> skipped whole
        { text: 'below min score passage', score: 0.2 }, // < minScore 0.5 -> skipped
      ],
      cap!,
      { req, minScore: 0.5 },
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]!.score).toBe(0.9);

    // When knowledge is dropped at dispatch, hooks.ts sets knowledgeDropped and removes x-freellm-citations
    const kbText = 'knowledge block '.repeat(120); // > 200 tokens (> 10% cap)
    registerKnowledge(req, kbText, 0);
    const headers: Record<string, string> = { 'x-freellm-citations': 'encoded-citations' };
    const fakeRes = {
      headersSent: false,
      setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
      removeHeader: (k: string) => { delete headers[k.toLowerCase()]; },
      once: () => fakeRes,
    } as any;

    const fitted = fitContextForRoute(
      req,
      fakeRes,
      [
        { role: 'system', content: kbText },
        { role: 'user', content: 'hi' },
      ],
      { contextWindow: 8192 },
      512,
    );
    expect(fitted).toHaveLength(1);
    expect(getRegistry(req)?.knowledgeDropped).toBe(true);
    expect(headers['x-freellm-citations']).toBeUndefined();
  });
});
