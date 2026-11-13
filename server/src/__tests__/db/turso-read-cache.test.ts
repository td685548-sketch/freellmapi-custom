import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'libsql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginStartupBusyBudget, busyBackoffMs, endStartupBusyBudget, LIFETIME_COUNTERS_MARKER, tursoSettingsVersion, wrapTursoDatabase } from '../../db/turso.js';
import type { Db } from '../../db/types.js';

// The remote wrapper reuses SELECT results for a few seconds, but only while
// nothing this process wrote could have changed them.

function setup() {
  const raw = new Database(':memory:') as unknown as Db;
  raw.exec('CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER, w TEXT);');
  let selects = 0;
  const counted: Db = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!/^\s*SELECT\b/i.test(sql)) return stmt;
        return {
          get: (...a: unknown[]) => { selects++; return stmt.get(...a); },
          all: (...a: unknown[]) => { selects++; return stmt.all(...a); },
          run: (...a: unknown[]) => stmt.run(...a),
        };
      };
    },
  });
  const db = wrapTursoDatabase(counted, true);
  return { db, selects: () => selects };
}

describe('Turso SELECT result cache', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-05T00:00:00Z') }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('serves repeat reads from memory and returns independent copies', () => {
    const { db, selects } = setup();
    db.prepare('INSERT INTO a (v) VALUES (?)').run('one');
    const read = () => db.prepare('SELECT id, v FROM a WHERE id = ?').get(1) as { v: string };
    const first = read();
    first.v = 'mutated';
    expect(read().v).toBe('one');
    read();
    expect(selects()).toBe(1);
  });

  it('drops a result when its own table is written, but not when another is', () => {
    const { db, selects } = setup();
    db.prepare('INSERT INTO a (v) VALUES (?)').run('one');
    const list = () => db.prepare('SELECT v FROM a ORDER BY id').all() as { v: string }[];
    expect(list()).toHaveLength(1);
    db.prepare('INSERT INTO b (a_id, w) VALUES (1, ?)').run('x');
    list();
    expect(selects()).toBe(1);
    db.prepare('INSERT INTO a (v) VALUES (?)').run('two');
    expect(list()).toHaveLength(2);
    db.prepare('UPDATE a SET v = ? WHERE id = 1').run('uno');
    expect(list()[0]!.v).toBe('uno');
    db.prepare('DELETE FROM a WHERE id = 1').run();
    expect(list()).toHaveLength(1);
  });

  it('tracks every table of a join', () => {
    const { db } = setup();
    db.prepare('INSERT INTO a (v) VALUES (?)').run('one');
    const joined = () => db.prepare('SELECT a.v, b.w FROM a JOIN b ON b.a_id = a.id').all();
    expect(joined()).toHaveLength(0);
    db.prepare('INSERT INTO b (a_id, w) VALUES (1, ?)').run('x');
    expect(joined()).toHaveLength(1);
  });

  it('expires after the TTL to bound staleness against outside writers', () => {
    const { db, selects } = setup();
    db.prepare('INSERT INTO a (v) VALUES (?)').run('one');
    const read = () => db.prepare('SELECT v FROM a').all();
    read(); read();
    expect(selects()).toBe(1);
    vi.setSystemTime(new Date('2026-11-05T00:00:04Z'));
    read();
    expect(selects()).toBe(2);
  });

  it('never caches inside a transaction and always sees its own writes', () => {
    const { db } = setup();
    const result = db.transaction(() => {
      const before = db.prepare('SELECT COUNT(*) AS n FROM a').get() as { n: number };
      db.prepare('INSERT INTO a (v) VALUES (?)').run('t');
      const after = db.prepare('SELECT COUNT(*) AS n FROM a').get() as { n: number };
      return [before.n, after.n];
    })();
    expect(result).toEqual([0, 1]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM a').get() as { n: number }).n).toBe(1);
  });

  it('keeps cached reads of other tables across a transaction', () => {
    const { db, selects } = setup();
    db.prepare('INSERT INTO a (v) VALUES (?)').run('one');
    const read = () => db.prepare('SELECT v FROM a').all();
    read(); read();
    expect(selects()).toBe(1);
    // Logging a request is a transaction that writes other tables; it used to
    // empty the whole cache at BEGIN, at COMMIT and again afterwards.
    db.transaction(() => { db.prepare('INSERT INTO b (a_id, w) VALUES (1, ?)').run('x'); })();
    read();
    expect(selects()).toBe(1);
    // ...but a transaction that writes the cached table still invalidates it.
    db.transaction(() => { db.prepare('INSERT INTO a (v) VALUES (?)').run('two'); })();
    expect(read()).toHaveLength(2);
    expect(selects()).toBe(2);
  });

  it('skips time-dependent and unparseable queries, and honours the kill switch', () => {
    const { db, selects } = setup();
    db.prepare("SELECT datetime('now') AS t FROM a").all();
    db.prepare("SELECT datetime('now') AS t FROM a").all();
    db.prepare('SELECT x.v FROM a x, b').all();
    db.prepare('SELECT x.v FROM a x, b').all();
    expect(selects()).toBe(4);

    vi.stubEnv('FREEAPI_TURSO_READ_CACHE', '0');
    const off = setup();
    off.db.prepare('SELECT v FROM a').all();
    off.db.prepare('SELECT v FROM a').all();
    expect(off.selects()).toBe(2);
  });

  it('does not touch local (non-remote) databases', () => {
    const raw = new Database(':memory:') as unknown as Db;
    raw.exec('CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)');
    const local = wrapTursoDatabase(raw, false);
    local.prepare('INSERT INTO a (v) VALUES (?)').run('x');
    expect(local.prepare('SELECT v FROM a').all()).toHaveLength(1);
    local.prepare('INSERT INTO a (v) VALUES (?)').run('y');
    expect(local.prepare('SELECT v FROM a').all()).toHaveLength(2);
  });

  it('knows about every trigger in the migrations (a trigger writes tables the cache cannot see)', () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
    const withTriggers = fs.readdirSync(dir)
      .filter(f => /CREATE\s+TRIGGER/i.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    // If this fails, add the trigger's written tables to TRIGGER_SIDE_EFFECTS in db/turso.ts.
    expect(withTriggers).toEqual(['20260914_000001_key_monthly_usage.ts', '20261111_000001_model_monthly_usage.ts']);
  });
});

