import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'url';
import { runMigrationsSync } from './migrate/runner.js';
import { initEncryptionKey, isEncryptionKeyInitialized, probeStoredSecrets } from '../lib/crypto.js';
import { restrictAllToOwner, restrictDirToOwner } from '../lib/file-permissions.js';
import { nodeSqliteFactory } from './node-sqlite.js';
import { beginStartupBusyBudget, endStartupBusyBudget, tursoEnabled, tursoFactory } from './turso.js';
import { observeDatabase } from '../custom/performance/database.js';
import type { Db, DbFactory } from './types.js';
import { readRoutingSetting } from './routing-settings-scope.js';

export type { Db, DbFactory } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/freeapi.db');
const runtimeRequire = createRequire(import.meta.url);

let db: Db;

export function getDb(): Db {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() or connectDb() first.');
  }
  return db;
}

export function getDefaultDbPath(): string {
  return process.env.FREEAPI_DB_PATH?.trim() || DB_PATH;
}

/** Default factory: opens a better-sqlite3 connection at the given path. */
function betterSqliteFactory(resolvedPath: string): Db {
  let BetterSqlite: new (path: string) => unknown;
  try {
    BetterSqlite = runtimeRequire('better-sqlite3') as new (path: string) => unknown;
  } catch (cause) {
    throw new Error(
      'better-sqlite3 is not installed. Reinstall dependencies, or use Node.js 22.13+ on Android/Termux.',
      { cause },
    );
  }
  return new BetterSqlite(resolvedPath) as Db;
}

export function defaultDbFactory(platform: NodeJS.Platform = process.platform): DbFactory {
  return platform === 'android' ? nodeSqliteFactory : betterSqliteFactory;
}

export function connectDb(
  dbPath?: string,
  opts?: {
    /** Create the parent directory if absent. Default: true. Set false in
     *  environments that do not have a writable local filesystem. */
    ensureDir?: boolean;
    /** Factory that constructs the raw Db connection. Default: better-sqlite3. */
    factory?: DbFactory;
  },
): Db {
  const resolvedPath = dbPath ?? getDefaultDbPath();
  const isMemory = resolvedPath === ':memory:';
  const remote = !opts?.factory && !isMemory && tursoEnabled();
  const ensureDir = !remote && (opts?.ensureDir ?? true);
  const factory = opts?.factory ?? (remote ? tursoFactory : defaultDbFactory());

  // Gated on ensureDir along with the mkdir: that flag means "this process does
  // not shape the filesystem here", and changing a directory's permissions is
  // exactly that kind of change. It also keeps the warning below from firing on
  // every boot in the read-only environments the flag exists for.
  if (!isMemory && ensureDir) {
    const dataDir = path.dirname(resolvedPath);
    let created = false;
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
      created = true;
    }
    // Before the connection, not after: on Windows the restriction is inherited,
    // so hardening first means the database file is born protected instead of
    // spending its first moments with whatever ACL the parent handed down.
    restrictDataDir(dataDir, created);
  }

  db = observeDatabase(factory(resolvedPath));
  if (!isMemory) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // The dashboard and the proxy hot path write concurrently; without a busy
  // timeout the loser of a write race gets SQLITE_BUSY immediately and the
  // request fails. Five seconds is far longer than any write here takes.
  db.pragma('busy_timeout = 5000');

  if (!isMemory && !remote) restrictDbFilePermissions(resolvedPath);

  console.log(remote ? 'Database initialized with Turso (remote libSQL)' : `Database initialized at ${resolvedPath}`);
  return db;
}

/**
 * Whether the directory holding the database may be restricted to this account.
 *
 * The sidecars can only be covered by the directory: SQLite creates `-wal` and
 * `-shm` on the first write and deletes them on the last clean close, so at
 * startup there is nothing there to chmod. But the directory is also shared
 * state — FREEAPI_DB_PATH may point anywhere — and locking down a directory
 * that is not ours is a worse outage than the leak it prevents. Pointing the DB
 * at `/tmp/freeapi.db` must not chmod 0700 `/tmp`.
 *
 * So the rule is ownership by construction rather than a guess about what is
 * safe. Two cases qualify, and nothing else does:
 *
 *   1. We just created the directory. Nothing else can be living in a directory
 *      that did not exist a moment ago.
 *   2. It is the built-in default data directory, which ships as ours.
 *
 * Case 2 is what covers the installed base: an existing deployment already has
 * `server/data`, so case 1 alone would harden new installs and quietly leave
 * every upgrade behind.
 *
 * An operator who points FREEAPI_DB_PATH at a dedicated directory can opt in
 * with FREEAPI_DB_DIR_HARDENING=1, and one who dislikes the default can opt out
 * with =0. It is a deliberate default-on-where-safe rather than a flag, because
 * hardening that only runs when someone remembers to ask for it is the same
 * class of failure as hardening nobody noticed had stopped running.
 */
