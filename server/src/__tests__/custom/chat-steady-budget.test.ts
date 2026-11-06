import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { defaultDbFactory, getDb, getUnifiedApiKey, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { encrypt } from '../../lib/crypto.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';
import { setRoutingStrategy } from '../../services/router.js';

// Steady state, the way production runs: SELECT cache on, batched writes on,
// requests following each other. Logging a request bumps the lifetime counters in
// `settings`; that write used to invalidate every cached routing setting, so each
// request re-read them all (19 round trips for a plain success; now 10).

describe('chat completion round trips in steady state', () => {
  const trips: string[] = [];
  let counting = false;
  let server: Server;
  let port: number;
  const realFetch = global.fetch;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    setKeyCacheTestOverride(true);
    initDb(':memory:', {
      factory: () => {
        const raw = defaultDbFactory()(':memory:');
        const prepare = raw.prepare.bind(raw);
        const exec = raw.exec.bind(raw);
        raw.exec = (sql: string) => { if (counting) trips.push('exec'); return exec(sql); };
        raw.prepare = (sql: string) => {
          const stmt = prepare(sql);
          const count = <T>(run: () => T): T => { if (counting) trips.push(sql.replace(/\s+/g, ' ').trim()); return run(); };
          return { get: (...a: unknown[]) => count(() => stmt.get(...a)), all: (...a: unknown[]) => count(() => stmt.all(...a)), run: (...a: unknown[]) => count(() => stmt.run(...a)) };
        };
        return wrapTursoDatabase(raw, true);
      },
    });
    setRoutingStrategy('priority');
    const key = encrypt('gsk_steady');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','s',?,?,?,'healthy',1)`)
      .run(key.encrypted, key.iv, key.authTag);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    port = (server.address() as { port: number }).port;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(`http://127.0.0.1:${port}`)) return realFetch(url, init);
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setKeyCacheTestOverride(null); });

  const chat = async () => {
    const res = await realFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${getUnifiedApiKey()}` },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();
    await new Promise(r => setTimeout(r, 30)); // trailing bookkeeping (attempt trace) lands after the response
    return res.status;
  };

  it('does not re-read routing settings on every request', async () => {
    await chat(); await chat();
    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      trips.length = 0; counting = true;
      expect(await chat()).toBe(200);
      counting = false;
      counts.push(trips.length);
    }
    // Was 19 per request before counters stopped invalidating cached settings. Raise only with a measured reason.
    for (const n of counts) expect(n).toBeLessThanOrEqual(11);
    // And the 21-key routing prefetch is not repeated within one request.
    expect(trips.filter(t => /SELECT key, value FROM settings WHERE key IN/.test(t)).length).toBeLessThanOrEqual(1);
  });
});
