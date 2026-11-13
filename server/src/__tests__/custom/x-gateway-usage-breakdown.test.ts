import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { invalidateConfigCache, setEnabled } from '../../custom/x-gateway/config.js';
import { invalidateXGatewayKeyCache } from '../../custom/provider-accounts/store.js';

let server: Server;
let base: string;
let session: string;
let ownerId: number;

function seedAccount(provider: string, opts: { enabled?: number; status?: string } = {}): number {
  const secret = encrypt(`sk-test-${provider}`);
  const row = getDb().prepare(`INSERT INTO x_gateway_keys
    (provider, label, auth_method, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?)`)
    .run(provider, `${provider}-acct`, secret.encrypted, secret.iv, secret.authTag, opts.status ?? 'healthy', opts.enabled ?? 1);
  invalidateXGatewayKeyCache();
  return Number(row.lastInsertRowid);
}

function seedRequest(r: {
  platform: string; model: string; status?: string; inTok?: number; outTok?: number; latency?: number;
  type?: string; caller?: string; userId?: number | null; createdAt?: string;
}): void {
  getDb().prepare(`INSERT INTO requests
    (platform, model_id, status, input_tokens, output_tokens, latency_ms, caller, request_type, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.platform, r.model, r.status ?? 'success', r.inTok ?? 0, r.outTok ?? 0, r.latency ?? 0,
      r.caller ?? 'x-gateway', r.type ?? 'chat', r.userId ?? null,
      r.createdAt ?? new Date().toISOString().slice(0, 19).replace('T', ' '));
}

function breakdown(range?: string, token = session) {
  return fetch(`${base}/api/thruline/usage/breakdown${range ? `?range=${range}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

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
  const owner = createUser('agent5@example.com', 'Agent5TestPassword!');
  ownerId = owner.userId;
  session = createSession(owner.userId);
  setEnabled(true);
});

describe('GET /api/thruline/usage/breakdown', () => {
  it('requires authentication and rejects an unknown range', async () => {
    const anon = await fetch(`${base}/api/thruline/usage/breakdown`);
    expect(anon.status).toBe(401);
    const bad = await breakdown('1y');
    expect(bad.status).toBe(400);
  });

  it('returns empty collections (with all endpoints) on a fresh install', async () => {
    const res = await breakdown();
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.range).toBe('7d');
    expect(body.topology).toEqual([]);
    expect(body.byModel).toEqual([]);
    expect(body.byAccount).toEqual([]);
    expect(body.byClientKey).toEqual([]);
    expect(body.byEndpoint.map((e: any) => e.endpoint)).toEqual([
      'chat/completions', 'messages', 'responses', 'embeddings', 'images', 'audio', 'search', 'fetch',
    ]);
  });

  it('builds topology with status, success rate, latency and tokens', async () => {
    const a1 = seedAccount('xai');
    seedAccount('xai');
    seedAccount('groq', { enabled: 0 });
    seedAccount('mistral', { status: 'error' });
    getDb().prepare('INSERT INTO x_gateway_key_monthly_usage (key_id, month, requests, tokens) VALUES (?, ?, 7, 700)')
      .run(a1, new Date().toISOString().slice(0, 7));
    seedRequest({ platform: 'xai', model: 'grok-4', inTok: 100, outTok: 50, latency: 200 });
    seedRequest({ platform: 'xai', model: 'grok-4', inTok: 10, outTok: 5, latency: 400 });
    seedRequest({ platform: 'xai', model: 'grok-4', status: 'error', latency: 300 });
    seedRequest({ platform: 'xai', model: 'grok-4', caller: 'http', inTok: 9999 }); // not x-gateway

    const body = await (await breakdown('24h')).json() as any;
    const byId = Object.fromEntries(body.topology.map((t: any) => [t.provider, t]));
    expect(Object.keys(byId).sort()).toEqual(['groq', 'mistral', 'xai']);

    expect(byId.xai.status).toBe('healthy');
    expect(byId.xai.totalAccounts).toBe(2);
    expect(byId.xai.activeAccounts).toBe(2);
    expect(byId.xai.requests).toBe(3);
    expect(byId.xai.promptTokens).toBe(110);
    expect(byId.xai.completionTokens).toBe(55);
    expect(byId.xai.totalTokens).toBe(165);
    expect(byId.xai.successRate).toBe(66.7);
    expect(byId.xai.avgLatencyMs).toBe(300);
    expect(byId.xai.monthlyRequests).toBe(7);
    expect(byId.groq.status).toBe('paused');
    expect(byId.mistral.status).toBe('degraded');
  });

  it('marks a provider as cooldown when every usable account is cooling down', async () => {
    const id = seedAccount('cerebras');
    getDb().prepare(`INSERT INTO rate_limit_cooldowns (platform, model_id, key_id, expires_at_ms, source)
      VALUES ('cerebras', 'm', ?, ?, 'rate_limit')`).run(id, Date.now() + 60_000);
    const body = await (await breakdown()).json() as any;
    expect(body.topology[0].status).toBe('cooldown');
    expect(body.byAccount[0].coolingDown).toBe(true);
  });

  it('groups by model with errors and estimated cost', async () => {
    seedRequest({ platform: 'xai', model: 'grok-4', inTok: 1000, outTok: 500, latency: 100 });
    seedRequest({ platform: 'xai', model: 'grok-4', status: 'error', latency: 300 });
    seedRequest({ platform: 'groq', model: 'llama', inTok: 5, outTok: 5, latency: 50 });
    const body = await (await breakdown('all')).json() as any;
    expect(body.byModel).toHaveLength(2);
    const grok = body.byModel.find((m: any) => m.model === 'grok-4');
    expect(grok).toMatchObject({
      provider: 'xai', requests: 2, errorCount: 1, promptTokens: 1000, completionTokens: 500,
      totalTokens: 1500, avgLatencyMs: 200,
    });
    expect(typeof grok.estimatedCostUsd).toBe('number');
    expect(grok.estimatedCostUsd).toBeGreaterThanOrEqual(0);
  });

  it('honours the time range', async () => {
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
    seedRequest({ platform: 'xai', model: 'grok-4', inTok: 1 });
    seedRequest({ platform: 'xai', model: 'grok-4', inTok: 1, createdAt: old });
    const total = async (range: string) =>
      ((await (await breakdown(range)).json() as any).byModel[0]?.requests ?? 0) as number;
    expect(await total('24h')).toBe(1);
    expect(await total('7d')).toBe(1);
    expect(await total('30d')).toBe(2);
    expect(await total('all')).toBe(2);
  });

  it('reports per-account monthly usage', async () => {
    const id = seedAccount('xai');
    getDb().prepare('INSERT INTO x_gateway_key_monthly_usage (key_id, month, requests, tokens) VALUES (?, ?, 3, 90)')
      .run(id, new Date().toISOString().slice(0, 7));
    const body = await (await breakdown()).json() as any;
    expect(body.byAccount).toHaveLength(1);
    expect(body.byAccount[0]).toMatchObject({ id, provider: 'xai', monthlyRequests: 3, monthlyTokens: 90, enabled: true });
  });

  it('attributes usage to client API keys through their owner', async () => {
    const other = createUser('other@example.com', 'OtherPassword123!', 'member').userId;
    const insertKey = getDb().prepare(
      'INSERT INTO x_gateway_client_keys (user_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?)');
    const k1 = Number(insertKey.run(ownerId, 'ci', 'h1', 'xk-aaaa').lastInsertRowid);
    insertKey.run(other, 'idle', 'h2', 'xk-bbbb');
    seedRequest({ platform: 'xai', model: 'grok-4', inTok: 10, outTok: 20, latency: 80, userId: ownerId });
    seedRequest({ platform: 'xai', model: 'grok-4', status: 'error', userId: ownerId });

    const body = await (await breakdown()).json() as any;
    expect(body.byClientKey).toHaveLength(2);
    const ci = body.byClientKey.find((k: any) => k.id === k1);
    expect(ci).toMatchObject({ name: 'ci', requests: 2, errorCount: 1, totalTokens: 30, sharedOwner: false });
    expect(JSON.stringify(body.byClientKey)).not.toContain('h1');
    const idle = body.byClientKey.find((k: any) => k.name === 'idle');
    expect(idle.requests).toBe(0);
  });

  it('classifies requests into endpoints', async () => {
    seedRequest({ platform: 'xai', model: 'a', type: 'chat', latency: 10 });
    seedRequest({ platform: 'xai', model: 'a', type: 'chat', latency: 30 });
    seedRequest({ platform: 'xai', model: 'e', type: 'embedding' });
    seedRequest({ platform: 'xai', model: 'i', type: 'image' });
    seedRequest({ platform: 'xai', model: 'u', type: 'transcription' });
    seedRequest({ platform: 'xai', model: 's', type: 'search' });
    const body = await (await breakdown()).json() as any;
    const ep = Object.fromEntries(body.byEndpoint.map((e: any) => [e.endpoint, e]));
    expect(ep['chat/completions']).toMatchObject({ requests: 2, avgLatencyMs: 20 });
    expect(ep.embeddings.requests).toBe(1);
    expect(ep.images.requests).toBe(1);
    expect(ep.audio.requests).toBe(1);
    expect(ep.search.requests).toBe(1);
    expect(ep.fetch.requests).toBe(0);
    expect(ep.messages.requests).toBe(0);
    expect(ep.responses.requests).toBe(0);
  });
});
