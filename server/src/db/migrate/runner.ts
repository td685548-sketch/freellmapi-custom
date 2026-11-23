import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import type { Db } from '../types.js';
import { DEFAULT_MIGRATIONS, type MigrationModule } from './defaults.js';

export type MigrationDirection = 'up' | 'down';
export type MigrationState = 'applied' | 'pending';

/**
 * Hook run before pending migrations are applied. Registered by the entry
 * points that own a database (server/src/index.ts, the migration CLI) so the
 * migration engine itself stays free of backup machinery: the hook takes the
 * snapshot (server/src/db/migration-snapshot.ts), the runner only decides
 * when — before an 'up' run that actually has pending migrations. A hook
 * failure never blocks the migration; the runner logs it and carries on.
 * Tests reset it with setBeforeMigrationsHook(null).
 */
export type BeforeMigrationsHook = (db: Db) => void;

let beforeMigrationsHook: BeforeMigrationsHook | null = null;

export function setBeforeMigrationsHook(hook: BeforeMigrationsHook | null): void {
  beforeMigrationsHook = hook;
}

function runBeforeMigrationsHook(db: Db): void {
  if (!beforeMigrationsHook) return;
  try {
    beforeMigrationsHook(db);
  } catch (err) {
    console.warn(
      `[migrations] pre-migration snapshot failed (${err instanceof Error ? err.message : String(err)}) — continuing without one`,
    );
  }
}

export interface MigrationRunnerOptions {
  migrationsDir?: string;
  migrationFileExtension?: '.ts' | '.js';
}

export interface MigrationStatus {
  filename: string;
  status: MigrationState;
  appliedAt: string | null;
}

interface AppliedMigrationRow {
  filename: string;
  applied_at: string;
}

