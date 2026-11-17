import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { resetComboRotation, rotateComboEntries, type ComboEntry } from '../../custom/x-gateway/combos.js';
import { invalidateConfigCache } from '../../custom/x-gateway/config.js';
import {
  DEFAULT_ROUTING_DEFAULTS,
  effectiveProviderPolicy,
  getRoutingDefaults,
  normalizeRoutingDefaults,
  setRoutingDefaults,
  shouldRotateCombo,
} from '../../custom/x-gateway/routing-defaults.js';

process.env.ENCRYPTION_KEY = '0'.repeat(64);

const entries = (ids: string[]): ComboEntry[] => ids.map(id => ({ platform: 'groq', modelId: id }));
const ids = (list: ComboEntry[]) => list.map(e => e.modelId);

describe('routing defaults service', () => {
  beforeEach(() => { initDb(':memory:'); invalidateConfigCache(); resetComboRotation(); });

  it('defaults keep existing behaviour', () => {
    expect(getRoutingDefaults()).toEqual(DEFAULT_ROUTING_DEFAULTS);
    expect(shouldRotateCombo('fallback')).toBe(false);
    expect(shouldRotateCombo('round-robin')).toBe(true);
  });

  it('normalises garbage and clamps limits', () => {
    expect(normalizeRoutingDefaults({ accountStrategy: 'x', accountStickyLimit: 9999, comboStickyLimit: 0, comboRoundRobin: 'yes' }))
      .toEqual({ accountStrategy: 'fallback', accountStickyLimit: 100, comboRoundRobin: false, comboStickyLimit: 1 });
    expect(normalizeRoutingDefaults(null)).toEqual(DEFAULT_ROUTING_DEFAULTS);
  });

  it('persists patches and only rotates fallback combos when enabled', () => {
    const saved = setRoutingDefaults({ comboRoundRobin: true, comboStickyLimit: 4 });
    expect(saved).toMatchObject({ comboRoundRobin: true, comboStickyLimit: 4, accountStrategy: 'fallback' });
    expect(getRoutingDefaults()).toEqual(saved);
    expect(shouldRotateCombo('fallback')).toBe(true);
    expect(shouldRotateCombo('smart')).toBe(false);
    expect(shouldRotateCombo('fusion')).toBe(false);
  });

  it('explicit provider strategy wins over the global default', () => {
    setRoutingDefaults({ accountStrategy: 'round-robin', accountStickyLimit: 7 });
    const resolved = { strategy: 'fallback' as const, stickyLimit: 3 };
    expect(effectiveProviderPolicy('groq', resolved, {})).toEqual({ strategy: 'round-robin', stickyLimit: 7 });
    expect(effectiveProviderPolicy('groq', resolved, { groq: { strategy: 'fallback' } as never }))
      .toEqual({ strategy: 'fallback', stickyLimit: 3 });
  });
});

describe('sticky combo rotation', () => {
  beforeEach(() => resetComboRotation());

  it('limit 1 matches the legacy per-request rotation', () => {
    const order = entries(['a', 'b', 'c']);
    expect([1, 2, 3, 4].map(() => ids(rotateComboEntries('x', order, 1)))).toEqual([
      ['a', 'b', 'c'], ['b', 'c', 'a'], ['c', 'a', 'b'], ['a', 'b', 'c'],
    ]);
  });

  it('limit 2 serves each step twice before rotating', () => {
    const order = entries(['a', 'b']);
    const firsts = Array.from({ length: 6 }, () => rotateComboEntries('y', order, 2)[0]!.modelId);
    expect(firsts).toEqual(['a', 'a', 'b', 'b', 'a', 'a']);
  });
});

describe('GET/PUT /api/thruline/routing-defaults', () => {
  let server: Server; let base: string; let admin: string; let member: string;
  beforeAll(async () => {
    initDb(':memory:'); invalidateConfigCache();
    admin = createSession(createUser('rd-admin@example.test', 'AdminPass123!').userId);
    member = createSession(createUser('rd-member@example.test', 'MemberPass123!', 'member').userId);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server?.close(); });
  const call = (token: string, method = 'GET', body?: unknown) => fetch(`${base}/api/thruline/routing-defaults`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  it('reads defaults, updates, and validates', async () => {
    expect(await (await call(admin)).json()).toEqual(DEFAULT_ROUTING_DEFAULTS);
    const put = await call(admin, 'PUT', { accountStrategy: 'round-robin', comboStickyLimit: 5 });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ accountStrategy: 'round-robin', comboStickyLimit: 5, accountStickyLimit: 3 });
    expect((await call(admin, 'PUT', { comboStickyLimit: 0 })).status).toBe(400);
    expect((await call(admin, 'PUT', { nope: true })).status).toBe(400);
  });

  it('rejects unauthenticated and unprivileged writes', async () => {
    expect((await call('bad-token')).status).toBe(401);
    expect((await call(member, 'PUT', { comboRoundRobin: true })).status).toBeGreaterThanOrEqual(401);
  });
});
