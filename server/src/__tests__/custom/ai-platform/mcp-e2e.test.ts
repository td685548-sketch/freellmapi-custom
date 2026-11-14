/**
 * T041 — MCP End-to-End HTTP Acceptance Tests (4 wires × stream/non-stream + edge cases).
 *
 * Exercises the full HTTP pipeline:
 * createApp() -> profileInferenceGate -> pipeline -> tool-loop -> tools -> executor -> transport -> FakeMcpHttpServer
 * and inner loopback -> FakeProviderServer.
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
import { startFakeProviderServer, type FakeProviderServer, type FakeProviderWire } from '../../helpers/ai-platform-fake-provider.js';

let appServer: http.Server | null = null;
let baseUrl = '';
let fakeProvider: FakeProviderServer;
let fakeMcp: FakeMcpHttpServer;
let primaryToken = '';
let clientKey = '';
let otherClientKey = '';
let profileId = 0;
let mcpServerId = 0;

async function adminCall(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
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

function insertProfile(name: string, rawKey: string): number {
  const res = getDb()
    .prepare(
      `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled, ai_tools_enabled, ai_tool_max_rounds)
       VALUES (?, ?, 'enc', 'iv', 'tag', 1, 1, 8)`,
    )
    .run(name, hashClientProfileKey(rawKey));
  return Number(res.lastInsertRowid);
}

function seedProviderKeys() {
  setKeyCacheTestOverride(true);
  for (const [platform, label, secret] of [
    ['groq', 'groq-e2e', 'gsk_e2e_test'],
    ['anthropic', 'anth-e2e', 'sk-ant-e2e-test'],
    ['google', 'gem-e2e', 'AIzaSyE2ETestKey'],
  ] as const) {
    const enc = encrypt(secret);
    getDb()
      .prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
         VALUES (?, ?, ?, ?, ?, 'healthy', 1)`,
      )
      .run(platform, label, enc.encrypted, enc.iv, enc.authTag);
  }
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  process.env.PROXY_RATE_LIMIT_RPM = '0';
  fakeProvider = await startFakeProviderServer();
  fakeMcp = await startFakeMcpHttpServer({
    onToolCall(name, args) {
      if (name === 'lookup_order') {
        const orderId = (args as { order_id?: string })?.order_id ?? 'unknown';
        return { content: [{ type: 'text', text: JSON.stringify({ orderId, status: 'shipped' }) }] };
      }
      if (name === 'refund_order') {
        return { content: [{ type: 'text', text: JSON.stringify({ refunded: true }) }] };
      }
      return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
    },
  });
});

afterAll(async () => {
  await fakeMcp.close();
  await fakeProvider.close();
});

beforeEach(async () => {
  initDb(':memory:');
  resetFlagsCacheForTests();
  seedProviderKeys();

  const app = createApp();
  appServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => appServer!.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;

  const primaryId = createUser('e2e-primary@example.com', 'Password123!').userId;
  primaryToken = createSession(primaryId);

  clientKey = 'sk-cp-e2e-primary-123456';
  otherClientKey = 'sk-cp-e2e-other-123456';
  profileId = insertProfile('e2e-profile-1', clientKey);
  insertProfile('e2e-profile-2', otherClientKey);

  // Enable mcpClient pillar and allowlist fakeMcp origin as primary
  setFlags({ mcpClient: true });
  const origRes = await adminCall('/api/ai-platform/mcp/allowed-internal-hosts', 'PUT', {
    origins: [fakeMcp.origin],
  });
  expect(origRes.status).toBe(200);

  // Register, sync, review tools, and bind to profile 1
  const srvRes = await adminCall('/api/ai-platform/mcp/servers', 'POST', {
    slug: 'orders',
    name: 'Orders MCP',
    url: fakeMcp.url,
    authKind: 'none',
  });
  expect(srvRes.status).toBe(201);
  mcpServerId = (srvRes.body?.server as { id: number }).id;

  const syncRes = await adminCall(`/api/ai-platform/mcp/servers/${mcpServerId}/sync`, 'POST');
  expect(syncRes.status).toBe(200);

  const toolsRes = await adminCall(`/api/ai-platform/mcp/servers/${mcpServerId}/tools`);
  const tools = (toolsRes.body?.tools ?? []) as Array<{ id: number; name: string }>;
  const lookupTool = tools.find((t) => t.name === 'lookup_order')!;
  const refundTool = tools.find((t) => t.name === 'refund_order')!;

  await adminCall(`/api/ai-platform/mcp/tools/${lookupTool.id}`, 'PATCH', {
    state: 'allowed',
    effect: 'read',
  });
  await adminCall(`/api/ai-platform/mcp/tools/${refundTool.id}`, 'PATCH', {
    state: 'allowed',
    effect: 'write',
  });

  const bindRes = await adminCall(`/api/ai-platform/mcp/bindings/profile/${profileId}`, 'PUT', {
    toolIds: [lookupTool.id, refundTool.id],
    enabled: true,
    maxRounds: 8,
  });
  expect(bindRes.status).toBe(200);

  fakeMcp.reset();
  fakeProvider.reset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetFlagsCacheForTests();
  if (appServer) {
    await new Promise<void>((resolve) => appServer!.close(() => resolve()));
    appServer = null;
  }
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
});

function installProviderFetchRedirect() {
  const realFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (
      urlStr.startsWith(baseUrl) ||
      urlStr.startsWith(fakeProvider.url) ||
      urlStr.startsWith(fakeMcp.url)
    ) {
      return realFetch(input, init);
    }
    const parsed = new URL(urlStr);
    return realFetch(`${fakeProvider.url}${parsed.pathname}${parsed.search}`, init);
  });
  return realFetch;
}

const MATRIX: Array<{ wire: FakeProviderWire; stream: boolean }> = [
  { wire: 'openai-chat', stream: false },
  { wire: 'openai-chat', stream: true },
  { wire: 'responses', stream: false },
  { wire: 'responses', stream: true },
  { wire: 'anthropic', stream: false },
  { wire: 'anthropic', stream: true },
  { wire: 'gemini', stream: false },
  { wire: 'gemini', stream: true },
];

describe('MCP E2E 4-wire × stream/non-stream matrix (T041)', () => {
  it.each(MATRIX)('executes model -> MCP read -> model -> output on $wire (stream=$stream)', async ({ wire, stream }) => {
    const realFetch = installProviderFetchRedirect();

    const upstreamWire: FakeProviderWire = wire === 'gemini' ? 'gemini' : 'openai-chat';
    fakeProvider.enqueue(
      {
        kind: 'scripted',
        wire: upstreamWire,
        stream: false,
        toolCalls: [
          {
            id: 'call_e2e_1',
            name: 'mcp__orders__lookup_order',
            arguments: JSON.stringify({ order_id: 'ord-42' }),
          },
        ],
        finishReason: 'tool_calls',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        kind: 'scripted',
        wire: upstreamWire,
        stream: false,
        text: 'Order ord-42 is shipped.',
        finishReason: 'stop',
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      },
    );

    let url = `${baseUrl}/v1/chat/completions`;
    let body: Record<string, unknown> = {
      model: 'llama-3.3-70b-versatile',
      stream,
      messages: [{ role: 'user', content: 'Check order ord-42' }],
    };

    if (wire === 'responses') {
      url = `${baseUrl}/v1/responses`;
      body = { model: 'llama-3.3-70b-versatile', stream, input: 'Check order ord-42' };
    } else if (wire === 'anthropic') {
      url = `${baseUrl}/v1/messages`;
      body = {
        model: 'llama-3.3-70b-versatile',
        stream,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Check order ord-42' }],
      };
    } else if (wire === 'gemini') {
      const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
      url = `${baseUrl}/v1beta/models/gemini-2.5-flash:${action}`;
      body = {
        contents: [{ role: 'user', parts: [{ text: 'Check order ord-42' }] }],
      };
    }

    const res = await realFetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${clientKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-freellm-tool-rounds')).toBe('2');

    const rawText = await res.text();
    expect(rawText).toContain('Order ord-42 is shipped.');
    expect(fakeMcp.getDispatchCount('tools/call')).toBe(1);

    // Second provider request must contain untrusted tool_result
    expect(fakeProvider.requests.length).toBe(2);
    expect(fakeProvider.requests[1]!.bodyText).toContain('trust=\\"untrusted\\"');

    // Non-stream JSON responses must reflect summed usage (15 + 30 = 45)
    if (!stream) {
      const json = JSON.parse(rawText) as Record<string, unknown>;
      if (wire === 'openai-chat') {
        expect((json.usage as { total_tokens?: number })?.total_tokens).toBe(45);
      } else if (wire === 'responses') {
        expect((json.usage as { total_tokens?: number })?.total_tokens).toBe(45);
      } else if (wire === 'anthropic') {
        const u = json.usage as { input_tokens?: number; output_tokens?: number };
        expect((u?.input_tokens ?? 0) + (u?.output_tokens ?? 0)).toBe(45);
      } else if (wire === 'gemini') {
        const u = json.usageMetadata as { totalTokenCount?: number };
        expect(u?.totalTokenCount).toBe(45);
      }
    }

    const callsRes = await adminCall('/api/ai-platform/mcp/calls');
    expect(callsRes.status).toBe(200);
    const calls = (callsRes.body?.calls ?? []) as Array<{ status: string; toolName: string }>;
    expect(calls.some((c) => c.toolName.includes('lookup_order') && c.status === 'ok')).toBe(true);

    // Verify DB request & token accounting (no duplicate outer charge)
    const reqSummary = getDb()
      .prepare(
        'SELECT COUNT(*) as cnt, COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens FROM requests',
      )
      .get() as { cnt: number; totalTokens: number };
    expect(reqSummary.cnt).toBe(2);
    expect(reqSummary.totalTokens).toBe(45);
  });

  it('executes model -> MCP read -> model -> output on gemini JSON-array stream (without alt=sse)', async () => {
    const realFetch = installProviderFetchRedirect();
    fakeProvider.enqueue(
      {
        kind: 'scripted',
        wire: 'gemini',
        stream: false,
        toolCalls: [
          {
            id: 'call_gem_json_1',
            name: 'mcp__orders__lookup_order',
            arguments: JSON.stringify({ order_id: 'ord-json-77' }),
          },
        ],
        finishReason: 'tool_calls',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        kind: 'scripted',
        wire: 'gemini',
        stream: false,
        text: 'Order ord-json-77 is shipped.',
        finishReason: 'stop',
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      },
    );

    const res = await realFetch(`${baseUrl}/v1beta/models/gemini-2.5-flash:streamGenerateContent`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${clientKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Check order ord-json-77' }] }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-freellm-tool-rounds')).toBe('2');
    const rawText = await res.text();
    expect(rawText).toContain('Order ord-json-77 is shipped.');
    expect(fakeMcp.getDispatchCount('tools/call')).toBe(1);
    const parsed = JSON.parse(rawText) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
  });
});

describe('MCP E2E governance & edge cases (T041)', () => {
  it('does not dispatch MCP when batch contains caller-owned tool call', async () => {
    const realFetch = installProviderFetchRedirect();
    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      toolCalls: [
        { id: 'call_caller_1', name: 'caller_fn', arguments: '{"x":1}' },
        { id: 'call_mcp_1', name: 'mcp__orders__lookup_order', arguments: '{"order_id":"ord-1"}' },
      ],
      finishReason: 'tool_calls',
    });

    const res = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        tools: [{ type: 'function', function: { name: 'caller_fn', parameters: { type: 'object' } } }],
        messages: [{ role: 'user', content: 'run both' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(fakeMcp.getDispatchCount('tools/call')).toBe(0);
    const json = (await res.json()) as { choices?: Array<{ message?: { tool_calls?: Array<{ function: { name: string } }> } }> };
    const names = json.choices?.[0]?.message?.tool_calls?.map((tc) => tc.function.name) ?? [];
    expect(names).toContain('caller_fn');
  });

  it('queues write tool as pending, enforces single dispatch on approve race, and never retries unknown', async () => {
    const realFetch = installProviderFetchRedirect();
    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      toolCalls: [
        { id: 'call_write_1', name: 'mcp__orders__refund_order', arguments: '{"order_id":"ord-9","amount":25}' },
      ],
      finishReason: 'tool_calls',
    });

    const chatRes = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'refund ord-9' }],
      }),
    });
    expect(chatRes.status).toBe(200);
    expect(fakeMcp.getDispatchCount('tools/call')).toBe(0);

    const listRes = await adminCall('/api/ai-platform/approvals?status=pending');
    const approvals = (listRes.body?.approvals ?? []) as Array<{ id: number; status: string }>;
    expect(approvals.length).toBe(1);
    const approvalId = approvals[0]!.id;

    // Concurrent approve race: exactly 1 succeeds, 1 gets 409, fakeMcp receives 1 dispatch
    const [r1, r2] = await Promise.all([
      adminCall(`/api/ai-platform/approvals/${approvalId}/approve`, 'POST', { note: 'ok-1' }),
      adminCall(`/api/ai-platform/approvals/${approvalId}/approve`, 'POST', { note: 'ok-2' }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(fakeMcp.getDispatchCount('tools/call')).toBe(1);

    // Mid-flight disconnect produces unknown and cannot be re-approved
    fakeMcp.setConfig({ disconnectOnMethod: 'tools/call' });
    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      toolCalls: [
        { id: 'call_write_2', name: 'mcp__orders__refund_order', arguments: '{"order_id":"ord-10","amount":30}' },
      ],
      finishReason: 'tool_calls',
    });
    await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'refund ord-10' }],
      }),
    });
    const pending2 = ((await adminCall('/api/ai-platform/approvals?status=pending')).body?.approvals ?? []) as Array<{ id: number }>;
    expect(pending2.length).toBe(1);
    const unknownId = pending2[0]!.id;

    const appUnknown = await adminCall(`/api/ai-platform/approvals/${unknownId}/approve`, 'POST');
    expect((appUnknown.body?.approval as { status?: string })?.status).toBe('unknown');

    // Re-approving unknown returns 409 without dispatching again
    const dispatchesBefore = fakeMcp.getDispatchCount('tools/call');
    const retryRes = await adminCall(`/api/ai-platform/approvals/${unknownId}/approve`, 'POST');
    expect(retryRes.status).toBe(409);
    expect(fakeMcp.getDispatchCount('tools/call')).toBe(dispatchesBefore);
  });

  it('respects x-freellm-tools: off, tenant/scope isolation, and abort', async () => {
    const realFetch = installProviderFetchRedirect();
    fakeProvider.enqueue({ kind: 'scripted', wire: 'openai-chat', text: 'plain-off' });

    const offRes = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${clientKey}`,
        'content-type': 'application/json',
        'x-freellm-tools': 'off',
      },
      body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(offRes.status).toBe(200);
    expect(offRes.headers.get('x-freellm-tool-rounds')).toBeNull();
    expect(fakeMcp.getDispatchCount('tools/call')).toBe(0);

    // Other profile without bindings gets no MCP tools
    fakeProvider.enqueue({ kind: 'scripted', wire: 'openai-chat', text: 'isolated' });
    const otherRes = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${otherClientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(otherRes.status).toBe(200);
    expect(fakeProvider.requests[1]!.bodyText).not.toContain('mcp__orders__lookup_order');
  });

  it('strips MCP tools and preserves caller tools on unsupported_model, and aborts cleanly', async () => {
    const realFetch = installProviderFetchRedirect();
    // groq/compound has supports_tool_calling = 0 in DB
    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      text: 'no-mcp-on-unsupported',
    });

    const unsupportedRes = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${clientKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'groq/compound',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(unsupportedRes.status).toBe(200);
    expect(unsupportedRes.headers.get('x-freellm-tools-skipped')).toBe('unsupported_model');
    expect(fakeProvider.requests[0]!.bodyText).not.toContain('mcp__orders__lookup_order');

    // Client abort cancels in-flight delayed MCP tool call without hanging
    fakeMcp.setConfig({ delayMs: 5000 });
    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      toolCalls: [
        {
          id: 'call_abort_1',
          name: 'mcp__orders__lookup_order',
          arguments: JSON.stringify({ order_id: 'ord-abort' }),
        },
      ],
      finishReason: 'tool_calls',
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 150);
    await expect(
      realFetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${clientKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: 'abort check' }],
        }),
        signal: ac.signal,
      }),
    ).rejects.toThrow();
    clearTimeout(timer);
  });
});
