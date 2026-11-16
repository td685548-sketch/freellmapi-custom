import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { getDb, getUnifiedApiKey, initDb } from '../../../db/index.js';
import { encrypt } from '../../../lib/crypto.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setKeyCacheTestOverride } from '../../../services/key-cache.js';
import { addDoc, resetKnowledgeIndexes } from '../../../services/profile-knowledge.js';
import { resetQuotaCaches } from '../../../services/usage-quotas.js';
import { mintUserApiKey } from '../../../services/user-keys.js';
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
let unifiedKey = '';
let userKey = '';
let grantedKey = '';
let ungrantedKey = '';
let grantedProfileId = 0;
let ungrantedProfileId = 0;
let flowId = 0;
let billingAgentId = 0;
let mcpServerId = 0;
let refundToolId = 0;

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

function seedProviderKeys() {
  setKeyCacheTestOverride(true);
  for (const [platform, label, secret] of [
    ['groq', 'groq-flow-e2e', 'gsk_flow_e2e'],
    ['anthropic', 'anth-flow-e2e', 'sk-ant-flow-e2e'],
    ['google', 'gem-flow-e2e', 'AIzaSyFlowE2E'],
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
        const orderId = (args as { order_id?: string })?.order_id ?? 'unknown';
        return { content: [{ type: 'text', text: JSON.stringify({ orderId, refunded: true }) }] };
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
  resetKnowledgeIndexes();
  resetQuotaCaches();
  seedProviderKeys();

  const app = createApp();
  appServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => appServer!.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;

  const primaryId = createUser('flow-e2e-owner@example.com', 'Password123!').userId;
  primaryToken = createSession(primaryId);
  unifiedKey = getUnifiedApiKey();
  userKey = mintUserApiKey(primaryId, 'flow-e2e-user-key').key;

  const p1 = await adminCall('/api/client-profiles', 'POST', { name: 'flow-granted-profile' });
  expect(p1.status).toBe(201);
  grantedProfileId = p1.body!.id as number;
  grantedKey = p1.body!.key as string;

  const p2 = await adminCall('/api/client-profiles', 'POST', { name: 'flow-ungranted-profile' });
  expect(p2.status).toBe(201);
  ungrantedProfileId = p2.body!.id as number;
  ungrantedKey = p2.body!.key as string;

  addDoc(ungrantedProfileId, 'Tech KB', 'Reboot the gateway device once.');

  // Enable orchestrator + outputGuard + mcpClient flags
  setFlags({ orchestrator: true, outputGuard: true, mcpClient: true });

  // Register fake MCP server + tools
  const origRes = await adminCall('/api/ai-platform/mcp/allowed-internal-hosts', 'PUT', {
    origins: [fakeMcp.origin],
  });
  expect(origRes.status).toBe(200);

  const srvRes = await adminCall('/api/ai-platform/mcp/servers', 'POST', {
    slug: 'orders',
    name: 'Orders MCP',
    url: fakeMcp.url,
    authKind: 'none',
  });
  expect(srvRes.status).toBe(201);
  mcpServerId = (srvRes.body!.server as { id: number }).id;

  await adminCall(`/api/ai-platform/mcp/servers/${mcpServerId}/sync`, 'POST');
  const toolsRes = await adminCall(`/api/ai-platform/mcp/servers/${mcpServerId}/tools`);
  const tools = (toolsRes.body!.tools ?? []) as Array<{ id: number; name: string }>;
  const lookupTool = tools.find((t) => t.name === 'lookup_order')!;
  const refundTool = tools.find((t) => t.name === 'refund_order')!;
  refundToolId = refundTool.id;

  await adminCall(`/api/ai-platform/mcp/tools/${lookupTool.id}`, 'PATCH', { state: 'allowed', effect: 'read' });
  await adminCall(`/api/ai-platform/mcp/tools/${refundTool.id}`, 'PATCH', { state: 'allowed', effect: 'write' });

  // Create agents
  const triageRes = await adminCall('/api/ai-platform/agents', 'POST', {
    slug: 'triage',
    name: 'Triage Agent',
    model: 'llama-3.3-70b-versatile',
    systemPrompt: 'Route requests cleanly.',
  });
  expect(triageRes.status).toBe(201);

  const billingRes = await adminCall('/api/ai-platform/agents', 'POST', {
    slug: 'billing',
    name: 'Billing Agent',
    model: 'llama-3.3-70b-versatile',
    systemPrompt: 'Handle order billing.',
  });
  expect(billingRes.status).toBe(201);
  billingAgentId = (billingRes.body!.agent as { id: number }).id;

  const techRes = await adminCall('/api/ai-platform/agents', 'POST', {
    slug: 'tech',
    name: 'Tech Agent',
    model: 'llama-3.3-70b-versatile',
    systemPrompt: 'Handle technical issues.',
    knowledgeScopeKind: 'profile',
    knowledgeScopeId: String(ungrantedProfileId),
  });
  expect(techRes.status).toBe(201);

  await adminCall(`/api/ai-platform/mcp/bindings/agent/${billingAgentId}`, 'PUT', {
    toolIds: [lookupTool.id, refundTool.id],
    enabled: true,
  });

  // Create, publish, and grant flow
  const flowRes = await adminCall('/api/ai-platform/flows', 'POST', {
    slug: 'support-triage',
    name: 'Support Triage Flow',
    draft: {
      kind: 'handoff',
      entryAgent: 'triage',
      agents: ['triage', 'billing', 'tech'],
      handoffs: {
        triage: ['billing', 'tech'],
        billing: [],
        tech: [],
      },
      limits: { maxSteps: 12, maxToolCalls: 20, maxHandoffs: 4, maxTokens: 60000, maxSeconds: 120 },
      awaitingApprovalText: 'Your refund request is awaiting administrator approval.',
      approvalTtlHours: 24,
    },
  });
  expect(flowRes.status).toBe(201);
  const createdFlow = flowRes.body!.flow as { id: number; revision: number };
  flowId = createdFlow.id;

  const pubRes = await adminCall(`/api/ai-platform/flows/${flowId}/publish`, 'POST', {
    revision: createdFlow.revision,
  });
  expect(pubRes.status).toBe(200);

  const grantRes = await adminCall(`/api/ai-platform/flows/${flowId}/grants`, 'PUT', {
    profileIds: [grantedProfileId],
  });
  expect(grantRes.status).toBe(200);

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

const WIRES: Array<{ wire: FakeProviderWire; stream: boolean }> = [
  { wire: 'openai-chat', stream: false },
  { wire: 'openai-chat', stream: true },
  { wire: 'anthropic', stream: false },
  { wire: 'anthropic', stream: true },
  { wire: 'responses', stream: false },
  { wire: 'responses', stream: true },
  { wire: 'gemini', stream: false },
  { wire: 'gemini', stream: true },
];

describe('Orchestrator Flow HTTP E2E (T120)', () => {
  it.each(WIRES)('runs triage -> billing -> lookup_order -> answer across $wire (stream=$stream)', async ({ wire, stream }) => {
    const realFetch = installProviderFetchRedirect();

    fakeProvider.enqueue(
      {
        kind: 'scripted',
        wire: 'openai-chat',
        stream: false,
        toolCalls: [
          {
            id: 'call_handoff',
            name: 'transfer_to_billing',
            arguments: JSON.stringify({ reason: 'Order status inquiry' }),
          },
        ],
        finishReason: 'tool_calls',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        kind: 'scripted',
        wire: 'openai-chat',
        stream: false,
        toolCalls: [
          {
            id: 'call_lookup',
            name: 'mcp__orders__lookup_order',
            arguments: JSON.stringify({ order_id: 'ORD-77' }),
          },
        ],
        finishReason: 'tool_calls',
        usage: { promptTokens: 20, completionTokens: 6, totalTokens: 26 },
      },
      {
        kind: 'scripted',
        wire: 'openai-chat',
        stream: false,
        text: 'Order ORD-77 is shipped!',
        finishReason: 'stop',
        usage: { promptTokens: 30, completionTokens: 9, totalTokens: 39 },
      },
    );

    let url = `${baseUrl}/v1/chat/completions`;
    let body: Record<string, unknown> = {
      model: 'flow:support-triage',
      stream,
      messages: [{ role: 'user', content: 'Where is ORD-77?' }],
    };
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    if (wire === 'openai-chat') {
      headers.authorization = `Bearer ${grantedKey}`;
    } else if (wire === 'responses') {
      url = `${baseUrl}/v1/responses`;
      body = { model: 'flow:support-triage', stream, input: 'Where is ORD-77?' };
      headers.authorization = `Bearer ${grantedKey}`;
    } else if (wire === 'anthropic') {
      url = `${baseUrl}/v1/messages`;
      body = {
        model: 'flow:support-triage',
        stream,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Where is ORD-77?' }],
      };
      headers['x-api-key'] = grantedKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      url = `${baseUrl}/v1beta/models/flow:support-triage:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
      body = { contents: [{ role: 'user', parts: [{ text: 'Where is ORD-77?' }] }] };
      headers['x-goog-api-key'] = grantedKey;
    }

    const res = await realFetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    const runId = res.headers.get('x-freellm-run-id');
    expect(runId).toMatch(/^run_/);

    const raw = await res.text();
    expect(raw).toContain('Order ORD-77 is shipped!');
    expect(raw).toContain('flow:support-triage');

    if (stream) {
      expect(raw).toContain(': progress ');
      expect(raw).toContain('"kind":"handoff"');
      expect(raw).toContain('"kind":"tool"');
    } else {
      expect(res.headers.get('x-freellm-run-status')).toBe('completed');
    }

    // Verify GET /v1/ai/runs/:id returns public run status ONLY to initiating client key
    const pubSelf = await realFetch(`${baseUrl}/v1/ai/runs/${runId}`, {
      headers: { authorization: `Bearer ${grantedKey}` },
    });
    expect(pubSelf.status).toBe(200);
    const pubJson = (await pubSelf.json()) as Record<string, unknown>;
    expect(pubJson.id).toBe(runId);
    expect(pubJson.flow).toBe('support-triage');
    expect(pubJson.status).toBe('completed');
    expect(pubJson.output_text).toBe('Order ORD-77 is shipped!');
    expect(pubJson.usage).toEqual({ prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 });
    expect(pubJson.steps).toBeUndefined();

    const pubOther = await realFetch(`${baseUrl}/v1/ai/runs/${runId}`, {
      headers: { authorization: `Bearer ${ungrantedKey}` },
    });
    expect(pubOther.status).toBe(404);
  });

  it('enforces 403 flow_not_granted, 400 flow_requires_client_key, 404 flow_not_found when off, and /v1/models visibility', async () => {
    const realFetch = global.fetch;

    // 1. /v1/models lists flow:support-triage ONLY for granted client key
    const mGranted = await realFetch(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${grantedKey}` },
    });
    const mGrantedJson = (await mGranted.json()) as { data: Array<{ id: string }> };
    expect(mGrantedJson.data.some((m) => m.id === 'flow:support-triage')).toBe(true);

    const mUngranted = await realFetch(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${ungrantedKey}` },
    });
    const mUngrantedJson = (await mUngranted.json()) as { data: Array<{ id: string }> };
    expect(mUngrantedJson.data.some((m) => m.id === 'flow:support-triage')).toBe(false);

    const mUnified = await realFetch(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${unifiedKey}` },
    });
    const mUnifiedJson = (await mUnified.json()) as { data: Array<{ id: string }> };
    expect(mUnifiedJson.data.some((m) => m.id === 'flow:support-triage')).toBe(false);

    // 2. 403 flow_not_granted for ungranted client key
    const r403 = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ungrantedKey}` },
      body: JSON.stringify({ model: 'flow:support-triage', messages: [{ role: 'user', content: 'Hi' }] }),
    });
    expect(r403.status).toBe(403);
    expect(((await r403.json()) as { error: { code: string } }).error.code).toBe('flow_not_granted');

    // 3. 400 flow_requires_client_key for unified key & personal user key
    for (const key of [unifiedKey, userKey]) {
      const r400 = await realFetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'flow:support-triage', messages: [{ role: 'user', content: 'Hi' }] }),
      });
      expect(r400.status).toBe(400);
      expect(((await r400.json()) as { error: { code: string } }).error.code).toBe('flow_requires_client_key');
    }

    // 4. 404 flow_not_found and hidden from /v1/models when orchestrator flag is false
    setFlags({ orchestrator: false });
    const mDisabled = await realFetch(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${grantedKey}` },
    });
    const mDisabledJson = (await mDisabled.json()) as { data: Array<{ id: string }> };
    expect(mDisabledJson.data.some((m) => m.id === 'flow:support-triage')).toBe(false);

    const r404 = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${grantedKey}` },
      body: JSON.stringify({ model: 'flow:support-triage', messages: [{ role: 'user', content: 'Hi' }] }),
    });
    expect(r404.status).toBe(404);
    expect(((await r404.json()) as { error: { code: string } }).error.code).toBe('flow_not_found');
  });

  it('attributes total tokens to client profile analytics and stops with quota_exhausted mid-run', async () => {
    const realFetch = installProviderFetchRedirect();

    // Set daily request quota to 1 on grantedProfileId so step 1 succeeds and step 2 hits 429
    const quotaPut = await adminCall(`/api/client-profiles/${grantedProfileId}/usage-quota`, 'PUT', {
      dailyRequests: 1,
    });
    expect(quotaPut.status).toBe(200);

    fakeProvider.enqueue(
      {
        kind: 'scripted',
        wire: 'openai-chat',
        stream: false,
        text: 'Routing you to billing now.',
        toolCalls: [
          {
            id: 'call_h',
            name: 'transfer_to_billing',
            arguments: '{"reason":"Check quota"}',
          },
        ],
        finishReason: 'tool_calls',
        usage: { promptTokens: 42, completionTokens: 18, totalTokens: 60 },
      },
      {
        kind: 'scripted',
        wire: 'openai-chat',
        stream: false,
        text: 'Should never be reached',
        finishReason: 'stop',
        usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
      },
    );

    const res = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${grantedKey}` },
      body: JSON.stringify({ model: 'flow:support-triage', messages: [{ role: 'user', content: 'Need billing' }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-freellm-run-status')).toBe('stopped;reason=quota_exhausted');
    const runId = res.headers.get('x-freellm-run-id')!;

    const runRes = await adminCall(`/api/ai-platform/runs/${runId}`);
    const run = runRes.body!.run as { status: string; stopReason: string; totalTokens: number };
    expect(run.status).toBe('stopped');
    expect(run.stopReason).toBe('quota_exhausted');
    expect(run.totalTokens).toBe(60);

    const analyticsRes = await adminCall(`/api/client-profiles/${grantedProfileId}/analytics`);
    expect(analyticsRes.status).toBe(200);
    const analytics = analyticsRes.body!.analytics as {
      totals: { requests: number; inputTokens: number; outputTokens: number };
    };
    expect(analytics.totals.requests).toBe(1);
    expect(analytics.totals.inputTokens + analytics.totals.outputTokens).toBe(60);
  });

  it('applies output guard to final flow answer and records guard step', async () => {
    const realFetch = installProviderFetchRedirect();

    const guardRes = await adminCall(`/api/ai-platform/output-guard/profile/${grantedProfileId}`, 'PUT', {
      mode: 'block',
      failMode: 'allow',
      replacementText: 'Blocked by flow output policy.',
      detectors: {
        keywords: { enabled: true, terms: ['secret-internal-code'] },
        patterns: { enabled: false, rules: [] },
        promptLeak: { enabled: false, minShingles: 2 },
        pii: { enabled: false, action: 'mask' },
        maxLength: { enabled: false, chars: 20000 },
        moderation: { enabled: false },
        judge: { enabled: false, model: 'auto', criteria: '' },
      },
      bypassRoles: [],
      holdChars: 200,
      maxDelayMs: 300,
      revision: 0,
    });
    expect(guardRes.status).toBe(200);

    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      stream: false,
      text: 'Here is the secret-internal-code you asked for.',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    });

    const res = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${grantedKey}` },
      body: JSON.stringify({ model: 'flow:support-triage', messages: [{ role: 'user', content: 'Tell me' }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-freellm-guard')).toBe('blocked;reason=keywords');
    const json = (await res.json()) as { choices: Array<{ message: { content: string }; finish_reason: string }> };
    expect(json.choices[0]!.message.content).toBe('Blocked by flow output policy.');
    expect(json.choices[0]!.finish_reason).toBe('content_filter');

    const runId = res.headers.get('x-freellm-run-id')!;
    const detail = await adminCall(`/api/ai-platform/runs/${runId}`);
    const steps = detail.body!.steps as Array<{ kind: string }>;
    expect(steps.some((s) => s.kind === 'guard')).toBe(true);
  });

  it('supports awaiting_approval -> admin approve via HTTP -> completed, admin cancel, disconnect cancel, and dry-run try', async () => {
    const realFetch = installProviderFetchRedirect();

    // 1. Trigger awaiting_approval via HTTP
    fakeProvider.enqueue(
      {
        kind: 'scripted',
        wire: 'openai-chat',
        stream: false,
        toolCalls: [{ id: 'tc-h', name: 'transfer_to_billing', arguments: '{"reason":"Refund"}' }],
        finishReason: 'tool_calls',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        kind: 'scripted',
        wire: 'openai-chat',
        stream: false,
        toolCalls: [{ id: 'tc-w', name: 'mcp__orders__refund_order', arguments: '{"order_id":"ORD-88","amount":25}' }],
        finishReason: 'tool_calls',
        usage: { promptTokens: 15, completionTokens: 5, totalTokens: 20 },
      },
      {
        kind: 'scripted',
        wire: 'openai-chat',
        stream: false,
        text: 'Refund ORD-88 processed after approval.',
        finishReason: 'stop',
        usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
      },
    );

    const chatRes = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${grantedKey}` },
      body: JSON.stringify({ model: 'flow:support-triage', messages: [{ role: 'user', content: 'Refund ORD-88' }] }),
    });
    expect(chatRes.status).toBe(200);
    expect(chatRes.headers.get('x-freellm-run-status')).toBe('awaiting_approval');
    const runId = chatRes.headers.get('x-freellm-run-id')!;
    const toolCallsBeforeApprove = fakeMcp.requests.filter(
      (r) => (r.bodyJson as { method?: string } | null)?.method === 'tools/call',
    );
    expect(toolCallsBeforeApprove).toHaveLength(0);

    const publicPending = await realFetch(`${baseUrl}/v1/ai/runs/${runId}`, {
      headers: { authorization: `Bearer ${grantedKey}` },
    });
    expect(((await publicPending.json()) as { status: string }).status).toBe('awaiting_approval');

    const approvalsList = await adminCall('/api/ai-platform/approvals?status=pending');
    const approvalId = (approvalsList.body!.approvals as Array<{ id: number }>)[0]!.id;

    const approveRes = await adminCall(`/api/ai-platform/approvals/${approvalId}/approve`, 'POST', {
      note: 'Verified customer',
    });
    expect(approveRes.status).toBe(200);
    const toolCallsAfterApprove = fakeMcp.requests.filter(
      (r) => (r.bodyJson as { method?: string } | null)?.method === 'tools/call',
    );
    expect(toolCallsAfterApprove).toHaveLength(1);

    const publicDone = await realFetch(`${baseUrl}/v1/ai/runs/${runId}`, {
      headers: { authorization: `Bearer ${grantedKey}` },
    });
    const publicDoneJson = (await publicDone.json()) as { status: string; output_text: string };
    expect(publicDoneJson.status).toBe('completed');
    expect(publicDoneJson.output_text).toBe('Refund ORD-88 processed after approval.');

    // 2. Admin cancel on awaiting_approval run + 409 on second cancel
    fakeProvider.enqueue(
      {
        kind: 'scripted',
        wire: 'openai-chat',
        stream: false,
        toolCalls: [{ id: 'tc-h2', name: 'transfer_to_billing', arguments: '{}' }],
        finishReason: 'tool_calls',
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      },
      {
        kind: 'scripted',
        wire: 'openai-chat',
        stream: false,
        toolCalls: [{ id: 'tc-w2', name: 'mcp__orders__refund_order', arguments: '{"order_id":"ORD-89","amount":15}' }],
        finishReason: 'tool_calls',
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      },
    );
    const chat2 = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${grantedKey}` },
      body: JSON.stringify({ model: 'flow:support-triage', messages: [{ role: 'user', content: 'Refund ORD-89' }] }),
    });
    const runId2 = chat2.headers.get('x-freellm-run-id')!;
    const cancel1 = await adminCall(`/api/ai-platform/runs/${runId2}/cancel`, 'POST');
    expect(cancel1.status).toBe(200);
    expect((cancel1.body!.run as { status: string }).status).toBe('cancelled');
    const cancel2 = await adminCall(`/api/ai-platform/runs/${runId2}/cancel`, 'POST');
    expect(cancel2.status).toBe(409);

    // 3. Dry-run POST /flows/:id/try does not charge client profile and is hidden from /v1/ai/runs/:id
    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      stream: false,
      text: 'Dry run ok.',
      finishReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    });
    const tryRes = await adminCall(`/api/ai-platform/flows/${flowId}/try`, 'POST', {
      message: 'Dry run test',
    });
    expect(tryRes.status).toBe(200);
    expect(tryRes.body!.outputText).toBe('Dry run ok.');
    const tryRunId = (tryRes.body!.run as { id: string }).id;
    const pubTry = await realFetch(`${baseUrl}/v1/ai/runs/${tryRunId}`, {
      headers: { authorization: `Bearer ${grantedKey}` },
    });
    expect(pubTry.status).toBe(404);

    // 4. Client disconnect cancels active run cleanly
    fakeProvider.setDefaultReply(async () => {
      await new Promise((r) => setTimeout(r, 400));
      return {
        kind: 'scripted',
        wire: 'openai-chat',
        stream: false,
        text: 'Slow answer',
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      };
    });
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 80);
    await expect(
      realFetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${grantedKey}` },
        body: JSON.stringify({ model: 'flow:support-triage', messages: [{ role: 'user', content: 'Slow query' }] }),
        signal: abortController.signal,
      }),
    ).rejects.toThrow();

    await new Promise((r) => setTimeout(r, 150));
    const cancelledRuns = await adminCall('/api/ai-platform/runs?status=cancelled');
    expect((cancelledRuns.body!.runs as Array<unknown>).length).toBeGreaterThanOrEqual(2);
    expect(refundToolId).toBeGreaterThan(0);
  });
});
