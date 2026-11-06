import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { defaultDbFactory, getDb, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { encrypt } from '../../lib/crypto.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';
import { setRoutingStrategy } from '../../services/router.js';
import { createUser } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { setEnabled } from '../../custom/x-gateway/config.js';

describe('X Gateway round-trip statement budget (SC-007)', () => {
  const trips: string[] = [];
  let counting = false;
  let server: Server;
  let port: number;
  let adminKey: string;
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
        raw.exec = (sql: string) => {
          if (counting) trips.push('exec');
          return exec(sql);
        };
        raw.prepare = (sql: string) => {
          const stmt = prepare(sql);
          const count = <T>(run: () => T): T => {
            if (counting) trips.push(sql.replace(/\s+/g, ' ').trim());
            return run();
          };
          return {
            get: (...a: unknown[]) => count(() => stmt.get(...a)),
            all: (...a: unknown[]) => count(() => stmt.all(...a)),
            run: (...a: unknown[]) => count(() => stmt.run(...a)),
          };
        };
        return wrapTursoDatabase(raw, true);
      },
    });

    setRoutingStrategy('priority');

    // Seed provider key
    const key = encrypt('gsk_steady_x');
    getDb()
      .prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq', 's', ?, ?, ?, 'healthy', 1)`
      )
      .run(key.encrypted, key.iv, key.authTag);

    // Create primary admin user and mint personal key
    const admin = createUser('admin-budget@example.com', 'AdminPass123!');
    adminKey = mintUserApiKey(admin.userId, 'Admin Key').key;

    // Enable X Gateway
    setEnabled(true);

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    port = (server.address() as { port: number }).port;

    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(`http://127.0.0.1:${port}`)) return realFetch(url, init);
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-budget',
          object: 'chat.completion',
          created: 1,
          model: 'm',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setKeyCacheTestOverride(null);
  });

  const chat = async (path: string) => {
    const res = await realFetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${adminKey}`,
      },
      body: JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    await res.text();
    await new Promise(r => setTimeout(r, 30)); // trailing bookkeeping
    return { status: res.status, headers: res.headers };
  };

  it('consecutive successful /x/v1 chat requests issue no more statements than /v1 (SC-007)', async () => {
    // Warm up /v1 caches
    await chat('/v1/chat/completions');
    await chat('/v1/chat/completions');

    // Measure /v1 steady-state statement counts
    const v1Counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      trips.length = 0;
      counting = true;
      const res = await chat('/v1/chat/completions');
      counting = false;
      expect(res.status).toBe(200);
      v1Counts.push(trips.length);
    }

    // Warm up /x/v1 caches
    await chat('/x/v1/chat/completions');
    await chat('/x/v1/chat/completions');

    // Measure /x/v1 steady-state statement counts
    const xCounts: number[] = [];
    for (let i = 0; i < 3; i++) {
      trips.length = 0;
      counting = true;
      const res = await chat('/x/v1/chat/completions');
      counting = false;
      expect(res.status).toBe(200);
      expect(res.headers.get('x-gateway')).toBe('x');
      xCounts.push(trips.length);
    }

    const avgV1 = v1Counts.reduce((a, b) => a + b, 0) / v1Counts.length;
    const avgX = xCounts.reduce((a, b) => a + b, 0) / xCounts.length;

    // SC-007: A gateway request issues no more storage round trips than an equivalent main-gateway request
    for (const count of xCounts) {
      expect(count).toBeLessThanOrEqual(Math.max(...v1Counts));
    }
    expect(avgX).toBeLessThanOrEqual(Math.ceil(avgV1));
  });
});
