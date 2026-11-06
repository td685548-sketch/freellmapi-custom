import Database from 'libsql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import type { Db } from '../../db/types.js';
import { recordQuotaObservation } from '../../services/provider-quota.js';

// A quota observation is two writes. On a remote database they used to cost
// BEGIN + 2 statements + COMMIT = four round trips for every health probe and
// every served chat request; as one write group they cost one.

function open() {
  const trips: string[] = [];
  const raw = new Database(':memory:') as unknown as Db;
  const exec = raw.exec.bind(raw);
  raw.exec = (sql: string) => { trips.push('exec'); return exec(sql); };
  const prepare = raw.prepare.bind(raw);
  raw.prepare = (sql: string) => {
    const stmt = prepare(sql);
    return {
      get: (...a: unknown[]) => { trips.push('get'); return stmt.get(...a); },
      all: (...a: unknown[]) => { trips.push('all'); return stmt.all(...a); },
      run: (...a: unknown[]) => { trips.push('run'); return stmt.run(...a); },
    };
  };
  initDb(':memory:', { factory: () => wrapTursoDatabase(raw, true) });
  return trips;
}

const observe = () => recordQuotaObservation({
  platform: 'groq', keyId: 7, quotaPoolKey: 'groq:test', metric: 'requests', source: 'probe',
  limit: 100, remaining: 42, resetAt: '2026-11-06T00:00:00Z', notes: "it's \"odd\"; -- ? \n text",
  rawJson: '{"a":"b\'c"}', endpoint: 'models', statusCode: 200,
});

const rows = () => ({
  state: getDb().prepare('SELECT platform, key_id, quota_pool_key, metric, limit_value, remaining_value, reset_at, source, notes FROM provider_quota_state').all(),
  obs: getDb().prepare('SELECT platform, key_id, quota_pool_key, metric, status_code, limit_value, remaining_value, notes, raw_json, endpoint FROM provider_quota_observations').all(),
});

describe('quota observation write group', () => {
  beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); });
  afterEach(() => vi.unstubAllEnvs());

  it('stores the same rows with and without batching', () => {
    open(); observe(); observe();
    const expected = rows();
    open(); vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1'); observe(); observe();
    expect(rows()).toEqual(expected);
    expect(expected.obs).toHaveLength(2);
    expect(expected.state).toHaveLength(1);
  });

  it('is one round trip when batching is on, four when it is not', () => {
    const trips = open();
    trips.length = 0; observe();
    expect(trips.filter(t => t === 'run' || t === 'exec')).toHaveLength(4); // BEGIN, 2 writes, COMMIT
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    trips.length = 0; observe();
    expect(trips.filter(t => t === 'run' || t === 'exec')).toHaveLength(1);
  });
});
