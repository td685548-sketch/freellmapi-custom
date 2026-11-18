import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyLocalSqlitePerformancePragmas } from '../../custom/sqlite-performance.js';

describe('sqlite-performance', () => {
  it('skips in-memory SQLite databases cleanly', () => {
    const memDb = new Database(':memory:');
    try {
      const res = applyLocalSqlitePerformancePragmas(memDb, {});
      expect(res).toEqual({ applied: false, reason: 'in_memory' });
    } finally {
      memDb.close();
    }
  });

  it('applies WAL throughput pragmas on file-backed local SQLite and respects FREEAPI_SQLITE_TUNING=0', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flm-sqlite-perf-'));
    const dbFile = path.join(tmpDir, 'test.db');
    const fileDb = new Database(dbFile);
    try {
      fileDb.pragma('journal_mode = WAL');

      const skipped = applyLocalSqlitePerformancePragmas(fileDb, {
        FREEAPI_SQLITE_TUNING: '0',
      });
      expect(skipped).toEqual({ applied: false, reason: 'disabled_by_override' });

      const applied = applyLocalSqlitePerformancePragmas(fileDb, {});
      expect(applied.applied).toBe(true);
      expect(applied.reason).toBe('applied');

      // SQLite synchronous: 1 = NORMAL, temp_store: 2 = MEMORY
      expect(fileDb.pragma('synchronous', { simple: true })).toBe(1);
      expect(fileDb.pragma('cache_size', { simple: true })).toBe(-65536);
      expect(fileDb.pragma('temp_store', { simple: true })).toBe(2);
      expect(fileDb.pragma('journal_size_limit', { simple: true })).toBe(67108864);
    } finally {
      fileDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
