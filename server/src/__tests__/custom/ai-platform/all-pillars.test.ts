/**
 * T132 — all six AI platform pillars switched on for one client key.
 *
 * Checks the fixed processing order from contracts/inference-surface.md:
 *   4  flow:<slug> hands the request to the orchestrator
 *   5  system prompt variables (prompts)
 *   6  knowledge search and injection (retrieval)
 *   7  MCP tool definitions and the server-side tool loop (mcpClient)
 *   8  provider cache breakpoints (promptCache)
 *   9  model call
 *  10  response: cache stats -> citations -> output guard
 *
 * The order is observed from outside: what the fake provider receives on each
 * call, and the headers and body the caller gets back.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CITATIONS_HEADER_NAME, RETRIEVAL_HEADER_NAME, type Scope } from '@freellmapi/shared/ai-platform-retrieval.js';
import { DEFAULT_GUARD_DETECTORS, DEFAULT_GUARD_POLICY_BASE } from '@freellmapi/shared/ai-platform-output-guard.js';
import { createApp } from '../../../app.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { getPolicy, setPolicy } from '../../../custom/ai-platform/output-guard/policy.js';
import { setQueryEmbeddingsRunnerForTests } from '../../../custom/ai-platform/retrieval/hybrid.js';
import {
  getScopeIndexSnapshot,
  setEmbeddingsRunnerForTests,
  stopIndexWorker,
} from '../../../custom/ai-platform/retrieval/indexer.js';
import { invalidateVectorCache } from '../../../custom/ai-platform/retrieval/vector-store.js';
import { getDb, initDb } from '../../../db/index.js';
import { setSetting } from '../../../db/index.js';
import { encrypt } from '../../../lib/crypto.js';
import { hashClientProfileKey } from '../../../lib/system-prompt.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setKeyCacheTestOverride } from '../../../services/key-cache.js';
import { resetKnowledgeIndexes } from '../../../services/profile-knowledge.js';
import { getActiveProfileId } from '../../../services/profile-models.js';
import { clearAllCooldowns } from '../../../services/ratelimit.js';
import { clearAllPenalties } from '../../../services/router.js';
import { createFakeEmbeddingsRunner } from '../../helpers/fake-embeddings.js';
import { startFakeMcpHttpServer } from '../../helpers/ai-platform-fake-mcp-http.js';
import { startFakeProviderServer, type FakeProviderServer } from '../../helpers/ai-platform-fake-provider.js';

const MODEL = 'anthropic/claude-sonnet-4';
const CLIENT_KEY = 'sk-cp-all-pillars-0001';
// Long enough (> 1024 tokens) for the provider cache to place a breakpoint on it.
const STABLE_RULES = 'Follow the returns policy and keep answers short. '.repeat(120);
const KNOWLEDGE_TEXT = 'Hardware devices carry a two-year replacement warranty with free diagnostics.';

type FakeMcp = Awaited<ReturnType<typeof startFakeMcpHttpServer>>;

let appServer: http.Server | null = null;
let baseUrl = '';
let fakeProvider: FakeProviderServer;
let fakeMcp: FakeMcp;
let primaryId = 0;
let primaryToken = '';
let profileId = 0;
const realFetch = global.fetch;

async function adminCall(path: string, method = 'GET', body?: unknown) {
  const res = await realFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${primaryToken}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, any> | null = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}

function seedProvidersAndRouting(): void {
  setKeyCacheTestOverride(true);
  const db = getDb();
  for (const [platform, label, secret] of [
    ['openrouter', 'or-all-pillars', 'sk-or-all-pillars'],
    ['groq', 'groq-all-pillars', 'gsk_all_pillars'],
  ] as const) {
    const enc = encrypt(secret);
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES (?, ?, ?, ?, ?, 'healthy', 1)`,
    ).run(platform, label, enc.encrypted, enc.iv, enc.authTag);
  }
  db.prepare(
    `INSERT OR IGNORE INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools, source)
     VALUES
      ('openrouter', 'anthropic/claude-sonnet-4', 'Claude Sonnet 4 (OR)', 1, 8, 'Frontier', 60, 1000, NULL, NULL, '~10M', 200000, 1, 1, 1, 'discovered'),
      ('groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 3, 10, 'Large', 30, 1000, 120000, NULL, '~10M', 128000, 1, 0, 1, 'catalog')`,
  ).run();
  db.prepare('UPDATE fallback_config SET enabled = 0').run();
  const activeProfileId = getActiveProfileId(db);
  if (activeProfileId != null) db.prepare('UPDATE profile_models SET enabled = 0 WHERE profile_id = ?').run(activeProfileId);
  let priority = 1;
  for (const [platform, modelId] of [['openrouter', MODEL], ['groq', 'llama-3.3-70b-versatile']] as const) {
    const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { id: number };
    db.prepare(
      `INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)
       ON CONFLICT(model_db_id) DO UPDATE SET priority = excluded.priority, enabled = 1`,
    ).run(row.id, priority);
    if (activeProfileId != null) {
      db.prepare(
        `INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)
         ON CONFLICT(profile_id, model_db_id) DO UPDATE SET priority = excluded.priority, enabled = 1`,
      ).run(activeProfileId, row.id, priority);
    }
    priority++;
  }
  setSetting('routing_strategy', 'priority');
}

function systemTexts(body: Record<string, any>): string[] {
  return (body.messages as Array<{ role: string; content: unknown }>)
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
}

function hasCacheControl(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasCacheControl);
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).some(([k, v]) => k === 'cache_control' || hasCacheControl(v));
  }
  return false;
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
      return { content: [{ type: 'text', text: 'unsupported' }], isError: true };
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
  invalidateVectorCache();
  clearAllCooldowns();
  clearAllPenalties();
  seedProvidersAndRouting();

  const fakeRunner = createFakeEmbeddingsRunner(768);
  setEmbeddingsRunnerForTests(fakeRunner);
  setQueryEmbeddingsRunnerForTests(fakeRunner);

  appServer = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => appServer!.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  primaryId = createUser('all-pillars-owner@example.com', 'Password123!').userId;
  primaryToken = createSession(primaryId);

  profileId = Number(getDb()
    .prepare(
      `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled, ai_tools_enabled, ai_tool_max_rounds)
       VALUES ('all-pillars', ?, 'enc', 'iv', 'tag', 1, 1, 4)`,
    )
    .run(hashClientProfileKey(CLIENT_KEY)).lastInsertRowid);

  vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.startsWith(baseUrl) || urlStr.startsWith(fakeProvider.url) || urlStr.startsWith(fakeMcp.url)) {
      return realFetch(input, init);
    }
    const parsed = new URL(urlStr);
    return realFetch(`${fakeProvider.url}${parsed.pathname}${parsed.search}`, init);
  });

  setFlags({ prompts: true, retrieval: true, mcpClient: true, promptCache: true, outputGuard: true, orchestrator: true });
  const scope: Scope = { kind: 'profile', id: String(profileId) };

  // 5. Versioned prompt with a caller variable.
  const state = await adminCall(`/api/ai-platform/prompts/profile/${profileId}`);
  expect(state.status).toBe(200);
  const draft = await adminCall(`/api/ai-platform/prompts/profile/${profileId}/draft`, 'PUT', {
    body: `Brand={{brand}}. ${STABLE_RULES}`,
    variables: [{ name: 'brand', source: 'caller', default: 'DefaultBrand' }],
    revision: state.json!.head.revision,
  });
  expect(draft.status, draft.text).toBe(200);
  const state2 = await adminCall(`/api/ai-platform/prompts/profile/${profileId}`);
  const published = await adminCall(`/api/ai-platform/prompts/profile/${profileId}/publish`, 'POST', { revision: state2.json!.head.revision });
  expect(published.status, published.text).toBe(200);

  // 6. Knowledge, indexed for hybrid search with citations.
  const doc = await adminCall(`/api/client-profiles/${profileId}/knowledge`, 'POST', { title: 'Hardware Warranty', content: KNOWLEDGE_TEXT });
  expect(doc.status, doc.text).toBe(201);
  const knowledgeSettings = await adminCall(`/api/client-profiles/${profileId}/knowledge-settings`, 'PUT', { enabled: true, maxChars: 8000 });
  expect(knowledgeSettings.status, knowledgeSettings.text).toBe(200);
  const retrievalSettings = await adminCall(`/api/ai-platform/retrieval/profile/${profileId}`, 'PUT', {
    mode: 'hybrid', topK: 3, minScore: 0.05, citationsEnabled: true,
  });
  expect(retrievalSettings.status, retrievalSettings.text).toBe(200);
  for (let i = 0; i < 200 && !getScopeIndexSnapshot(scope).status.ready; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(getScopeIndexSnapshot(scope).status.ready).toBe(true);

  // 7. MCP server with one reviewed read tool bound to the profile.
  expect((await adminCall('/api/ai-platform/mcp/allowed-internal-hosts', 'PUT', { origins: [fakeMcp.origin] })).status).toBe(200);
  const server = await adminCall('/api/ai-platform/mcp/servers', 'POST', { slug: 'orders', name: 'Orders MCP', url: fakeMcp.url, authKind: 'none' });
  expect(server.status, server.text).toBe(201);
  const serverId = server.json!.server.id as number;
  expect((await adminCall(`/api/ai-platform/mcp/servers/${serverId}/sync`, 'POST')).status).toBe(200);
  const tools = (await adminCall(`/api/ai-platform/mcp/servers/${serverId}/tools`)).json!.tools as Array<{ id: number; name: string }>;
  const lookup = tools.find((t) => t.name === 'lookup_order')!;
  expect((await adminCall(`/api/ai-platform/mcp/tools/${lookup.id}`, 'PATCH', { state: 'allowed', effect: 'read' })).status).toBe(200);
  const bind = await adminCall(`/api/ai-platform/mcp/bindings/profile/${profileId}`, 'PUT', { toolIds: [lookup.id], enabled: true, maxRounds: 4 });
  expect(bind.status, bind.text).toBe(200);

  // 8. Provider cache: forward caller markers and place automatic breakpoints.
  const cache = await adminCall('/api/ai-platform/prompt-cache/settings', 'PUT', { forward: true, autoBreakpoints: true });
  expect(cache.status, cache.text).toBe(200);

  // 10. Output guard masks e-mail addresses in the final answer.
  await setPolicy(scope, {
    ...DEFAULT_GUARD_POLICY_BASE,
    revision: getPolicy(scope).revision,
    mode: 'block',
    failMode: 'allow',
    detectors: { ...DEFAULT_GUARD_DETECTORS, pii: { enabled: true, action: 'mask' } },
    replacementText: 'Blocked by output guard.',
  }, primaryId);

  // 4. A one-agent flow granted to the same client key.
  const agent = await adminCall('/api/ai-platform/agents', 'POST', {
    slug: 'helper', name: 'Helper', model: MODEL, systemPrompt: 'AGENT_SYSTEM_PROMPT: answer as the helper agent.',
  });
  expect(agent.status, agent.text).toBe(201);
  const flow = await adminCall('/api/ai-platform/flows', 'POST', {
    slug: 'helpdesk',
    name: 'Helpdesk',
    draft: {
      kind: 'single', entryAgent: 'helper', agents: ['helper'], handoffs: { helper: [] },
      limits: { maxSteps: 4, maxToolCalls: 4, maxHandoffs: 1, maxTokens: 20000, maxSeconds: 60 },
      awaitingApprovalText: 'Awaiting approval.', approvalTtlHours: 24,
    },
  });
  expect(flow.status, flow.text).toBe(201);
  const created = flow.json!.flow as { id: number; revision: number };
  expect((await adminCall(`/api/ai-platform/flows/${created.id}/publish`, 'POST', { revision: created.revision })).status).toBe(200);
  expect((await adminCall(`/api/ai-platform/flows/${created.id}/grants`, 'PUT', { profileIds: [profileId] })).status).toBe(200);

  fakeProvider.reset();
  fakeMcp.reset();
});

afterEach(async () => {
  stopIndexWorker();
  setEmbeddingsRunnerForTests(null);
  setQueryEmbeddingsRunnerForTests(null);
  vi.restoreAllMocks();
  resetFlagsCacheForTests();
  if (appServer) {
    await new Promise<void>((resolve) => appServer!.close(() => resolve()));
    appServer = null;
  }
  try { getDb().close(); } catch { /* already closed */ }
});