export function shouldHardenDataDir(
  dataDir: string,
  created: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const override = parseDirHardeningOverride();
  if (override !== undefined) return override;
  if (created) return true;

  // Windows paths are case-insensitive; comparing them case-sensitively would
  // miss `C:\App\Data` vs `c:\app\data` and silently skip the default install.
  const normalize = (p: string): string =>
    platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  return normalize(dataDir) === normalize(path.dirname(DB_PATH));
}

/** Tri-state, matching CSP_UPGRADE_INSECURE_REQUESTS in lib/config.ts: on, off,
 *  or unset to leave the policy above in charge. */
function parseDirHardeningOverride(): boolean | undefined {
  const raw = process.env.FREEAPI_DB_DIR_HARDENING;
  if (raw === undefined || raw.trim() === '') return undefined;
  const lower = raw.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return undefined;
}

/** Emitted at most once: connectDb runs once in a server, but a test suite
 *  reconnects constantly and does not need the same line each time. */
let warnedUnhardenedDataDir = false;

function restrictDataDir(dataDir: string, created: boolean): void {
  if (!shouldHardenDataDir(dataDir, created)) {
    if (!warnedUnhardenedDataDir) {
      warnedUnhardenedDataDir = true;
      console.log(
        `[db] leaving permissions on ${dataDir} as they are: it is not a directory this server created. ` +
        'The WAL sidecars written there inherit whatever it already grants. ' +
        'Set FREEAPI_DB_DIR_HARDENING=1 if it belongs to this account alone.',
      );
    }
    return;
  }

  if (!restrictDirToOwner(dataDir)) {
    console.warn(
      `[db] could not restrict permissions on ${dataDir}; ` +
      'the database and its WAL sidecars may be readable by other local accounts',
    );
  }
}

/** Restrict the DB and its WAL sidecars to the owner. The file holds encrypted
 *  provider keys plus the dashboard password hash, so it must not be readable by
 *  other local users. Best-effort: a filesystem that cannot express the
 *  restriction must not stop startup — but it now says so instead of failing
 *  silently, because a hardening step nobody can see failing is one nobody
 *  notices is absent.
 *
 *  This pass only ever finds the main file on a clean start; the sidecars do not
 *  exist yet. They are covered by the directory instead — see
 *  shouldHardenDataDir. It still runs for both, because a directory this server
 *  is not allowed to touch can still hold sidecars left behind by an unclean
 *  shutdown, and because the main file predates the directory pass on any
 *  install that upgraded into it. */
function restrictDbFilePermissions(resolvedPath: string): void {
  const failed = restrictAllToOwner(['', '-wal', '-shm'].map(suffix => `${resolvedPath}${suffix}`));
  if (failed.length > 0) {
    console.warn(
      `[db] could not restrict database file permissions (${failed.length} of 3 targets); ` +
      'the database may be readable by other local accounts',
    );
  }
}

export function initDb(
  dbPath?: string,
  opts?: { ensureDir?: boolean; factory?: DbFactory },
): Db {
  // Migrations and first writes may have to wait for a previous instance to release the write lock;
  // index.ts ends the long wait once the server listens.
  beginStartupBusyBudget();
  const db = connectDb(dbPath, opts);

  if (process.env.NODE_ENV !== 'development') {
    runMigrationsSync(db, 'up');
  } else {
    // In dev, verify the DB has been initialised. If not, give a clear error.
    const ready = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'"
    ).get();
    if (!ready) {
      console.error(
        '\n  [dev] Database not initialised. Run:\n\n' +
        '    npm run db:migration:up\n\n' +
        '  Then restart the server.\n'
      );
      process.exit(1);
    }
  }

  if (!isEncryptionKeyInitialized()) initEncryptionKey(db);

  keyStoreDecryptable = probeStoredSecrets(db);
  if (keyStoreDecryptable === false) {
    console.error(
      '[crypto] The loaded encryption key cannot decrypt the provider keys in this database. ' +
      'Every request will fail with "Unsupported state or unable to authenticate data" and nothing ' +
      'will route until this is fixed. The database and the key file (.encryption-key next to it, ' +
      'or ENCRYPTION_KEY) came from different installs — restore the key that belongs to this ' +
      'database, then restart.',
    );
  }

  if (process.env.NODE_ENV === 'test') {
    endStartupBusyBudget();
  }

  return db;
}

let keyStoreDecryptable: boolean | null = null;

/**
 * Result of the boot-time probe: true when the key opens stored secrets, false
 * when it does not, null when the database holds no secret to check. Read by the
 * health and status endpoints so a key mismatch is visible instead of surfacing
 * as one failing provider after another.
 */
export function isKeyStoreDecryptable(): boolean | null {
  return keyStoreDecryptable;
}

