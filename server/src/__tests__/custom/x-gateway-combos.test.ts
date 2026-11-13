import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import {
  buildComboPresets,
  normalizeConfidenceThreshold,
  resetComboRotation,
  resolveComboPolicy,
  rotateComboEntries,
  validateCombo,
  validateComboMeta,
  type ComboEntry,
} from '../../custom/x-gateway/combos.js';
import {
  createCombo,
  getComboByName,
  invalidateConfigCache,
  listCombos,
  setEnabled,
  updateCombo,
} from '../../custom/x-gateway/config.js';
import {
  pickFusionCandidates,
  recordRouteOutcome,
  resetRouteHealth,
  resolveCandidateRoutes,
  sortCandidatesByHealth,
} from '../../custom/x-gateway/router.js';
import { invalidateXGatewayKeyCache } from '../../custom/provider-accounts/store.js';

process.env.ENCRYPTION_KEY = '0'.repeat(64);

// The encryption key only exists after initDb(), so encrypt lazily.
let secret: { encrypted: string; iv: string; authTag: string } | null = null;

function seedAccount(provider: string, modelId: string): number {
  secret ??= encrypt('sk-combo-test');
  const info = getDb().prepare(`INSERT INTO x_gateway_keys
    (provider,label,auth_method,encrypted_key,iv,auth_tag,models_json,status,enabled)
    VALUES (?,?,?,?,?,?,?,'healthy',1)`)
    .run(provider, `${provider} account`, 'api_key', secret.encrypted, secret.iv, secret.authTag,
      JSON.stringify([{ id: modelId, name: modelId }]));
  invalidateXGatewayKeyCache();
  return Number(info.lastInsertRowid);
}

describe('combo strategy metadata and validation', () => {
  it('accepts the four strategies and rejects anything else', () => {
    for (const strategy of ['fallback', 'round-robin', 'smart', 'fusion'] as const) {
      expect(validateComboMeta(strategy, 'summary')).toBeNull();
    }
    expect(validateComboMeta('fastest', undefined)).toMatch(/fallback, round-robin, smart, fusion/);
    expect(validateComboMeta(undefined, 'x'.repeat(201))).toMatch(/200/);
    expect(validateCombo('meta-combo', [{ platform: 'groq', modelId: 'm' }], { strategy: 'fastest' as never }))
      .toEqual({ valid: false, error: 'Strategy must be one of: fallback, round-robin, smart, fusion' });
  });

  it('persists strategy and description, and still reads legacy bare-array rows', () => {
    initDb(':memory:');
    invalidateConfigCache();

    const created = createCombo('smart-box', [{ platform: 'groq', modelId: 'm1' }], undefined, {
      strategy: 'smart',
      description: '  routed by latency  ',
      smartPolicy: 'custom',
      sessionSticky: true,
      confidenceThreshold: 0.65,
    });
    expect(created.strategy).toBe('smart');
    expect(created.description).toBe('routed by latency');
    expect(created).toMatchObject({ smartPolicy: 'custom', sessionSticky: true, confidenceThreshold: 0.65 });
    expect(listCombos().find(c => c.id === created.id)).toMatchObject({
      strategy: 'smart',
      description: 'routed by latency',
      smartPolicy: 'custom',
      sessionSticky: true,
      confidenceThreshold: 0.65,
    });

    const updated = updateCombo(created.id, 'smart-box', [{ platform: 'groq', modelId: 'm2' }], {
      strategy: 'smart',
      description: '',
      smartPolicy: 'strict',
      confidenceThreshold: 0.9,
    });
    expect(updated).toMatchObject({
      strategy: 'smart',
      smartPolicy: 'strict',
      confidenceThreshold: 0.9,
    });
    expect(updated?.sessionSticky).toBeUndefined();
    expect(updated?.description).toBeUndefined();
    expect(updated?.entries).toEqual([{ platform: 'groq', modelId: 'm2' }]);

    // Rows written before this feature are bare arrays; they default to fallback.
    getDb().prepare('UPDATE x_gateway_combos SET entries_json = ? WHERE id = ?')
      .run(JSON.stringify([{ platform: 'groq', modelId: 'legacy' }]), created.id);
    invalidateConfigCache();
    expect(listCombos().find(c => c.id === created.id)).toMatchObject({
      strategy: 'fallback',
      entries: [{ platform: 'groq', modelId: 'legacy' }],
    });
  });

  it('validates and resolves smart router policies', () => {
    expect(validateComboMeta('smart', undefined, {
      smartPolicy: 'strict',
      sessionSticky: true,
      confidenceThreshold: 0.6,
    })).toBeNull();
    expect(validateComboMeta('smart', undefined, { smartPolicy: 'always' as never })).toMatch(/Smart policy/);
    expect(validateComboMeta('smart', undefined, { sessionSticky: 'yes' as never })).toMatch(/sessionSticky/);
    expect(validateComboMeta('smart', undefined, { confidenceThreshold: 1.5 })).toMatch(/between 0 and 1/);
    expect(validateCombo('policy-combo', [{ platform: 'groq', modelId: 'm' }], {
      strategy: 'smart',
      smartPolicy: 'custom',
      confidenceThreshold: 2,
    })).toEqual({ valid: false, error: 'confidenceThreshold must be a number between 0 and 1' });

    expect(resolveComboPolicy()).toEqual({ smartPolicy: 'smart', sessionSticky: true, confidenceThreshold: 0.8 });
    expect(resolveComboPolicy({ smartPolicy: 'per-turn' })).toEqual({
      smartPolicy: 'per-turn',
      sessionSticky: false,
      confidenceThreshold: 0.8,
    });
    expect(resolveComboPolicy({ smartPolicy: 'custom', sessionSticky: false, confidenceThreshold: 0.55 })).toEqual({
      smartPolicy: 'custom',
      sessionSticky: false,
      confidenceThreshold: 0.55,
    });
    expect(normalizeConfidenceThreshold(4)).toBe(1);
    expect(normalizeConfidenceThreshold(-1)).toBe(0);
    expect(normalizeConfidenceThreshold('nope', 0.7)).toBe(0.7);
  });
});

