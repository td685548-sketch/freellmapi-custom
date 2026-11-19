import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { DEFAULT_MIGRATIONS } from '../../db/migrate/defaults.js';
import { snapshotBeforeMigrations } from '../../db/migration-snapshot.js';
import { getMigrationStatuses, runMigrationsSync, setBeforeMigrationsHook } from '../../db/migrate/runner.js';
import { down as rollbackQuotaVouchers } from '../../db/migrations/20261118_200000_custom_quota_vouchers_topups.js';

const LAST_MIGRATION = '20261118_200000_custom_quota_vouchers_topups.ts';
const BASELINE_MIGRATION = '20260101_000000_legacy_baseline.ts';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  // Global DB for the schedule read inside createBackup(); the databases
  // under test are separate file handles.
  initDb(':memory:');
});

afterEach(() => {
  setBeforeMigrationsHook(null);
  vi.restoreAllMocks();
});

/** Minimal file database with the tables a snapshot needs. */
function buildFileDb(dir: string, applied: string[]): { dbPath: string; db: Database.Database } {
  const dbPath = path.join(dir, 'freeapi.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      filepath TEXT,
      filesize INTEGER NOT NULL,
      is_full INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      tables_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE items (name TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('probe', 'v1');
  db.prepare('INSERT INTO items (name) VALUES (?)').run('keep-me');
  const insert = db.prepare('INSERT INTO migrations (filename) VALUES (?)');
  for (const filename of applied) insert.run(filename);
  return { dbPath, db };
}

describe('snapshotBeforeMigrations', () => {
  it('takes a pre-migration dump when migrations are pending on an existing database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-migration-snapshot-'));
    const { db } = buildFileDb(dir, [BASELINE_MIGRATION]);
    try {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotBeforeMigrations(db);

      expect(log).toHaveBeenCalledWith(expect.stringContaining('pre-migration snapshot'));
      const dumps = fs.readdirSync(path.join(dir, 'backups'));
      expect(dumps).toHaveLength(1);
      expect(dumps[0]).toMatch(/^pre-migration-.*\.sql$/);
      const dump = fs.readFileSync(path.join(dir, 'backups', dumps[0]), 'utf8');
      expect(dump).toContain('keep-me');
      const row = db.prepare("SELECT source, filename FROM backups WHERE source = 'pre-migration'").get() as
        | { source: string; filename: string }
        | undefined;
      expect(row?.source).toBe('pre-migration');
      expect(row?.filename).toBe(dumps[0]);
    } finally {
      db.close();
    }
  });

  it('takes no snapshot on a fresh database with nothing applied', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-migration-snapshot-fresh-'));
    const { db } = buildFileDb(dir, []);
    try {
      snapshotBeforeMigrations(db);
      expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('takes no snapshot (and does not throw) when the backups table is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-migration-snapshot-nobackups-'));
    const dbPath = path.join(dir, 'freeapi.db');
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL UNIQUE,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.prepare('INSERT INTO migrations (filename) VALUES (?)').run(BASELINE_MIGRATION);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => snapshotBeforeMigrations(db)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('backups table does not exist'));
      expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('pre-migration snapshot hook', () => {
  it('snapshots before a pending migration runs, with the pre-migration state in the dump', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-migration-snapshot-hook-'));
    const dbPath = path.join(dir, 'freeapi.db');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Full real schema, then roll the last migration back by hand so it is
    // pending again.
    initDb(dbPath);
    const db = getDb();
    try {
      rollbackQuotaVouchers(db);
      db.prepare('DELETE FROM migrations WHERE filename = ?').run(LAST_MIGRATION);
      expect(getMigrationStatuses(db).filter(s => s.status === 'pending')).toHaveLength(1);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'custom_quota_vouchers'").get())
        .toBeUndefined();

      setBeforeMigrationsHook(snapshotBeforeMigrations);
      runMigrationsSync(db, 'up');

      // The migration re-applied…
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'custom_quota_vouchers'").get())
        .toBeTruthy();
      // …but the snapshot was taken before it ran, so the dump has no trace
      // of the tables it creates.
      const row = db.prepare("SELECT filename, filepath FROM backups WHERE source = 'pre-migration'").get() as
        | { filename: string; filepath: string }
        | undefined;
      expect(row).toBeTruthy();
      expect(row!.filename).toMatch(/^pre-migration-.*\.sql$/);
      const dump = fs.readFileSync(row!.filepath, 'utf8');
      expect(dump).not.toContain('custom_quota_vouchers');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('pre-migration snapshot'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining(LAST_MIGRATION));
    } finally {
      db.close?.();
    }
  });

  it('a failing snapshot never blocks the migration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-migration-snapshot-fail-'));
    const dbPath = path.join(dir, 'freeapi.db');
    initDb(dbPath);
    const db = getDb();
    try {
      rollbackQuotaVouchers(db);
      db.prepare('DELETE FROM migrations WHERE filename = ?').run(LAST_MIGRATION);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setBeforeMigrationsHook(() => {
        throw new Error('disk is full (simulated)');
      });
      expect(() => runMigrationsSync(db, 'up')).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('pre-migration snapshot failed'));
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'custom_quota_vouchers'").get())
        .toBeTruthy();
    } finally {
      db.close?.();
    }
  });

  it('initDb logs the schema version at boot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-migration-snapshot-version-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dbPath = path.join(dir, 'freeapi.db');
    initDb(dbPath);
    try {
      const lines = log.mock.calls.map(call => String(call[0]));
      const version = lines.find(line => line.includes('schema version'));
      // The boot log names the newest registered migration; derive it from
      // the registry instead of hardcoding so the next migration does not
      // break this test again.
      const latest = DEFAULT_MIGRATIONS[DEFAULT_MIGRATIONS.length - 1].filename;
      expect(version).toMatch(
        new RegExp(`schema version: \\d+ migrations applied, latest ${latest.replace('.', '\\.')}`),
      );
    } finally {
      getDb().close?.();
    }
  });
});