/**
 * Unified API key storage (hash-only).
 *
 * The unified key is the single credential that opens the whole /v1 surface,
 * so it must never sit in the database as recoverable plaintext the way it
 * used to (settings key `unified_api_key`). Like client-profile and user keys,
 * only its SHA-256 digest is stored now, under `unified_api_key_hash`, plus a
 * non-secret prefix (`unified_api_key_prefix`, e.g. `freellmapi-…ab12`) for
 * masked display in the dashboard. The plaintext exists only in the return
 * value of regenerateUnifiedKey() — shown once, then it is the operator's to
 * keep. There is deliberately no getter that returns the current key: nothing
 * in the server can recover it from the database, including the Keys page.
 *
 * Migration 20261118_210000_custom_unified_key_hash converts existing
 * installs: it hashes the legacy plaintext row in place and deletes it.
 * Databases that predate the migration (dev mode, which does not run
 * migrations) keep working through the legacy fallback in
 * validateUnifiedApiKey() until the migration runs.
 */
export const UNIFIED_KEY_HASH_SETTING = 'unified_api_key_hash';
export const UNIFIED_KEY_PREFIX_SETTING = 'unified_api_key_prefix';
export const LEGACY_UNIFIED_KEY_SETTING = 'unified_api_key';

/** SHA-256 digest of a unified key, hex-encoded — the only form stored. */
export function hashUnifiedApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** Non-secret display prefix, e.g. `freellmapi-…ab12`. Safe to log and show. */
export function unifiedKeyPrefix(key: string): string {
  return key.length > 15 ? `${key.slice(0, 11)}…${key.slice(-4)}` : `${key.slice(0, 4)}…`;
}

/** Constant-time comparison of two strings via fixed-length HMAC digests,
 *  mirroring timingSafeStringEqual in lib/system-prompt.ts without importing
 *  it (that module imports this one). */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const key = Buffer.alloc(32);
  const digestA = crypto.createHmac('sha256', key).update(a).digest();
  const digestB = crypto.createHmac('sha256', key).update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * Process-ephemeral credential for the server's own loopback calls. The
 * unified key used to be readable so in-process callers (customer-AI hub,
 * guest trials, MCP loopback, prompt evals, the orchestrator's synthetic
 * requests) could present it as a Bearer <redacted> With hash-only storage that is
 * impossible, so these callers use a random token that exists only in this
 * process's memory: it is generated lazily, never persisted, never logged,
 * never returned by any API, and dies with the process. validateUnifiedApiKey
 * accepts it as the unified kind, exactly like the operator's key.
 */
let internalLoopbackToken: string | null = null;

export function getInternalLoopbackToken(): string {
  if (!internalLoopbackToken) {
    internalLoopbackToken = `freellmapi-internal-${crypto.randomBytes(24).toString('hex')}`;
  }
  return internalLoopbackToken;
}

/** For tests only: drop the cached in-process token so a fresh one is minted. */
export function resetInternalLoopbackTokenForTests(): void {
  internalLoopbackToken = null;
}

/** The stored SHA-256 digest of the unified key, or null when no key exists. */
export function getUnifiedApiKeyHash(): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(UNIFIED_KEY_HASH_SETTING) as { value: string } | undefined;
  return row?.value ?? null;
}

/** The stored display prefix of the unified key, or null when no key exists. */
export function getUnifiedApiKeyPrefix(): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(UNIFIED_KEY_PREFIX_SETTING) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Whether `token` is the current unified key. Compares SHA-256 digests so the
 * plaintext never has to be recovered. Also accepts the process-ephemeral
 * internal loopback token, and — transitionally — a legacy plaintext row in
 * databases the hash migration has not run on yet (dev mode); that row is
 * deleted by regenerateUnifiedKey() and by the migration.
 */
export function validateUnifiedApiKey(token: string | undefined): boolean {
  if (!token) return false;
  if (internalLoopbackToken && timingSafeEqualStrings(token, internalLoopbackToken)) return true;
  const hash = getUnifiedApiKeyHash();
  if (hash) return timingSafeEqualStrings(hashUnifiedApiKey(token), hash);
  const db = getDb();
  const legacy = db.prepare('SELECT value FROM settings WHERE key = ?').get(LEGACY_UNIFIED_KEY_SETTING) as { value: string } | undefined;
  if (legacy?.value) return timingSafeEqualStrings(token, legacy.value);
  return false;
}

export function regenerateUnifiedKey(): string {
  const db = getDb();
  const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  upsert.run(UNIFIED_KEY_HASH_SETTING, hashUnifiedApiKey(key));
  upsert.run(UNIFIED_KEY_PREFIX_SETTING, unifiedKeyPrefix(key));
  // Any legacy plaintext row is gone for good once a new key is minted.
  db.prepare('DELETE FROM settings WHERE key = ?').run(LEGACY_UNIFIED_KEY_SETTING);
  return key;
}

// Generic key/value settings accessors (used by routing strategy, etc.).
export function getSetting(key: string): string | undefined {
  const db = getDb();
  return readRoutingSetting(db, key, () => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  });
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
