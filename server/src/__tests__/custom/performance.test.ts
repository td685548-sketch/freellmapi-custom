import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { PerformanceMetrics, installPerformanceMetrics, measureDb, measureStartup, startManualPerformanceMetrics, stopPerformanceMetrics } from '../../custom/performance/metrics.js';
import { observeDatabase } from '../../custom/performance/database.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { defaultDbFactory } from '../../db/index.js';
import { isTursoDatabase } from '../../db/turso.js';
import { readRoutingSetting, withRoutingSettingsScope } from '../../db/routing-settings-scope.js';

afterEach(() => { stopPerformanceMetrics(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function request(metrics: PerformanceMetrics, path: string, next: () => void, method = 'GET') {
  const response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
  metrics.middleware({ method, path, originalUrl: `${path}?token=secret` } as Request,
    response as unknown as Response, next as NextFunction);
  return response;
}
function finish(response: ReturnType<typeof request>) {
  response.writableFinished = true;
  response.emit('finish'); response.emit('close');
}

describe('performance measurement', () => {
  it('keeps interleaved request scopes separate and ignores late work', async () => {
    const metrics = new PerformanceMetrics();
    let releaseA!: () => void, releaseB!: () => void;
    let doneA!: Promise<void>, doneB!: Promise<void>;
    const a = request(metrics, '/api/keys', () => {
      doneA = (async () => {
        measureDb('execute', () => 1);
        await new Promise<void>(resolve => { releaseA = resolve; });
        measureDb('execute', () => 2);
      })();
    });
    const b = request(metrics, '/api/logs', () => {
      doneB = (async () => {
        await new Promise<void>(resolve => { releaseB = resolve; });
        measureDb('execute', () => 3);
      })();
    });
    releaseB(); await doneB; finish(b);
    finish(a); releaseA(); await doneA;
    const rows = metrics.snapshot().routes;
    expect(rows.find(row => row.route === '/api/logs')).toMatchObject({ db_calls: 1, requests: 1 });
    expect(rows.find(row => row.route === '/api/keys')).toMatchObject({ db_calls: 1, requests: 1 });
    expect(rows).toHaveLength(2);
  });

  it('counts disconnect only once and never treats it as success', () => {
    const metrics = new PerformanceMetrics();
    const res = request(metrics, '/api/keys', () => measureDb('execute', () => 1));
    res.emit('close'); finish(res);
    expect(metrics.snapshot().routes[0]).toMatchObject({ requests: 1, aborted: 1, success: 0 });
    expect(res.listenerCount('finish') + res.listenerCount('close')).toBe(0);
  });

  it('retains only fixed labels and numeric aggregates, resets windows', () => {
    const metrics = new PerformanceMetrics();
    const error = new Error('secret SQL bind password provider-token');
    const response = request(metrics, '/api/keys', () => {
      expect(() => measureDb('execute', () => { throw error; })).toThrow(error);
    });
    response.statusCode = 403; finish(response);
    for (let i = 0; i < 1000; i++) finish(request(metrics, `/api/users/private-${i}`, () => {}));
    finish(request(metrics, '/api/keys', () => {}, 'POST'));
    const snapshot = metrics.snapshot(true);
    expect(snapshot.routes).toHaveLength(1);
    expect(snapshot.routes[0]).toMatchObject({ client_errors: 1, db_errors: 1 });
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|password|provider-token|private-|originalUrl|SQL/);
    expect(metrics.snapshot().routes).toEqual([]);
  });

  it('has no timer or DB wrapper when disabled and one timer across app installs', () => {
    vi.useFakeTimers(); vi.stubEnv('CUSTOM_PERF_METRICS', '0');
    const next = vi.fn();
    installPerformanceMetrics()({} as Request, {} as Response, next);
    const raw = defaultDbFactory()(':memory:');
    try { expect(observeDatabase(raw)).toBe(raw); } finally { raw.close?.(); }
    expect(next).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    vi.stubEnv('CUSTOM_PERF_METRICS', '1');
    installPerformanceMetrics(); installPerformanceMetrics();
    expect(vi.getTimerCount()).toBe(1);
    stopPerformanceMetrics(); expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves bindings, freshness, metadata and nested transaction rollback', () => {
    vi.stubEnv('CUSTOM_PERF_METRICS', '1');
    const raw = defaultDbFactory()(':memory:');
    const db = observeDatabase(raw);
    try {
      db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)');
      const statement = db.prepare('SELECT value FROM sample WHERE id = ?');
      expect(db.memory).toBe(true); expect(db.name).toBe(raw.name);
      const transaction = db.transaction((value: string) => {
        db.prepare('INSERT INTO sample VALUES (@id, @value)').run({ id: 1, value });
        expect(() => db.transaction(() => { db.prepare('UPDATE sample SET value = ?').run('bad'); throw new Error('rollback'); })()).toThrow('rollback');
        return statement.get(1);
      });
      expect(transaction('first')).toEqual({ value: 'first' });
      db.prepare('UPDATE sample SET value = ?').run('second');
      expect(statement.get(1)).toEqual({ value: 'second' });
    } finally { db.close?.(); }
  });

  it('measures execution in its current request even if prepared earlier', () => {
    vi.stubEnv('CUSTOM_PERF_METRICS', '1');
    const db = observeDatabase(defaultDbFactory()(':memory:'));
    try {
      const stmt = db.prepare('SELECT 1 AS n');
      const metrics = new PerformanceMetrics();
      finish(request(metrics, '/api/keys', () => expect(stmt.get()).toEqual({ n: 1 })));
      expect(metrics.snapshot().routes[0]).toMatchObject({ prepare_calls: 0, db_calls: 1 });
    } finally { db.close?.(); }
  });

  it('distinguishes native prepare misses from logical prepare and execution', () => {
    vi.stubEnv('CUSTOM_PERF_METRICS', '1');
    const db = observeDatabase(wrapTursoDatabase(defaultDbFactory()(':memory:'), true));
    const metrics = new PerformanceMetrics();
    try {
      finish(request(metrics, '/api/keys', () => {
        db.prepare('SELECT 1 AS n').get(); db.prepare('SELECT 1 AS n').get();
      }));
      expect(metrics.snapshot().routes[0]).toMatchObject({ prepare_calls: 2, native_prepare_calls: 1, db_calls: 2 });
    } finally { db.close?.(); }
  });

  it('reports failed startup phases without replacing or logging the exception', () => {
    vi.stubEnv('CUSTOM_PERF_METRICS', '1');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = new Error('secret-token');
    try {
      expect(() => measureStartup('database_init', () => measureDb('execute', () => { throw error; }))).toThrow(error);
      const record = JSON.parse(log.mock.calls[0][1] as string);
      expect(record).toMatchObject({ phase: 'database_init', completed: false, db_calls: 1, db_errors: 1 });
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret-token');
    } finally { log.mockRestore(); }
  });

  it('preserves Turso identity and invalidates settings after writes and rollback', () => {
    vi.stubEnv('CUSTOM_PERF_METRICS', '1');
    vi.stubEnv('FREEAPI_DB_DRIVER', 'sqlite'); // remote marker must also survive without env detection
    const raw = wrapTursoDatabase(defaultDbFactory()(':memory:'), true);
    const db = observeDatabase(raw);
    try {
      expect(db).toBe(raw); expect(observeDatabase(db)).toBe(db);
      expect(isTursoDatabase(db)).toBe(true);
      db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('routing_strategy', 'speed')");
      const read = () => readRoutingSetting(db, 'routing_strategy', () => 'unexpected fallback');
      withRoutingSettingsScope(() => {
        expect(read()).toBe('speed');
        db.prepare("UPDATE settings SET value = 'balanced'").run();
        expect(read()).toBe('balanced');
        expect(() => db.transaction(() => {
          db.prepare("UPDATE settings SET value = 'cost'").run();
          expect(read()).toBe('cost');
          throw new Error('rollback');
        })()).toThrow('rollback');
        expect(read()).toBe('balanced');
      });
    } finally { db.close?.(); }
  });

  it('does not periodically reset long benchmark workloads', () => {
    vi.useFakeTimers(); vi.stubEnv('CUSTOM_PERF_METRICS', '1');
    startManualPerformanceMetrics(); installPerformanceMetrics();
    expect(vi.getTimerCount()).toBe(0);
    const metrics = new PerformanceMetrics();
    metrics.start();
    finish(request(metrics, '/api/keys', () => measureDb('execute', () => 1)));
    vi.advanceTimersByTime(120_000);
    expect(metrics.snapshot().routes[0]).toMatchObject({ requests: 1, db_calls: 1 });
    metrics.stop();
  });

  it('keeps aggregate output bounded across 10000 requests and repeated windows', () => {
    const metrics = new PerformanceMetrics();
    for (let window = 0; window < 10; window++) {
      for (let i = 0; i < 1000; i++) finish(request(metrics, '/api/logs', () => measureDb('execute', () => 1)));
      const snapshot = metrics.snapshot(true);
      expect(snapshot.routes).toHaveLength(1);
      expect(snapshot.routes[0]).toMatchObject({ requests: 1000, db_calls: 1000 });
      expect(JSON.stringify(snapshot).length).toBeLessThan(2000);
      expect(metrics.snapshot().routes).toEqual([]);
    }
  });
});
