import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { getDb, initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';

// The summary used to run one statement per metric over the same `requests`
// window. It now shares a scan; this compares it with those original statements
// on mixed data so the numbers cannot drift.

describe('GET /api/analytics/summary (shared raw scan)', () => {
  let server: Server;
  let base: string;
  let token: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    token = createSession(createUser('summary@example.com', 'Password123!').userId);
    const db = getDb();
    const insert = db.prepare(`INSERT INTO requests
      (platform, model_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms, requested_model, request_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`);
    for (let i = 0; i < 137; i++) {
      insert.run(
        i % 3 === 0 ? 'groq' : 'google', i % 2 ? 'm-a' : 'm-b',
        i % 11 === 0 ? 'error' : 'success', 10 + i, 5 + i, (i * 37) % 900 + 1,
        i % 4 === 0 ? null : (i * 13) % 300,
        i % 5 === 0 ? 'm-a' : i % 7 === 0 ? 'other' : null,
        i % 6 === 0 ? 'embedding' : 'chat',
        `-${i < 100 ? i % 20 : i < 120 ? 30 + i : 200 + i} hours`, // inside 24h, inside 7d, outside 7d
      );
    }
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server?.close(); });

  const summary = async (range: string) =>
    (await (await fetch(`${base}/api/analytics/summary?range=${range}`, { headers: { Authorization: `Bearer ${token}` } })).json()) as Record<string, any>;

  // The statements the route used before sharing a scan.
  function reference(since: string) {
    const db = getDb();
    const avg = (db.prepare('SELECT AVG(latency_ms) AS v FROM requests WHERE created_at >= ?').get(since) as any).v;
    const pins = db.prepare(`SELECT SUM(CASE WHEN requested_model IS NOT NULL THEN 1 ELSE 0 END) AS a,
      SUM(CASE WHEN requested_model = model_id THEN 1 ELSE 0 END) AS b FROM requests WHERE created_at >= ?`).get(since) as any;
    const count = (db.prepare('SELECT COUNT(*) AS c FROM requests WHERE created_at >= ? AND latency_ms IS NOT NULL').get(since) as any).c as number;
    const at = (f: number) => (db.prepare(`SELECT latency_ms FROM requests WHERE created_at >= ? AND latency_ms IS NOT NULL
      ORDER BY latency_ms ASC LIMIT 1 OFFSET ?`).get(since, Math.floor((count - 1) * f)) as any).latency_ms as number;
    const ttfb = (db.prepare('SELECT AVG(ttfb_ms) AS v FROM requests WHERE created_at >= ? AND ttfb_ms IS NOT NULL').get(since) as any).v;
    const types = db.prepare('SELECT request_type, COUNT(*) AS count FROM requests WHERE created_at >= ? GROUP BY request_type').all(since) as any[];
    const t = { chat: 0, embedding: 0 };
    for (const r of types) if (r.request_type === 'embedding') t.embedding = r.count; else if (r.request_type === 'chat') t.chat = r.count;
    return {
      avgLatencyMs: Math.round(avg ?? 0), p50LatencyMs: count ? Math.round(at(0.5)) : null, p95LatencyMs: count ? Math.round(at(0.95)) : null,
      avgTtfbMs: ttfb != null ? Math.round(ttfb) : null, requestTypeCounts: t,
      pinnedRequests: pins.a ?? 0, pinHonoredRequests: pins.b ?? 0,
    };
  }

  it('matches the per-metric statements for every range', async () => {
    for (const [range, hours] of [['24h', 24], ['7d', 168], ['30d', 720], ['all', 100000]] as const) {
      const body = await summary(range);
      const since = (getDb().prepare("SELECT datetime('now', ?) AS s").get(`-${hours} hours`) as any).s as string;
      const expected = reference(range === 'all' ? '1970-01-01 00:00:00' : since);
      for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
        expect(body[key], `${range}.${key}`).toEqual(expected[key]);
      }
    }
  });

  it('reports nulls, not zeros, for an empty window', async () => {
    getDb().prepare('DELETE FROM requests').run();
    const body = await summary('24h');
    expect(body.p50LatencyMs).toBeNull();
    expect(body.p95LatencyMs).toBeNull();
    expect(body.avgTtfbMs).toBeNull();
    expect(body.requestTypeCounts).toEqual({ chat: 0, embedding: 0 });
    expect(body.pinnedRequests).toBe(0);
  });
});
