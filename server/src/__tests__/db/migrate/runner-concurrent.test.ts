import fs from 'fs';
import os from 'os';
import path from 'path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../db/migrate/runner.js';
import { DEFAULT_MIGRATIONS } from '../../../db/migrate/defaults.js';

const tempDirs: string[] = [];
// Fixed dev key so the two worker boots do not race on the auto-generated
// .encryption-key file (the legacy baseline migration initialises it).
const TEST_ENCRYPTION_KEY = '0123456789abcdef'.repeat(4);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('migration runner concurrent boot', () => {
  it('two simultaneous async boots apply a pending migration exactly once', async () => {
    const migrationsDir = createMigrationsDir();
    writeMigration(migrationsDir, '20260608_000001_create_widgets.ts', `
      import type Database from 'better-sqlite3';

      export function up(db: Database.Database): void {
        db.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY)');
        db.prepare('INSERT INTO widgets (id) VALUES (1)').run();
      }

      export function down(db: Database.Database): void {
        db.exec('DROP TABLE widgets');
      }
    `);

    const dbPath = createDbFile();
    const dbA = openFileDb(dbPath);
    const dbB = openFileDb(dbPath);
    try {
      // Both boots start from the same snapshot: neither has seen the
      // migration applied yet. Without the lock the loser re-applies it and
      // crashes — the CREATE TABLE hits "table already exists" (or the
      // migrations INSERT hits the UNIQUE constraint).
      await Promise.all([
        runMigrations(dbA, 'up', { migrationsDir }),
        runMigrations(dbB, 'up', { migrationsDir }),
      ]);

      const applied = dbA.prepare('SELECT filename FROM migrations ORDER BY filename ASC').all() as { filename: string }[];
      expect(applied.map(row => row.filename)).toEqual(['20260608_000001_create_widgets.ts']);
      const rows = dbA.prepare('SELECT COUNT(*) AS count FROM widgets').get() as { count: number };
      expect(rows.count).toBe(1);
    } finally {
      dbA.close();
      dbB.close();
    }
  });

  it('two simultaneous sync boots apply the full default set exactly once', async () => {
    const dbPath = createDbFile();
    const results = await Promise.all([runBootWorker(dbPath), runBootWorker(dbPath)]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);

    const db = openFileDb(dbPath);
    try {
      const applied = db.prepare('SELECT filename FROM migrations ORDER BY filename ASC').all() as { filename: string }[];
      expect(applied.map(row => row.filename)).toEqual(DEFAULT_MIGRATIONS.map(migration => migration.filename));
    } finally {
      db.close();
    }
  }, 120_000);
});

function runBootWorker(dbPath: string): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./concurrent-boot-worker.ts', import.meta.url), {
      workerData: { dbPath, encryptionKey: TEST_ENCRYPTION_KEY },
      // Raw node cannot resolve the server's `.js` import specifiers to
      // their `.ts` sources; the register module installs the resolve hook
      // before the worker's entry module loads.
      execArgv: ['--import', new URL('./concurrent-boot-register.mjs', import.meta.url).href],
    });
    let settled = false;
    worker.once('message', (result: { ok: boolean; message?: string }) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      resolve(result);
    });
    worker.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.once('exit', code => {
      if (settled) return;
      settled = true;
      if (code !== 0) reject(new Error(`boot worker exited with code ${code}`));
      else resolve({ ok: false, message: 'boot worker exited without reporting' });
    });
  });
}

function createMigrationsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-migrations-'));
  tempDirs.push(dir);
  return dir;
}

function writeMigration(migrationsDir: string, filename: string, source: string): void {
  fs.writeFileSync(path.join(migrationsDir, filename), source.trimStart());
}

function createDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-migration-db-'));
  tempDirs.push(dir);
  return path.join(dir, 'concurrent.db');
}

/** A file connection configured the way connectDb() configures one: WAL
 * journal plus the 5s busy timeout production boots with. busy_timeout
 * goes first so a lock held by the other boot makes the journal_mode flip
 * wait instead of failing instantly. */
function openFileDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  return db;
}