describe('round robin, smart ordering and fusion', () => {
  const entries = (ids: string[]): ComboEntry[] => ids.map(id => ({ platform: 'groq', modelId: id }));

  beforeEach(() => {
    initDb(':memory:');
    invalidateConfigCache();
    resetComboRotation();
    resetRouteHealth();
  });

  it('rotates the starting step and resets on demand', () => {
    const order = entries(['a', 'b', 'c']);
    expect(rotateComboEntries('spin', order).map(e => e.modelId)).toEqual(['a', 'b', 'c']);
    expect(rotateComboEntries('spin', order).map(e => e.modelId)).toEqual(['b', 'c', 'a']);
    expect(rotateComboEntries('spin', order).map(e => e.modelId)).toEqual(['c', 'a', 'b']);
    resetComboRotation('spin');
    expect(rotateComboEntries('spin', order).map(e => e.modelId)).toEqual(['a', 'b', 'c']);
    expect(rotateComboEntries('single', entries(['only']))).toEqual(entries(['only']));
  });

  it('routes combos by round robin and smart health', () => {
    const slow = seedAccount('groq', 'llama-3.3-70b-versatile');
    const fast = seedAccount('openai', 'gpt-5.4-mini');
    createCombo('rr', [
      { platform: 'groq', modelId: 'llama-3.3-70b-versatile' },
      { platform: 'openai', modelId: 'gpt-5.4-mini' },
    ], undefined, { strategy: 'round-robin' });

    const first = resolveCandidateRoutes('combo:rr');
    expect(first.combo).toMatchObject({ name: 'rr', strategy: 'round-robin' });
    expect(first.combo?.smartPolicy).toBe('smart');
    expect(first.combo?.sessionSticky).toBe(true);
    expect(first.combo?.confidenceThreshold).toBe(0.8);
    expect(first.candidates.map(c => c.account.id)).toEqual([slow, fast]);
    expect(first.candidates.map(c => c.step)).toEqual([0, 1]);
    expect(resolveCandidateRoutes('combo:rr').candidates.map(c => c.account.id)).toEqual([fast, slow]);

    recordRouteOutcome(`${slow}:llama-3.3-70b-versatile`, { error: true });
    recordRouteOutcome(`${fast}:gpt-5.4-mini`, { latencyMs: 150 });
    createCombo('smart-order', [
      { platform: 'groq', modelId: 'llama-3.3-70b-versatile' },
      { platform: 'openai', modelId: 'gpt-5.4-mini' },
    ], undefined, { strategy: 'smart' });
    expect(resolveCandidateRoutes('combo:smart-order').candidates.map(c => c.account.id)).toEqual([fast, slow]);
  });

  it('keeps step order when health is unknown and ranks healthy routes first', () => {
    const candidates = [
      { account: { id: 1 }, modelId: 'm' },
      { account: { id: 2 }, modelId: 'm' },
      { account: { id: 3 }, modelId: 'm' },
    ];
    expect(sortCandidatesByHealth(candidates).map(c => c.account.id)).toEqual([1, 2, 3]);
    recordRouteOutcome('3:m', { error: true });
    recordRouteOutcome('2:m', { latencyMs: 80 });
    expect(sortCandidatesByHealth(candidates).map(c => c.account.id)).toEqual([2, 1, 3]);
  });

  it('picks at most two distinct combo steps for fusion', () => {
    expect(pickFusionCandidates([{ step: 0 }, { step: 0 }, { step: 1 }, { step: 2 }])).toHaveLength(2);
    expect(pickFusionCandidates([{ step: 0 }, { step: 0 }])).toHaveLength(1);
    expect(pickFusionCandidates([{ step: 0 }, { step: 1 }]).map(c => c.step)).toEqual([0, 1]);
  });
});

