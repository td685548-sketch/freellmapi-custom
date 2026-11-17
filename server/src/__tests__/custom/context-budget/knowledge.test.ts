import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CITATIONS_HEADER_NAME, type RetrievalHit } from '@freellmapi/shared/ai-platform-retrieval.js';
import { createApp } from '../../../app.js';
import { defaultDbFactory, getDb, initDb } from '../../../db/index.js';
import { wrapTursoDatabase } from '../../../db/turso.js';
import { encrypt } from '../../../lib/crypto.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setKeyCacheTestOverride } from '../../../services/key-cache.js';
import { addDoc, resetKnowledgeIndexes, setKnowledgeSettings } from '../../../services/profile-knowledge.js';
import { clearAllCooldowns } from '../../../services/ratelimit.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { runPreRequest } from '../../../custom/ai-platform/pipeline.js';
import { citationFilter } from '../../../custom/ai-platform/retrieval/citations.js';
import { setQueryEmbeddingsRunnerForTests } from '../../../custom/ai-platform/retrieval/hybrid.js';
import {
  enqueueReindexJob,
  runPendingIndexJobsUntilIdle,
  setEmbeddingsRunnerForTests,
  stopIndexWorker,
} from '../../../custom/ai-platform/retrieval/indexer.js';
import { setRetrievalSettings } from '../../../custom/ai-platform/retrieval/settings.js';
import { invalidateVectorCache } from '../../../custom/ai-platform/retrieval/vector-store.js';
import { estimateTextTokens } from '../../../custom/context-budget/estimate.js';
import {
  checkMandatoryBudget,
  getKnowledgeTokenCap,
  isShingleDuplicate,
  knowledgeCandidateMaxChars,
  prepareContextBudget,
  registerHistory,
  registerSummary,
  selectPassagesWithinTokens,
} from '../../../custom/context-budget/gate.js';
import { clearContextPolicyCache, saveContextPolicy } from '../../../custom/context-budget/policy.js';
import { getRegistry } from '../../../custom/context-budget/registry.js';
import { classifySegments } from '../../../custom/context-budget/segments.js';
import { injectKnowledge } from '../../../custom/knowledge-inject.js';
import type { GateProfile } from '../../../services/profile-usage.js';

function makeMockReq(
  body: unknown,
  headers: Record<string, string> = {},
  originalUrl = '/v1/chat/completions',
): Request {
  const reqEmitter = new EventEmitter();
  return Object.assign(reqEmitter, {
    method: 'POST',
    originalUrl,
    url: originalUrl,
    path: originalUrl,
    headers,
    body,
    socket: { remoteAddress: '203.0.113.10' },
  }) as unknown as Request;
}

function makeMockRes(): { res: Response; headers: Record<string, string>; statusCode: number; body: unknown } {
  const state = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
  };
  const resEmitter = new EventEmitter();
  const res = Object.assign(resEmitter, {
    headersSent: false,
    writableFinished: false,
    setHeader(name: string, value: string | number | readonly string[]) {
      state.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      return res;
    },
    getHeader(name: string) {
      return state.headers[name.toLowerCase()];
    },
    removeHeader(name: string) {
      delete state.headers[name.toLowerCase()];
    },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
  }) as unknown as Response;
  return {
    res,
    get headers() { return state.headers; },
    get statusCode() { return state.statusCode; },
    get body() { return state.body; },
  };
}

