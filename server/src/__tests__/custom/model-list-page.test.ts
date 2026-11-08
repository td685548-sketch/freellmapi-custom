import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { defaultDbFactory, getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setKeyCacheTestOverride, invalidateKeyCache } from '../../services/key-cache.js';
import { invalidateModelListPages, readModelListPage, ModelListPageExpired } from '../../services/model-list-page.js';
import { setRoutingStrategy } from '../../services/router.js';
import { invalidateWindowUsage } from '../../services/ratelimit.js';

describe('paged Chat Models catalog', () => {
  let server: Server; let base: string; let token: string;
  const ids: number[] = [];
  const reads: Array<{ sql: string; rows: number; binds: number }> = [];
  let counting = false;
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const raw = defaultDbFactory()(':memory:');
    const prepare = raw.prepare.bind(raw);
    raw.prepare = (sql: string) => {
      const statement = prepare(sql);
      return {
        get: (...args: unknown[]) => {
          const row = statement.get(...args);
          if (counting) reads.push({ sql: sql.replace(/\s+/g, ' '), rows: row ? 1 : 0, binds: args.length });
          return row;
        },
        run: (...args: unknown[]) => statement.run(...args),
        all: (...args: unknown[]) => {
          const rows = statement.all(...args);
          if (counting) reads.push({ sql: sql.replace(/\s+/g, ' '), rows: rows.length, binds: args.length });
          return rows;
        },
      };
    };
    initDb(':memory:', { factory: () => raw });
    setKeyCacheTestOverride(true);
    const db = getDb();
    db.prepare('UPDATE models SET enabled = 0').run();
    for (const platform of ['groq', 'nvidia']) {
      const key = encrypt('fixture-key');
      db.prepare(`INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled)
        VALUES (?, 'Fixture provider', ?, ?, ?, 'healthy', 1)`).run(platform, key.encrypted, key.iv, key.authTag);
    }
    const model = db.prepare(`INSERT INTO models
      (platform,model_id,display_name,enabled,supports_vision,supports_tools,context_window,intelligence_rank,speed_rank,size_label)
      VALUES (?, ?, ?, 1, ?, ?, ?, 1, 1, 'Large')`);
    for (let i = 1; i <= 45; i++) {
      const n = String(i).padStart(3, '0');
      const id = Number(model.run('groq', `paged-${n}`, `Paged model ${n}`, i % 2, i % 3 === 0 ? 1 : 0, i * 1000).lastInsertRowid);
      ids.push(id);
      db.prepare('INSERT OR REPLACE INTO fallback_config (model_db_id,priority,enabled) VALUES (?, ?, 1)').run(id, i);
    }
    const sibling = Number(model.run('nvidia', 'paged-001-nvidia', 'Paged model 001 (Nvidia)', 1, 0, 1000).lastInsertRowid);
    db.prepare('INSERT OR REPLACE INTO fallback_config (model_db_id,priority,enabled) VALUES (?, 46, 1)').run(sibling);
    db.prepare('UPDATE models SET rpm_limit = 2 WHERE id = ?').run(ids[0]);
    const keyId = (db.prepare("SELECT id FROM api_keys WHERE platform = 'groq'").get() as { id: number }).id;
    for (let i = 0; i < 2; i++) db.prepare(`INSERT INTO rate_limit_usage (platform,model_id,key_id,kind,tokens,created_at_ms)
      VALUES ('groq','paged-001',?,'request',0,?)`).run(keyId, Date.now());
    invalidateWindowUsage();
    setRoutingStrategy('priority');
    token = createSession(createUser('pages@example.com', 'Password123!').userId);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server?.close(); setKeyCacheTestOverride(null); invalidateModelListPages(); });
  async function get(query = '', authenticated = true) {
    const response = await fetch(`${base}/api/fallback/page?profile=global${query}`, {
      headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: response.status, body: await response.json() };
  }
  const keys = (page: { entries: Array<{ groupKey: string }> }) => [...new Set(page.entries.map(e => e.groupKey))];

  it('requires dashboard authentication', async () => {
    expect((await get('', false)).status).toBe(401);
  });
  it('returns 20 whole logical groups per page, with stable continuation and no duplicates', async () => {
    const first = await get();
    expect(first.status).toBe(200);
    expect(keys(first.body)).toHaveLength(20);
    expect(first.body.entries).toHaveLength(21); // both providers of logical model 001
    expect(first.body.matchedGroups).toBe(45);
    const second = await get(`&snapshot=${first.body.snapshot}&offset=${first.body.nextOffset}`);
    const third = await get(`&snapshot=${second.body.snapshot}&offset=${second.body.nextOffset}`);
    expect(keys(second.body)).toHaveLength(20);
    expect(keys(third.body)).toHaveLength(5);
    expect(third.body.nextOffset).toBeNull();
    expect(new Set([...keys(first.body), ...keys(second.body), ...keys(third.body)]).size).toBe(45);
    expect(second.body.snapshot).toBe(first.body.snapshot);
    expect(Object.values(second.body.ranks)).toEqual(Array.from({ length: 20 }, (_, i) => i + 21));
  });
  it('searches and sorts the full catalog before selecting a page', async () => {
    const result = await get('&search=Paged%20model%20045');
    expect(result.body.entries.map((e: { modelId: string }) => e.modelId)).toEqual(['paged-045']);
    const desc = await get('&sort=model&direction=desc');
    expect(desc.body.entries[0].modelId).toBe('paged-045');
    const vision = await get('&vision=1&context=40000');
    expect(vision.body.matchedGroups).toBe(3);
    expect(vision.body.entries.every((e: { contextWindow: number }) => e.contextWindow >= 40000)).toBe(true);
    expect((await get('&search=does-not-exist')).body.matchedGroups).toBe(0);
    expect((await get('&search=nvidia')).body.entries).toHaveLength(2);
  });
  it('keeps the same used/limit values as the legacy quota display', async () => {
    const paged = (await get('&search=Paged%20model%20001')).body;
    const response = await fetch(base + '/api/fallback/rate-limit-usage', { headers: { Authorization: `Bearer ${token}` } });
    const legacy = await response.json();
    const displayed = paged.rateLimitUsage.rows.find((r: { modelDbId: number }) => r.modelDbId === ids[0]);
    expect(displayed.rpm).toEqual({ used: 2, limit: 2 });
    expect(displayed.rpm).toEqual(legacy.rows.find((r: { modelDbId: number }) => r.modelDbId === ids[0]).rpm);
  });
  it('hydrates only the requested members and reuses ranking/history work across clicks', async () => {
    const first = await get();
    reads.length = 0; counting = true;
    const next = await get(`&snapshot=${first.body.snapshot}&offset=20`);
    counting = false;
    expect(next.status).toBe(200);
    const detail = reads.filter(r => r.sql.includes('JOIN model_overrides'));
    expect(detail).toHaveLength(1);
    expect(detail[0].sql).toContain('WHERE m.id IN');
    expect(detail[0].rows).toBe(20);
    expect(detail[0].binds).toBe(20);
    expect(reads.filter(r => /FROM requests|FROM rate_limit_usage/.test(r.sql))).toHaveLength(0);
    expect(reads.filter(r => /FROM models m/.test(r.sql))).toHaveLength(1);
    expect(next.body.routing.scores).toHaveLength(20);
    expect(next.body.rateLimitUsage.rows).toHaveLength(20);
  });
  it('reduces database reads compared with the four eager catalog requests', async () => {
    const legacy = ['/api/fallback', '/api/fallback/routing', '/api/fallback/rate-limit-usage', '/api/fallback/token-usage'];
    await get();
    reads.length = 0; counting = true;
    for (const path of legacy) await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
    counting = false;
    const legacyCount = reads.length;
    const legacyDetailRows = reads.filter(r => r.sql.includes('JOIN model_overrides')).reduce((sum, r) => sum + r.rows, 0);
    invalidateModelListPages();
    reads.length = 0; counting = true;
    const first = await get();
    counting = false;
    expect(first.status).toBe(200);
    expect(reads.length).toBeLessThan(legacyCount);
    expect(reads.filter(r => r.sql.includes('JOIN model_overrides')).reduce((sum, r) => sum + r.rows, 0)).toBeLessThan(legacyDetailRows);
  });
  it('refreshes only opened groups without repeating metadata or history scans', async () => {
    const first = await get();
    reads.length = 0; counting = true;
    const response = await fetch(`${base}/api/fallback/page/live?profile=global&snapshot=${first.body.snapshot}&count=40`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const live = await response.json(); counting = false;
    expect(response.status).toBe(200);
    expect(live.routing.scores).toHaveLength(41);
    expect(live.rateLimitUsage.rows).toHaveLength(41);
    expect(reads.filter(r => /FROM requests|FROM rate_limit_usage|JOIN model_overrides/.test(r.sql))).toHaveLength(0);
  });
  it('rejects invalid parameters and expired/mismatched cursors', async () => {
    for (const query of ['&offset=-1', '&offset=20', '&sort=sql', '&vision=true', '&search=' + 'x'.repeat(201)]) {
      expect((await get(query)).status).toBe(400);
    }
    const first = await get();
    const selection = { profileId: null, search: '', vision: false, tools: false, context: 0, direction: 'asc' as const, offset: 20, snapshot: first.body.snapshot };
    expect(() => readModelListPage(selection, Date.now() + 300_001)).toThrow(ModelListPageExpired);
    expect((await get(`&snapshot=${first.body.snapshot}&offset=20`)).status).toBe(410);
  });
  it('keeps endpoint identities unambiguous when the other renamed group is not loaded', async () => {
    const db = getDb();
    for (const name of ['A', 'B']) {
      const key = encrypt('fixture-relay'); const scope = `https://relay-${name.toLowerCase()}.example/v1`;
      const keyId = Number(db.prepare(`INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled,base_url)
        VALUES ('custom','Relay',?,?,?,'healthy',1,?)`).run(key.encrypted, key.iv, key.authTag, scope).lastInsertRowid);
      const id = Number(db.prepare(`INSERT INTO models
        (platform,model_id,display_name,intelligence_rank,speed_rank,size_label,enabled,key_id,endpoint_scope)
        VALUES ('custom','shared-route',?,1,1,'Large',1,?,?)`).run(`Endpoint ${name} alias`, keyId, scope).lastInsertRowid);
      db.prepare('INSERT OR REPLACE INTO fallback_config (model_db_id,priority,enabled) VALUES (?,100,1)').run(id);
    }
    invalidateKeyCache(); invalidateModelListPages();
    const response = await get('&search=Endpoint%20A%20alias');
    expect(response.body.entries).toHaveLength(1);
    expect(response.body.entries[0].endpointCollision).toBe(true);
  });
  it('pins partial edits to their profile and preserves unseen rows and other chains', async () => {
    const db = getDb();
    db.prepare("INSERT INTO profiles (id,name) VALUES (777,'paged chain'),(778,'another chain')").run();
    for (const profile of [777, 778]) for (let i = 0; i < ids.length; i++) {
      db.prepare('INSERT INTO profile_models (profile_id,model_db_id,priority,enabled) VALUES (?, ?, ?, 1)').run(profile, ids[i], i + 1);
    }
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('active_profile_id','778')").run();
    const response = await fetch(`${base}/api/fallback/page`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 777, entries: [{ modelDbId: ids[0], priority: 1, enabled: false }] }),
    });
    expect(response.status).toBe(200);
    const row = (profile: number, id: number) => db.prepare('SELECT enabled,priority FROM profile_models WHERE profile_id=? AND model_db_id=?').get(profile, id);
    expect(row(777, ids[0])).toEqual({ enabled: 0, priority: 1 });
    expect(row(777, ids[44])).toEqual({ enabled: 1, priority: 45 });
    expect(row(778, ids[0])).toEqual({ enabled: 1, priority: 1 });
    const prof = await fetch(`${base}/api/fallback/page?profile=777`, { headers: { Authorization: `Bearer ${token}` } });
    const profBody = await prof.json();
    expect(profBody.entries.find((e: { modelDbId: number }) => e.modelDbId === ids[0]).enabled).toBe(false);
    expect((await get(`&snapshot=${profBody.snapshot}&offset=20`)).status).toBe(410);
  });
});