describe('preset combos', () => {
  it('builds only the presets that the connected models can serve', () => {
    const presets = buildComboPresets([
      { platform: 'anthropic', modelId: 'claude-sonnet-4-20250514' },
      { platform: 'openai', modelId: 'gpt-5.4-mini' },
      { platform: 'groq', modelId: 'llama-3.3-70b-versatile' },
      { platform: 'ollama', modelId: 'qwen3.5', free: true },
      { platform: 'fal-ai', modelId: 'flux-dev' },
      { platform: 'openai', modelId: 'gpt-5.4-mini' },
    ]);
    const byName = new Map(presets.map(preset => [preset.name, preset]));

    expect(byName.get('coding-flagship')).toMatchObject({ strategy: 'fallback' });
    expect(byName.get('coding-flagship')?.entries[0]).toEqual({ platform: 'anthropic', modelId: 'claude-sonnet-4-20250514' });
    expect(byName.get('fast-autocomplete')?.strategy).toBe('round-robin');
    expect(byName.get('fast-autocomplete')?.entries[0]).toEqual({ platform: 'openai', modelId: 'gpt-5.4-mini' });
    expect(byName.get('free-fallback')?.entries).toEqual([{ platform: 'ollama', modelId: 'qwen3.5' }]);
    // No reasoning model was connected, so that preset is omitted rather than invented.
    expect(byName.has('reasoning-deep')).toBe(false);
    // Image models never leak into chat presets.
    expect(presets.some(preset => preset.entries.some(entry => entry.modelId === 'flux-dev'))).toBe(false);
  });
});

