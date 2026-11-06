import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { defaultDbFactory, getDb, getUnifiedApiKey, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { encrypt } from '../../lib/crypto.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { setRoutingStrategy } from '../../services/router.js';

// On a remote database every statement blocks the event loop for a network round
// trip (the driver is synchronous), so the statements one chat request issues are
// the time the whole server is unresponsive. This pins the count for the common
// case, a request served by its first provider.

describe('chat completion statement budget on a remote-style connection', () => {
  const executed: string[] = [];
  let counting = false;
  let server: Server;
  let port: number;
  const realFetch = global.fetch;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_READ_CACHE', '0'); // count real executions, not cache hits
    setKeyCacheTestOverride(true); // production keeps the usable-key registry in memory
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
    setRoutingStrategy('priority');
    const key = encrypt('gsk_budget');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','b',?,?,?,'healthy',1)`)
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

  const chat = () => realFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getUnifiedApiKey()}` },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
  });

  it('keeps a first-try success within its statement budget', async () => {
    await chat();
    clearAllCooldowns(Number.MAX_SAFE_INTEGER);
    getDb().prepare('DELETE FROM rate_limit_usage').run();
    executed.length = 0; counting = true;
    const res = await chat(); await res.text();
    counting = false;
    expect(res.status).toBe(200);
    const writes = executed.filter(s => !/^SELECT/i.test(s));
    // 31 statements / 12 writes before the lifetime counters were folded into one
    // upsert and the redundant key-status UPDATE was skipped. Raise only with a measured reason.
    expect(writes.length).toBeLessThanOrEqual(8);
    expect(executed.length).toBeLessThanOrEqual(26);
    // The four lifetime counters are one statement, and the status UPDATE is skipped for a healthy key.
    expect(executed.filter(s => /INTO settings/.test(s) && /total_requests/.test(s))).toHaveLength(1);
    expect(executed.filter(s => /UPDATE api_keys SET status = 'healthy'/.test(s))).toHaveLength(0);
  });
});
