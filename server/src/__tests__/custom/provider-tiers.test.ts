import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { initDb, getDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createSession, createUser } from '../../services/auth.js';
import { providerTiers, tierForScore } from '../../services/provider-tiers.js';

function key(platform: string, baseUrl: string | null = null, enabled = 1, status = 'healthy') {
  return Number(getDb().prepare(`INSERT INTO api_keys
    (platform, base_url, encrypted_key, iv, auth_tag, enabled, status)
    VALUES (?, ?, 'SECRET_MUST_NOT_LEAK', 'iv', 'tag', ?, ?)`).run(platform, baseUrl, enabled, status).lastInsertRowid);
}

function observation(keyId: number, platform: string, status = 'success', createdAt?: string) {
  getDb().prepare(`INSERT INTO requests
    (platform, model_id, key_id, status, output_tokens, latency_ms, ttfb_ms, created_at)
    VALUES (?, 'observed', ?, ?, 100, 1000, 300, COALESCE(?, datetime('now')))`)
    .run(platform, keyId, status, createdAt ?? null);
}

describe('Provider tier board', () => {
  let server: Server;
  let base: string;
  let admin: string;
  let member: string;
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    admin = createSession(createUser('tiers-owner@example.com', 'Password123!').userId);
    member = createSession(createUser('tiers-member@example.com', 'Password123!', 'member').userId);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server?.close(); });
  beforeEach(() => {
    getDb().prepare('DELETE FROM requests').run();
    getDb().prepare('DELETE FROM api_keys').run();
  });

  it('counts linked and usable keys independently without multiplying observations', () => {
    const first = key('groq');
    key('groq', null, 0);
    key('groq', null, 1, 'error');
    observation(first, 'groq');
    const row = providerTiers('7d').rows[0];
    expect(row).toMatchObject({ linkedKeyCount: 3, usableKeyCount: 1, samples: 1, successes: 1, tier: null });
    expect(row.intelligence).toBeNull();
    expect(JSON.stringify(row)).not.toContain('SECRET');
  });

  it('isolates same-host custom endpoints and normalizes trailing slashes', () => {
    const a = key('custom', 'https://relay.example/tenant-a/v1/');
    key('custom', 'https://relay.example/tenant-a/v1');
    const b = key('custom', 'https://relay.example/tenant-b/v1');
    observation(a, 'custom');
    observation(b, 'custom', 'error');
    const rows = providerTiers('7d').rows;
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.name.includes('tenant-a'))).toMatchObject({ linkedKeyCount: 2, samples: 1, successes: 1 });
    expect(rows.find(r => r.name.includes('tenant-b'))).toMatchObject({ linkedKeyCount: 1, samples: 1, successes: 0 });
    expect(rows[0].providerId).not.toBe(rows[1].providerId);
    expect(JSON.stringify(rows)).not.toContain('https://');
  });

  it('includes unseen providers without fabricated metrics or tiers', () => {
    key('google');
    expect(providerTiers('24h').rows[0]).toMatchObject({ samples: 0, score: null, reliability: null, speed: null, intelligence: null, tier: null });
  });

  it('honors range, ignores canceled/non-chat/rejected requests, and gates tiers at 20 samples', () => {
    const id = key('groq');
    for (let i = 0; i < 19; i++) observation(id, 'groq');
    observation(id, 'groq', 'canceled');
    observation(id, 'groq', 'error', '2000-01-01 00:00:00');
    getDb().prepare("INSERT INTO requests (platform, model_id, status) VALUES ('groq', 'rejected', 'error')").run();
    const knownModel = getDb().prepare('SELECT id FROM models LIMIT 1').get() as { id: number };
    getDb().prepare("INSERT INTO requests (platform, model_id, model_db_id, status) VALUES ('groq', 'rejected', ?, 'error')").run(knownModel.id);
    observation(id, 'groq');
    getDb().prepare("UPDATE requests SET request_type = 'image' WHERE id = (SELECT MAX(id) FROM requests)").run();
    expect(providerTiers('7d').rows[0]).toMatchObject({ samples: 19, tier: null });
    observation(id, 'groq');
    expect(providerTiers('7d').rows[0].tier).not.toBeNull();
    expect(providerTiers('all').rows[0].samples).toBe(21);
  });

  it('does not invent speed from failed or zero-timing calls', () => {
    const id = key('groq');
    for (let i = 0; i < 20; i++) observation(id, 'groq', 'error');
    expect(providerTiers('7d').rows[0]).toMatchObject({ speed: null, intelligence: null, tier: 'D' });
  });

  it('uses model metadata once per observation, and only two bulk reads regardless of provider count', () => {
    const model = getDb().prepare("SELECT id, platform, model_id FROM models WHERE size_label IN ('Frontier', 'Large', 'Medium', 'Small') LIMIT 1")
      .get() as { id: number; platform: string; model_id: string };
    const id = key(model.platform);
    key(model.platform);
    for (let i = 0; i < 20; i++) observation(id, model.platform);
    getDb().prepare('UPDATE requests SET model_db_id = ?, model_id = ?').run(model.id, model.model_id);
    key('unmeasured-provider');
    const prepare = vi.spyOn(getDb(), 'prepare');
    try {
      const rows = providerTiers('7d').rows;
      expect(rows.find(r => r.platform === model.platform)).toMatchObject({
        samples: 20, linkedKeyCount: 2, intelligence: 1, modelCount: 1,
      });
      expect(prepare).toHaveBeenCalledTimes(2);
      const sql = prepare.mock.calls.map(([query]) => query).join(' ');
      expect(sql).not.toMatch(/SELECT\s+\*|encrypted_key|auth_tag|key_label/i);
    } finally { prepare.mockRestore(); }
  });

  it('uses documented tier boundaries', () => {
    expect([.85, .75, .65, .5, .49].map(s => tierForScore(s, 20))).toEqual(['S', 'A', 'B', 'C', 'D']);
    expect(tierForScore(1, 19)).toBeNull();
  });

  it('requires dashboard auth and view_logs and validates ranges', async () => {
    const hit = (suffix = '', token?: string) => fetch(`${base}/api/analytics/provider-tiers${suffix}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    expect((await hit()).status).toBe(401);
    expect((await hit('', member)).status).toBe(403);
    expect((await hit('?range=invalid', admin)).status).toBe(400);
    expect((await hit('?range=7d&range=all', admin)).status).toBe(400);
    const response = await hit('', admin);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ range: '7d', minSamples: 20, rows: [] });
  });
});