describe('combo presets and fusion over HTTP', () => {
  let server: Server;
  let base: string;
  let admin: string;
  let denied: string;
  let apiKey: string;
  const realFetch = global.fetch;
  const upstream = vi.fn();

  beforeAll(async () => {
    initDb(':memory:');
    invalidateConfigCache();

    const owner = createUser('combo-admin@example.test', 'AdminPass123!');
    admin = createSession(owner.userId);
    apiKey = mintUserApiKey(owner.userId, 'combo fusion test').key;
    denied = createSession(createUser('combo-denied@example.test', 'MemberPass123!', 'member').userId);

    seedAccount('anthropic', 'claude-sonnet-4-20250514');
    seedAccount('openai', 'gpt-5.4-mini');
    seedAccount('groq', 'llama-3.3-70b-versatile');
    seedAccount('ollama', 'qwen3.5');

    createCombo('coding-flagship', [{ platform: 'groq', modelId: 'llama-3.3-70b-versatile' }], undefined, {
      strategy: 'fallback',
      description: 'hand-written combo',
    });

    setEnabled(true);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    vi.spyOn(global, 'fetch').mockImplementation((url, init) =>
      String(url).startsWith(base) ? realFetch(url, init) : upstream(url, init));
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
  });

  const call = (path: string, token = admin, method = 'GET', body?: unknown) => fetch(`${base}/api/x-gateway${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  it('creates missing presets without overwriting existing combos', async () => {
    const res = await call('/combos/presets', admin, 'POST', {});
    expect(res.status).toBe(200);
    const body = await res.json() as {
      created: Array<{ name: string; strategy: string }>;
      skipped: Array<{ name: string; reason: string }>;
      createdCount: number;
      skippedCount: number;
    };

    expect(body.skipped).toEqual(expect.arrayContaining([
      { name: 'coding-flagship', reason: 'exists' },
      { name: 'reasoning-deep', reason: 'no_models' },
    ]));
    expect(body.created.map(combo => combo.name).sort()).toEqual(['fast-autocomplete', 'free-fallback']);
    expect(body.createdCount).toBe(2);

    expect(getComboByName('coding-flagship')).toMatchObject({
      description: 'hand-written combo',
      entries: [{ platform: 'groq', modelId: 'llama-3.3-70b-versatile' }],
    });
    expect(getComboByName('fast-autocomplete')?.strategy).toBe('round-robin');
    expect(getComboByName('free-fallback')?.entries).toEqual([{ platform: 'ollama', modelId: 'qwen3.5' }]);

    // A second run only reports skips.
    const again = await (await call('/combos/presets', admin, 'POST', {})).json() as { createdCount: number };
    expect(again.createdCount).toBe(0);
  });

  it('requires edit_x_combos to generate presets', async () => {
    const res = await call('/combos/presets', denied, 'POST', {});
    expect(res.status).toBe(403);
  });

  it('rejects an unknown strategy on create and update', async () => {
    const created = await call('/combos', admin, 'POST', {
      name: 'bad-strategy',
      entries: [{ platform: 'groq', modelId: 'llama-3.3-70b-versatile' }],
      strategy: 'fastest',
    });
    expect(created.status).toBe(400);

    const ok = await call('/combos', admin, 'POST', {
      name: 'ok-strategy',
      entries: [{ platform: 'groq', modelId: 'llama-3.3-70b-versatile' }],
      strategy: 'smart',
      smartPolicy: 'strict',
      sessionSticky: true,
      confidenceThreshold: 0.6,
      description: 'from the API',
    });
    expect(ok.status).toBe(201);
    const combo = await ok.json() as {
      id: number;
      strategy: string;
      smartPolicy?: string;
      sessionSticky?: boolean;
      confidenceThreshold?: number;
    };
    expect(combo).toMatchObject({
      strategy: 'smart',
      smartPolicy: 'strict',
      sessionSticky: true,
      confidenceThreshold: 0.6,
    });

    const badPolicy = await call('/combos', admin, 'POST', {
      name: 'bad-policy',
      entries: [{ platform: 'groq', modelId: 'llama-3.3-70b-versatile' }],
      strategy: 'smart',
      smartPolicy: 'always',
    });
    expect(badPolicy.status).toBe(400);

    const badThreshold = await call('/combos', admin, 'POST', {
      name: 'bad-threshold',
      entries: [{ platform: 'groq', modelId: 'llama-3.3-70b-versatile' }],
      strategy: 'smart',
      confidenceThreshold: 1.5,
    });
    expect(badThreshold.status).toBe(400);

    const updated = await call(`/combos/${combo.id}`, admin, 'PUT', {
      name: 'ok-strategy',
      entries: [{ platform: 'groq', modelId: 'llama-3.3-70b-versatile' }],
      strategy: 'smart',
      smartPolicy: 'custom',
      sessionSticky: false,
      confidenceThreshold: 0.55,
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      strategy: 'smart',
      smartPolicy: 'custom',
      sessionSticky: false,
      confidenceThreshold: 0.55,
    });
  });

  it('races the first two steps of a fusion combo and returns the fastest success', async () => {
    const glow = seedAccount('groq', 'slow-model');
    const fast = seedAccount('openai', 'fast-model');
    createCombo('race', [
      { platform: 'groq', modelId: 'slow-model' },
      { platform: 'openai', modelId: 'fast-model' },
    ], undefined, { strategy: 'fusion' });

    const seen: string[] = [];
    upstream.mockImplementation(async (_url, init) => {
      const model = JSON.parse(String(init?.body)).model as string;
      seen.push(model);
      if (model === 'slow-model') {
        await new Promise(resolve => setTimeout(resolve, 80));
        return new Response('{"error":{"message":"slow provider down"}}', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        id: 'fusion-winner',
        object: 'chat.completion',
        created: 1,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'fast answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }), { headers: { 'content-type': 'application/json' } });
    });

    const res = await fetch(`${base}/thruline/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'combo:race', messages: [{ role: 'user', content: 'Hello' }] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-combo-strategy')).toBe('fusion');
    expect(res.headers.get('x-routed-via')).toBe('openai/fast-model');
    expect(await res.json()).toMatchObject({ choices: [{ message: { content: 'fast answer' } }] });
    expect(seen.sort()).toEqual(['fast-model', 'slow-model']);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM requests WHERE caller = 'x-gateway' AND status = 'success'").get())
      .toMatchObject({ n: 1 });
    expect(glow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(0);
  });
});
