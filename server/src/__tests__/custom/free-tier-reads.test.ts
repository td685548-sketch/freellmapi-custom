import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDbFactory, getDb, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { pruneRequestAnalytics } from '../../services/request-retention.js';
import { refreshStatsCache } from '../../services/router.js';

// Turso bills by rows read, and two jobs used to scan whole tables every minute while traffic flowed:
// the count-bound prunes (DELETE ... OFFSET maxRows) and the routing stats refresh (a week and the
// month to date of `requests`). These pin the cheaper behaviour.

function tracedDb(remote: boolean): string[] {
  const sql: string[] = [];
  initDb(':memory:', {
    factory: () => {
      const raw = defaultDbFactory()(':memory:');
      const prepare = raw.prepare.bind(raw);
      raw.prepare = (text: string) => {
        const stmt = prepare(text);
        const note = <T>(run: () => T): T => { sql.push(text.replace(/\s+/g, ' ').trim()); return run(); };
        return { get: (...a: unknown[]) => note(() => stmt.get(...a)), all: (...a: unknown[]) => note(() => stmt.all(...a)), run: (...a: unknown[]) => note(() => stmt.run(...a)) };
      };
      return remote ? wrapTursoDatabase(raw, true) : raw;
    },
  });
  return sql;
}

const addRequests = (n: number) => {
  const ins = getDb().prepare("INSERT INTO requests (platform, model_id, status, created_at) VALUES ('groq', 'm', 'success', datetime('now', ?))");
  for (let i = 0; i < n; i++) ins.run(`-${n - i} seconds`);
};

describe('count-bound prunes', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('skips the OFFSET scan while a table is below its cap', () => {
    vi.stubEnv('REQUEST_ANALYTICS_MAX_ROWS', '50');
    const sql = tracedDb(false);
    addRequests(20);
    sql.length = 0;
    pruneRequestAnalytics({ force: true });
    expect(sql.filter(s => /OFFSET/.test(s))).toEqual([]);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n).toBe(20);
  });

  it('still keeps exactly the newest rows once over the cap, gaps in the ids included', () => {
    vi.stubEnv('REQUEST_ANALYTICS_MAX_ROWS', '5');
    const sql = tracedDb(false);
    addRequests(12);
    getDb().prepare('DELETE FROM requests WHERE id IN (3, 7, 9)').run(); // 9 rows left, ids with gaps
    sql.length = 0;
    pruneRequestAnalytics({ force: true });
    expect(sql.some(s => /DELETE FROM requests WHERE id IN .*OFFSET/.test(s))).toBe(true);
    const ids = (getDb().prepare('SELECT id FROM requests ORDER BY id').all() as Array<{ id: number }>).map(r => r.id);
    expect(ids).toEqual([6, 8, 10, 11, 12]);
  });

  it('applies to the server log, search and decision logs too', () => {
    vi.stubEnv('REQUEST_ANALYTICS_MAX_ROWS', '50');
    const sql = tracedDb(false);
    sql.length = 0;
    pruneRequestAnalytics({ force: true });
    expect(sql.filter(s => /OFFSET/.test(s))).toEqual([]); // every table is empty here
    expect(sql.filter(s => /SELECT \(SELECT MIN\(rowid\)/.test(s)).length).toBeGreaterThanOrEqual(4);
  });
});

describe('routing stats refresh', () => {
  const statsReads = (sql: string[]) => sql.filter(s => /FROM requests WHERE created_at >= \? AND status <> 'canceled'/.test(s)).length;
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-07T10:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('refreshes every ten minutes on a remote database', () => {
    const sql = tracedDb(true);
    refreshStatsCache(getDb(), true);
    const first = statsReads(sql);
    vi.setSystemTime(new Date('2026-11-07T10:05:00Z'));
    refreshStatsCache(getDb());
    expect(statsReads(sql)).toBe(first);
    vi.setSystemTime(new Date('2026-11-07T10:10:01Z'));
    refreshStatsCache(getDb());
    expect(statsReads(sql)).toBe(first + 1);
  });

  it('keeps the one-minute refresh on a local database, and honours ROUTER_STATS_TTL_MS', () => {
    const sql = tracedDb(false);
    refreshStatsCache(getDb(), true);
    const first = statsReads(sql);
    vi.setSystemTime(new Date('2026-11-07T10:01:01Z'));
    refreshStatsCache(getDb());
    expect(statsReads(sql)).toBe(first + 1);
    vi.stubEnv('ROUTER_STATS_TTL_MS', '300000');
    vi.setSystemTime(new Date('2026-11-07T10:03:00Z'));
    refreshStatsCache(getDb());
    expect(statsReads(sql)).toBe(first + 1);
  });
});