interface MigrationRecord {
  filename: string;
  module?: MigrationModule;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

export async function runMigrations(
  db: Db,
  direction: MigrationDirection = 'up',
  options: MigrationRunnerOptions = {},
): Promise<void> {
  initializeMigrationTracking(db);
  const records = getMigrationRecords(options);

  if (direction === 'up') {
    await runPendingMigrations(db, records, options);
    return;
  }

  if (direction === 'down') {
    await runLatestDownMigration(db, records, options);
    return;
  }

  throw new Error(`Unknown migration direction: ${direction}`);
}

export function runMigrationsSync(
  db: Db,
  direction: MigrationDirection = 'up',
): void {
  initializeMigrationTracking(db);
  const records = getDefaultMigrationRecords();

  if (direction === 'up') {
    runPendingMigrationsSync(db, records);
    return;
  }

  if (direction === 'down') {
    runLatestDownMigrationSync(db, records);
    return;
  }

  throw new Error(`Unknown migration direction: ${direction}`);
}

export function getMigrationStatuses(
  db: Db,
  options: MigrationRunnerOptions = {},
): MigrationStatus[] {
  initializeMigrationTracking(db);

  const applied = getAppliedMigrations(db);
  return getMigrationRecords(options).map(record => ({
    filename: record.filename,
    status: applied.has(record.filename) ? 'applied' : 'pending',
    appliedAt: applied.get(record.filename) ?? null,
  }));
}

function initializeMigrationTracking(db: Db): void {
  ensureMigrationsTable(db);
}

function ensureMigrationsTable(db: Db): void {
  db.exec(CREATE_MIGRATIONS_TABLE_SQL);
}

async function runPendingMigrations(
  db: Db,
  records: readonly MigrationRecord[],
  options: MigrationRunnerOptions,
): Promise<void> {
  const applied = getAppliedMigrations(db);
  const pending = records.filter(record => !applied.has(record.filename));
  if (pending.length === 0) return;
  runBeforeMigrationsHook(db);

  // Load every pending module before taking the write lock: a dynamic import
  // can take a while, and holding the lock across it would stall the other
  // boot for no reason.
  const loaded: LoadedMigration[] = [];
  for (const record of pending) {
    loaded.push({ filename: record.filename, module: await loadMigrationModule(record, options) });
  }

  await runLockedWithRetriesAsync(db, loaded);
}

async function runLatestDownMigration(
  db: Db,
  records: readonly MigrationRecord[],
  options: MigrationRunnerOptions,
): Promise<void> {
  const row = db.prepare(`
    SELECT filename
      FROM migrations
     ORDER BY id DESC
     LIMIT 1
  `).get() as { filename: string } | undefined;

  if (!row) return;

  const record = records.find(record => record.filename === row.filename);
  if (!record) throw new Error(`Migration file not found: ${row.filename}`);

  const migration = await loadMigrationModule(record, options);
  const revertMigration = db.transaction(() => {
    migration.down(db);
    db.prepare('DELETE FROM migrations WHERE filename = ?').run(row.filename);
  });

  revertMigration();
}

function runPendingMigrationsSync(
  db: Db,
  records: readonly MigrationRecord[],
): void {
  const applied = getAppliedMigrations(db);
  const pending = records.filter(record => !applied.has(record.filename));
  if (pending.length === 0) return;
  runBeforeMigrationsHook(db);

  for (const record of pending) {
    if (!record.module) throw new Error(`Migration ${record.filename} cannot run synchronously`);
  }

  runLockedWithRetries(
    db,
    pending.map(record => ({ filename: record.filename, module: record.module! })),
  );
}

function runLatestDownMigrationSync(
  db: Db,
  records: readonly MigrationRecord[],
): void {
  const row = db.prepare(`
    SELECT filename
      FROM migrations
     ORDER BY id DESC
     LIMIT 1
  `).get() as { filename: string } | undefined;

  if (!row) return;

  const record = records.find(record => record.filename === row.filename);
  if (!record?.module) throw new Error(`Migration ${row.filename} cannot run synchronously`);

  const revertMigration = db.transaction(() => {
    record.module!.down(db);
    db.prepare('DELETE FROM migrations WHERE filename = ?').run(row.filename);
  });

  revertMigration();
}

interface LoadedMigration {
  filename: string;
  module: MigrationModule;
}

/**
 * Why two processes booting at once used to crash: each computed its pending
 * list from a snapshot, then applied migrations one transaction at a time.
 * The loser re-applied a migration the winner had just committed and died on
 * the UNIQUE constraint on migrations.filename (or on SQLITE_BUSY while the
 * winner held the write lock). The fix is to hold one write lock across the
 * whole re-read + apply, so the loser waits instead of racing.
 *
 * The lock is taken through db.transaction() — never a raw BEGIN IMMEDIATE —
 * because migrations themselves call db.transaction() (legacy baseline,
 * request aggregates), and every driver in the tree (better-sqlite3,
 * node:sqlite, the Turso wrapper) nests transaction() calls with savepoints,
 * while a raw BEGIN would make the next transaction() call fail with
 * "cannot start a transaction within a transaction" on the wrapped drivers.
 *
 * A deferred transaction takes no lock until its first write, so the first
 * statement inside is a DELETE that matches no row (filenames are never
 * empty). It changes nothing and rolls back with the transaction, but it
 * forces the RESERVED lock: verified empirically, a second connection gets
 * SQLITE_BUSY on its own write while the first holds it. CREATE TABLE IF
 * NOT EXISTS on an existing table does NOT take the lock, so it cannot be
 * the forcing write.
 *
 * On Turso the wrapper already retries SQLITE_BUSY per statement with its
 * startup budget; the runner-level retry below covers local SQLite, where a
 * busy_timeout of 5s is the only wait before the DELETE throws.
 */
function applyPendingMigrationsLocked(db: Db, loaded: readonly LoadedMigration[]): void {
  const applyAll = db.transaction(() => {
    db.prepare('DELETE FROM migrations WHERE filename = ?').run('');
    const applied = getAppliedMigrations(db);
    for (const { filename, module } of loaded) {
      if (applied.has(filename)) continue;
      const applyMigration = db.transaction(() => {
        module.up(db);
        db.prepare('INSERT INTO migrations (filename) VALUES (?)').run(filename);
      });
      applyMigration();
      applied.set(filename, new Date().toISOString());
    }
  });
  applyAll();
}

/** Backoff between lock-acquire retries, in milliseconds. Each attempt also
 * waits up to the connection's busy_timeout inside SQLite before giving up,
 * so the total wait is roughly a minute — long enough for a concurrent boot
 * to finish even a full migration run (116 migrations take ~0.2s on a
 * warm disk), short enough that a genuinely stuck lock still fails boot
 * loudly instead of hanging forever. */
const MIGRATION_LOCK_RETRY_MS = [100, 200, 400, 800, 1500, 2500, 3500, 5000];

const lockSleeper = new Int32Array(new SharedArrayBuffer(4));
/** Synchronous sleep: the sync runner cannot await, and the driver is
 * synchronous anyway (same pattern as the Turso busy-retry sleep). */
function sleepSync(ms: number): void {
  Atomics.wait(lockSleeper, 0, 0, ms);
}

function sleepAsync(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isMigrationBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === 'SQLITE_BUSY' || /\bSQLITE_BUSY\b|database is locked/i.test(error.message);
}

/** Milliseconds to wait before the next lock attempt, or undefined when the
 * error is not a lock contention (a genuinely broken migration must still
 * fail boot loudly) or the retry budget is spent. */
function lockRetryDelay(error: unknown, attempt: number): number | undefined {
  if (!isMigrationBusyError(error)) return undefined;
  return MIGRATION_LOCK_RETRY_MS[attempt];
}

function runLockedWithRetries(db: Db, loaded: readonly LoadedMigration[]): void {
  for (let attempt = 0; ; attempt++) {
    try {
      applyPendingMigrationsLocked(db, loaded);
      return;
    } catch (error) {
      const wait = lockRetryDelay(error, attempt);
      if (wait === undefined) throw error;
      noteLockRetry(wait, attempt);
      sleepSync(wait);
    }
  }
}

async function runLockedWithRetriesAsync(db: Db, loaded: readonly LoadedMigration[]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      applyPendingMigrationsLocked(db, loaded);
      return;
    } catch (error) {
      const wait = lockRetryDelay(error, attempt);
      if (wait === undefined) throw error;
      noteLockRetry(wait, attempt);
      await sleepAsync(wait);
    }
  }
}