describe('Turso SQLITE_BUSY retry', () => {
  function flaky(failures: number, message = 'Hrana(StreamError(Error { message: "SQLite error: database is locked", code: "SQLITE_BUSY" }))') {
    const raw = new Database(':memory:') as unknown as Db;
    raw.exec('CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)');
    let remaining = failures;
    let runs = 0;
    const wrapped: Db = new Proxy(raw, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          return {
            get: (...a: unknown[]) => stmt.get(...a),
            all: (...a: unknown[]) => stmt.all(...a),
            run: (...a: unknown[]) => {
              if (remaining-- > 0) throw new Error(message);
              runs++;
              return stmt.run(...a);
            },
          };
        };
      },
    });
    return { db: wrapTursoDatabase(wrapped, true), runs: () => runs };
  }

  it('retries a busy write instead of failing the caller', () => {
    const { db, runs } = flaky(2);
    db.prepare('INSERT INTO a (v) VALUES (?)').run('x');
    expect(runs()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM a').get()).toEqual({ n: 1 });
  });

  it('gives up with the original error once the budget is spent', () => {
    const { db } = flaky(1000);
    expect(() => db.prepare('INSERT INTO a (v) VALUES (?)').run('x')).toThrow(/database is locked/);
  }, 30_000);

  it('does not retry other errors', () => {
    const { db, runs } = flaky(1, 'UNIQUE constraint failed: a.id');
    expect(() => db.prepare('INSERT INTO a (v) VALUES (?)').run('x')).toThrow(/UNIQUE/);
    expect(runs()).toBe(0);
  });

  it('allows a long wait while booting and a short one afterwards', () => {
    expect(busyBackoffMs(0, 5)).toBe(100);
    expect(busyBackoffMs(6, 5)).toBe(3_500);
    expect(busyBackoffMs(7, 5)).toBeNull();
    expect(busyBackoffMs(2, 600)).toBe(200);
    expect(busyBackoffMs(3, 600)).toBeNull();
  });

  it('waits about a minute for the write lock while starting up, and never once serving', () => {
    const schedule: number[] = [];
    for (let attempt = 0; ; attempt++) {
      const wait = busyBackoffMs(attempt, 5, true);
      if (wait === null) break;
      schedule.push(wait);
    }
    const total = schedule.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(55_000);
    expect(total).toBeLessThanOrEqual(65_000);
    expect(schedule.slice(0, 7)).toEqual([100, 200, 400, 800, 1_500, 2_500, 3_500]); // the usual start is unchanged
    expect(Math.max(...schedule)).toBe(5_000);
    // After the boot window the startup budget no longer applies, even if it was never ended.
    expect(busyBackoffMs(3, 600, true)).toBeNull();
  });

  it('follows the startup flag by default, and ends with it', () => {
    expect(busyBackoffMs(8, 5)).toBeNull(); // the plain boot schedule has 7 entries
    beginStartupBusyBudget();
    expect(busyBackoffMs(8, 5)).toBe(5_000);
    expect(busyBackoffMs(16, 5)).toBe(5_000);
    expect(busyBackoffMs(17, 5)).toBeNull();
    endStartupBusyBudget();
    expect(busyBackoffMs(8, 5)).toBeNull();
  });
});