describe('all six AI platform pillars on one client key (T132)', () => {
  it('applies prompts, retrieval, MCP tools and cache breakpoints before the model, then cache stats, citations and the guard on the answer', async () => {
    fakeProvider.enqueue(
      {
        kind: 'scripted',
        wire: 'openai-chat',
        stream: false,
        toolCalls: [{ id: 'call_all_1', name: 'mcp__orders__lookup_order', arguments: JSON.stringify({ order_id: 'ord-42' }) }],
        finishReason: 'tool_calls',
        usage: { promptTokens: 1500, completionTokens: 10, totalTokens: 1510, cachedTokens: 1200 },
      },
      {
        kind: 'scripted',
        wire: 'openai-chat',
        stream: false,
        text: 'Order ord-42 has shipped and hardware has a two-year warranty. Write to help@acme.example for more.',
        finishReason: 'stop',
        usage: { promptTokens: 1600, completionTokens: 20, totalTokens: 1620, cachedTokens: 1200 },
      },
    );

    const res = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${CLIENT_KEY}`,
        'x-freellm-vars': JSON.stringify({ brand: 'Acme' }),
      },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'What warranty does hardware have, and where is order ord-42?' }] }),
    });
    const raw = await res.text();
    expect(res.status, raw).toBe(200);
    const body = JSON.parse(raw) as Record<string, any>;

    // Two model calls: before and after the server-side tool round.
    const calls = fakeProvider.requests.filter((r) => r.path.includes('chat/completions'));
    expect(calls.length).toBe(2);
    const first = calls[0]!.bodyJson as Record<string, any>;
    const second = calls[1]!.bodyJson as Record<string, any>;

    // 5 before 6: the rendered prompt is the first system block, knowledge comes after it.
    const systems = systemTexts(first);
    const promptIndex = systems.findIndex((s) => s.includes('Brand=Acme.'));
    const knowledgeIndex = systems.findIndex((s) => s.includes('two-year replacement warranty'));
    expect(promptIndex).toBe(0);
    expect(knowledgeIndex).toBeGreaterThan(promptIndex);
    expect(systems.join('\n')).not.toContain('{{brand}}');

    // 7: the MCP tool definition is attached; the second call carries the tool result.
    const toolNames = (first.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(toolNames).toContain('mcp__orders__lookup_order');
    expect(JSON.stringify(second.messages)).toContain('shipped');
    const toolCalls = fakeMcp.requests.filter((r) => (r.bodyJson as { method?: string } | null)?.method === 'tools/call');
    expect(toolCalls.map((r) => (r.bodyJson as { params: { name: string } }).params.name)).toEqual(['lookup_order']);
    // Counts model rounds, as in mcp-e2e: one tool round means two model calls.
    expect(res.headers.get('x-freellm-tool-rounds')).toBe('2');

    // 8 after 5 and 6: the stable prompt block carries a breakpoint, the per-query knowledge block does not.
    const firstSystems = (first.messages as Array<{ role: string; content: unknown }>).filter((m) => m.role === 'system');
    expect(hasCacheControl(firstSystems[promptIndex])).toBe(true);
    expect(hasCacheControl(firstSystems[knowledgeIndex])).toBe(false);

    // 10: cache stats recorded, citations attached, and the guard ran last on the final text.
    const cacheRows = getDb().prepare('SELECT cache_read_tokens FROM custom_ai_cache_usage_daily WHERE profile_id = ?').all(profileId) as Array<{ cache_read_tokens: number }>;
    expect(cacheRows.reduce((sum, r) => sum + r.cache_read_tokens, 0)).toBeGreaterThan(0);
    expect(res.headers.get(RETRIEVAL_HEADER_NAME)).toMatch(/^hybrid/);
    expect(res.headers.get(CITATIONS_HEADER_NAME)).toBeTruthy();
    expect(Array.isArray(body.citations) && body.citations.length > 0).toBe(true);
    const answer = body.choices[0].message.content as string;
    expect(answer).toContain('two-year warranty');
    expect(answer).not.toContain('help@acme.example');
    expect(res.headers.get('x-freellm-guard')).toMatch(/^masked/);
  });

  it('hands flow:<slug> to the orchestrator first, and the guard still filters the flow answer', async () => {
    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      stream: false,
      text: 'The helper agent says: contact help@acme.example.',
      finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
    });

    const res = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CLIENT_KEY}` },
      body: JSON.stringify({ model: 'flow:helpdesk', messages: [{ role: 'user', content: 'Who should I contact?' }] }),
    });
    const raw = await res.text();
    expect(res.status, raw).toBe(200);
    const body = JSON.parse(raw) as Record<string, any>;

    expect(body.model).toBe('flow:helpdesk');
    expect(res.headers.get('x-freellm-run-id')).toMatch(/^run_/);
    expect(res.headers.get('x-freellm-run-status')).toBe('completed');

    // The model call was made for the flow's agent, not as an ordinary profile request.
    const call = fakeProvider.requests.find((r) => r.path.includes('chat/completions'));
    expect(call).toBeDefined();
    expect(JSON.stringify((call!.bodyJson as Record<string, any>).messages)).toContain('AGENT_SYSTEM_PROMPT');

    const answer = body.choices[0].message.content as string;
    expect(answer).toContain('helper agent');
    expect(answer).not.toContain('help@acme.example');
  });
});