/** Say once per retry that startup is waiting for another writer: otherwise
 * a long wait looks like a hang. */
function noteLockRetry(wait: number, attempt: number): void {
  console.warn(
    `[migrations] database is locked by another process applying migrations — retrying in ${wait}ms (attempt ${attempt + 1})`,
  );
}

function getAppliedMigrations(db: Db): Map<string, string> {
  const rows = db.prepare(`
    SELECT filename, applied_at
      FROM migrations
     ORDER BY filename ASC
  `).all() as AppliedMigrationRow[];

  return new Map(rows.map(row => [row.filename, row.applied_at]));
}

function getMigrationRecords(options: MigrationRunnerOptions): MigrationRecord[] {
  if (isDefaultMigrationSet(options)) return getDefaultMigrationRecords();

  return getMigrationFilenames(options).map(filename => ({ filename }));
}

function getDefaultMigrationRecords(): MigrationRecord[] {
  return DEFAULT_MIGRATIONS.map(migration => ({
    filename: migration.filename,
    module: migration.module,
  }));
}

function getMigrationFilenames(options: MigrationRunnerOptions): string[] {
  const migrationsDir = getMigrationsDir(options);
  if (!fs.existsSync(migrationsDir)) return [];

  const extension = getMigrationFileExtension(options);
  return fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(filename => filename.endsWith(extension) && !filename.endsWith('.d.ts'))
    .sort((left, right) => left.localeCompare(right));
}

async function loadMigrationModule(
  record: MigrationRecord,
  options: MigrationRunnerOptions,
): Promise<MigrationModule> {
  if (record.module) return record.module;

  const migrationPath = path.join(getMigrationsDir(options), record.filename);
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`Migration file not found: ${record.filename}`);
  }

  const imported = await import(pathToFileURL(migrationPath).href) as Partial<MigrationModule>;
  if (typeof imported.up !== 'function' || typeof imported.down !== 'function') {
    throw new Error(`Migration ${record.filename} must export up(db) and down(db) functions`);
  }

  return {
    up: imported.up,
    down: imported.down,
  };
}

function isDefaultMigrationSet(options: MigrationRunnerOptions): boolean {
  return options.migrationsDir === undefined && options.migrationFileExtension === undefined;
}

function getMigrationsDir(options: MigrationRunnerOptions): string {
  return options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
}

function getMigrationFileExtension(options: MigrationRunnerOptions): '.ts' | '.js' {
  if (options.migrationFileExtension) return options.migrationFileExtension;
  return fileURLToPath(import.meta.url).endsWith('.ts') ? '.ts' : '.js';
}
