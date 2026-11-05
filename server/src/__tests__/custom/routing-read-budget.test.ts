import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { defaultDbFactory, getDb, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { getActiveProfileId } from '../../services/profile-models.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';

// On a remote database every statement is a blocking round trip, so the number
// of statements a dashboard poll makes is its latency. This pins the budget for
// GET /api/fallback/routing and checks the pieces that shrank it.

describe('routing read budget on a remote-style connection', () => {
  const executed: string[] = [];
  let counting = false;
  let server: Server;
  let base: string;
  let token: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_READ_CACHE', '0'); // measure real executions, not cache hits
    // Production keeps the usable-key registry in memory; NODE_ENV=test bypasses it,
    // which would count a read no deployed server makes.
    setKeyCacheTestOverride(true);
    const factory = () => {
      const raw = defaultDbFactory()(':memory:');
      const prepare = raw.prepare.bind(raw);
      raw.prepare = (sql: string) => {
        const stmt = prepare(sql);
        const count = <T>(run: () => T): T => { if (counting) executed.push(sql.replace(/\s+/g, ' ').trim()); return run(); };
        return {
          get: (...a: unknown[]) => count(() => stmt.get(...a)),
          all: (...a: unknown[]) => count(() => stmt.all(...a)),
          run: (...a: unknown[]) => count(() => stmt.run(...a)),
        };
      };
      return wrapTursoDatabase(raw, true);
    };
    initDb(':memory:', { factory });
    token = createSession(createUser('budget@example.com', 'Password123!').userId);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server?.close(); vi.unstubAllEnvs(); setKeyCacheTestOverride(null); });

  const get = (path: string) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });

  it('validates the dashboard session once per request, not once per gate', async () => {
    await get('/api/fallback/routing');
    executed.length = 0; counting = true;
    expect((await get('/api/fallback/routing')).status).toBe(200);
    counting = false;
    expect(executed.filter(s => /FROM sessions/.test(s))).toHaveLength(1);
  });

  it('keeps GET /api/fallback/routing within its statement budget', async () => {
    await get('/api/fallback/routing');
    executed.length = 0; counting = true;
    await get('/api/fallback/routing');
    counting = false;
    // 7 before this change (production caches on): session, settings prefetch,
    // profile, chain, then three for decision status. Raise only with a measured reason.
    expect(executed.length).toBeLessThanOrEqual(5);
    expect(executed.filter(s => /routing_cooldown_ceiling_ms|WHERE key = \?/.test(s) && /settings/.test(s)).length).toBeLessThanOrEqual(1);
  });

  it('keeps GET /api/analytics/summary within its statement budget', async () => {
    await get('/api/analytics/summary');
    executed.length = 0; counting = true;
    expect((await get('/api/analytics/summary')).status).toBe(200);
    counting = false;
    // 10 before: five separate scans of `requests` over the same window.
    expect(executed.length).toBeLessThanOrEqual(7);
  });

  it('resolves the active profile exactly as the two-step lookup did', () => {
    const db = getDb();
    db.prepare("INSERT INTO profiles (id, name) VALUES (77, 'p77')").run();
    const set = (v: string | null) => {
      db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
      if (v !== null) db.prepare("INSERT INTO settings (key, value) VALUES ('active_profile_id', ?)").run(v);
    };
    const cases: Array<[string | null, number | null]> = [
      [null, null], ['77', 77], [' 77', 77], ['77abc', 77], ['abc', null], ['', null], ['0', null], ['999', null], ['-77', null],
    ];
    for (const [value, expected] of cases) {
      set(value);
      expect(getActiveProfileId(db), `value ${JSON.stringify(value)}`).toBe(expected);
    }
  });
});
