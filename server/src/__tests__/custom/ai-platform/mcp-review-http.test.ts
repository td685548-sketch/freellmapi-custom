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
import { startFakeProviderServer, type FakeProviderServer } from '../../helpers/ai-platform-fake-provider.js';

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

describe('Reviewer HTTP compatibility probes', () => {
 it('retains stored conversations when MCP takeover is enabled', async()=>{
  getDb().prepare('UPDATE client_profiles SET conv_enabled=1 WHERE id=?').run(profileId);
  const realFetch=installProviderFetchRedirect();
  fakeProvider.enqueue({kind:'scripted',wire:'openai-chat',text:'First reply',stream:false},{kind:'scripted',wire:'openai-chat',text:'Second reply',stream:false});
  const headers={authorization:`Bearer ${clientKey}`,'content-type':'application/json','x-conversation-id':'review-conversation','x-end-user':'review-user'};
  const request=async(text:string)=>{
   const r=await realFetch(`${baseUrl}/v1/chat/completions`,{method:'POST',headers,body:JSON.stringify({model:'llama-3.3-70b-versatile',messages:[{role:'user',content:text}]})});
   await r.text(); return r;
  };
  const first=await request('Remember code alpha'); expect(first.status).toBe(200);
  const second=await request('What was the code?'); expect(second.status).toBe(200);
  expect(second.headers.get('x-conversation-history')).toBe('2');
 });
 it('forwards tool_choice none and response_format to the inner provider',async()=>{
  const realFetch=installProviderFetchRedirect();
  fakeProvider.enqueue({kind:'scripted',wire:'openai-chat',text:'{}',stream:false});
  const r=await realFetch(`${baseUrl}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${clientKey}`,'content-type':'application/json'},body:JSON.stringify({model:'llama-3.3-70b-versatile',messages:[{role:'user',content:'Return JSON without calling tools'}],tool_choice:'none',response_format:{type:'json_object'}})});
  expect(r.status).toBe(200); await r.text();
  const body=fakeProvider.requests[0]!.bodyJson as Record<string,unknown>;
  expect(body.tool_choice).toBe('none'); expect(body.response_format).toEqual({type:'json_object'});
 });

 it('enforces end-user isolation (403) on stored conversation with MCP enabled (F06)', async () => {
  getDb().prepare('UPDATE client_profiles SET conv_enabled=1 WHERE id=?').run(profileId);
  const realFetch = installProviderFetchRedirect();
  fakeProvider.enqueue({ kind: 'scripted', wire: 'openai-chat', text: 'Owner reply', stream: false });

  const first = await realFetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${clientKey}`,
      'content-type': 'application/json',
      'x-conversation-id': 'iso-conv-1',
      'x-end-user': 'alice',
    },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] }),
  });
  expect(first.status).toBe(200);
  await first.text();

  const intruder = await realFetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${clientKey}`,
      'content-type': 'application/json',
      'x-conversation-id': 'iso-conv-1',
      'x-end-user': 'bob',
    },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'steal' }] }),
  });
  expect(intruder.status).toBe(403);
 });

 it('serves quick answers without calling provider and injects KB only once across MCP rounds (F06)', async () => {
  getDb()
    .prepare('UPDATE client_profiles SET qa_enabled=1, qa_min_similarity=50, kb_enabled=1, kb_max_chars=4000 WHERE id=?')
    .run(profileId);
  getDb()
    .prepare("INSERT INTO custom_quick_answers (profile_id, question, answer, enabled) VALUES (?, 'What are your hours?', 'Open 24/7', 1)")
    .run(profileId);
  const docId = Number(
    getDb()
      .prepare("INSERT INTO custom_knowledge_docs (profile_id, filename, size_bytes, chunk_count) VALUES (?, 'faq.txt', 32, 1)")
      .run(profileId).lastInsertRowid,
  );
  getDb()
    .prepare("INSERT INTO custom_knowledge_chunks (doc_id, profile_id, chunk_index, content) VALUES (?, ?, 0, 'KB_UNIQUE_MARKER_991')")
    .run(docId, profileId);

  const realFetch = installProviderFetchRedirect();
  const qaRes = await realFetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'What are your hours?' }] }),
  });
  expect(qaRes.status).toBe(200);
  const qaText = await qaRes.text();
  expect(qaText).toContain('Open 24/7');
  expect(fakeProvider.requests.length).toBe(0);

  // Non-QA prompt triggers 2-round MCP tool loop; KB marker must appear once per turn, not duplicated per round
  fakeProvider.enqueue(
    {
      kind: 'scripted',
      wire: 'openai-chat',
      toolCalls: [{ id: 'call_kb_1', name: 'mcp__orders__lookup_order', arguments: '{"order_id":"ord-kb"}' }],
      finishReason: 'tool_calls',
    },
    { kind: 'scripted', wire: 'openai-chat', text: 'KB + MCP done', finishReason: 'stop' },
  );
  const kbRes = await realFetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'Check order ord-kb with KB_UNIQUE_MARKER_991' }] }),
  });
  expect(kbRes.status).toBe(200);
  await kbRes.text();
  expect(fakeProvider.requests.length).toBe(2);
  const r2Body = fakeProvider.requests[1]!.bodyText;
  const occurrences = r2Body.split('KB_UNIQUE_MARKER_991').length - 1;
  expect(occurrences).toBeLessThanOrEqual(2);
 });
});
