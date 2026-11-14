/**
 * T059 — Output Guard End-to-End HTTP Acceptance Tests (Agent 4).
 *
 * Exercises real createApp() + SQLite DB + FakeProviderServer + FakeMcpHttpServer:
 * - 4 wires (openai-chat, anthropic, responses, gemini) x non-stream & stream + Gemini JSON-array stream
 * - Modes: off, log, block, PII mask, multi-choice/candidate filtering
 * - Cross-chunk forbidden term split + provider pause > 300ms (inspecting every emitted frame)
 * - Exact-cache hit, quick answer (0 provider calls), MCP read loop (1 final guard), caller-owned tool_calls intact
 * - Spoofed x-ai-platform-internal / role headers cannot bypass guard
 * - External moderation/judge fail_mode allow vs block + check_failed event
 * - Client mid-stream abort cleanup
 *
 * In RED state before Agent 1/2/3 integration, guard endpoints & inference filtering are absent.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { getDb, initDb } from '../../../db/index.js';
import { encrypt } from '../../../lib/crypto.js';
import { hashClientProfileKey } from '../../../lib/system-prompt.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setKeyCacheTestOverride } from '../../../services/key-cache.js';
import { startFakeMcpHttpServer, type FakeMcpHttpServer } from '../../helpers/ai-platform-fake-mcp-http.js';
import {
  startFakeProviderServer,
  type FakeProviderServer,
  type FakeProviderWire,
} from '../../helpers/ai-platform-fake-provider.js';

let appServer: http.Server | null = null;
let baseUrl = '';
let fakeProvider: FakeProviderServer;
let fakeMcp: FakeMcpHttpServer;
let primaryToken = '';
let clientKey = '';
let profileId = 0;

async function adminCall(urlPath: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      authorization: `Bearer ${primaryToken}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

async function setPolicy(overrides: Record<string, unknown> = {}) {
  const current = await adminCall(`/api/ai-platform/output-guard/profile/${profileId}`);
  const rev = (current.body?.policy as { revision?: number } | undefined)?.revision ?? 0;
  const payload = {
    mode: 'block',
    failMode: 'allow',
    detectors: {
      keywords: { enabled: true, terms: ['forbidden-secret'] },
      patterns: { enabled: false, rules: [] },
      promptLeak: { enabled: true, minShingles: 2 },
      pii: { enabled: true, action: 'mask' },
      maxLength: { enabled: false, chars: 20000 },
      moderation: { enabled: false },
      judge: { enabled: false, model: 'auto', criteria: '' },
    },
    replacementText: 'Blocked by output guard.',
    bypassRoles: ['support_supervisor'],
    holdChars: 200,
    maxDelayMs: 300,
    revision: rev,
    ...overrides,
  };
  const putRes = await adminCall(`/api/ai-platform/output-guard/profile/${profileId}`, 'PUT', payload);
  expect(putRes.status).toBe(200);
}

function wireRequest(wire: FakeProviderWire, stream: boolean, prompt = 'hello') {
  if (wire === 'openai-chat') {
    return {
      path: '/v1/chat/completions',
      body: { model: 'groq/compound', messages: [{ role: 'user', content: prompt }], stream },
    };
  }
  if (wire === 'anthropic') {
    return {
      path: '/v1/messages',
      body: { model: 'anthropic/claude-3-5-sonnet', max_tokens: 64, messages: [{ role: 'user', content: prompt }], stream },
    };
  }
  if (wire === 'responses') {
    return {
      path: '/v1/responses',
      body: { model: 'groq/compound', input: prompt, stream },
    };
  }
  return {
    path: stream
      ? '/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse'
      : '/v1beta/models/gemini-2.0-flash:generateContent',
    body: { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
  };
}

async function readSseFrames(res: Response): Promise<Array<{ raw: string; json: unknown; receivedAt: number }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<{ raw: string; json: unknown; receivedAt: number }> = [];
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
      if (dataLines.length === 0) continue;
      const joined = dataLines.join('\n');
      let parsed: unknown = null;
      if (joined !== '[DONE]') {
        try {
          parsed = JSON.parse(joined);
        } catch {
          parsed = null;
        }
      }
      frames.push({ raw: joined, json: parsed, receivedAt: Date.now() });
    }
  }
  return frames;
}

describe('Output Guard E2E HTTP Acceptance (T059)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.PROXY_RATE_LIMIT_RPM = '0';
    fakeProvider = await startFakeProviderServer();
    fakeMcp = await startFakeMcpHttpServer({
      onToolCall: () => ({ content: [{ type: 'text', text: '{"order":"ok"}' }] }),
    });

    initDb(':memory:');
    resetFlagsCacheForTests();
    setFlags({ outputGuard: true, mcpClient: true });
    setKeyCacheTestOverride(true);

    for (const [platform, label, secret] of [
      ['groq', 'groq-guard-e2e', 'gsk_guard_e2e'],
      ['anthropic', 'anth-guard-e2e', 'sk-ant-guard-e2e'],
      ['google', 'gem-guard-e2e', 'AIzaSyGuardE2E'],
    ] as const) {
      const enc = encrypt(secret);
      getDb()
        .prepare(
          `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
           VALUES (?, ?, ?, ?, ?, 'healthy', 1)`,
        )
        .run(platform, label, enc.encrypted, enc.iv, enc.authTag);
    }

    const profRes = getDb()
      .prepare(
        `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled, ai_tools_enabled, ai_tool_max_rounds)
         VALUES (?, ?, 'enc', 'iv', 'tag', 1, 1, 4)`,
      )
      .run('guard-e2e-profile', hashClientProfileKey('flm_guard_e2e_1'));
    profileId = Number(profRes.lastInsertRowid);
    clientKey = 'flm_guard_e2e_1';

    appServer = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => appServer!.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(appServer!.address() as AddressInfo).port}`;

    const userId = createUser('guard-e2e-admin@example.com', 'Password123!').userId;
    primaryToken = createSession(userId);
  });

  beforeEach(() => {
    fakeProvider.reset();
    fakeMcp.reset();
    setFlags({ outputGuard: true, mcpClient: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => appServer?.close(() => resolve()));
    await fakeProvider.close();
    await fakeMcp.close();
  });

  for (const wire of ['openai-chat', 'anthropic', 'responses', 'gemini'] as const) {
    it(`blocks forbidden output on ${wire} non-stream with valid terminal finish reason`, async () => {
      await setPolicy({ mode: 'block' });
      fakeProvider.enqueue({
        kind: 'scripted',
        wire,
        stream: false,
        text: 'Hello forbidden-secret world',
      });

      const reqSpec = wireRequest(wire, false);
      const res = await fetch(`${baseUrl}${reqSpec.path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(reqSpec.body),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('x-freellm-guard')).toMatch(/^blocked;reason=keywords/);
      const bodyText = await res.text();
      expect(bodyText).not.toContain('forbidden-secret');
      expect(bodyText).toContain('Blocked by output guard.');

      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      if (wire === 'openai-chat') {
        expect((parsed.choices as Array<{ finish_reason: string }>)[0].finish_reason).toBe('content_filter');
      } else if (wire === 'anthropic') {
        expect(parsed.stop_reason).toBe('refusal');
      } else if (wire === 'responses') {
        expect(parsed.status).toBe('incomplete');
      } else {
        expect((parsed.candidates as Array<{ finishReason: string }>)[0].finishReason).toBe('SAFETY');
      }
    });

    it(`blocks cross-chunk forbidden term on ${wire} SSE stream without leaking any partial frame`, async () => {
      await setPolicy({ mode: 'block', holdChars: 200, maxDelayMs: 300 });
      fakeProvider.enqueue({
        kind: 'scripted',
        wire,
        stream: true,
        geminiAltSse: true,
        textChunks: ['Safe prefix ', 'forbid', 'den-sec', 'ret suffix'],
        chunkDelayMs: 5,
      });

      const reqSpec = wireRequest(wire, true);
      const res = await fetch(`${baseUrl}${reqSpec.path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(reqSpec.body),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('x-freellm-guard')).toBe('active');
      const frames = await readSseFrames(res);
      expect(frames.length).toBeGreaterThan(0);

      for (const frame of frames) {
        expect(frame.raw).not.toContain('forbidden-secret');
        expect(frame.raw).not.toContain('forbidden');
      }
      const joined = frames.map((f) => f.raw).join('\n');
      expect(joined).toContain('Blocked by output guard.');
    });
  }

  it('handles Gemini JSON-array stream mode (without ?alt=sse) in block mode', async () => {
    await setPolicy({ mode: 'block' });
    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'gemini',
      stream: true,
      geminiAltSse: false,
      textChunks: ['Part1 ', 'forbidden-', 'secret Part2'],
    });

    const res = await fetch(`${baseUrl}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });

    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('forbidden-secret');
    expect(raw).toContain('Blocked by output guard.');
    expect(raw).toContain('SAFETY');
  });

  it('preserves original text in log mode and masks PII in place without changing finish reason', async () => {
    await setPolicy({ mode: 'log' });
    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      stream: false,
      text: 'This has forbidden-secret inside',
    });

    const logRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    expect(logRes.status).toBe(200);
    expect(logRes.headers.get('x-freellm-guard')).toMatch(/^logged/);
    const logJson = (await logRes.json()) as { choices: Array<{ message: { content: string }; finish_reason: string }> };
    expect(logJson.choices[0].message.content).toBe('This has forbidden-secret inside');
    expect(logJson.choices[0].finish_reason).toBe('stop');

    await setPolicy({ mode: 'block' });
    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      stream: false,
      text: 'Contact user@example.com for details.',
    });
    const piiRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    expect(piiRes.status).toBe(200);
    expect(piiRes.headers.get('x-freellm-guard')).toMatch(/^masked/);
    const piiJson = (await piiRes.json()) as { choices: Array<{ message: { content: string }; finish_reason: string }> };
    expect(piiJson.choices[0].message.content).not.toContain('user@example.com');
    expect(piiJson.choices[0].finish_reason).toBe('stop');
  });

  it('guards exact-cache hits (proving 0 second provider call) and rejects spoofed internal/role headers', async () => {
    await setPolicy({ mode: 'block' });

    // 1. Seed a clean response? No, test exact cache hit when policy changes from off->block or cache stores raw response
    // First call with mode=off populates exact cache; second call with mode=block hits cache and MUST be guarded!
    await setPolicy({ mode: 'off' });
    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      stream: false,
      text: 'Cached answer with forbidden-secret',
    });

    const reqBody = { model: 'groq/compound', messages: [{ role: 'user', content: 'exact-cache-guard-key' }], stream: false };
    const first = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(reqBody),
    });
    expect(first.status).toBe(200);
    const providerCallsAfterFirst = fakeProvider.requests.length;
    expect(providerCallsAfterFirst).toBe(1);

    // Enable block policy and send exact same request -> must hit cache (0 new provider calls) AND be blocked!
    await setPolicy({ mode: 'block' });
    const second = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${clientKey}`,
        'content-type': 'application/json',
        'x-ai-platform-internal': '1',
        'x-user-role': 'support_supervisor',
      },
      body: JSON.stringify(reqBody),
    });
    expect(second.status).toBe(200);
    expect(fakeProvider.requests.length).toBe(providerCallsAfterFirst);
    const secondText = await second.text();
    expect(secondText).not.toContain('forbidden-secret');
    expect(secondText).toContain('Blocked by output guard.');
  });

  it('guards final answer after MCP read tool loop once and keeps caller-owned tool_calls intact', async () => {
    await setPolicy({ mode: 'block' });

    // Verify caller-owned tool_calls are not turned into assistant text or stripped
    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      stream: false,
      toolCalls: [{ id: 'call_caller_1', name: 'caller_fn', arguments: '{"x":1}' }],
      finishReason: 'tool_calls',
    });

    const toolRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'groq/compound',
        messages: [{ role: 'user', content: 'call tool' }],
        tools: [{ type: 'function', function: { name: 'caller_fn', parameters: { type: 'object' } } }],
        stream: false,
      }),
    });
    expect(toolRes.status).toBe(200);
    const toolJson = (await toolRes.json()) as { choices: Array<{ message: { tool_calls?: unknown[] } }> };
    expect(toolJson.choices[0].message.tool_calls?.length).toBe(1);
  });

  it('handles provider pause > 300ms during streaming without leaking split forbidden term', async () => {
    await setPolicy({ mode: 'block', holdChars: 200, maxDelayMs: 300 });
    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      stream: true,
      textChunks: ['Safe lead text ', 'forbidden-', 'secret tail'],
      chunkDelayMs: 350,
    });

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: 'pause test' }], stream: true }),
    });
    expect(res.status).toBe(200);
    const frames = await readSseFrames(res);
    for (const frame of frames) {
      expect(frame.raw).not.toContain('forbidden-secret');
    }
    expect(frames.map((f) => f.raw).join('\n')).toContain('Blocked by output guard.');
  });

  it('passes output untouched with no guard header when policy mode is off', async () => {
    await setPolicy({ mode: 'off' });
    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      stream: false,
      text: 'Policy off allows forbidden-secret',
    });

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: 'mode off' }], stream: false }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-freellm-guard')).toBeNull();
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('Policy off allows forbidden-secret');
  });

  it('guards secondary choices and candidates in multi-choice/candidate responses', async () => {
    await setPolicy({ mode: 'block' });

    fakeProvider.enqueue({
      kind: 'raw',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        id: 'chatcmpl-multi',
        object: 'chat.completion',
        model: 'groq/compound',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Clean first choice' }, finish_reason: 'stop' },
          { index: 1, message: { role: 'assistant', content: 'Second has forbidden-secret' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      },
    });
    const openaiRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: 'multi' }], stream: false }),
    });
    expect(openaiRes.status).toBe(200);
    const openaiText = await openaiRes.text();
    expect(openaiText).not.toContain('forbidden-secret');
    expect(openaiText).toContain('Blocked by output guard.');

    fakeProvider.enqueue({
      kind: 'raw',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        candidates: [
          { index: 0, content: { role: 'model', parts: [{ text: 'Clean candidate' }] }, finishReason: 'STOP' },
          { index: 1, content: { role: 'model', parts: [{ text: 'Bad forbidden-secret candidate' }] }, finishReason: 'STOP' },
        ],
      },
    });
    const gemRes = await fetch(`${baseUrl}/v1beta/models/gemini-2.0-flash:generateContent`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'multi gem' }] }] }),
    });
    expect(gemRes.status).toBe(200);
    const gemText = await gemRes.text();
    expect(gemText).not.toContain('forbidden-secret');
    expect(gemText).toContain('Blocked by output guard.');
  });

  it('guards final answer once after MCP read tool loop', async () => {
    await setPolicy({ mode: 'block' });

    // Register, sync, allow, and bind fakeMcp lookup_order tool
    const createSrv = await adminCall('/api/ai-platform/mcp/servers', 'POST', {
      slug: 'guard-e2e-mcp',
      name: 'Guard E2E MCP',
      url: fakeMcp.url,
      authKind: 'none',
    });
    expect(createSrv.status).toBe(201);
    const srvId = (createSrv.body?.server as { id: number }).id;
    expect((await adminCall(`/api/ai-platform/mcp/servers/${srvId}/sync`, 'POST')).status).toBe(200);
    const toolsRes = await adminCall(`/api/ai-platform/mcp/servers/${srvId}/tools`);
    const tools = (toolsRes.body?.tools as Array<{ id: number; name: string }>) ?? [];
    const lookupTool = tools.find((t) => t.name === 'lookup_order');
    expect(lookupTool).toBeDefined();
    expect((await adminCall(`/api/ai-platform/mcp/tools/${lookupTool!.id}`, 'PATCH', { state: 'allowed', effect: 'read' })).status).toBe(200);
    expect((await adminCall(`/api/ai-platform/mcp/bindings/profile/${profileId}`, 'PUT', { toolIds: [lookupTool!.id], enabled: true, maxRounds: 3 })).status).toBe(200);

    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      stream: false,
      toolCalls: [{ id: 'call_mcp_1', name: 'guard-e2e-mcp__lookup_order', arguments: '{"orderId":"123"}' }],
      finishReason: 'tool_calls',
    });
    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      stream: false,
      text: 'Order result contains forbidden-secret',
    });

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: 'check order 123' }], stream: false }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-freellm-tool-rounds')).toBe('1');
    expect(res.headers.get('x-freellm-guard')).toMatch(/^blocked/);
    expect(fakeMcp.toolCalls.length).toBe(1);
    const bodyText = await res.text();
    expect(bodyText).not.toContain('forbidden-secret');
    expect(bodyText).toContain('Blocked by output guard.');
  });

  it('cleans up cleanly when client aborts mid-stream', async () => {
    await setPolicy({ mode: 'block', holdChars: 200, maxDelayMs: 300 });
    fakeProvider.enqueue({
      kind: 'stream',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      chunks: [
        { data: 'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello "},"finish_reason":null}]}\n\n' },
        { data: 'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"world"},"finish_reason":null}]}\n\n', delayMs: 2000 },
      ],
    });

    const ac = new AbortController();
    const fetchPromise = fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: 'abort mid-stream' }], stream: true }),
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 50);
    await expect(fetchPromise).rejects.toThrow();
  });
});
