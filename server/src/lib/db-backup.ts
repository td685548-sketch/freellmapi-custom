import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'node:module';
import { promisify } from 'util';
import { gzip, gunzipSync } from 'zlib';
import type { Db } from '../db/types.js';
import type { Scheduler } from './scheduler.js';
import { getDefaultDbPath } from '../db/index.js';
import { isTursoDatabase, tursoEnabled } from '../db/turso.js';
import { restrictToOwner } from './file-permissions.js';

// Compressing a whole database is the one expensive step of a backup (about 0.7 s for a 27 MB
// file with gzipSync, growing with the file). The async form runs on the libuv thread pool, so
// requests keep being served while it works.
const gzipAsync = promisify(gzip);

const MAGIC = Buffer.from('FAPIBK1\0');
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
const PLACEHOLDER_KEY = 'replace-with-64-char-hex';

/**
 * Local-file generations. The old code overwrote the single backup target on
 * every run, so one torn or corrupt write destroyed the only copy. A local
 * target now keeps up to FREEAPI_DB_BACKUP_RETENTION generations (default 7,
 * counting the live target): `target`, `target.1`, …, `target.6`. The newest
 * write lands atomically (tmp file + rename) and the previous target is
 * shifted down a generation first, so a failed run never leaves the install
 * without a restorable backup — restoreDbBackupIfNeeded falls back to the
 * newest surviving generation when the live target is missing. HTTP(S)
 * targets keep no local generations: the remote service owns versioning, and
 * a local copy would just be a second source of truth to keep in sync.
 */
const DEFAULT_BACKUP_RETENTION = 7;
const MAX_GENERATION_SCAN = 1000;

export function getBackupRetention(): number {
  const raw = process.env.FREEAPI_DB_BACKUP_RETENTION;
  if (raw === undefined || raw.trim() === '') return DEFAULT_BACKUP_RETENTION;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_BACKUP_RETENTION;
  return parsed;
}

/**
 * How often a full test-restore runs: every Nth successful local backup the
 * written blob is decrypted, gunzipped and opened as a throwaway SQLite
 * database with PRAGMA integrity_check, instead of only checking the SQLite
 * magic header (which every backup gets). Default 12 — about hourly at the
 * 5-minute interval. 0 disables it.
 */
const DEFAULT_TEST_RESTORE_EVERY = 12;

export function getTestRestoreEvery(): number {
  const raw = process.env.FREEAPI_DB_BACKUP_TEST_RESTORE_EVERY;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TEST_RESTORE_EVERY;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_TEST_RESTORE_EVERY;
  return parsed;
}

export interface DbBackupResult {
  ok: boolean;
  target?: string;
  bytes?: number;
  restored?: boolean;
  skipped?: string;
  /** True when this run also passed a full open-and-integrity_check restore. */
  testRestored?: boolean;
}

