// Worker for the concurrent-boot test (runner-concurrent.test.ts): boots the
// full default migration set against a real file DB in a separate thread, so
// two boots genuinely overlap in time.
//
// This file is loaded by raw node, not by vitest, so it must use only
// erasable TypeScript: no enums, namespaces, or parameter properties.
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { runMigrationsSync } from '../../../db/migrate/runner.js';

const { dbPath, encryptionKey } = workerData as { dbPath: string; encryptionKey: string };
// The legacy baseline migration initialises the encryption key; a fixed env
// key keeps both workers from racing on the auto-generated key file. The
// runner import above does not read this variable at import time.
process.env.ENCRYPTION_KEY = encryptionKey;

let db: Database.Database | null = null;
try {
  db = new Database(dbPath);
  // busy_timeout first: with the default 0 timeout, any lock contention in
  // the journal_mode flip below (or in the other boot's open) fails
  // instantly instead of waiting.
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  runMigrationsSync(db, 'up');
  parentPort!.postMessage({ ok: true });
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack ?? null : null,
    code: (error as { code?: unknown } | null)?.code ?? null,
  });
} finally {
  try {
    db?.close();
  } catch {
    // The boot result is already reported; a close failure must not mask it.
  }
}
