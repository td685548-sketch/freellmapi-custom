import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { defaultDbFactory, getDb, getUnifiedApiKey, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { encrypt } from '../../lib/crypto.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';
import { setUsageMemoTestOverride } from '../../services/ratelimit.js';
import { setRoutingStrategy } from '../../services/router.js';

describe('chat completion round trips on a failover', () => {
  const trips: string[] = [];
  let counting = false;
  let groqDown = false;
  let server: Server;
  let port: number;
  const realFetch = global.fetch;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    setKeyCacheTestOverride(true);
    setUsageMemoTestOverride(true);
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
    for (const platform of ['groq', 'cerebras']) {
      getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?,'s',?,?,?,'healthy',1)`)
        .run(platform, key.encrypted, key.iv, key.authTag);
    }
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    port = (server.address() as { port: number }).port;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(`http://127.0.0.1:${port}`)) return realFetch(url, init);
      if (groqDown && String(url).includes('groq.com')) return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setKeyCacheTestOverride(null); setUsageMemoTestOverride(null); });

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

  it('keeps a six-attempt groq-to-cerebras failover within its round-trip budget', async () => {
    await chat(); await chat(); // warm: groq answers, caches fill
    groqDown = true;
    trips.length = 0; counting = true;
    const status = await chat();
    counting = false;
    expect(status).toBe(200);
    // 93 before the four usage counters were read in one statement (and memoised for the
    // same attempt); 63 now. Raise only with a measured reason.
    expect(trips.length).toBeLessThanOrEqual(66);
    expect(trips.filter(t => /FROM rate_limit_usage/.test(t)).length).toBeLessThanOrEqual(9);
  });
});
