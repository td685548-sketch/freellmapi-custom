import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import { createApp } from '../../../app.js';
import { defaultDbFactory, getDb, initDb } from '../../../db/index.js';
import { wrapTursoDatabase } from '../../../db/turso.js';
import { encrypt } from '../../../lib/crypto.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setKeyCacheTestOverride } from '../../../services/key-cache.js';
import { clearAllCooldowns } from '../../../services/ratelimit.js';
import { loadHistoryCandidates } from '../../../services/profile-conversations.js';
import { clearContextPolicyCache, saveContextPolicy } from '../../../custom/context-budget/policy.js';
import { getRegistry } from '../../../custom/context-budget/registry.js';
import {
  checkMandatoryBudget,
  historyCandidateLimits,
  prepareContextBudget,
  registerHistory,
  registerSummary,
} from '../../../custom/context-budget/gate.js';

function makeMockReq(body: unknown, headers: Record<string, string> = {}, originalUrl = '/v1/chat/completions'): Request {
  return {
    method: 'POST',
    originalUrl,
    url: originalUrl,
    path: originalUrl,
    headers,
    body,
  } as unknown as Request;
}

function makeMockRes(): { res: Response; statusCode: number; headers: Record<string, string>; body: unknown } {
  const state = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
  };
  const res = {
    setHeader(name: string, value: string | number | readonly string[]) {
      state.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    },
    getHeader(name: string) {
      return state.headers[name.toLowerCase()];
    },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
  } as unknown as Response;
  return {
    res,
    get statusCode() { return state.statusCode; },
    get headers() { return state.headers; },
    get body() { return state.body; },
  };
}

