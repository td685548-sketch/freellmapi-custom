import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { createUser, createSession } from '../../services/auth.js';
import { providerAccountsRouter } from '../../custom/provider-accounts/router.js';
import {
  accountRow,
  getProviderModelConfig,
  getUsableXGatewayKeys,
  invalidateXGatewayKeyCache,
  listAccounts,
  sanitizeCustomHeaders,
} from '../../custom/provider-accounts/store.js';
import { resolveAccountProvider } from '../../custom/provider-accounts/execution.js';
import { createProxyPoolEntry } from '../../custom/x-gateway/proxy-pool.js';
import * as migration from '../../db/migrations/20261107_120000_custom_x_gateway_keys.js';
import * as proxyAndApiKeysMigration from '../../db/migrations/20261107_130000_custom_x_gateway_proxy_and_api_keys.js';
import * as proxyPoolMigration from '../../db/migrations/20261107_150000_custom_x_gateway_proxy_pool.js';

const nativeFetch = globalThis.fetch;
const fullPermissions = [
  'use_x_gateway',
  'view_keys',
  'add_keys',
  'edit_keys',
  'delete_keys',
  'test_keys',
  'manage_key_models',
];

let server: ReturnType<ReturnType<typeof express>['listen']>;
let base: string;
let token: string;
let userId: number;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  migration.up(db);
  proxyAndApiKeysMigration.up(db);
  proxyPoolMigration.up(db);

  createUser('root-adv@test.dev', 'password123');
  userId = createUser('adv-operator@test.dev', 'password123', 'member').userId;
  db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(fullPermissions), userId);
  token = createSession(userId);

  const app = express();
  app.use(express.json());
  app.use('/api/thruline-accounts', providerAccountsRouter);
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/thruline-accounts`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM x_gateway_keys').run();
  db.prepare('DELETE FROM x_gateway_proxy_pool').run();
  db.prepare('DELETE FROM x_gateway_config').run();
  db.prepare('DELETE FROM settings WHERE key = ?').run('x_gateway_custom_nodes');
  invalidateXGatewayKeyCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(method: string, path: string, body?: unknown) {
  const res = await nativeFetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : null };
}

describe('Agent 1 — Advanced Provider & Account Management (9Router Parity)', () => {
  it('sanitizes custom headers and blocks unsafe transport/auth headers', () => {
    const cleaned = sanitizeCustomHeaders({
      'X-Custom-Trace': 'trace-123',
      'anthropic-beta': 'output-128k-2025-02-19',
      Authorization: 'Bearer attacker',
      Host: 'evil.example.com',
      Cookie: 'session=abc',
      'X-CRLF': 'bad\r\nheader',
    });

    expect(cleaned).toEqual({
      'X-Custom-Trace': 'trace-123',
      'anthropic-beta': 'output-128k-2025-02-19',
    });
  });

  it('persists per-provider strategy, stickyLimit, thinkingMode, and customHeaders via PUT /providers/:providerId/models', async () => {
    const putRes = await call('PUT', '/providers/openai/models', {
      disabledModels: ['gpt-4-turbo'],
      customModels: [{ id: 'gpt-5-custom', name: 'GPT-5 Custom' }],
      modelAliases: { fast: 'gpt-4o-mini' },
      strategy: 'round-robin',
      stickyLimit: 5,
      thinkingMode: 'high',
      customHeaders: {
        'X-OpenAI-Organization': 'org-test-123',
        Authorization: 'should-be-stripped',
      },
    });

    expect(putRes.status).toBe(200);
    expect(putRes.body).toMatchObject({
      providerId: 'openai',
      disabledModels: ['gpt-4-turbo'],
      customModels: [{ id: 'gpt-5-custom', name: 'GPT-5 Custom' }],
      modelAliases: { fast: 'gpt-4o-mini' },
      strategy: 'round-robin',
      stickyLimit: 5,
      thinkingMode: 'high',
      customHeaders: { 'X-OpenAI-Organization': 'org-test-123' },
    });

    const getRes = await call('GET', '/providers/openai/models');
    expect(getRes.status).toBe(200);
    expect(getRes.body.strategy).toBe('round-robin');
    expect(getRes.body.stickyLimit).toBe(5);
    expect(getRes.body.thinkingMode).toBe('high');
    expect(getRes.body.customHeaders).toEqual({ 'X-OpenAI-Organization': 'org-test-123' });

    const providers = listAccounts();
    const openai = providers.find(p => p.id === 'openai');
    expect(openai?.strategy).toBe('round-robin');
    expect(openai?.stickyLimit).toBe(5);
    expect(openai?.thinkingMode).toBe('high');
    expect(openai?.customHeaders).toEqual({ 'X-OpenAI-Organization': 'org-test-123' });
  });

  it('reorders provider accounts via PUT /providers/:providerId/priority and reflects priority in listAccounts and getUsableXGatewayKeys', async () => {
    const a1 = await call('POST', '/', { provider: 'groq', key: 'gsk_1', label: 'Groq #1' });
    const a2 = await call('POST', '/', { provider: 'groq', key: 'gsk_2', label: 'Groq #2' });
    const a3 = await call('POST', '/', { provider: 'groq', key: 'gsk_3', label: 'Groq #3' });

    const id1 = a1.body.id as number;
    const id2 = a2.body.id as number;
    const id3 = a3.body.id as number;

    const reorderRes = await call('PUT', '/providers/groq/priority', {
      accountIds: [id3, id1, id2],
    });
    expect(reorderRes.status).toBe(200);
    expect(reorderRes.body.accountPriorities).toEqual([id3, id1, id2]);

    const groqProvider = listAccounts().find(p => p.id === 'groq')!;
    expect(groqProvider.accounts.map(a => ({ id: a.id, priority: a.priority }))).toEqual([
      { id: id3, priority: 1 },
      { id: id1, priority: 2 },
      { id: id2, priority: 3 },
    ]);

    const usableIds = getUsableXGatewayKeys()
      .filter(k => k.provider === 'groq')
      .map(k => k.id);
    expect(usableIds).toEqual([id3, id1, id2]);
  });

  it('supports bulk proxy assignment (one-to-one rotation, single pool, and unbind) and bulk delete', async () => {
    const pool1 = createProxyPoolEntry('Pool A', 'http://127.0.0.1:8081');
    const pool2 = createProxyPoolEntry('Pool B', 'http://127.0.0.1:8082');

    const bulkCreated = await call('POST', '/bulk', {
      provider: 'deepseek',
      entries: [
        { key: 'ds-key-1', label: 'DS 1' },
        { key: 'ds-key-2', label: 'DS 2' },
        { key: 'ds-key-3', label: 'DS 3' },
      ],
    });
    expect(bulkCreated.status).toBe(201);
    const ids = bulkCreated.body.ids as number[];

    // 1. One-to-one rotation across Pool A and Pool B
    const rotateRes = await call('POST', '/bulk-proxy', {
      accountIds: ids,
      mode: 'one-to-one',
    });
    expect(rotateRes.status).toBe(200);
    expect(rotateRes.body.updated).toBe(3);
    expect(accountRow(ids[0]!).proxy_pool_id).toBe(pool1.id);
    expect(accountRow(ids[1]!).proxy_pool_id).toBe(pool2.id);
    expect(accountRow(ids[2]!).proxy_pool_id).toBe(pool1.id);

    // 2. Bind all to Pool B
    const poolRes = await call('POST', '/bulk-proxy', {
      accountIds: ids,
      mode: 'pool',
      proxyPoolId: pool2.id,
    });
    expect(poolRes.status).toBe(200);
    expect(ids.map(id => accountRow(id).proxy_pool_id)).toEqual([pool2.id, pool2.id, pool2.id]);

    // 3. Unbind all
    const noneRes = await call('POST', '/bulk-proxy', {
      accountIds: ids,
      mode: 'none',
    });
    expect(noneRes.status).toBe(200);
    expect(ids.map(id => accountRow(id).proxy_pool_id)).toEqual([null, null, null]);

    // 4. Bulk delete first two accounts
    const delRes = await call('POST', '/bulk-delete', {
      accountIds: [ids[0], ids[1]],
    });
    expect(delRes.status).toBe(200);
    expect(delRes.body.deleted).toBe(2);

    const remaining = listAccounts().find(p => p.id === 'deepseek')!.accounts;
    expect(remaining.map(a => a.id)).toEqual([ids[2]]);
  });

  it('creates and updates Custom Compatible Nodes via POST /nodes and PUT /nodes/:nodeId with SSRF protection', async () => {
    const createRes = await call('POST', '/nodes', {
      name: 'My OpenAI Node',
      prefix: 'my-node',
      type: 'openai-compatible',
      apiType: 'chat',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o-mini'],
    });
    expect(createRes.status).toBe(201);
    const nodeId = createRes.body.node.id as string;

    const updateRes = await call('PUT', `/nodes/${nodeId}`, {
      name: 'Updated Responses Node',
      prefix: 'my-node-v2',
      type: 'openai-compatible',
      apiType: 'responses',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o', 'gpt-4.1'],
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.node).toMatchObject({
      id: nodeId,
      name: 'Updated Responses Node',
      prefix: 'my-node-v2',
      apiType: 'responses',
      models: ['gpt-4o', 'gpt-4.1'],
    });

    // SSRF guard blocks metadata/loopback URLs
    const ssrfRes = await call('PUT', `/nodes/${nodeId}`, {
      name: 'Bad SSRF Node',
      prefix: 'ssrf',
      type: 'openai-compatible',
      baseUrl: 'http://169.254.169.254/latest/meta-data',
    });
    expect(ssrfRes.status).toBe(400);
  });

  it('fetches live models via POST /providers/:providerId/fetch-models and forwards customHeaders + thinkingMode in execution', async () => {
    const accRes = await call('POST', '/', {
      provider: 'openai',
      key: 'sk-live-test-key',
      label: 'OpenAI Primary',
    });
    const accountId = accRes.body.id as number;

    await call('PUT', '/providers/openai/models', {
      thinkingMode: 'high',
      customHeaders: { 'X-Custom-Header': 'custom-val-99' },
    });

    const seenCalls: Array<{ url: string; headers: Record<string, string>; body?: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith(base)) {
        return nativeFetch(input, init);
      }
      const headersObj: Record<string, string> = {};
      if (init?.headers) {
        new Headers(init.headers).forEach((v, k) => {
          headersObj[k.toLowerCase()] = v;
        });
      }
      const parsedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      seenCalls.push({ url, headers: headersObj, body: parsedBody });

      if (url === 'https://api.openai.com/v1/models') {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'gpt-4.1-live', name: 'GPT 4.1 Live' },
              { id: 'o4-mini-live' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url === 'https://api.openai.com/v1/chat/completions') {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            created: 1700000000,
            model: 'o4-mini-live',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected upstream URL: ${url}`);
    });

    const fetchModelsRes = await call('POST', '/providers/openai/fetch-models', {});
    expect(fetchModelsRes.status).toBe(200);
    expect(fetchModelsRes.body.models).toEqual([
      { id: 'gpt-4.1-live', name: 'GPT 4.1 Live' },
      { id: 'o4-mini-live', name: 'o4-mini-live' },
    ]);
    expect(seenCalls[0]?.headers['x-custom-header']).toBe('custom-val-99');

    // Verify execution.ts forwards customHeaders and injects reasoning_effort from thinkingMode
    const row = accountRow(accountId);
    const providerInstance = resolveAccountProvider(row)!;
    expect(getProviderModelConfig('openai').thinkingMode).toBe('high');

    const completion = await providerInstance.chatCompletion(
      'ignored',
      [{ role: 'user', content: 'Solve this' }],
      'o4-mini-live',
    );
    expect(completion.choices[0]?.message.content).toBe('Hello!');
    const chatCall = seenCalls.find(c => c.url.endsWith('/chat/completions'))!;
    expect(chatCall.headers['x-custom-header']).toBe('custom-val-99');
    expect(chatCall.body?.reasoning_effort).toBe('high');
  });
});