describe('Turso executeBatch', () => {
  it('runs one atomic script, and a BUSY failure is rolled back before the retry', () => {
    const raw = new Database(':memory:') as unknown as Db;
    raw.exec('CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)');
    const scripts: string[] = [];
    let failures = 2;
    const exec = raw.exec.bind(raw);
    raw.exec = (sql: string) => {
      scripts.push(sql.slice(0, 12));
      if (/^BEGIN;/.test(sql) && failures-- > 0) throw new Error('SQLite error: database is locked');
      return exec(sql);
    };
    const db = wrapTursoDatabase(raw, true);
    db.executeBatch!([{ sql: 'INSERT INTO a (v) VALUES (?)', params: ["it's"] }, { sql: 'INSERT INTO a (v) VALUES (?)', params: [null] }]);
    expect(db.prepare('SELECT v FROM a ORDER BY id').all()).toEqual([{ v: "it's" }, { v: null }]);
    expect(scripts.filter(s => s === 'ROLLBACK')).toHaveLength(2); // one per failed attempt
  });

  it('is not offered on local connections or inside a transaction', () => {
    const local = wrapTursoDatabase(new Database(':memory:') as unknown as Db, false);
    expect(local.executeBatch).toBeUndefined();
    const raw = new Database(':memory:') as unknown as Db;
    raw.exec('CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)');
    const db = wrapTursoDatabase(raw, true);
    expect(() => db.transaction(() => db.executeBatch!([{ sql: 'INSERT INTO a (v) VALUES (?)', params: ['x'] }]))()).toThrow(/inside a transaction/);
  });
});


describe('lifetime counters and cached settings', () => {
  function open() {
    const raw = new Database(':memory:') as unknown as Db;
    raw.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE other (id INTEGER PRIMARY KEY, v TEXT)");
    raw.exec("INSERT INTO settings VALUES ('routing_strategy', 'speed'), ('total_requests', '0')");
    let selects = 0;
    const prepare = raw.prepare.bind(raw);
    raw.prepare = (sql: string) => {
      const stmt = prepare(sql);
      return {
        get: (...a: unknown[]) => { if (/^\s*SELECT/i.test(sql)) selects++; return stmt.get(...a); },
        all: (...a: unknown[]) => { if (/^\s*SELECT/i.test(sql)) selects++; return stmt.all(...a); },
        run: (...a: unknown[]) => stmt.run(...a),
      };
    };
    return { db: wrapTursoDatabase(raw, true), selects: () => selects };
  }
  const COUNTER_UPSERT = `${LIFETIME_COUNTERS_MARKER}
    INSERT INTO settings (key, value) VALUES ('total_requests', ?) ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(settings.value AS INTEGER) + CAST(excluded.value AS INTEGER) AS TEXT)`;

  it('a counter upsert leaves cached settings reads and the settings version alone', () => {
    const { db, selects } = open();
    const read = () => db.prepare('SELECT value FROM settings WHERE key = ?').get('routing_strategy');
    read(); read();
    expect(selects()).toBe(1);
    const before = tursoSettingsVersion(db);
    db.prepare(COUNTER_UPSERT).run('1');
    db.prepare(COUNTER_UPSERT).run('1');
    read();
    expect(selects()).toBe(1);
    expect(tursoSettingsVersion(db)).toBe(before);
  });

  it('a real settings write still invalidates both', () => {
    const { db, selects } = open();
    const read = () => db.prepare('SELECT value FROM settings WHERE key = ?').get('routing_strategy') as { value: string };
    read();
    const before = tursoSettingsVersion(db);
    db.prepare("UPDATE settings SET value = 'speed2' WHERE key = 'routing_strategy'").run();
    expect(read().value).toBe('speed2');
    expect(selects()).toBe(2);
    expect(tursoSettingsVersion(db)).toBeGreaterThan(before);
    // Writes to other tables do not touch the settings version.
    const mid = tursoSettingsVersion(db);
    db.prepare('INSERT INTO other (v) VALUES (?)').run('x');
    expect(tursoSettingsVersion(db)).toBe(mid);
  });

  it('a read of the counters themselves is invalidated by the counter upsert', () => {
    const { db } = open();
    const totals = () => db.prepare("SELECT value FROM settings WHERE key IN ('total_requests')").get() as { value: string };
    expect(totals().value).toBe('0');
    db.prepare(COUNTER_UPSERT).run('5');
    expect(totals().value).toBe('5');
  });

  it('a rolled-back transaction bumps the settings version', () => {
    const { db } = open();
    const before = tursoSettingsVersion(db);
    expect(() => db.transaction(() => { throw new Error('boom'); })()).toThrow('boom');
    expect(tursoSettingsVersion(db)).toBeGreaterThan(before);
  });
});