describe('context-budget gate & conversation candidate loading', () => {
  let server: Server;
  let base: string;
  const realFetch = global.fetch;
  const upstreamBodies: Array<Record<string, unknown>> = [];
  let summaryDelayMs = 0;
  let ownerId: number;
  let ownerToken: string;
  let profileId: number;
  let profileKey: string;
  let restrictedProfileId: number;
  let restrictedProfileKey: string;

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

    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });
    const db = getDb();
    const enc = encrypt('gsk_gate_test');
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES ('groq', 'gate-k', ?, ?, ?, 'healthy', 1)`,
    ).run(enc.encrypted, enc.iv, enc.authTag);
    db.prepare("UPDATE models SET rpm_limit = NULL, rpd_limit = NULL WHERE platform = 'groq'").run();
    // Ensure deterministic context windows across Groq models: small 8192 and large 131072.
    db.prepare("UPDATE models SET enabled = 0").run();
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
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    ownerId = createUser('gate-owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);

    const p1 = await call('/api/client-profiles', ownerToken, 'POST', { name: 'gate-main' });
    profileId = p1.body.id;
    profileKey = p1.body.key;
    await call(`/api/client-profiles/${profileId}/quota`, ownerToken, 'PUT', { rpmLimit: null });

    const p2 = await call('/api/client-profiles', ownerToken, 'POST', { name: 'gate-restricted' });
    restrictedProfileId = p2.body.id;
    restrictedProfileKey = p2.body.key;
    await call(`/api/client-profiles/${restrictedProfileId}/restrictions`, ownerToken, 'PUT', {
      allowedModels: ['llama-3.1-8b-instant'],
    });
    await call(`/api/client-profiles/${restrictedProfileId}/quota`, ownerToken, 'PUT', { rpmLimit: null });

    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      const parsedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const msgs = (parsedBody.messages ?? []) as Array<{ role?: string; content?: unknown }>;
      if (msgs.some(m => typeof m.content === 'string' && m.content.includes('running summary'))) {
        if (summaryDelayMs > 0) await new Promise(r => setTimeout(r, summaryDelayMs));
        return new Response(
          JSON.stringify({
            id: 'sum',
            object: 'chat.completion',
            created: 1,
            model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Summary text.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      upstreamBodies.push(parsedBody);
      return new Response(
        JSON.stringify({
          id: 'ok',
          object: 'chat.completion',
          created: 1,
          model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok reply' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setKeyCacheTestOverride(null);
    clearContextPolicyCache();
  });

  afterEach(async () => {
    summaryDelayMs = 0;
    upstreamBodies.length = 0;
    clearAllCooldowns();
    clearContextPolicyCache();
    const db = getDb();
    db.prepare('DELETE FROM custom_context_policies').run();
    db.prepare('DELETE FROM custom_conversation_messages').run();
    db.prepare('DELETE FROM custom_conversations').run();
    await call(`/api/client-profiles/${profileId}/conversation-settings`, ownerToken, 'PUT', {
      enabled: false,
      ttlHours: 168,
      maxMessages: 20,
      maxChars: 12000,
      summarize: false,
    });
  });

  it('is a no-op when context policy is disabled', () => {
    const req = makeMockReq({ model: 'auto', messages: [{ role: 'user', content: 'hello' }] });
    const reg = prepareContextBudget(req, profileId);
    expect(reg).toBeUndefined();
    expect(getRegistry(req)).toBeUndefined();

    const mock = makeMockRes();
    expect(checkMandatoryBudget(req, mock.res, 'openai-chat')).toBe(true);
    expect(mock.statusCode).toBe(200);
    expect(mock.headers['x-freellm-context']).toBeUndefined();
  });

  it('extracts clientMaxTokens across all four wire field names', () => {
    saveContextPolicy(profileId, { enabled: true, preset: 'balanced' });

    const reqOpenAi = makeMockReq({ max_tokens: 512, messages: [{ role: 'user', content: 'hi' }] });
    expect(prepareContextBudget(reqOpenAi, profileId)?.clientMaxTokens).toBe(512);

    const reqOpenAiCompletion = makeMockReq({ max_completion_tokens: 777, messages: [{ role: 'user', content: 'hi' }] });
    expect(prepareContextBudget(reqOpenAiCompletion, profileId)?.clientMaxTokens).toBe(777);

    const reqResponses = makeMockReq({ max_output_tokens: 900, input: 'hi' }, {}, '/v1/responses');
    expect(prepareContextBudget(reqResponses, profileId)?.clientMaxTokens).toBe(900);

    const reqGemini = makeMockReq(
      { generationConfig: { maxOutputTokens: 1234 }, contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      {},
      '/v1beta/models/auto:generateContent',
    );
    expect(prepareContextBudget(reqGemini, profileId)?.clientMaxTokens).toBe(1234);

    const reqNone = makeMockReq({ messages: [{ role: 'user', content: 'hi' }] });
    expect(prepareContextBudget(reqNone, profileId)?.clientMaxTokens).toBeNull();
  });

  it('loads candidate history past legacy conv_max_chars (bounded by conv_max_messages) and registers units with messageId and summary', async () => {
    const db = getDb();
    saveContextPolicy(profileId, { enabled: true, preset: 'balanced' }); // maxInputTokens = 16000
    const settingsRes = await call(`/api/client-profiles/${profileId}/conversation-settings`, ownerToken, 'PUT', {
      enabled: true,
      maxMessages: 6,
      maxChars: 1000, // legacy limit too small for 6 messages of ~300 chars (1800 total)
      summarize: true,
    });
    expect(settingsRes.status).toBe(200);

    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO custom_conversations (id, profile_id, conv_key, end_user, summary, summarized_through, message_count, chars, created_at, updated_at)
       VALUES (50, ?, 'cand-conv', NULL, 'Earlier summary note', 2, 8, 2400, ?, ?)`,
    ).run(profileId, nowIso, nowIso);

    const insertMsg = db.prepare(
      `INSERT INTO custom_conversation_messages (id, conversation_id, role, content, created_at)
       VALUES (?, 50, ?, ?, ?)`,
    );
    for (let i = 1; i <= 8; i++) {
      const role = i % 2 === 1 ? 'user' : 'assistant';
      insertMsg.run(100 + i, role, `msg-${i}-${'a'.repeat(290)}`, nowIso);
    }

    const limits = historyCandidateLimits(
      saveContextPolicy(profileId, { enabled: true, preset: 'balanced' }),
      { enabled: true, ttlHours: 168, maxMessages: 6, maxChars: 1000, summarize: true },
    );
    expect(limits).toEqual({ maxMessages: 6, maxChars: 16000 * 4 });

    const loaded = loadHistoryCandidates(
      profileId,
      'cand-conv',
      null,
      { enabled: true, ttlHours: 168, maxMessages: 6, maxChars: 1000, summarize: true },
      limits,
    );
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.conversationId).toBe(50);
      expect(loaded.summary).toBe('Earlier summary note');
      // Bounded by conv_max_messages = 6 (ids 103..108), exceeding legacy conv_max_chars = 250.
      expect(loaded.history.map(m => m.id)).toEqual([103, 104, 105, 106, 107, 108]);
    }

    // Also verify end-to-end injection sets units and registry.conversation on an Express request.
    const req = makeMockReq(
      { model: 'auto', messages: [{ role: 'user', content: 'latest question' }] },
      { 'x-conversation-id': 'cand-conv' },
    );
    const reg = prepareContextBudget(req, profileId)!;
    expect(reg).toBeDefined();
    if (loaded.ok) {
      registerSummary(req, loaded.summary ? `Summary of the earlier part of this conversation:\n${loaded.summary}` : null);
      registerHistory(req, loaded.history);
    }
    expect(reg.units.some(u => u.kind === 'summary')).toBe(true);
    expect(reg.units.filter(u => u.kind === 'history').map(u => u.messageId)).toEqual([103, 104, 105, 106, 107, 108]);

    // Real HTTP call through /v1/chat/completions sends all 6 candidate history messages (>250 chars) + summary!
    const resp = await call(
      '/v1/chat/completions',
      profileKey,
      'POST',
      { model: 'auto', messages: [{ role: 'user', content: 'new turn' }] },
      { 'x-conversation-id': 'cand-conv' },
    );
    expect(resp.status).toBe(200);
    const sentMsgs = (upstreamBodies[0]?.messages ?? []) as Array<{ role: string; content: string }>;
    expect(sentMsgs.some(m => m.role === 'system' && m.content.includes('Earlier summary note'))).toBe(true);
    const sentHistory = sentMsgs.filter(m => m.role !== 'system');
    expect(sentHistory).toHaveLength(7); // 6 stored candidates + 1 new user turn
  });

  it('rejects oversized mandatory context with 400 context_budget_exceeded and wire-specific payloads across all 4 surfaces', async () => {
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 2000,
      outputReserveTokens: 256,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 25,
      dropBlockTurns: 4,
    });

    const hugePrompt = 'word '.repeat(3000); // ~3750 tokens > 2000

    // 1. /v1/chat/completions
    const chatRes = await call('/v1/chat/completions', profileKey, 'POST', {
      model: 'auto',
      messages: [{ role: 'user', content: hugePrompt }],
    });
    expect(chatRes.status).toBe(400);
    expect(chatRes.headers.get('x-freellm-context')).toMatch(/^budget=2000;mandatory=\d+$/);
    expect(chatRes.body).toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'context_budget_exceeded',
        param: 'messages',
      },
    });
    expect(upstreamBodies).toHaveLength(0);

    // 2. /v1/messages (Anthropic)
    const anthRes = await call('/v1/messages', profileKey, 'POST', {
      model: 'auto',
      max_tokens: 256,
      messages: [{ role: 'user', content: hugePrompt }],
    });
    expect(anthRes.status).toBe(400);
    expect(anthRes.headers.get('x-freellm-context')).toMatch(/^budget=2000;mandatory=\d+$/);
    expect(anthRes.body).toMatchObject({
      type: 'error',
      error: {
        type: 'invalid_request_error',
      },
    });

    // 3. /v1/responses
    const respRes = await call('/v1/responses', profileKey, 'POST', {
      model: 'auto',
      input: hugePrompt,
    });
    expect(respRes.status).toBe(400);
    expect(respRes.headers.get('x-freellm-context')).toMatch(/^budget=2000;mandatory=\d+$/);
    expect(respRes.body).toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'context_budget_exceeded',
        param: 'messages',
      },
    });

    // 4. Gemini :generateContent
    const gemRes = await call('/v1beta/models/llama-3.3-70b-versatile:generateContent', profileKey, 'POST', {
      contents: [{ role: 'user', parts: [{ text: hugePrompt }] }],
    });
    expect(gemRes.status).toBe(400);
    expect(gemRes.headers.get('x-freellm-context')).toMatch(/^budget=2000;mandatory=\d+$/);
    expect(gemRes.body).toMatchObject({
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
      },
    });
  });

  it('excludes client-sent history from mandatory budget check in passthrough mode', () => {
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 2000,
      outputReserveTokens: 256,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 25,
      dropBlockTurns: 4,
      clientHistoryMode: 'passthrough',
    });

    const hugeClientHistory = 'old history '.repeat(4000);
    const req = makeMockReq({
      model: 'auto',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: hugeClientHistory },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'short new question' },
      ],
    });
    const reg = prepareContextBudget(req, profileId)!;
    const mock = makeMockRes();
    const ok = checkMandatoryBudget(req, mock.res, 'openai-chat');
    expect(ok).toBe(true);
    expect(reg.mandatoryTokens).toBeLessThan(100);
  });

  it('computes provisional budget W_max honoring profile model allowlist', async () => {
    // Key policy allows up to 32000 tokens, but restrictedProfile only allows llama-3.1-8b-instant (8192).
    // Provisional budget for 8192: floor((8192 - 1024) * 0.9) = 6451.
    // Profile 1 (no allowlist) can access llama-3.3-70b-versatile (131072) -> provisionalBudget = 32000.
    saveContextPolicy(profileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 32000,
      outputReserveTokens: 1024,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 25,
      dropBlockTurns: 4,
    });
    saveContextPolicy(restrictedProfileId, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 32000,
      outputReserveTokens: 1024,
      safetyMarginPct: 10,
      summarySharePct: 15,
      knowledgeSharePct: 25,
      dropBlockTurns: 4,
    });

    const mediumPrompt = 'alpha '.repeat(6000); // ~9000 tokens: > 6451, < 32000
    const reqUnrestricted = makeMockReq({ model: 'auto', messages: [{ role: 'user', content: mediumPrompt }] });
    const regUnrestricted = prepareContextBudget(reqUnrestricted, profileId)!;
    expect(regUnrestricted.provisionalBudget).toBe(32000);
    expect(checkMandatoryBudget(reqUnrestricted, makeMockRes().res, 'openai-chat')).toBe(true);

    const reqRestricted = makeMockReq({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: mediumPrompt }] });
    const regRestricted = prepareContextBudget(reqRestricted, restrictedProfileId)!;
    expect(regRestricted.provisionalBudget).toBe(6451);
    const mockRestricted = makeMockRes();
    expect(checkMandatoryBudget(reqRestricted, mockRestricted.res, 'openai-chat')).toBe(false);
    expect(mockRestricted.statusCode).toBe(400);
    expect(mockRestricted.headers['x-freellm-context']).toMatch(/^budget=6451;mandatory=\d+$/);

    const httpRestricted = await call('/v1/chat/completions', restrictedProfileKey, 'POST', {
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: mediumPrompt }],
    });
    expect(httpRestricted.status).toBe(400);
    expect(httpRestricted.headers.get('x-freellm-context')).toMatch(/^budget=6451;mandatory=\d+$/);
  });

  it('handles concurrent requests on the same X-Conversation-Id safely without leaking in-flight summaries', async () => {
    saveContextPolicy(profileId, { enabled: true, preset: 'balanced' });
    await call(`/api/client-profiles/${profileId}/conversation-settings`, ownerToken, 'PUT', {
      enabled: true,
      maxMessages: 20,
      maxChars: 12000,
      summarize: true,
    });

    // Seed an existing turn first.
    await call(
      '/v1/chat/completions',
      profileKey,
      'POST',
      { model: 'auto', messages: [{ role: 'user', content: 'seed turn' }] },
      { 'x-conversation-id': 'conc-1' },
    );
    upstreamBodies.length = 0;

    summaryDelayMs = 80;
    const [r1, r2] = await Promise.all([
      call(
        '/v1/chat/completions',
        profileKey,
        'POST',
        { model: 'auto', messages: [{ role: 'user', content: 'concurrent A' }] },
        { 'x-conversation-id': 'conc-1' },
      ),
      call(
        '/v1/chat/completions',
        profileKey,
        'POST',
        { model: 'auto', messages: [{ role: 'user', content: 'concurrent B' }] },
        { 'x-conversation-id': 'conc-1' },
      ),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(upstreamBodies).toHaveLength(2);
    // Neither concurrent request saw the other's uncommitted turn or an in-flight summary.
    for (const body of upstreamBodies) {
      const contents = (body.messages as Array<{ content: string }>).map(m => m.content);
      expect(contents).toContain('seed turn');
      expect(contents.some(c => c.includes('Summary text.'))).toBe(false);
    }
  });

  it('treats a conversation deleted between two turns as a fresh conversation without error', async () => {
    saveContextPolicy(profileId, { enabled: true, preset: 'balanced' });
    await call(`/api/client-profiles/${profileId}/conversation-settings`, ownerToken, 'PUT', {
      enabled: true,
      maxMessages: 20,
      maxChars: 12000,
      summarize: false,
    });

    const first = await call(
      '/v1/chat/completions',
      profileKey,
      'POST',
      { model: 'auto', messages: [{ role: 'user', content: 'turn before delete' }] },
      { 'x-conversation-id': 'del-conv' },
    );
    expect(first.status).toBe(200);

    // Delete the conversation between turns.
    const db = getDb();
    db.prepare('DELETE FROM custom_conversation_messages').run();
    db.prepare('DELETE FROM custom_conversations').run();
    upstreamBodies.length = 0;

    const second = await call(
      '/v1/chat/completions',
      profileKey,
      'POST',
      { model: 'auto', messages: [{ role: 'user', content: 'turn after delete' }] },
      { 'x-conversation-id': 'del-conv' },
    );
    expect(second.status).toBe(200);
    expect(second.headers.get('x-conversation-history')).toBe('0');
    const msgs = (upstreamBodies[0]?.messages ?? []) as Array<{ role: string; content: string }>;
    expect(msgs.map(m => `${m.role}:${m.content}`)).toEqual(['user:turn after delete']);
  });
});