function parseContextHeader(headerValue: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headerValue) return out;
  for (const part of headerValue.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      out[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return out;
}

function makeHit(overrides: Partial<RetrievalHit> = {}): RetrievalHit {
  return {
    docId: '1',
    chunkId: 1,
    ord: 0,
    title: 'Shipping Policy',
    snippet: 'Standard shipping takes 2-4 business days.',
    text: 'Standard shipping takes 2-4 business days nationwide.',
    score: 0.9,
    semanticRank: 1,
    sources: ['semantic'],
    ...overrides,
  };
}

describe('context-budget US4: knowledge retrieval budget, dedup, and citations', () => {
  let server: Server;
  let base: string;
  const realFetch = global.fetch;
  const upstreamBodies: Array<Record<string, unknown>> = [];
  let ownerId: number;
  let ownerToken: string;
  let profileId: number;
  let profileKey: string;

  const call = async (
    path: string,
    token: string | undefined,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await realFetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as any, headers: res.headers };
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    vi.stubEnv('PROXY_RATE_LIMIT_RPM', '0');
    setKeyCacheTestOverride(true);
    clearContextPolicyCache();
    resetFlagsCacheForTests();

    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });
    setFlags({
      prompts: false,
      retrieval: false,
      promptCache: false,
      mcpClient: false,
      outputGuard: false,
      orchestrator: false,
    });
    const db = getDb();
    const enc = encrypt('gsk_knowledge_test');
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES ('groq', 'kb-k', ?, ?, ?, 'healthy', 1)`,
    ).run(enc.encrypted, enc.iv, enc.authTag);
    db.prepare("UPDATE models SET rpm_limit = NULL, rpd_limit = NULL, tpm_limit = NULL WHERE platform = 'groq'").run();
    db.prepare('UPDATE models SET enabled = 0').run();
    db.prepare(
      `UPDATE models SET enabled = 1, context_window = 8192
       WHERE platform = 'groq' AND model_id = 'llama-3.1-8b-instant'`,
    ).run();
    const updated70b = db.prepare(
      `UPDATE models SET enabled = 1, context_window = 131072
       WHERE platform = 'groq' AND model_id = 'llama-3.3-70b-versatile'`,
    ).run();
    if (updated70b.changes === 0) {
      db.prepare(
        `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, supports_tools, supports_vision, context_window, enabled, source)
         VALUES ('groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 1, 1, 1, 0, 131072, 1, 'seed')`,
      ).run();
    }

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    ownerId = createUser('kb-owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);

    const p1 = await call('/api/client-profiles', ownerToken, 'POST', { name: 'kb-main' });
    profileId = p1.body.id;
    profileKey = p1.body.key;
    await call(`/api/client-profiles/${profileId}/quota`, ownerToken, 'PUT', { rpmLimit: null });

    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      const parsedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      upstreamBodies.push(parsedBody);
      return new Response(
        JSON.stringify({
          id: 'ok',
          object: 'chat.completion',
          created: 1,
          model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok reply' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
  });

  afterAll(() => {
    stopIndexWorker();
    server?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setKeyCacheTestOverride(null);
    clearContextPolicyCache();
    resetFlagsCacheForTests();
    setEmbeddingsRunnerForTests(null);
    setQueryEmbeddingsRunnerForTests(null);
    invalidateVectorCache();
  });

  afterEach(async () => {
    upstreamBodies.length = 0;
    clearAllCooldowns();
    clearContextPolicyCache();
    resetFlagsCacheForTests();
    setFlags({
      prompts: false,
      retrieval: false,
      promptCache: false,
      mcpClient: false,
      outputGuard: false,
      orchestrator: false,
    });
    setEmbeddingsRunnerForTests(null);
    setQueryEmbeddingsRunnerForTests(null);
    invalidateVectorCache();
    resetKnowledgeIndexes();

    const db = getDb();
    db.prepare('DELETE FROM custom_context_policies').run();
    db.prepare('DELETE FROM custom_conversation_messages').run();
    db.prepare('DELETE FROM custom_conversations').run();
    db.prepare('DELETE FROM custom_knowledge_chunks').run();
    db.prepare('DELETE FROM custom_knowledge_docs').run();
    db.prepare('DELETE FROM custom_ai_chunk_embeddings').run();
    db.prepare('DELETE FROM custom_ai_retrieval_settings').run();
    setKnowledgeSettings(profileId, { enabled: false, maxChars: 3000 });
    await call(`/api/client-profiles/${profileId}/conversation-settings`, ownerToken, 'PUT', {
      enabled: false,
      ttlHours: 168,
      maxMessages: 20,
      maxChars: 12000,
      summarize: false,
    });
  });

  it('computes provisional knowledge token cap per R7 and selects whole passages within token cap', () => {
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 4000,
      outputReserveTokens: 1000,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 20,
      dropBlockTurns: 4,
      summarize: false,
      clientHistoryMode: 'passthrough',
    });

    const req = makeMockReq({
      model: 'auto',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Tell me about policy details.' },
      ],
    });
    const mock = makeMockRes();
    const reg = prepareContextBudget(req, profileId)!;
    expect(reg).toBeDefined();
    expect(checkMandatoryBudget(req, mock.res, 'openai-chat')).toBe(true);

    const expectedCap = Math.floor(
      Math.max(0, reg.provisionalBudget! - reg.mandatoryTokens!) * 0.2,
    );
    expect(getKnowledgeTokenCap(req)).toBe(expectedCap);
    expect(knowledgeCandidateMaxChars(expectedCap)).toBe(expectedCap * 4);

    const passages = [
      { id: 'low', score: 0.4, text: 'alpha beta gamma delta epsilon '.repeat(4).trim() },
      { id: 'best', score: 0.95, text: 'one two three four five six '.repeat(5).trim() },
      { id: 'mid', score: 0.7, text: 'seven eight nine ten eleven twelve '.repeat(5).trim() },
      { id: 'huge', score: 0.99, text: 'oversized '.repeat(120).trim() },
    ];
    // Cap allows `best` + `mid`, must skip `huge` without slicing, and order descending by score.
    const tightCap =
      estimateTextTokens(passages[1]!.text) + estimateTextTokens(passages[2]!.text) + 1;
    const picked = selectPassagesWithinTokens(passages, tightCap);
    expect(picked.map((p) => p.id)).toEqual(['best', 'mid']);
    expect(picked[0]!.text).toBe(passages[1]!.text);
    expect(picked[1]!.text).toBe(passages[2]!.text);
  });

  it('keeps total injected Vietnamese knowledge tokens <= cap for an English query and registers whole units', () => {
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 2000,
      outputReserveTokens: 512,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 15,
      dropBlockTurns: 4,
      summarize: false,
      clientHistoryMode: 'passthrough',
    });
    setKnowledgeSettings(profileId, { enabled: true, maxChars: 100 }); // legacy char limit smaller than cap * 4

    // Vietnamese passages have higher token/char ratio (~1 token per 2.5 chars).
    const vnDoc1 =
      'Chính sách bảo hành toàn diện áp dụng cho thiết bị điện tử trong vòng hai mươi bốn tháng kể từ ngày giao hàng thành công tại Việt Nam.';
    const vnDoc2 =
      'Chính sách đổi trả hàng hóa áp dụng trong bảy ngày đầu tiên nếu sản phẩm còn nguyên tem niêm phong và hóa đơn mua hàng chính hãng.';
    const vnDoc3 =
      'Chính sách vận chuyển nhanh toàn quốc hỗ trợ giao nhận tận nơi trong hai ngày làm việc với chi phí ưu đãi cho khách hàng thân thiết.';
    const vnDoc4 =
      'Chính sách hoàn tiền trực tiếp qua tài khoản ngân hàng được xử lý tự động trong vòng ba ngày làm việc sau khi kiểm tra sản phẩm.';
    addDoc(profileId, 'Bảo hành', vnDoc1);
    addDoc(profileId, 'Đổi trả', vnDoc2);
    addDoc(profileId, 'Vận chuyển', vnDoc3);
    addDoc(profileId, 'Hoàn tiền', vnDoc4);

    const req = makeMockReq({
      model: 'auto',
      messages: [
        { role: 'system', content: 'Answer concisely.' },
        {
          role: 'user',
          content: 'Please explain chính sách bảo hành đổi trả vận chuyển hoàn tiền in detail.',
        },
      ],
    });
    const mock = makeMockRes();
    prepareContextBudget(req, profileId);
    expect(checkMandatoryBudget(req, mock.res, 'openai-chat')).toBe(true);
    const cap = getKnowledgeTokenCap(req)!;
    expect(cap).toBeGreaterThan(0);

    const count = injectKnowledge(req, profileId, 100);
    expect(count).toBeGreaterThan(0);

    const reg = getRegistry(req)!;
    const kbUnits = reg.units.filter((u) => u.kind === 'knowledge');
    expect(kbUnits.length).toBeGreaterThan(0);

    const bodyMsgs = (req.body as { messages: Array<{ role: string; content: string }> }).messages;
    const kbMsg = bodyMsgs.find(
      (m) => m.role === 'system' && m.content.includes('Reference material from this website.'),
    );
    expect(kbMsg).toBeDefined();
    // 4-token message framing + text tokens must stay <= cap
    expect(4 + estimateTextTokens(kbMsg!.content)).toBeLessThanOrEqual(cap);

    // Every included passage must appear intact (never truncated mid-passage)
    for (const passage of [vnDoc1, vnDoc2, vnDoc3, vnDoc4]) {
      const titleSnippet = passage.slice(0, 20);
      if (kbMsg!.content.includes(titleSnippet)) {
        expect(kbMsg!.content).toContain(passage);
      }
    }

    const segments = classifySegments(bodyMsgs as any, reg);
    expect(segments.some((s) => s.kind === 'knowledge' && s.droppable)).toBe(true);
  });

  it('drops passages with >= 80% 5-word shingle overlap against registered history or summary', () => {
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'balanced',
    });

    const historyText =
      'Our enterprise support team responds to priority severity one tickets within fifteen minutes twenty four hours a day all year round.';
    const summaryText =
      'Customer asked about refund timeline and learned that bank transfer refunds complete within three to five business days after inspection.';
    const freshText =
      'Custom SSO integration uses SAML two point zero metadata XML uploaded through the organization security settings panel.';

    expect(isShingleDuplicate(historyText, [historyText], 0.8)).toBe(true);
    expect(
      isShingleDuplicate(
        'Our enterprise support team responds to priority severity one tickets within fifteen minutes twenty four hours a day.',
        [historyText],
        0.8,
      ),
    ).toBe(true);
    expect(isShingleDuplicate(freshText, [historyText, summaryText], 0.8)).toBe(false);

    addDoc(profileId, 'Support SLA', historyText);
    addDoc(profileId, 'Refund Summary', summaryText);
    addDoc(profileId, 'SSO SAML', freshText);

    const req = makeMockReq({
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: 'Tell me about enterprise support priority tickets refund timeline and SAML SSO.',
        },
      ],
    });
    const mock = makeMockRes();
    prepareContextBudget(req, profileId);
    registerSummary(req, summaryText);
    registerHistory(req, [{ id: 10, role: 'assistant', content: historyText }]);
    expect(checkMandatoryBudget(req, mock.res, 'openai-chat')).toBe(true);

    const count = injectKnowledge(req, profileId, 3000);
    expect(count).toBe(1);

    const kbMsg = (req.body as { messages: Array<{ role: string; content: string }> }).messages.find(
      (m) => m.role === 'system' && m.content.includes('Reference material'),
    );
    expect(kbMsg?.content).toContain(freshText);
    expect(kbMsg?.content).not.toContain(historyText);
    expect(kbMsg?.content).not.toContain(summaryText);
  });

  it('injects nothing when query does not match (kb_sent=0) and reallocates unused knowledge share to history', async () => {
    await call(`/api/client-profiles/${profileId}/conversation-settings`, ownerToken, 'PUT', {
      enabled: true,
      ttlHours: 168,
      maxMessages: 20,
      maxChars: 12000,
      summarize: false,
    });
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 2000,
      outputReserveTokens: 512,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 40,
      dropBlockTurns: 2,
      summarize: false,
      clientHistoryMode: 'passthrough',
    });
    setKnowledgeSettings(profileId, { enabled: true, maxChars: 3000 });
    addDoc(profileId, 'Quantum', 'Quantum entanglement photon polarization experiments in vacuum chambers.');

    // Populate stored conversation history sized to exceed (1 - 0.15 - 0.40) = 45% of available,
    // so history relies on the unused 40% knowledge remainder to fit more turns.
    for (let i = 1; i <= 6; i++) {
      const r = await call('/v1/chat/completions', profileKey, 'POST', {
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: `Turn ${i}: ` + 'history word '.repeat(60) }],
      }, { 'x-conversation-id': 'kb-remainder-conv' });
      expect(r.status).toBe(200);
    }

    const unmatched = await call('/v1/chat/completions', profileKey, 'POST', {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'zzzz unmatched inquiry about baking bread' }],
    }, { 'x-conversation-id': 'kb-remainder-conv' });
    expect(unmatched.status).toBe(200);

    const ctx = parseContextHeader(unmatched.headers.get('x-freellm-context'));
    expect(ctx.kb_sent).toBe('0');
    expect(ctx.knowledge).toBe('0');

    const budget = Number(ctx.budget);
    const mandatory = Number(ctx.mandatory);
    const available = budget - mandatory;
    // History received more than the 45% baseline because unused 40% knowledge share was reallocated
    expect(Number(ctx.history)).toBeGreaterThan(Math.floor(available * 0.45));
  });

  it('filters semantic retrieval hits below knowledgeMinScore in pipeline Slot 6', async () => {
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 4000,
      outputReserveTokens: 512,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 25,
      dropBlockTurns: 4,
      summarize: false,
      clientHistoryMode: 'passthrough',
      knowledgeMinScore: 0.75,
    });
    setKnowledgeSettings(profileId, { enabled: true, maxChars: 200 });

    const docHighId = addDoc(profileId, 'High Match', 'Semantic warranty policy guarantees two year replacement.');
    addDoc(profileId, 'Low Match', 'Distant topic about cafeteria lunch schedules.');

    const scope = { kind: 'profile' as const, id: String(profileId) };
    setRetrievalSettings(scope, {
      mode: 'semantic',
      dimensions: 64,
      topK: 5,
      minScore: 0.1,
      citationsEnabled: true,
    });

    // Deterministic 64-dim unit vectors: query=[1,0,...], high=[0.95, 0.3122,...] (~0.95), low=[0.4, 0.9165,...] (~0.40)
    const vecByText = (text: string): number[] => {
      const v = new Array<number>(64).fill(0);
      if (text.includes('warranty') && !text.includes('question')) {
        v[0] = 0.95;
        v[1] = 0.3122499;
      } else if (text.includes('cafeteria')) {
        v[0] = 0.4;
        v[1] = 0.9165151;
      } else {
        v[0] = 1;
      }
      return v;
    };
    const runner = async (_model: string, inputs: string[]) => ({
      family: 'test-model',
      modelId: 'test-embed',
      dimensions: 64,
      vectors: inputs.map((t) => vecByText(t)),
      usage: { promptTokens: 4, totalTokens: 4 },
    });
    setEmbeddingsRunnerForTests(runner as any);
    setQueryEmbeddingsRunnerForTests(runner as any);

    enqueueReindexJob(scope, 'reindex');
    await runPendingIndexJobsUntilIdle();
    invalidateVectorCache(scope);

    resetFlagsCacheForTests();
    setFlags({ retrieval: true });

    const req = makeMockReq({
      model: 'auto',
      messages: [{ role: 'user', content: 'warranty policy question' }],
    });
    const mock = makeMockRes();
    prepareContextBudget(req, profileId);
    checkMandatoryBudget(req, mock.res, 'openai-chat');

    const profile: GateProfile = {
      id: profileId,
      rpmLimit: null,
      allowedModels: [],
      maxTokens: null,
      endUserQuota: { dailyRequests: null, dailyTokens: null, monthlyRequests: null, monthlyTokens: null },
      knowledge: { enabled: true, maxChars: 200 },
      conversations: { enabled: false, ttlHours: 168, maxMessages: 20, maxChars: 12000, summarize: false },
      contentFilter: { enabled: false, blockOnError: false, rules: [] },
      quickAnswers: { enabled: false, minSimilarity: 0.85, answers: [] },
    } as unknown as GateProfile;

    const outcome = await runPreRequest(req, mock.res, profile, null);
    expect(outcome).toBe('continue');

    const kbMsg = (req.body as { messages: Array<{ role: string; content: string }> }).messages.find(
      (m) => m.role === 'system' && m.content.includes('Reference material'),
    );
    expect(kbMsg?.content).toContain('Semantic warranty policy');
    expect(kbMsg?.content).not.toContain('cafeteria lunch');

    const citHeader = mock.headers[CITATIONS_HEADER_NAME];
    expect(citHeader).toBeDefined();
    const decoded = JSON.parse(Buffer.from(citHeader!, 'base64url').toString('utf8')) as Array<{ docId: string }>;
    expect(decoded.map((d) => d.docId)).toEqual([String(docHighId)]);
  });

  it('citationFilter skips response citations when registry.knowledgeDropped is true, and dispatch removes x-freellm-citations', async () => {
    // 1. Unit check on citationFilter
    const unitReq = makeMockReq({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    saveContextPolicy(profileId, { enabled: true, preset: 'balanced' });
    const reg = prepareContextBudget(unitReq, profileId)!;
    const filter = citationFilter('openai-chat', [makeHit()], { req: unitReq })!;
    expect(filter).not.toBeNull();
    expect(filter.onResponseObject({ id: 'c1', choices: [] })?.citations).toHaveLength(1);
    reg.knowledgeDropped = true;
    expect(filter.onResponseObject({ id: 'c1', choices: [] })).toBeUndefined();

    // 2. Full HTTP check: provisionalBudget uses 131k window -> KB fits at gate and sets x-freellm-citations;
    //    dispatch routes to 8192-window model where mandatory leaves too little room -> KB dropped at dispatch.
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 32000,
      outputReserveTokens: 1024,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 25,
      dropBlockTurns: 4,
      summarize: false,
      clientHistoryMode: 'passthrough',
    });
    setKnowledgeSettings(profileId, { enabled: true, maxChars: 3000 });
    // ~5400 tokens of mandatory user message: fits provisionalBudget (32000) and 8192 window (6451),
    // leaving knowledgeCap = floor((6451 - 5400) * 0.25) ~= 262 tokens, while KB block is ~300+ tokens -> KB dropped at dispatch.
    const kbText =
      'Comprehensive warranty coverage includes hardware replacement and shipping support across all regions. '.repeat(16).trim();
    addDoc(profileId, 'Warranty Terms', kbText);

    const scope = { kind: 'profile' as const, id: String(profileId) };
    getDb()
      .prepare(
        `INSERT INTO custom_ai_retrieval_settings (scope_kind, scope_id, mode, top_k, min_score, citations_enabled)
         VALUES (?, ?, 'keyword', 3, 0.1, 1)`,
      )
      .run(scope.kind, scope.id);
    resetFlagsCacheForTests();
    setFlags({ retrieval: true });

    const bigUserPrompt = 'warranty replacement hardware coverage '.repeat(540).trim();
    const res = await call('/v1/chat/completions', profileKey, 'POST', {
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: bigUserPrompt }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(CITATIONS_HEADER_NAME)).toBeNull();
    expect(res.body?.citations).toBeUndefined();

    const ctx = parseContextHeader(res.headers.get('x-freellm-context'));
    expect(ctx.kb_sent).toBe('0');
    expect(Number(ctx.kb_dropped)).toBeGreaterThan(0);
  });

  it('preserves legacy maxChars parity when context policy is disabled', () => {
    setKnowledgeSettings(profileId, { enabled: true, maxChars: 140 });
    const docA = 'Shipping costs 30000 VND nationwide for standard orders within two to four days.';
    const docB = 'Shipping express costs 60000 VND for same day delivery in major cities.';
    addDoc(profileId, 'Standard Shipping', docA);
    addDoc(profileId, 'Express Shipping', docB);

    const req = makeMockReq({
      model: 'auto',
      messages: [{ role: 'user', content: 'What are the shipping costs?' }],
    });
    expect(getKnowledgeTokenCap(req)).toBeNull();
    const count = injectKnowledge(req, profileId, 140);
    // Only one doc fits within legacy 140 chars
    expect(count).toBe(1);
    expect(getRegistry(req)).toBeUndefined();
  });
});
