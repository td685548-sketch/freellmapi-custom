import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import { initDb, getDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { setAnalyticsMemoTtlForTest } from '../../custom/analytics-memo.js';
import { logRequest } from '../../lib/request-log.js';

describe('analytics memo', () => {
  let server: Server;
  let base: string;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    tokens.admin = createSession(createUser('admin@example.com', 'AdminPass123!').userId);
    const reader = createUser('reader@example.com', 'MemberPass123!', 'member');
    getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(['view_logs']), reader.userId);
    tokens.reader = createSession(reader.userId);
    const nobody = createUser('nobody@example.com', 'MemberPass123!', 'member');
    getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify([]), nobody.userId);
    tokens.nobody = createSession(nobody.userId);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); });
  afterEach(() => setAnalyticsMemoTtlForTest(null));

  const get = async (path: string, who?: string) => {
    const res = await fetch(base + path, { headers: who ? { Authorization: `Bearer ${tokens[who]}` } : {} });
    return { status: res.status, cache: res.headers.get('x-analytics-cache'), body: res.status === 200 ? await res.json() as Record<string, unknown> : null };
  };

  it('is off by default under test, so existing suites read their own writes', async () => {
    const first = await get('/api/analytics/summary?range=7d', 'admin');
    const second = await get('/api/analytics/summary?range=7d', 'admin');
    expect(first.cache).toBeNull();
    expect(second.cache).toBeNull();
  });

  it('answers a repeat of the same question from the copy, whichever order the parameters come in', async () => {
    setAnalyticsMemoTtlForTest(60_000);
    const first = await get('/api/analytics/timeline?range=7d&granularity=hour', 'admin');
    const again = await get('/api/analytics/timeline?granularity=hour&range=7d', 'admin');
    expect(first.status).toBe(200);
    expect(first.cache).toBe('miss');
    expect(again.cache).toBe('hit');
    expect(again.body).toEqual(first.body);
  });

  it('keeps different questions apart', async () => {
    setAnalyticsMemoTtlForTest(60_000);
    expect((await get('/api/analytics/summary?range=7d', 'admin')).cache).toBe('miss');
    expect((await get('/api/analytics/summary?range=30d', 'admin')).cache).toBe('miss');
    expect((await get('/api/analytics/summary?range=7d', 'admin')).cache).toBe('hit');
  });

  it('never lets a cached answer open the gates', async () => {
    setAnalyticsMemoTtlForTest(60_000);
    expect((await get('/api/analytics/summary?range=7d', 'admin')).cache).toBe('miss');
    expect((await get('/api/analytics/summary?range=7d', 'admin')).cache).toBe('hit');
    // Signed out, and signed in without the permission: refused, with the copy sitting right there.
    expect((await get('/api/analytics/summary?range=7d')).status).toBe(401);
    expect((await get('/api/analytics/summary?range=7d', 'nobody')).status).toBe(403);
    // An account that is allowed to read gets the shared answer.
    const reader = await get('/api/analytics/summary?range=7d', 'reader');
    expect(reader.status).toBe(200);
    expect(reader.cache).toBe('hit');
  });

  it('serves a copy for at most the configured time, then recomputes from the ledger', async () => {
    setAnalyticsMemoTtlForTest(120);
    const before = await get('/api/analytics/by-platform?range=7d', 'admin');
    expect(before.body).toEqual([]);
    logRequest('groq', 'm1', null, 'success', 10, 5, 100, null);
    const stale = await get('/api/analytics/by-platform?range=7d', 'admin');
    expect(stale.cache).toBe('hit');
    expect(stale.body).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 160));
    const fresh = await get('/api/analytics/by-platform?range=7d', 'admin');
    expect(fresh.cache).toBe('miss');
    expect((fresh.body as unknown[]).length).toBe(1);
  });

  it('leaves the live request list and unknown paths alone', async () => {
    setAnalyticsMemoTtlForTest(60_000);
    expect((await get('/api/analytics/requests?limit=5', 'admin')).cache).toBeNull();
    expect((await get('/api/analytics/requests?limit=5', 'admin')).cache).toBeNull();
    // A different letter case is routed the same but is simply not memoised.
    expect((await get('/api/analytics/Summary?range=7d', 'admin')).cache).toBeNull();
  });
});
