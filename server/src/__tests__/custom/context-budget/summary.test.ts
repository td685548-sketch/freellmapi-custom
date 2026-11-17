import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@freellmapi/shared/types.js';

interface RecordedCall {
  messages: ChatMessage[];
  options: Record<string, unknown>;
}

const recordedProviderCalls: RecordedCall[] = [];
const recordedSummaryCalls: Array<{ messages: ChatMessage[]; maxTokens?: number; options: Record<string, unknown> }> = [];
let failNextSummary = false;

const chatCompletion = vi.fn(
  async (_apiKey: string, messages: ChatMessage[], modelId: string, options: Record<string, unknown> = {}) => {
    const isSummaryCall = messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('running summary'),
    );
    if (isSummaryCall) {
      recordedSummaryCalls.push({
        messages: JSON.parse(JSON.stringify(messages)) as ChatMessage[],
        maxTokens: typeof options.max_tokens === 'number' ? options.max_tokens : undefined,
        options: JSON.parse(JSON.stringify(options)) as Record<string, unknown>,
      });
      if (failNextSummary) {
        failNextSummary = false;
        throw Object.assign(new Error('Summary upstream 500'), {
          status: 500,
          providerRejection: 'upstream' as const,
        });
      }
      const promptText = String(messages.at(-1)?.content ?? '');
      const hasAlpha = promptText.includes('User A secret');
      const summaryText = hasAlpha
        ? 'Summary note: User A secret token ABC-123.'
        : `Summary covering ${promptText.length} chars of earlier turns.`;
      return {
        id: 'chatcmpl_sum',
        object: 'chat.completion',
        created: 1700000000,
        model: modelId,
        choices: [{ index: 0, message: { role: 'assistant', content: summaryText }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
      };
    }

    recordedProviderCalls.push({
      messages: JSON.parse(JSON.stringify(messages)) as ChatMessage[],
      options: JSON.parse(JSON.stringify(options)) as Record<string, unknown>,
    });
    return {
      id: 'chatcmpl_main',
      object: 'chat.completion',
      created: 1700000000,
      model: modelId,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Assistant reply ok.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    };
  },
);

const fakeProvider = { name: 'groq', chatCompletion, streamChatCompletion: vi.fn() } as any;

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
const { resetFlagsCacheForTests, setFlags } = await import('../../../custom/ai-platform/flags.js');
const { setBindings } = await import('../../../custom/ai-platform/mcp-client/bindings.js');
const {
  createServer,
  listServerTools,
  reviewTool,
  syncServerTools,
} = await import('../../../custom/ai-platform/mcp-client/registry.js');
const { clearContextPolicyCache, saveContextPolicy } = await import('../../../custom/context-budget/policy.js');
const {
  appendTurn,
  foldableTurns,
  saveWindowStart,
} = await import('../../../services/profile-conversations.js');
const { summarizeConversation, summaryPrompt } = await import('../../../custom/conversation-summary.js');

describe('context-budget US3 budget-triggered summarization (T046)', () => {
  let server: Server;
  let baseUrl: string;
  let port: number;
  const realFetch = global.fetch;
  let ownerId: number;
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

  async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    vi.stubEnv('PROXY_RATE_LIMIT_RPM', '0');
    setKeyCacheTestOverride(true);
    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });
    resetFlagsCacheForTests();

    const enc = encrypt('gsk_sum_test');
    const db = getDb();
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES ('groq', 'sum-key', ?, ?, ?, 'healthy', 1)`,
    ).run(enc.encrypted, enc.iv, enc.authTag);

    db.prepare('UPDATE models SET enabled = 0').run();
    db.prepare('UPDATE fallback_config SET enabled = 0').run();
    db.prepare('UPDATE profile_models SET enabled = 0').run();
    const inserted = db
      .prepare(
        `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, context_window, enabled)
         VALUES ('groq', 'sum-model-32k', 'Sum 32k', 1, 1, 'Medium', 32768, 1)`,
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
    port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;

    ownerId = createUser('sum-owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);

    const created = await requestJson('/api/client-profiles', {
      method: 'POST',
      token: ownerToken,
      body: { name: 'sum-profile', systemPrompt: 'You are concise.' },
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
      body: { enabled: true, ttlHours: 168, maxMessages: 100, maxChars: 100_000, summarize: true },
    });
  });

  afterEach(async () => {
    clearAllCooldowns();
    clearContextPolicyCache();
    resetFlagsCacheForTests();
    failNextSummary = false;
    recordedProviderCalls.length = 0;
    recordedSummaryCalls.length = 0;
    chatCompletion.mockClear();

    const db = getDb();
    db.prepare('DELETE FROM custom_context_reports').run();
    db.prepare('DELETE FROM custom_context_policies').run();
    db.prepare('DELETE FROM custom_conversation_messages').run();
    db.prepare('DELETE FROM custom_conversations').run();
    db.prepare('DELETE FROM custom_quick_answers').run();
    db.prepare('DELETE FROM custom_ai_tool_bindings').run();
    db.prepare('DELETE FROM custom_ai_mcp_tools').run();
    db.prepare('DELETE FROM custom_ai_mcp_servers').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('UPDATE client_profiles SET ai_tools_enabled = 0, qa_enabled = 0 WHERE id = ?').run(profileId);
    await requestJson(`/api/client-profiles/${profileId}/conversation-settings`, {
      method: 'PUT',
      token: ownerToken,
      body: { enabled: true, ttlHours: 168, maxMessages: 100, maxChars: 100_000, summarize: true },
    });
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setKeyCacheTestOverride(null);
  });

  it('saveWindowStart & foldableTurns respect boundaryId, 16k char cap, and legacy fallback when omitted', () => {
    const db = getDb();
    const convSettings = { enabled: true, ttlHours: 168, maxMessages: 20, maxChars: 100_000, summarize: true };
    let convId: number | null = null;
    const msgIds: number[] = [];
    for (let i = 0; i < 6; i++) {
      convId = appendTurn(
        profileId,
        'unit-fold',
        null,
        convId,
        [{ role: 'user', content: `U${i}: ` + 'x'.repeat(3000) }],
        `A${i}: ` + 'y'.repeat(3000),
        convSettings,
      );
    }
    const rows = db
      .prepare('SELECT id FROM custom_conversation_messages WHERE conversation_id = ? ORDER BY id')
      .all(convId!) as Array<{ id: number }>;
    for (const r of rows) msgIds.push(r.id);

    // Without boundaryId (legacy): 12 messages < maxMessages(20) and ~36k < maxChars(100k) -> null
    expect(foldableTurns(convId!, convSettings)).toBeNull();

    // saveWindowStart persists context_window_start_id
    const boundary = msgIds[8]!;
    saveWindowStart(convId!, boundary);
    const saved = db
      .prepare('SELECT context_window_start_id FROM custom_conversations WHERE id = ?')
      .get(convId!) as { context_window_start_id: number | null };
    expect(saved.context_window_start_id).toBe(boundary);

    // With boundaryId: returns summarized_through < id < boundary capped at 16,000 chars
    const fold = foldableTurns(convId!, convSettings, boundary);
    expect(fold).not.toBeNull();
    expect(fold!.turns.every((t) => t.id < boundary)).toBe(true);
    const totalChars = fold!.turns.reduce((sum, t) => sum + t.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(16_000);
    expect(fold!.turns.length).toBeLessThan(8);

    // When boundaryId is at or below summarized_through -> null
    db.prepare('UPDATE custom_conversations SET summarized_through = ? WHERE id = ?').run(boundary, convId!);
    expect(foldableTurns(convId!, convSettings, boundary)).toBeNull();
  });

  it('records context_window_start_id, folds dropped turns once per cycle, and marks summary requests UA', async () => {
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 2200,
      outputReserveTokens: 256,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 0,
      dropBlockTurns: 2,
      summarize: true,
      clientHistoryMode: 'passthrough',
    });

    const convSettings = { enabled: true, ttlHours: 168, maxMessages: 100, maxChars: 100_000, summarize: true };
    const pad = 'word '.repeat(75); // ~375 chars (~95 tokens) per message
    let convId: number | null = null;
    for (let t = 0; t < 12; t++) {
      convId = appendTurn(
        profileId,
        'budget-fold-1',
        null,
        convId,
        [{ role: 'user', content: `Turn ${t} user ${pad}` }],
        `Turn ${t} assistant ${pad}`,
        convSettings,
      );
    }

    // Request 1: budget trims older turns and triggers summary for dropped turns
    const res1 = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-conversation-id': 'budget-fold-1' },
      body: { model: 'auto', messages: [{ role: 'user', content: 'Current question 1' }] },
    });
    expect(res1.status).toBe(200);
    await waitFor(() => {
      const r = getDb()
        .prepare('SELECT summarized_through FROM custom_conversations WHERE id = ?')
        .get(convId!) as { summarized_through: number };
      return r.summarized_through > 0;
    });

    const row1 = getDb()
      .prepare('SELECT context_window_start_id, summarized_through, summary FROM custom_conversations WHERE id = ?')
      .get(convId!) as { context_window_start_id: number | null; summarized_through: number; summary: string | null };
    expect(row1.context_window_start_id).not.toBeNull();
    expect(row1.summarized_through).toBeGreaterThan(0);
    expect(row1.summarized_through).toBeLessThan(row1.context_window_start_id!);
    expect(row1.summary).toBeTruthy();

    // Verify context_window_start_id equals oldest history message actually sent
    const oldestSentMsg = recordedProviderCalls[0]!.messages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Turn '),
    );
    const dbOldestSent = getDb()
      .prepare('SELECT id FROM custom_conversation_messages WHERE conversation_id = ? AND content = ?')
      .get(convId!, String(oldestSentMsg!.content)) as { id: number };
    expect(row1.context_window_start_id).toBe(dbOldestSent.id);

    // Verify FR-021: summary call logged with client_user_agent = 'freellm-conversation-summary'
    const uaCount = (
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM requests WHERE profile_id = ? AND client_user_agent = 'freellm-conversation-summary'")
        .get(profileId) as { n: number }
    ).n;
    expect(uaCount).toBe(1);

    const firstFoldedPrompt = String(recordedSummaryCalls[0]!.messages.at(-1)!.content);
    const firstSummarizedThrough = row1.summarized_through;

    // Add 4 more turns and run Request 2 -> second fold only folds id > firstSummarizedThrough
    for (let t = 12; t < 16; t++) {
      appendTurn(
        profileId,
        'budget-fold-1',
        null,
        convId,
        [{ role: 'user', content: `Turn ${t} user ${pad}` }],
        `Turn ${t} assistant ${pad}`,
        convSettings,
      );
    }

    const res2 = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-conversation-id': 'budget-fold-1' },
      body: { model: 'auto', messages: [{ role: 'user', content: 'Current question 2' }] },
    });
    expect(res2.status).toBe(200);
    await waitFor(() => recordedSummaryCalls.length >= 2);
    await waitFor(() => {
      const r = getDb()
        .prepare('SELECT summarized_through FROM custom_conversations WHERE id = ?')
        .get(convId!) as { summarized_through: number };
      return r.summarized_through > firstSummarizedThrough;
    });

    const secondFoldedPrompt = String(recordedSummaryCalls[1]!.messages.at(-1)!.content);
    expect(firstFoldedPrompt).toContain('Turn 0 user');
    expect(secondFoldedPrompt).not.toContain('Turn 0 user');
  });

  it('recovers cleanly on subsequent turn after summary call fails', async () => {
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 2000,
      outputReserveTokens: 256,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 0,
      dropBlockTurns: 2,
      summarize: true,
      clientHistoryMode: 'passthrough',
    });

    const convSettings = { enabled: true, ttlHours: 168, maxMessages: 100, maxChars: 100_000, summarize: true };
    const pad = 'retry '.repeat(70);
    let convId: number | null = null;
    for (let t = 0; t < 10; t++) {
      convId = appendTurn(
        profileId,
        'retry-sum',
        null,
        convId,
        [{ role: 'user', content: `Turn ${t} user ${pad}` }],
        `Turn ${t} assistant ${pad}`,
        convSettings,
      );
    }

    failNextSummary = true;
    const res1 = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-conversation-id': 'retry-sum' },
      body: { model: 'auto', messages: [{ role: 'user', content: 'Turn 10 question' }] },
    });
    expect(res1.status).toBe(200);
    await waitFor(() => recordedSummaryCalls.length >= 1);
    await new Promise((r) => setTimeout(r, 80));

    // Summary failed -> summarized_through remains 0 and summary remains null
    const afterFail = getDb()
      .prepare('SELECT summary, summarized_through FROM custom_conversations WHERE id = ?')
      .get(convId!) as { summary: string | null; summarized_through: number };
    expect(afterFail.summary).toBeNull();
    expect(afterFail.summarized_through).toBe(0);

    // Clear cooldown caused by the simulated 500 on the single test model before sending next turn
    clearAllCooldowns();

    // Next turn succeeds with sliding window and retries summarization
    const res2 = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-conversation-id': 'retry-sum' },
      body: { model: 'auto', messages: [{ role: 'user', content: 'Turn 11 question' }] },
    });
    expect(res2.status).toBe(200);
    await waitFor(() => {
      const r = getDb()
        .prepare('SELECT summarized_through FROM custom_conversations WHERE id = ?')
        .get(convId!) as { summarized_through: number };
      return r.summarized_through > 0;
    });

    const afterRetry = getDb()
      .prepare('SELECT summary, summarized_through FROM custom_conversations WHERE id = ?')
      .get(convId!) as { summary: string | null; summarized_through: number };
    expect(afterRetry.summary).toBeTruthy();
    expect(afterRetry.summarized_through).toBeGreaterThan(0);
    expect(String(recordedSummaryCalls[1]!.messages.at(-1)!.content)).toContain('Turn 0 user');
  });

  it('never leaks end user A summary into end user B context on the same key', async () => {
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 2200,
      outputReserveTokens: 256,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 0,
      dropBlockTurns: 2,
      summarize: true,
      clientHistoryMode: 'passthrough',
    });

    const convSettings = { enabled: true, ttlHours: 168, maxMessages: 100, maxChars: 100_000, summarize: true };
    const pad = 'alpha '.repeat(70);
    let convA: number | null = null;
    for (let t = 0; t < 10; t++) {
      convA = appendTurn(
        profileId,
        'conv-user-a',
        'user-a',
        convA,
        [{ role: 'user', content: t === 0 ? `User A secret ${pad}` : `User A turn ${t} ${pad}` }],
        `User A reply ${t} ${pad}`,
        convSettings,
      );
    }

    const resA = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-conversation-id': 'conv-user-a', 'x-end-user': 'user-a' },
      body: { model: 'auto', messages: [{ role: 'user', content: 'Ask A' }] },
    });
    expect(resA.status).toBe(200);
    await waitFor(() => {
      const r = getDb()
        .prepare('SELECT summary FROM custom_conversations WHERE id = ?')
        .get(convA!) as { summary: string | null };
      return Boolean(r.summary);
    });

    // End user B with same conversation id is rejected (403) and with own conversation id sees no A summary
    const resCross = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-conversation-id': 'conv-user-a', 'x-end-user': 'user-b' },
      body: { model: 'auto', messages: [{ role: 'user', content: 'Sneak' }] },
    });
    expect(resCross.status).toBe(403);

    recordedProviderCalls.length = 0;
    const resB = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-conversation-id': 'conv-user-b', 'x-end-user': 'user-b' },
      body: { model: 'auto', messages: [{ role: 'user', content: 'Hello from B' }] },
    });
    expect(resB.status).toBe(200);
    const bPayload = JSON.stringify(recordedProviderCalls[0]!.messages);
    expect(bPayload).not.toContain('User A secret');
    expect(bPayload).not.toContain('ABC-123');
  });

  it('computes summaryPrompt targetWords = clamp(round(cap * 0.6), 80, 400) and sends max_tokens = cap', async () => {
    // Direct summaryPrompt checks
    expect(summaryPrompt(null, [{ role: 'user', content: 'hi' }])[0]!.content).toContain('at most 200 words');
    expect(summaryPrompt(null, [{ role: 'user', content: 'hi' }], 120)[0]!.content).toContain('at most 120 words');

    const convSettings = { enabled: true, ttlHours: 168, maxMessages: 2, maxChars: 100_000, summarize: true };
    const cases = [
      { cap: 100, expectedWords: 80 }, // round(60) clamped up to 80
      { cap: 300, expectedWords: 180 }, // round(180)
      { cap: 1000, expectedWords: 400 }, // round(600) clamped down to 400
    ];

    for (const c of cases) {
      recordedSummaryCalls.length = 0;
      let cid: number | null = null;
      cid = appendTurn(profileId, `cap-${c.cap}`, null, cid, [{ role: 'user', content: 'Old 1' }], 'Ans 1', convSettings);
      cid = appendTurn(profileId, `cap-${c.cap}`, null, cid, [{ role: 'user', content: 'Recent 2' }], 'Ans 2', convSettings);
      const ok = await summarizeConversation(
        profileId,
        cid!,
        convSettings,
        { host: '127.0.0.1', port },
        { summaryCapTokens: c.cap },
      );
      expect(ok).toBe(true);
      expect(recordedSummaryCalls).toHaveLength(1);
      const sysTexts = recordedSummaryCalls[0]!.messages
        .filter((m) => m.role === 'system')
        .map((m) => String(m.content))
        .join('\n');
      expect(sysTexts).toContain(`at most ${c.expectedWords} words`);
      expect(recordedSummaryCalls[0]!.maxTokens).toBe(c.cap);
    }
  });

  it('leaves context_window_start_id null, omits X-FreeLLM-Context, and uses legacy folding on quick-answer & MCP takeover paths', async () => {
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 2000,
      outputReserveTokens: 256,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 0,
      dropBlockTurns: 2,
      summarize: true,
      clientHistoryMode: 'passthrough',
    });

    // Enable quick answers and keep maxMessages = 2 so legacy folding triggers when > 2 stored messages
    await requestJson(`/api/client-profiles/${profileId}/conversation-settings`, {
      method: 'PUT',
      token: ownerToken,
      body: { enabled: true, ttlHours: 168, maxMessages: 2, maxChars: 100_000, summarize: true },
    });
    const db = getDb();
    db.prepare('UPDATE client_profiles SET qa_enabled = 1 WHERE id = ?').run(profileId);
    db.prepare(
      `INSERT INTO custom_quick_answers (profile_id, questions, answer, enabled, updated_at)
       VALUES (?, ?, 'We are open 9-5.', 1, '2026-11-17T00:00:00Z')`,
    ).run(profileId, JSON.stringify(['what are your hours?']));

    const convSettings = { enabled: true, ttlHours: 168, maxMessages: 2, maxChars: 100_000, summarize: true };
    const qaConvId = appendTurn(
      profileId,
      'qa-out-of-scope',
      null,
      null,
      [{ role: 'user', content: 'Old QA turn' }],
      'Old QA reply',
      convSettings,
    );

    const qaRes = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-conversation-id': 'qa-out-of-scope' },
      body: { model: 'auto', messages: [{ role: 'user', content: 'what are your hours?' }] },
    });
    expect(qaRes.status).toBe(200);
    expect(qaRes.headers.get('x-quick-answer')).toBeTruthy();
    expect(qaRes.headers.get('x-freellm-context')).toBeNull();
    await waitFor(() => recordedSummaryCalls.length >= 1);

    const qaRow = db
      .prepare('SELECT context_window_start_id, summarized_through FROM custom_conversations WHERE id = ?')
      .get(qaConvId) as { context_window_start_id: number | null; summarized_through: number };
    expect(qaRow.context_window_start_id).toBeNull();
    expect(qaRow.summarized_through).toBeGreaterThan(0);

    // MCP takeover path with X-Conversation-Id
    recordedSummaryCalls.length = 0;
    db.prepare('UPDATE client_profiles SET qa_enabled = 0, ai_tools_enabled = 1 WHERE id = ?').run(profileId);
    setFlags({ mcpClient: true });
    const srv = await createServer(
      { slug: 'sum-mcp', name: 'SumMCP', url: 'https://mcp.example.com/v1', authKind: 'none' },
      ownerId,
    );
    const fakeTransport = {
      async mcpInitialize(config: { serverId: number; revision: number; credentialGeneration: number; url: string }) {
        return {
          serverId: config.serverId,
          revision: config.revision,
          credentialGeneration: config.credentialGeneration,
          origin: new URL(config.url).origin,
          sessionId: 'sess-sum-mcp',
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'sum-mcp' },
        };
      },
      async mcpListTools() {
        return [{ name: 'ping_tool', description: 'Ping', inputSchema: { type: 'object', properties: {} } }];
      },
    };
    await syncServerTools(srv.id, ownerId, undefined, fakeTransport as any);
    const tool = listServerTools(srv.id)[0]!;
    reviewTool(tool.id, { state: 'allowed', effect: 'read' }, ownerId);
    setBindings({ kind: 'profile', id: String(profileId) }, { toolIds: [tool.id], enabled: true });

    const mcpConvId = appendTurn(
      profileId,
      'mcp-out-of-scope',
      null,
      null,
      [{ role: 'user', content: 'Old MCP turn' }],
      'Old MCP reply',
      convSettings,
    );

    const mcpRes = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-conversation-id': 'mcp-out-of-scope' },
      body: { model: 'auto', messages: [{ role: 'user', content: 'Hello MCP' }] },
    });
    expect(mcpRes.status).toBe(200);
    expect(mcpRes.headers.get('x-freellm-context')).toBeNull();
    await waitFor(() => recordedSummaryCalls.length >= 1);

    const mcpRow = db
      .prepare('SELECT context_window_start_id, summarized_through FROM custom_conversations WHERE id = ?')
      .get(mcpConvId) as { context_window_start_id: number | null; summarized_through: number };
    expect(mcpRow.context_window_start_id).toBeNull();
    expect(mcpRow.summarized_through).toBeGreaterThan(0);
  });

  it('skips scheduleSummary when policy.summarize is false even if conversation summarize setting is true', async () => {
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 2000,
      outputReserveTokens: 256,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 0,
      dropBlockTurns: 2,
      summarize: false,
      clientHistoryMode: 'passthrough',
    });

    const convSettings = { enabled: true, ttlHours: 168, maxMessages: 100, maxChars: 100_000, summarize: true };
    const pad = 'skip '.repeat(75);
    let convId: number | null = null;
    for (let t = 0; t < 10; t++) {
      convId = appendTurn(
        profileId,
        'no-policy-sum',
        null,
        convId,
        [{ role: 'user', content: `Turn ${t} user ${pad}` }],
        `Turn ${t} assistant ${pad}`,
        convSettings,
      );
    }

    const res = await requestJson('/v1/chat/completions', {
      token: profileKey,
      headers: { 'x-conversation-id': 'no-policy-sum' },
      body: { model: 'auto', messages: [{ role: 'user', content: 'Final question' }] },
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 120));

    expect(recordedSummaryCalls).toHaveLength(0);
    const row = getDb()
      .prepare('SELECT context_window_start_id, summarized_through FROM custom_conversations WHERE id = ?')
      .get(convId!) as { context_window_start_id: number | null; summarized_through: number };
    expect(row.context_window_start_id).not.toBeNull();
    expect(row.summarized_through).toBe(0);
  });
});