function backupTarget(): string | null {
  const raw = process.env.FREEAPI_DB_BACKUP_TARGET
    ?? process.env.FREEAPI_DB_BACKUP_URL
    ?? process.env.FREEAPI_DB_BACKUP_PATH
    ?? '';
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isDbBackupConfigured(): boolean {
  return backupTarget() !== null;
}

function backupIntervalMs(): number {
  const raw = process.env.FREEAPI_DB_BACKUP_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_INTERVAL_MS;
}

function isHttpTarget(target: string): boolean {
  return target.startsWith('https://') || target.startsWith('http://');
}

function parseBackupKey(): Buffer {
  const raw = (process.env.FREEAPI_DB_BACKUP_KEY || process.env.ENCRYPTION_KEY || '').trim();
  if (!raw || raw === PLACEHOLDER_KEY || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error('FREEAPI_DB_BACKUP_KEY or ENCRYPTION_KEY must be a 64-character hex key when DB backup is enabled');
  }
  return Buffer.from(raw, 'hex');
}

function encryptBackup(plain: Buffer): Buffer {
  const key = parseBackupKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

function decryptBackup(payload: Buffer): Buffer {
  if (payload.length < MAGIC.length + 12 + 16 || !payload.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('backup payload has an unsupported format');
  }
  const key = parseBackupKey();
  const ivStart = MAGIC.length;
  const tagStart = ivStart + 12;
  const bodyStart = tagStart + 16;
  const iv = payload.subarray(ivStart, tagStart);
  const tag = payload.subarray(tagStart, bodyStart);
  const ciphertext = payload.subarray(bodyStart);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Split a Hugging Face `/resolve/` download URL into the pieces the commit API
 * needs, or null for anything else.
 *
 * A HF repo serves downloads at `/{type}/{ns}/{repo}/resolve/{rev}/{path}`, but
 * that route is read-only: a PUT to it is answered 404/405 and the blob never
 * lands. Writes go through the commit API instead. Both halves are derived from
 * the one URL the operator configures, so FREEAPI_DB_BACKUP_TARGET stays the
 * plain download URL they can paste into a browser.
 *
 * Models are the type with no prefix segment (`/{ns}/{repo}/resolve/...`);
 * datasets and spaces name themselves. The API path pluralizes the type.
 */
export function parseHuggingFaceTarget(target: string): { commitUrl: string; filePath: string } | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.hostname !== 'huggingface.co') return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const prefixed = segments[0] === 'datasets' || segments[0] === 'spaces';
  const type = prefixed ? segments[0] : 'models';
  const rest = prefixed ? segments.slice(1) : segments;
  // ns / repo / 'resolve' / rev / path…
  if (rest.length < 5 || rest[2] !== 'resolve') return null;
  const [namespace, repo, , revision] = rest;
  const filePath = rest.slice(4).map(decodeURIComponent).join('/');
  if (!namespace || !repo || !revision || !filePath) return null;

  return {
    commitUrl: `https://huggingface.co/api/${type}/${namespace}/${repo}/commit/${revision}`,
    filePath,
  };
}

/**
 * Upload one file through the HF commit API: newline-delimited JSON, a header
 * line naming the commit followed by a line per file.
 *
 * The blob is sent as base64 TEXT rather than as bytes — `encoding: 'utf-8'`,
 * NOT 'base64', because that flag would tell HF to decode the content back to
 * binary before writing it, which is exactly what we are avoiding: repos on Xet
 * storage reject binary blobs pushed through this route. Base64 costs a third
 * more bytes and buys a file the route will actually accept. readTarget()
 * reverses it.
 */
async function uploadToHuggingFace(
  commitUrl: string,
  filePath: string,
  payload: Buffer,
  token: string,
): Promise<void> {
  const lines = [
    { key: 'header', value: { summary: `chore: update ${filePath}` } },
    { key: 'file', value: { path: filePath, content: payload.toString('base64'), encoding: 'utf-8' } },
  ];
  const res = await fetch(commitUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-ndjson',
      Authorization: `Bearer ${token}`,
    },
    body: lines.map(line => JSON.stringify(line)).join('\n'),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`backup upload failed: HF commit HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
}

/** Undo the base64 wrapper uploadToHuggingFace applies. Sniffed rather than
 *  assumed: a blob left behind by an older build is raw and starts with MAGIC,
 *  and a restore that silently base64-decoded it would turn a recoverable
 *  database into a corrupt one. */
function decodeHuggingFacePayload(raw: Buffer): Buffer {
  if (raw.subarray(0, MAGIC.length).equals(MAGIC)) return raw;
  return Buffer.from(raw.toString('utf8'), 'base64');
}

async function readTarget(target: string): Promise<Buffer | null> {
  if (isHttpTarget(target)) {
    const headers: Record<string, string> = {};
    const token = process.env.FREEAPI_DB_BACKUP_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(target, { method: 'GET', headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) throw new Error(`backup restore failed: HTTP ${res.status}`);
    const raw = Buffer.from(await res.arrayBuffer());
    return parseHuggingFaceTarget(target) ? decodeHuggingFacePayload(raw) : raw;
  }

  if (!fs.existsSync(target)) return null;
  return fs.readFileSync(target);
}

async function writeTarget(target: string, payload: Buffer): Promise<void> {
  if (isHttpTarget(target)) {
    const token = process.env.FREEAPI_DB_BACKUP_TOKEN?.trim();
    const huggingFace = parseHuggingFaceTarget(target);
    if (huggingFace) {
      // Anonymous writes do not exist on HF; without a token every upload would
      // 401 on a schedule and only ever be noticed as an empty restore.
      if (!token) throw new Error('FREEAPI_DB_BACKUP_TOKEN is required to upload a backup to Hugging Face');
      await uploadToHuggingFace(huggingFace.commitUrl, huggingFace.filePath, payload, token);
      return;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(target, {
      method: 'PUT',
      headers,
      body: payload,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`backup upload failed: HTTP ${res.status}`);
    return;
  }

  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  // Encrypted, but not therefore safe to leave world-readable: the key is
  // FREEAPI_DB_BACKUP_KEY or ENCRYPTION_KEY, which on a normal install sits in a
  // .env file on the same host. The mode covers creation; restrictToOwner covers
  // the overwrite case, where an existing file keeps the mode it already had —
  // and covers Windows, where the mode argument is a no-op.
  //
  // Atomic: write a tmp file in the same directory and rename it over the
  // target, so a crash or a full disk mid-write leaves the previous backup
  // intact instead of a half-written blob. The tmp name carries the pid and
  // random bytes so two processes never share one.
  const tmpTarget = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tmpTarget, payload, { mode: 0o600 });
    if (!restrictToOwner(tmpTarget)) {
      console.warn(`[db-backup] could not restrict permissions on ${tmpTarget} — it may be readable by other local accounts`);
    }
    fs.renameSync(tmpTarget, target);
  } catch (err) {
    try { fs.rmSync(tmpTarget, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  if (!restrictToOwner(target)) {
    console.warn(`[db-backup] could not restrict permissions on ${target} — it may be readable by other local accounts`);
  }
}

function renameIfExists(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function deleteIfExists(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch { /* best effort */ }
}

/** Existing local generations for a target, newest first (`target.1`, …). */
function localGenerationPaths(target: string): string[] {
  const paths: string[] = [];
  for (let i = 1; i <= MAX_GENERATION_SCAN; i++) {
    const candidate = `${target}.${i}`;
    if (!fs.existsSync(candidate)) break;
    paths.push(candidate);
  }
  return paths;
}

/**
 * Shift the live local target down a generation before a new backup lands:
 * `target` → `target.1`, `target.1` → `target.2`, and so on, keeping at most
 * `keep` generations in total (live target included). `keep <= 0` keeps every
 * generation. `keep === 1` keeps only the live target, so there is nothing
 * to shift — the atomic rename in writeTarget overwrites it.
 *
 * Runs AFTER the new payload is fully written to its tmp file and BEFORE the
 * rename lands it, so a failure anywhere up to the rename leaves every
 * generation untouched, and a failure after the rename still leaves the
 * previous backup as `target.1` for the restore fallback.
 */
export function rotateLocalBackupGenerations(target: string, keep = getBackupRetention()): void {
  if (keep === 1) return;
  if (keep <= 0) {
    // Unlimited: shift every existing generation up by one.
    let max = 0;
    for (let i = 1; i <= MAX_GENERATION_SCAN; i++) {
      if (fs.existsSync(`${target}.${i}`)) max = i;
      else break;
    }
    for (let i = max; i >= 1; i--) renameIfExists(`${target}.${i}`, `${target}.${i + 1}`);
  } else {
    for (let i = keep - 2; i >= 1; i--) renameIfExists(`${target}.${i}`, `${target}.${i + 1}`);
    // Leftovers from a previously larger retention are pruned: after the
    // shift the newest old generation is `target.(keep-1)`.
    for (let i = keep; i <= keep + MAX_GENERATION_SCAN; i++) {
      if (!fs.existsSync(`${target}.${i}`)) break;
      deleteIfExists(`${target}.${i}`);
    }
  }
  renameIfExists(target, `${target}.1`);
}

/**
 * PRAGMA integrity_check on the live database, before a backup is taken.
 * Returns null when the database is sound, otherwise a short description of
 * the failure. A corrupt database must not overwrite the last good backup,
 * so the caller aborts the run on any non-null return. Best-effort drivers
 * (a Db that cannot run the pragma) report the failure instead of passing.
 */
export function checkDbIntegrity(db: Db): string | null {
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check?: unknown }[];
    if (rows.length === 1 && rows[0]?.integrity_check === 'ok') return null;
    const detail = rows.map(row => String(row?.integrity_check ?? '')).filter(Boolean).join('; ');
    return detail || 'integrity_check did not return ok';
  } catch (err) {
    return `could not run integrity_check: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Decrypt + gunzip a backup blob and check the result is a SQLite database
 * (magic header). Cheap enough to run after every local write; a full
 * test-restore (testRestoreBackup) runs on top of this periodically.
 */
export function verifyBackupPayload(payload: Buffer): { ok: boolean; bytes?: number; error?: string } {
  let plain: Buffer;
  try {
    plain = gunzipSync(decryptBackup(payload));
  } catch (err) {
    return { ok: false, error: `backup payload does not decrypt/decompress: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (plain.length < SQLITE_MAGIC.length || !plain.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
    return { ok: false, error: 'backup payload does not contain a SQLite database' };
  }
  return { ok: true, bytes: plain.length };
}

/**
 * Full test-restore of already-decrypted backup bytes: write them to a
 * throwaway file, open it read-only as SQLite and run integrity_check, then
 * delete it. Catches corruption the magic-header check cannot see (a torn
 * page, a bad freelist). Returns skipped (ok) when better-sqlite3 cannot be
 * loaded — e.g. Android/Termux builds, which use node-sqlite instead.
 */
export function testRestoreBackup(plain: Buffer): { ok: boolean; skipped?: string; error?: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-db-backup-verify-'));
  const file = path.join(dir, 'restored.db');
  try {
    fs.writeFileSync(file, plain, { mode: 0o600 });
    let BetterSqlite: new (path: string, opts?: Record<string, unknown>) => {
      pragma: (sql: string, opts?: Record<string, unknown>) => unknown;
      close: () => void;
    };
    try {
      const runtimeRequire = createRequire(import.meta.url);
      BetterSqlite = runtimeRequire('better-sqlite3') as typeof BetterSqlite;
    } catch {
      return { ok: true, skipped: 'better-sqlite3 unavailable, test-restore skipped' };
    }
    const testDb = new BetterSqlite(file, { readonly: true });
    try {
      const result = testDb.pragma('integrity_check', { simple: true }) as unknown;
      if (result !== 'ok') return { ok: false, error: `test-restore integrity_check failed: ${String(result)}` };
      return { ok: true };
    } finally {
      testDb.close();
    }
  } catch (err) {
    return { ok: false, error: `test-restore failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Backups since the last periodic test-restore. Module state, resettable in tests. */
let backupsSinceTestRestore = 0;

export function resetBackupTestRestoreCounterForTests(): void {
  backupsSinceTestRestore = 0;
}

export async function restoreDbBackupIfNeeded(dbPath = getDefaultDbPath()): Promise<DbBackupResult> {
  if (tursoEnabled()) return { ok: true, skipped: 'remote database' };
  const target = backupTarget();
  if (!target) return { ok: true, skipped: 'not configured' };
  if (dbPath === ':memory:') return { ok: true, target, skipped: 'memory database' };
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) return { ok: true, target, skipped: 'database already exists' };

  // Local targets keep generations (target, target.1, …): a run interrupted
  // between rotating and writing can leave the live target missing while the
  // previous backup survives as target.1, and a torn write can leave it
  // unreadable — so fall back to the newest generation that actually
  // decrypts. HTTP(S) targets have no generations.
  const candidates = isHttpTarget(target)
    ? [target]
    : [target, ...localGenerationPaths(target)];
  let restored: Buffer | null = null;
  let usedTarget = target;
  let lastError = '';
  for (const candidate of candidates) {
    let payload: Buffer | null = null;
    try {
      payload = await readTarget(candidate);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (!payload || payload.length === 0) continue;
    try {
      restored = gunzipSync(decryptBackup(payload));
      usedTarget = candidate;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!restored) {
    if (candidates.some(candidate => fs.existsSync(candidate)) || lastError) {
      throw new Error(`could not restore SQLite backup from ${target}: ${lastError || 'no readable backup found'}`);
    }
    return { ok: true, target, skipped: 'no backup found' };
  }
  if (usedTarget !== target) {
    console.log(`[db-backup] live backup ${target} is missing or unreadable — restoring generation ${usedTarget}`);
  }

  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  // This is the decrypted database — provider keys and the dashboard password
  // hash in the clear. connectDb hardens it too, but that is a later call and
  // sometimes a later process; the file must not be readable in between.
  fs.writeFileSync(dbPath, restored, { mode: 0o600 });
  if (!restrictToOwner(dbPath)) {
    console.warn(`[db-backup] could not restrict permissions on the restored database at ${dbPath}`);
  }
  console.log(`[db-backup] restored ${restored.length} bytes from ${usedTarget}`);
  return { ok: true, target: usedTarget, bytes: restored.length, restored: true };
}

export async function backupDbNow(db: Db, dbPath = getDefaultDbPath()): Promise<DbBackupResult> {
  if (isTursoDatabase(db)) return { ok: true, skipped: 'remote database' };
  const target = backupTarget();
  if (!target) return { ok: true, skipped: 'not configured' };
  if (dbPath === ':memory:') return { ok: true, target, skipped: 'memory database' };
  if (!fs.existsSync(dbPath)) return { ok: false, target, skipped: 'database file missing' };

  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Best effort: reading the main DB still works for rollback-journal or quiet WAL DBs.
  }

  // Integrity first: a corrupt database must never overwrite the last good
  // backup. Aborting here leaves every existing generation untouched.
  const integrityProblem = checkDbIntegrity(db);
  if (integrityProblem) {
    console.error(`[db-backup] refusing to back up ${dbPath}: ${integrityProblem}`);
    return { ok: false, target, skipped: 'integrity_check_failed' };
  }

  // The read stays synchronous on purpose: it takes the snapshot in one step relative to this
  // process's own writes, which could otherwise trigger an automatic checkpoint into the file
  // while an async read is half done and tear the copy. Everything after it works on the
  // in-memory snapshot, so only the compression is moved off the event loop.
  const plain = fs.readFileSync(dbPath);
  const payload = encryptBackup(await gzipAsync(plain));

  // Local targets: rotate generations, then land the new backup atomically.
  // HTTP(S) targets have no local generations and no read-back verification —
  // the upload response is the confirmation there.
  const local = !isHttpTarget(target);
  if (local) rotateLocalBackupGenerations(target);
  await writeTarget(target, payload);

  let testRestored = false;
  if (local) {
    // Verify what actually landed, not what was meant to: read the written
    // blob back, decrypt it and check the SQLite magic. A failure here means
    // the previous generation (now target.1) is still the good one — say so
    // instead of reporting success.
    const written = await readTarget(target);
    const verified = written ? verifyBackupPayload(written) : { ok: false, error: 'written backup could not be read back' };
    if (!verified.ok) {
      console.error(`[db-backup] written backup at ${target} failed verification (${verified.error}); previous generation preserved as ${target}.1`);
      return { ok: false, target, bytes: plain.length, skipped: 'backup_verification_failed' };
    }

    // Periodic full test-restore: open the round-tripped bytes as a
    // throwaway database and run integrity_check on them.
    const every = getTestRestoreEvery();
    backupsSinceTestRestore += 1;
    if (every > 0 && backupsSinceTestRestore >= every) {
      backupsSinceTestRestore = 0;
      const plainBack = gunzipSync(decryptBackup(written!));
      const test = testRestoreBackup(plainBack);
      if (test.skipped) {
        console.log(`[db-backup] periodic test-restore skipped: ${test.skipped}`);
      } else if (!test.ok) {
        console.error(`[db-backup] periodic test-restore failed (${test.error}); previous generation preserved as ${target}.1`);
        return { ok: false, target, bytes: plain.length, skipped: 'test_restore_failed' };
      } else {
        testRestored = true;
      }
    }
  }

  console.log(`[db-backup] uploaded ${plain.length} bytes to ${target}${testRestored ? ' (test-restore passed)' : ''}`);
  return { ok: true, target, bytes: plain.length, ...(testRestored ? { testRestored: true } : {}) };
}

export function startDbBackupPump(db: Db, scheduler: Scheduler, dbPath = getDefaultDbPath()): (() => void) | null {
  if (isTursoDatabase(db)) return null;
  if (!backupTarget()) return null;
  const run = () => {
    void backupDbNow(db, dbPath).catch(err => {
      console.warn(`[db-backup] ${err instanceof Error ? err.message : err}`);
    });
  };
  run();
  return scheduler.every(backupIntervalMs(), run);
}
