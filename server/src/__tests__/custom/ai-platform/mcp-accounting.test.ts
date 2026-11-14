import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app.js';
import { getDb, initDb } from '../../../db/index.js';
import { encrypt } from '../../../lib/crypto.js';
import { setKeyCacheTestOverride } from '../../../services/key-cache.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { setBindings } from '../../../custom/ai-platform/mcp-client/bindings.js';
import {
  createServer,
  listServerTools,
  reviewTool,
  syncServerTools,
} from '../../../custom/ai-platform/mcp-client/registry.js';
import type { McpTransportClient } from '../../../custom/ai-platform/mcp-client/store.js';
import { prepareMcpTakeover } from '../../../custom/ai-platform/mcp-client/admission.js';
import { profileForGate } from '../../../services/profile-usage.js';
import { hashClientProfileKey } from '../../../lib/system-prompt.js';
import { isInternalCall } from '../../../custom/ai-platform/loopback.js';
import { startFakeProviderServer } from '../../helpers/ai-platform-fake-provider.js';

let server: http.Server | null = null;
let baseUrl = '';

async function startTestApp() {
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

function makeFakeTransport(): McpTransportClient {
  return {
    async mcpInitialize(config) {
      return {
        serverId: config.serverId,
        revision: config.revision,
        credentialGeneration: config.credentialGeneration,
        origin: new URL(config.url).origin,
        sessionId: 'sess-acct',
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'acct-mcp' },
      };
    },
    async mcpListTools() {
      return [
        {
          name: 'ping',
          description: 'Ping',
          inputSchema: { type: 'object', properties: {} },
        },
      ];
    },
  };
}

function insertProfile(rawKey: string, opts: { aiToolsEnabled?: number; maxRounds?: number | null; rpmLimit?: number | null } = {}) {
  const res = getDb()
    .prepare(
      `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled, ai_tools_enabled, ai_tool_max_rounds, rpm_limit)
       VALUES (?, ?, 'enc', 'iv', 'tag', 1, ?, ?, ?)`,
    )
    .run(
      'acct-profile',
      hashClientProfileKey(rawKey),
      opts.aiToolsEnabled ?? 0,
      opts.maxRounds ?? null,
      opts.rpmLimit ?? null,
    );
  return Number(res.lastInsertRowid);
}

beforeEach(async () => {
  initDb(':memory:');
  resetFlagsCacheForTests();
  await startTestApp();
});

afterEach(async () => {
  resetFlagsCacheForTests();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  try { getDb().close(); } catch { /* already closed */ }
});

