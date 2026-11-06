import Database from 'libsql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { inlineParams, sqlLiteral, wrapTursoDatabase } from '../../db/turso.js';
import type { Db } from '../../db/types.js';
import { newRequestTrace, runWithRequestTrace } from '../../lib/attempt-trace.js';
import { logRequest } from '../../lib/request-log.js';

// Writing the request log in one round trip must store exactly what the
// transaction path stores, whatever the text, and must be all-or-nothing.

const NASTY = [
  "it's a \"quoted\" error; DROP TABLE requests;--",
  'line1\nline2\ttab \\ backslash ? question /* c */ -- c',
  'emoji 🙂 and ünïcödé and %s %1$s ${x}',
  '',
];

function open(): { raw: Db; executed: string[] } {
  const executed: string[] = [];
  const raw = new Database(':memory:') as unknown as Db;
  const exec = raw.exec.bind(raw);
  raw.exec = (sql: string) => { executed.push(sql); return exec(sql); };
  initDb(':memory:', { factory: () => wrapTursoDatabase(raw, true) });
  return { raw, executed };
}

const snapshot = () => {
  const db = getDb();
  return {
    requests: db.prepare('SELECT platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms, requested_model, served_model, caller, failure_attribution FROM requests ORDER BY id').all(),
    hourly: db.prepare('SELECT total_requests, success_count, error_count, input_tokens, output_tokens FROM request_hourly').all(),
    counters: db.prepare("SELECT key, value FROM settings WHERE key IN ('total_requests','total_input_tokens','total_output_tokens') ORDER BY key").all(),
  };
};

function logAll(): void {
  NASTY.forEach((text, i) => {
    logRequest('groq', `model-${i}`, null, i % 2 ? 'error' : 'success', 10 + i, 5, 120, text, i % 2 ? null : 33, i === 0 ? 'pin' : null, null, 'http', null);
  });
  logRequest('groq', 'm', null, 'canceled', 0, 0, 5, null);
}

describe('request log written in one round trip', () => {
  beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); });
  afterEach(() => vi.unstubAllEnvs());

  it('stores exactly what the transaction path stores', () => {
    open(); logAll();
    const expected = snapshot();
    open(); vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1'); logAll();
    expect(snapshot()).toEqual(expected);
  });

  it('is a single script and reports the new row id to the attempt trace', () => {
    const { executed } = open();
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    executed.length = 0;
    const trace = newRequestTrace();
    runWithRequestTrace(trace, () => { logRequest('groq', 'm', null, 'success', 1, 1, 1, null); });
    const scripts = executed.filter(s => /INSERT INTO requests/.test(s));
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(/^BEGIN;[\s\S]*COMMIT$/);
    expect(trace.lastRequestRowId).toBe((getDb().prepare('SELECT MAX(id) AS id FROM requests').get() as { id: number }).id);
  });

  it('rolls everything back when a statement fails', () => {
    open();
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    const before = snapshot();
    getDb().exec("CREATE TRIGGER no_rows BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(logRequest('groq', 'm', null, 'success', 1, 1, 1, null)).toBe(false);
    getDb().exec('DROP TRIGGER no_rows');
    expect(snapshot()).toEqual(before);
    expect(before.requests).toEqual([]);
    expect(logRequest('groq', 'm', null, 'success', 1, 1, 1, null)).toBe(true); // connection is usable again
  });

  it('is off by default', () => {
    const { executed } = open();
    executed.length = 0;
    logRequest('groq', 'm', null, 'success', 1, 1, 1, null);
    expect(executed.some(s => /^BEGIN;/.test(s))).toBe(false);
  });
});

describe('SQL literal inlining', () => {
  it('quotes strings and renders every supported type', () => {
    expect(sqlLiteral("o'neil")).toBe("'o''neil'");
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(undefined)).toBe('NULL');
    expect(sqlLiteral(12.5)).toBe('12.5');
    expect(sqlLiteral(10n)).toBe('10');
    expect(sqlLiteral(true)).toBe('1');
    expect(sqlLiteral(new Uint8Array([0, 255, 16]))).toBe("X'00ff10'");
  });
  it('refuses what SQL text cannot carry', () => {
    expect(() => sqlLiteral('a\0b')).toThrow(/NUL/);
    expect(() => sqlLiteral(NaN)).toThrow();
    expect(() => sqlLiteral({})).toThrow();
  });
  it('substitutes only real placeholders, in order', () => {
    expect(inlineParams("INSERT INTO t VALUES (?, '?', ?) -- ? \n /* ? */", ['a', 2])).toBe("INSERT INTO t VALUES ('a', '?', 2) -- ? \n /* ? */");
    expect(() => inlineParams('SELECT ?', [])).toThrow();
    expect(() => inlineParams('SELECT 1', [1])).toThrow();
  });
});
