import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { isDbWritable } from '../../routes/status.js';

async function request(
  app: Express,
  method: string,
  path: string,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, { method, headers });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

function insertHealthyKey(platform: string) {
  const secret = encrypt(`${platform}-test-key`);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag);
}

function insertKey(platform: string, status: string): number {
  const secret = encrypt(`${platform}-test-key`);
  const row = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, ?, 1)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag, status);
  return Number(row.lastInsertRowid);
}

function keyIdFor(platform: string): number {
  const row = getDb().prepare(`SELECT id FROM api_keys WHERE platform = ?`).get(platform) as { id: number };
  return row.id;
}

// These tests share one in-memory DB and run top-to-bottom: the "no upstreams"
// assertions must precede the key insert.
describe('status & interop endpoints (#433)', () => {
  let app: Express;
  let unifiedKey = '';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    unifiedKey = getUnifiedApiKey();
  });

  it('GET /livez returns 200 with status, version, and uptime', async () => {
    const { status, body } = await request(app, 'GET', '/livez');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptime_s).toBe('number');
    // Nothing stored yet, so the key-store probe has no opinion either way.
    expect(body.stored_keys_decryptable).toBeNull();
  });

  it('GET /readyz returns 503 no_upstreams_configured when nothing is set up', async () => {
    const { status, body } = await request(app, 'GET', '/readyz');
    expect(status).toBe(503);
    expect(body.reason).toBe('no_upstreams_configured');
  });

  it('GET /v1/providers rejects a missing/invalid key with 401', async () => {
    const { status, body } = await request(app, 'GET', '/v1/providers');
    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('GET /v1/providers returns empty providers and zero counts before any key', async () => {
    const { status, body } = await request(app, 'GET', '/v1/providers', {
      Authorization: `Bearer ${unifiedKey}`,
    });
    expect(status).toBe(200);
    expect(body.providers).toEqual([]);
    expect(body.counts).toEqual({ healthy: 0, rate_limited: 0, invalid: 0, unknown: 0 });
  });

  it('GET /readyz returns 200 for unprobed keys before the first health pass (bootstrap)', async () => {
    insertHealthyKey('groq');
    const { status, body } = await request(app, 'GET', '/readyz');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.ready_upstreams).toBeGreaterThanOrEqual(1);
  });

  it('GET /v1/providers reports the healthy upstream', async () => {
    const { status, body } = await request(app, 'GET', '/v1/providers', {
      'x-api-key': unifiedKey,
    });
    expect(status).toBe(200);
    const groq = body.providers.find((p: { platform: string }) => p.platform === 'groq');
    expect(groq).toBeDefined();
    expect(groq.status).toBe('healthy');
    expect(groq.keys).toBe(1);
    expect(body.counts.healthy).toBeGreaterThanOrEqual(1);
  });

  it('GET /v1/models?ready=true filters to servable models (auth required)', async () => {
    const unauth = await request(app, 'GET', '/v1/models?ready=true');
    expect(unauth.status).toBe(401);

    const full = await request(app, 'GET', '/v1/models', { 'x-api-key': unifiedKey });
    const ready = await request(app, 'GET', '/v1/models?ready=true', { 'x-api-key': unifiedKey });
    expect(ready.status).toBe(200);
    expect(ready.body.object).toBe('list');
    // Every non-virtual model in the filtered list is actually available, and the
    // filter never returns more than the unfiltered catalog.
    const realModels = ready.body.data.filter((m: { id: string }) => m.id !== 'auto' && m.id !== 'fusion');
    for (const m of realModels) expect(m.available).toBe(true);
    expect(ready.body.data.length).toBeLessThanOrEqual(full.body.data.length);
  });

  it('GET /readyz counts an unknown key while no probe has ever run (bootstrap)', async () => {
    insertKey('cerebras', 'unknown');
    const { status, body } = await request(app, 'GET', '/readyz');
    expect(status).toBe(200);
    // groq (healthy, unprobed) + cerebras (unknown, unprobed).
    expect(body.ready_upstreams).toBe(2);
  });

  it('GET /readyz returns 503 once a probe has run but no key ever proved healthy', async () => {
    // Simulate the first health pass having run (a last_checked_at stamp) on
    // every key, without any key ever succeeding: 'unknown' stops counting
    // the moment a probe exists.
    getDb().prepare(`UPDATE api_keys SET last_checked_at = datetime('now')`).run();
    const { status, body } = await request(app, 'GET', '/readyz');
    expect(status).toBe(503);
    expect(body.reason).toBe('no_upstream_ever_probed_healthy');
  });

  it('GET /readyz returns 200 once a key has a last_healthy_at stamp', async () => {
    // A deterministic route for the proven key: its own enabled model row.
    getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
      VALUES ('groq', 'groq-readyz-test-model', 'Ready Test', 1, 1, 1)
    `).run();
    getDb().prepare(`
      UPDATE api_keys SET last_healthy_at = datetime('now') WHERE platform = 'groq'
    `).run();
    const { status, body } = await request(app, 'GET', '/readyz');
    expect(status).toBe(200);
    // Only groq counts now: cerebras is still 'unknown' after the first pass.
    expect(body.ready_upstreams).toBe(1);
  });

  it('GET /readyz returns 503 all_upstreams_rate_limited when every proven route is on cooldown', async () => {
    const groqKeyId = keyIdFor('groq');
    getDb().prepare(`
      INSERT INTO rate_limit_cooldowns (platform, model_id, key_id, expires_at_ms)
      SELECT platform, model_id, ?, ?
      FROM models
      WHERE platform = 'groq' AND enabled = 1 AND (key_id IS NULL OR key_id = ?)
    `).run(groqKeyId, Date.now() + 60 * 60 * 1000, groqKeyId);

    const { status, body } = await request(app, 'GET', '/readyz');
    expect(status).toBe(503);
    expect(body.reason).toBe('all_upstreams_rate_limited');

    // Lifting the cooldown restores readiness — the flip was the cooldown,
    // not the key state.
    getDb().prepare(`DELETE FROM rate_limit_cooldowns`).run();
    const back = await request(app, 'GET', '/readyz');
    expect(back.status).toBe(200);
    expect(back.body.ready_upstreams).toBe(1);
  });

  it('isDbWritable probes the write path without persisting a row', () => {
    expect(isDbWritable()).toBe(true);
    const row = getDb().prepare(
      `SELECT COUNT(*) AS n FROM settings WHERE key = '__readyz_write_probe'`,
    ).get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('isDbWritable reports false when the probe itself cannot run', () => {
    const broken = {
      transaction: () => {
        throw new Error('boom');
      },
    } as any;
    expect(isDbWritable(broken)).toBe(false);
  });
});
