import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { invalidateConfigCache, setEnabled } from '../../custom/x-gateway/config.js';
import { invalidateXGatewayKeyCache } from '../../custom/provider-accounts/store.js';
import { parseSystemOneAnswers } from '../../custom/x-gateway/protocols.js';

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../../custom/provider-accounts/execution.js', async importOriginal => ({
  ...await importOriginal<object>(), resolveAccountProvider: () => ({ chatCompletion: complete }),
}));

let server: Server;
let base: string;
let session: string;
let apiKey: string;

function seedAccount(provider = 'xai', model = 'grok-4', label = 'main'): number {
  const secret = encrypt(`sk-test-${provider}`);
  const row = getDb().prepare(`INSERT INTO x_gateway_keys
    (provider, label, auth_method, encrypted_key, iv, auth_tag, base_url, models_json, status, enabled)
    VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?, 'healthy', 1)`)
    .run(provider, label, secret.encrypted, secret.iv, secret.authTag, `https://${provider}.example/v1`,
      JSON.stringify([{ id: model, name: model }]));
  invalidateXGatewayKeyCache();
  return Number(row.lastInsertRowid);
}

function seedRequest(r: {
  platform: string; model: string; requested?: string | null; status?: string; inTok?: number; outTok?: number;
  latency?: number; type?: string; caller?: string; keyId?: number | null; error?: string | null; createdAt?: string;
}): void {
  getDb().prepare(`INSERT INTO requests
    (platform, model_id, requested_model, key_id, status, input_tokens, output_tokens, latency_ms, error, caller, request_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.platform, r.model, r.requested ?? null, r.keyId ?? null, r.status ?? 'success', r.inTok ?? 0, r.outTok ?? 0,
      r.latency ?? 0, r.error ?? null, r.caller ?? 'x-gateway', r.type ?? 'chat',
      r.createdAt ?? new Date().toISOString().slice(0, 19).replace('T', ' '));
}

const details = (qs = '', token = session) =>
  fetch(`${base}/api/thruline/usage/request-details${qs ? `?${qs}` : ''}`, { headers: { Authorization: `Bearer ${token}` } });

const systemone = (body: unknown) =>
  fetch(`${base}/thruline/v1/systemone`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  await new Promise<void>(resolve => {
    server = createApp().listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
  initDb(':memory:');
  invalidateConfigCache();
  invalidateXGatewayKeyCache();
  const owner = createUser('agent3@example.com', 'Agent3TestPassword!');
  session = createSession(owner.userId);
  apiKey = mintUserApiKey(owner.userId, 'systemone tests').key;
  setEnabled(true);
  complete.mockReset();
});

describe('GET /api/thruline/usage/request-details', () => {
  it('requires authentication', async () => {
    expect((await fetch(`${base}/api/thruline/usage/request-details`)).status).toBe(401);
  });

  it('paginates newest first and reports totals', async () => {
    for (let i = 0; i < 25; i++) seedRequest({ platform: 'xai', model: `m${i}` });
    seedRequest({ platform: 'xai', model: 'other-caller', caller: 'http' });

    const first = await (await details('pageSize=10')).json() as any;
    expect(first).toMatchObject({ page: 1, pageSize: 10, totalCount: 25, totalPages: 3 });
    expect(first.details).toHaveLength(10);
    expect(first.details[0].modelId).toBe('m24');

    const last = await (await details('page=3&pageSize=10')).json() as any;
    expect(last.details).toHaveLength(5);
    expect(last.details[4].modelId).toBe('m0');

    const defaults = await (await details()).json() as any;
    expect(defaults).toMatchObject({ page: 1, pageSize: 20, totalPages: 2 });
  });

  it('rejects invalid pagination and filter values', async () => {
    for (const qs of ['page=0', 'page=abc', 'pageSize=0', 'pageSize=101', 'status=weird', 'startDate=nope', 'accountId=x']) {
      expect((await details(qs)).status, qs).toBe(400);
    }
  });

  it('filters by provider, model, status and exposes filter options', async () => {
    seedRequest({ platform: 'xai', model: 'grok-4', requested: 'auto' });
    seedRequest({ platform: 'xai', model: 'grok-3', status: 'error', error: 'boom' });
    seedRequest({ platform: 'groq', model: 'llama-70b', requested: 'fast-llama' });

    const byProvider = await (await details('provider=groq')).json() as any;
    expect(byProvider.details.map((d: any) => d.modelId)).toEqual(['llama-70b']);

    const byModelId = await (await details('model=grok')).json() as any;
    expect(byModelId.totalCount).toBe(2);
    const byRequested = await (await details('model=fast-')).json() as any;
    expect(byRequested.details.map((d: any) => d.provider)).toEqual(['groq']);

    const errors = await (await details('status=error')).json() as any;
    expect(errors.details).toHaveLength(1);
    expect(errors.details[0]).toMatchObject({ status: 'error', error: 'boom', modelId: 'grok-3' });

    expect(byProvider.filters.providers).toEqual(['groq', 'xai']);
    expect(byProvider.filters.models.sort()).toEqual(['grok-3', 'grok-4', 'llama-70b']);
  });

  it('filters by startDate / endDate (date-only end is inclusive)', async () => {
    seedRequest({ platform: 'xai', model: 'jan', createdAt: '2026-01-10 12:00:00' });
    seedRequest({ platform: 'xai', model: 'feb', createdAt: '2026-02-10 12:00:00' });
    seedRequest({ platform: 'xai', model: 'mar', createdAt: '2026-03-10 12:00:00' });

    const models = async (qs: string) => ((await (await details(qs)).json() as any).details.map((d: any) => d.modelId));
    expect(await models('startDate=2026-02-01&endDate=2026-02-28')).toEqual(['feb']);
    expect(await models('startDate=2026-02-10&endDate=2026-02-10')).toEqual(['feb']);
    expect(await models('startDate=2026-02-15T00:00:00Z')).toEqual(['mar']);
    expect(await models('endDate=2026-01-31')).toEqual(['jan']);
  });

  it('joins account label, filters by accountId and computes estimatedCost', async () => {
    const id = seedAccount('xai', 'grok-4', 'team-account');
    seedRequest({ platform: 'xai', model: 'grok-4', keyId: id, inTok: 1_000_000, outTok: 500_000, latency: 120, type: 'embedding' });
    seedRequest({ platform: 'xai', model: 'grok-4', keyId: null });

    const body = await (await details(`accountId=${id}`)).json() as any;
    expect(body.details).toHaveLength(1);
    const row = body.details[0];
    expect(row).toMatchObject({
      provider: 'xai', accountId: id, accountLabel: 'team-account', modelId: 'grok-4', requestType: 'embedding',
      endpoint: 'embeddings', inputTokens: 1_000_000, outputTokens: 500_000, cachedTokens: 0, reasoningTokens: 0,
      latencyMs: 120, status: 'success', error: null,
    });
    expect(typeof row.estimatedCost).toBe('number');
    expect(row.estimatedCost).toBeGreaterThan(0);
    expect(typeof row.createdAt).toBe('string');
  });
});

describe('POST /thruline/v1/systemone', () => {
  const valid = { model: 'auto', state: { stock: 3 }, questions: { reorder: 'Should we reorder?' } };

  it('requires authentication', async () => {
    const res = await fetch(`${base}/thruline/v1/systemone`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid),
    });
    expect(res.status).toBe(401);
  });

  it.each([
    ['model', { state: {}, questions: { a: 'q' } }],
    ['blank model', { model: '  ', state: {}, questions: { a: 'q' } }],
    ['state', { model: 'auto', questions: { a: 'q' } }],
    ['null state', { model: 'auto', state: null, questions: { a: 'q' } }],
    ['questions', { model: 'auto', state: {} }],
    ['empty questions', { model: 'auto', state: {}, questions: {} }],
    ['array questions', { model: 'auto', state: {}, questions: ['q'] }],
    ['bad question value', { model: 'auto', state: {}, questions: { a: 5 } }],
  ])('returns 400 for missing/invalid %s', async (_label, body) => {
    const res = await systemone(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.type).toBe('invalid_request_error');
    expect(complete).not.toHaveBeenCalled();
  });

  it('returns 503 when no account is available', async () => {
    expect((await systemone(valid)).status).toBe(503);
  });

  it('returns structured answers and passes state + questions to the model', async () => {
    seedAccount('xai', 'grok-4');
    complete.mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: '{"reorder":"yes","note":{"qty":10}}' } }],
      usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
    });

    const res = await systemone({
      model: 'auto', state: { stock: 3 }, questions: { reorder: 'Should we reorder?', note: { ask: 'how many' } },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toEqual({
      object: 'systemone.decision',
      model: 'grok-4',
      answers: { reorder: 'yes', note: { qty: 10 } },
      usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
    });

    const [, messages] = complete.mock.calls[0]!;
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('reorder, note');
    expect(messages[1].content).toContain('"stock": 3');
    expect(messages[1].content).toContain('Should we reorder?');
  });

  it('extracts JSON from a markdown code fence', async () => {
    seedAccount('xai', 'grok-4');
    complete.mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'Here you go:\n```json\n{"reorder": true}\n```' } }],
    });
    const res = await systemone(valid);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).answers).toEqual({ reorder: true });
  });

  it('returns 502 when the reply is not a JSON object', async () => {
    seedAccount('xai', 'grok-4');
    complete.mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'I cannot decide.' } }] });
    const res = await systemone(valid);
    expect(res.status).toBe(502);
    const log = getDb().prepare("SELECT status FROM requests WHERE caller = 'x-gateway'").all() as any[];
    expect(log.map(l => l.status)).toEqual(['error']);
  });

  it('logs successful calls so they appear in request details', async () => {
    seedAccount('xai', 'grok-4');
    complete.mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: '{"reorder":"no"}' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
    expect((await systemone(valid)).status).toBe(200);
    const body = await (await details()).json() as any;
    expect(body.totalCount).toBe(1);
    expect(body.details[0]).toMatchObject({ provider: 'xai', modelId: 'grok-4', inputTokens: 5, outputTokens: 2 });
  });
});

describe('parseSystemOneAnswers', () => {
  it('handles plain, fenced, prose-wrapped and invalid replies', () => {
    expect(parseSystemOneAnswers('{"a":1}')).toEqual({ a: 1 });
    expect(parseSystemOneAnswers('```\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseSystemOneAnswers('Answer: {"a":3} done')).toEqual({ a: 3 });
    expect(parseSystemOneAnswers('[1,2]')).toBeNull();
    expect(parseSystemOneAnswers('nope')).toBeNull();
  });
});