describe('MCP Admission & Accounting (T049)', () => {
  it('profileForGate reads ai_tools_enabled and ai_tool_max_rounds safely', () => {
    const rawKey = 'sk-cp-test-profile-gate-1234';
    insertProfile(rawKey, { aiToolsEnabled: 1, maxRounds: 5 });
    const profile = profileForGate(rawKey);
    expect(profile).not.toBeNull();
    expect(profile!.aiToolsEnabled).toBe(true);
    expect(profile!.aiToolMaxRounds).toBe(5);
  });

  it('prepareMcpTakeover returns null when flag is off, per-profile is off, header is off, or no bound tools exist', async () => {
    const rawKey = 'sk-cp-test-takeover-null-1234';
    const profileId = insertProfile(rawKey, { aiToolsEnabled: 1 });
    const srv = await createServer({ slug: 's1', name: 'S1', url: 'https://mcp.example.com/v1', authKind: 'none' }, 1);
    setFlags({ mcpClient: true });
    await syncServerTools(srv.id, 1, undefined, makeFakeTransport());
    const tool = listServerTools(srv.id)[0]!;
    reviewTool(tool.id, { state: 'allowed', effect: 'read' }, 1);
    setBindings({ kind: 'profile', id: String(profileId) }, { toolIds: [tool.id], enabled: true });

    const profile = profileForGate(rawKey)!;
    const baseReq = {
      method: 'POST',
      originalUrl: '/v1/chat/completions',
      url: '/v1/chat/completions',
      path: '/v1/chat/completions',
      headers: {},
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
    } as unknown as Parameters<typeof prepareMcpTakeover>[0];

    // Flag off -> null
    setFlags({ mcpClient: false });
    expect(prepareMcpTakeover(baseReq, profile, null)).toBeNull();

    // Flag on, x-freellm-tools: off -> null
    setFlags({ mcpClient: true });
    const offHeaderReq = {
      ...baseReq,
      headers: { 'x-freellm-tools': 'off' },
    } as unknown as Parameters<typeof prepareMcpTakeover>[0];
    expect(prepareMcpTakeover(offHeaderReq, profile, null)).toBeNull();

    // Flag on, valid request -> non-null plan
    const plan = prepareMcpTakeover(baseReq, profile, null);
    expect(plan).not.toBeNull();
    expect(plan!.tools).toHaveLength(1);
    expect(plan!.wire).toBe('openai-chat');
  });

  it('rejects unsigned x-ai-platform-internal headers and never grants internal bypass', async () => {
    const rawKey = 'sk-cp-forged-internal-1234';
    insertProfile(rawKey, { aiToolsEnabled: 0, rpmLimit: 1 });

    // First request with forged header still consumes the 1 RPM slot (not bypassed)
    const r1 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${rawKey}`,
        'content-type': 'application/json',
        'x-ai-platform-internal': 'v1.9999999999.deadbeef.forgedsig',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    // Regardless of upstream provider presence, RPM header must be set (gate ran normally)
    expect(r1.headers.get('x-ratelimit-limit-profile-rpm')).toBe('1');

    // Second request hits 429 profile_rate_limit_exceeded
    const r2 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${rawKey}`,
        'content-type': 'application/json',
        'x-ai-platform-internal': 'v1.9999999999.deadbeef.forgedsig',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r2.status).toBe(429);

    expect(
      isInternalCall({
        headers: { 'x-ai-platform-internal': 'v1.1.aa.bb' },
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as Parameters<typeof isInternalCall>[0]),
    ).toBeNull();
  });

  it('settles inner gateway round DB counters once per round and enforces profile RPM across takeover', async () => {
    setKeyCacheTestOverride(true);
    const enc = encrypt('gsk_acct_test');
    getDb()
      .prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
         VALUES ('groq', 'groq-acct', ?, ?, ?, 'healthy', 1)`,
      )
      .run(enc.encrypted, enc.iv, enc.authTag);

    // Offset profile id from earlier tests that share the in-memory rate-limit map
    insertProfile('sk-cp-offset-dummy-1234', { aiToolsEnabled: 0 });
    const rawKey = 'sk-cp-takeover-db-acct-1234';
    const profileId = insertProfile(rawKey, { aiToolsEnabled: 1, maxRounds: 4, rpmLimit: 2 });
    getDb().prepare('UPDATE client_profiles SET eu_daily_requests = 10 WHERE id = ?').run(profileId);
    const srv = await createServer({ slug: 'acct-srv', name: 'AcctSrv', url: 'https://mcp.example.com/v1', authKind: 'none' }, 1);
    setFlags({ mcpClient: true });
    await syncServerTools(srv.id, 1, undefined, makeFakeTransport());
    const tool = listServerTools(srv.id)[0]!;
    reviewTool(tool.id, { state: 'allowed', effect: 'read' }, 1);
    setBindings({ kind: 'profile', id: String(profileId) }, { toolIds: [tool.id], enabled: true });

    const fakeProvider = await startFakeProviderServer({
      kind: 'scripted',
      text: 'accounting-ok',
      usage: { promptTokens: 15, completionTokens: 5, totalTokens: 20 },
    });

    const realFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.startsWith(baseUrl) || urlStr.startsWith(fakeProvider.url)) {
        return realFetch(input, init);
      }
      const parsed = new URL(urlStr);
      return realFetch(`${fakeProvider.url}${parsed.pathname}${parsed.search}`, init);
    });

    try {
      const reqHeaders = {
        authorization: `Bearer ${rawKey}`,
        'content-type': 'application/json',
        'x-end-user': 'eu-acct-1',
      };
      const reqBody = JSON.stringify({
        model: 'groq/compound',
        messages: [{ role: 'user', content: 'hello accounting' }],
      });

      const r1 = await realFetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: reqHeaders, body: reqBody });
      expect(r1.status).toBe(200);
      const b1 = await r1.json() as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
      expect(b1.usage?.prompt_tokens).toBe(15);
      expect(b1.usage?.completion_tokens).toBe(5);
      expect(b1.usage?.total_tokens).toBe(20);

      // Only 1 requests row and 1 custom_end_user_counters row (outer envelope did not double-bill)
      const logCount1 = getDb().prepare('SELECT COUNT(*) as c FROM requests').get() as { c: number };
      expect(logCount1.c).toBe(1);
      const euRow1 = getDb()
        .prepare("SELECT requests, tokens FROM custom_end_user_counters WHERE end_user = 'eu-acct-1'")
        .get() as { requests: number; tokens: number } | undefined;
      expect(euRow1?.requests).toBe(1);
      expect(euRow1?.tokens).toBe(20);

      const r2 = await realFetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: reqHeaders, body: reqBody });
      expect(r2.status).toBe(200);
      const logCount2 = getDb().prepare('SELECT COUNT(*) as c FROM requests').get() as { c: number };
      expect(logCount2.c).toBe(2);

      // 3rd request hits profile RPM limit (2) on the inner gateway round
      const r3 = await realFetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: reqHeaders, body: reqBody });
      expect(r3.status).toBe(429);
    } finally {
      vi.restoreAllMocks();
      await fakeProvider.close();
    }
  });

  it('F05: forwards tool_choice/response_format/max_completion_tokens and falls back before admission on unsupported fields', async () => {
    setKeyCacheTestOverride(true);
    const enc = encrypt('gsk_f05_test');
    getDb()
      .prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
         VALUES ('groq', 'groq-f05', ?, ?, ?, 'healthy', 1)`,
      )
      .run(enc.encrypted, enc.iv, enc.authTag);

    insertProfile('sk-cp-f05-offset-1', { aiToolsEnabled: 0 });
    insertProfile('sk-cp-f05-offset-2', { aiToolsEnabled: 0 });
    const rawKey = 'sk-cp-f05-http-1234';
    const profileId = insertProfile(rawKey, { aiToolsEnabled: 1, maxRounds: 4 });
    const srv = await createServer({ slug: 'f05-srv', name: 'F05Srv', url: 'https://mcp.example.com/v1', authKind: 'none' }, 1);
    setFlags({ mcpClient: true });
    await syncServerTools(srv.id, 1, undefined, makeFakeTransport());
    const tool = listServerTools(srv.id)[0]!;
    reviewTool(tool.id, { state: 'allowed', effect: 'read' }, 1);
    setBindings({ kind: 'profile', id: String(profileId) }, { toolIds: [tool.id], enabled: true });

    const fakeProvider = await startFakeProviderServer({ kind: 'scripted', text: '{}' });
    const realFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.startsWith(baseUrl) || urlStr.startsWith(fakeProvider.url)) {
        return realFetch(input, init);
      }
      const parsed = new URL(urlStr);
      return realFetch(`${fakeProvider.url}${parsed.pathname}${parsed.search}`, init);
    });

    try {
      const r1 = await realFetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'groq/compound',
          messages: [{ role: 'user', content: 'json only' }],
          tool_choice: 'none',
          response_format: { type: 'json_object' },
          max_completion_tokens: 128,
        }),
      });
      expect(r1.status).toBe(200);
      await r1.text();
      const sent1 = fakeProvider.requests[0]!.bodyJson as Record<string, unknown>;
      expect(sent1.tool_choice).toBe('none');
      expect(sent1.response_format).toEqual({ type: 'json_object' });
      expect(sent1.max_tokens).toBe(128);

      // Unsupported field (parallel_tool_calls) triggers fallback to normal gateway before admission
      fakeProvider.clearRequests();
      fakeProvider.enqueue({ kind: 'scripted', wire: 'openai-chat', text: 'fallback-ok', stream: false });
      const r2 = await realFetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'groq/compound',
          messages: [{ role: 'user', content: 'parallel off' }],
          parallel_tool_calls: false,
        }),
      });
      expect(r2.status).toBe(200);
      await r2.text();
      const sent2 = fakeProvider.requests[0]!.bodyJson as Record<string, unknown>;
      expect(sent2.parallel_tool_calls).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await fakeProvider.close();
    }
  });

  it('F06: preserves multi-turn conversations, validation, quick answers, and single KB enrichment under MCP takeover', async () => {
    setKeyCacheTestOverride(true);
    const enc = encrypt('gsk_f06_test');
    getDb()
      .prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
         VALUES ('groq', 'groq-f06', ?, ?, ?, 'healthy', 1)`,
      )
      .run(enc.encrypted, enc.iv, enc.authTag);

    insertProfile('sk-cp-f06-offset-1', { aiToolsEnabled: 0 });
    insertProfile('sk-cp-f06-offset-2', { aiToolsEnabled: 0 });
    insertProfile('sk-cp-f06-offset-3', { aiToolsEnabled: 0 });
    const rawKey = 'sk-cp-f06-http-1234';
    const profileId = insertProfile(rawKey, { aiToolsEnabled: 1, maxRounds: 4 });
    getDb().prepare('UPDATE client_profiles SET conv_enabled = 1, qa_enabled = 1 WHERE id = ?').run(profileId);
    getDb()
      .prepare(
        `INSERT INTO custom_quick_answers (profile_id, questions, answer, enabled, updated_at)
         VALUES (?, ?, '9am to 5pm daily.', 1, ?)`,
      )
      .run(profileId, JSON.stringify(['What are your opening hours?']), new Date().toISOString());

    const srv = await createServer({ slug: 'f06-srv', name: 'F06Srv', url: 'https://mcp.example.com/v1', authKind: 'none' }, 1);
    setFlags({ mcpClient: true });
    await syncServerTools(srv.id, 1, undefined, makeFakeTransport());
    const tool = listServerTools(srv.id)[0]!;
    reviewTool(tool.id, { state: 'allowed', effect: 'read' }, 1);
    setBindings({ kind: 'profile', id: String(profileId) }, { toolIds: [tool.id], enabled: true });

    const fakeProvider = await startFakeProviderServer();
    const realFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.startsWith(baseUrl) || urlStr.startsWith(fakeProvider.url)) {
        return realFetch(input, init);
      }
      const parsed = new URL(urlStr);
      return realFetch(`${fakeProvider.url}${parsed.pathname}${parsed.search}`, init);
    });

    try {
      // 1. Multi-turn conversation
      fakeProvider.enqueue(
        { kind: 'scripted', wire: 'openai-chat', text: 'Alpha noted.', stream: false },
        { kind: 'scripted', wire: 'openai-chat', text: 'It was alpha.', stream: false },
      );
      const convHeaders = {
        authorization: `Bearer ${rawKey}`,
        'content-type': 'application/json',
        'x-conversation-id': 'conv-f06-1',
        'x-end-user': 'eu-f06-a',
      };
      const t1 = await realFetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: convHeaders,
        body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: 'Remember code alpha' }] }),
      });
      expect(t1.status).toBe(200);
      await t1.text();

      const t2 = await realFetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: convHeaders,
        body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: 'What was the code?' }] }),
      });
      expect(t2.status).toBe(200);
      expect(t2.headers.get('x-conversation-history')).toBe('2');
      await t2.text();

      const msgCount = getDb().prepare('SELECT COUNT(*) as c FROM custom_conversation_messages').get() as { c: number };
      expect(msgCount.c).toBe(4);

      // 2. Wrong end-user on existing conversation -> 403
      const wrongEu = await realFetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...convHeaders, 'x-end-user': 'eu-f06-other' },
        body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: 'steal' }] }),
      });
      expect(wrongEu.status).toBe(403);

      // 3. Quick answer -> zero provider calls
      fakeProvider.clearRequests();
      const qaRes = await realFetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: 'What are your opening hours?' }] }),
      });
      expect(qaRes.status).toBe(200);
      expect(qaRes.headers.get('x-quick-answer')).toBeTruthy();
      expect(fakeProvider.requests).toHaveLength(0);

      // 4. F06: Knowledge injection runs ONCE on outer request, NOT duplicated on round 2
      const { addDoc, setKnowledgeSettings } = await import('../../../services/profile-knowledge.js');
      setKnowledgeSettings(profileId, { enabled: true, maxChars: 2000 });
      addDoc(profileId, 'Policy', 'The refund policy code is UNIQUE_KB_FACT_98765.');

      fakeProvider.clearRequests();
      fakeProvider.enqueue(
        {
          kind: 'scripted',
          wire: 'openai-chat',
          toolCalls: [{ id: 'call_kb_1', name: tool.exposedName, arguments: { query: 'policy' } }],
          stream: false,
        },
        { kind: 'scripted', wire: 'openai-chat', text: 'KB policy confirmed.', stream: false },
      );

      const kbRes = await realFetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: 'Tell me about UNIQUE_KB_FACT_98765' }] }),
      });
      expect(kbRes.status).toBe(200);
      await kbRes.text();
      expect(fakeProvider.requests).toHaveLength(2);

      for (const reqLog of fakeProvider.requests) {
        const bodyStr = JSON.stringify(reqLog.bodyJson);
        const matches = bodyStr.match(/Reference material from this website\./g) ?? [];
        expect(matches).toHaveLength(1);
      }
    } finally {
      vi.restoreAllMocks();
      await fakeProvider.close();
    }
  });
});
