import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { defaultDbFactory, getDb, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';

// Opening the dashboard fires about ten requests at once, and on a remote
// database each statement blocks the whole server. These pin the statement count
// of the routes that grew with the data (one query per platform) so it cannot
// creep back, and check the batched answers equal the per-platform ones.

describe('dashboard open on a remote-style connection', () => {
  const executed: string[] = [];
  let counting = false;
  let server: Server;
  let base: string;
  let token: string;

  // Platforms whose keys cannot be validated (modelsAvailable is computed for
  // them) and the built-in discovery allowlist (modelDiscovery is computed).
  const NO_CHECK = ['freeai', 'freeinference', 'iteracompute', 'kiosapi', 'llmtr', 'novai'];
  const DISCOVERY = ['longcat', 'siliconflow'];

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_READ_CACHE', '0');
    setKeyCacheTestOverride(true);
    initDb(':memory:', {
      factory: () => {
        const raw = defaultDbFactory()(':memory:');
        const prepare = raw.prepare.bind(raw);
        raw.prepare = (sql: string) => {
          const stmt = prepare(sql);
          const count = <T>(run: () => T): T => { if (counting) executed.push(sql.replace(/\s+/g, ' ').trim()); return run(); };
          return { get: (...a: unknown[]) => count(() => stmt.get(...a)), all: (...a: unknown[]) => count(() => stmt.all(...a)), run: (...a: unknown[]) => count(() => stmt.run(...a)) };
        };
        return wrapTursoDatabase(raw, true);
      },
    });
    const insert = getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, 'k', ?, ?, ?, 'healthy', 1)`);
    for (const platform of [...NO_CHECK, ...DISCOVERY, 'groq', 'cerebras']) {
      const k = encrypt('key-' + platform);
      insert.run(platform, k.encrypted, k.iv, k.authTag);
    }
    // Give two of them real models so the counts are not all zero.
    getDb().prepare("UPDATE models SET platform = 'llmtr', enabled = 1 WHERE id = (SELECT MIN(id) FROM models)").run();
    getDb().prepare("UPDATE models SET platform = 'novai', enabled = 1 WHERE id = (SELECT MAX(id) FROM models)").run();
    token = createSession(createUser('dash@example.com', 'Password123!').userId);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server?.close(); vi.unstubAllEnvs(); setKeyCacheTestOverride(null); });

  const get = (path: string) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });

  it('lists keys in a fixed number of statements, however many platforms there are', async () => {
    await get('/api/keys');
    executed.length = 0; counting = true;
    const res = await get('/api/keys');
    const body = await res.json() as Array<{ platform: string; modelsAvailable?: number; modelDiscovery: boolean }>;
    counting = false;
    expect(res.status).toBe(200);
    // roster + custom models x3 + cooldowns + one model-count query + one discovery context (2) = 8.
    // Before: that plus one statement per no-check platform and per discovery platform.
    expect(executed.length).toBeLessThanOrEqual(9);

    const db = getDb();
    for (const row of body.filter(r => NO_CHECK.includes(r.platform))) {
      const expected = (db.prepare(`
        SELECT (SELECT COUNT(*) FROM models WHERE platform = ? AND enabled = 1)
             + (SELECT COUNT(*) FROM embedding_models WHERE platform = ? AND enabled = 1)
             + (SELECT COUNT(*) FROM media_models WHERE platform = ? AND enabled = 1) AS c`).get(row.platform, row.platform, row.platform) as { c: number }).c;
      expect(row.modelsAvailable, row.platform).toBe(expected);
    }
    expect(body.find(r => r.platform === 'llmtr')!.modelsAvailable).toBeGreaterThan(0);
    // Catalog-managed platforms are not offered discovery; the rest of the allowlist follows the DB.
    for (const row of body.filter(r => DISCOVERY.includes(r.platform))) expect(typeof row.modelDiscovery).toBe('boolean');
    expect(body.filter(r => !DISCOVERY.includes(r.platform)).every(r => r.modelDiscovery === false)).toBe(true);
  });

  it('counts usable keys per platform from the registry, not a GROUP BY', async () => {
    await get('/api/fallback/token-usage');
    executed.length = 0; counting = true;
    const res = await get('/api/fallback/token-usage');
    await res.text();
    counting = false;
    expect(res.status).toBe(200);
    expect(executed.filter(s => /GROUP BY platform/.test(s) && /FROM api_keys/.test(s))).toHaveLength(0);
  });
});
