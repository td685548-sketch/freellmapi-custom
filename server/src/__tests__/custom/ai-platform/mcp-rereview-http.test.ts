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

describe('Second-pass HTTP controls',()=>{
 it('preserves frequency and presence penalty or falls back before takeover',async()=>{
  const realFetch=installProviderFetchRedirect();
  fakeProvider.enqueue({kind:'scripted',wire:'openai-chat',text:'answer',stream:false});
  const response=await realFetch(`${baseUrl}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${clientKey}`,'content-type':'application/json'},body:JSON.stringify({model:'llama-3.3-70b-versatile',messages:[{role:'user',content:'hello'}],frequency_penalty:0.75,presence_penalty:0.5})});
  expect(response.status).toBe(200);await response.text();
  const body=fakeProvider.requests[0]!.bodyJson as Record<string,unknown>;
  expect(body.frequency_penalty).toBe(0.75);expect(body.presence_penalty).toBe(0.5);
 });
});
