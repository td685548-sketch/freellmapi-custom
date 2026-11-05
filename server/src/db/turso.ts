import { createRequire } from 'node:module';
import type { Db, DbFactory, DbStatement } from './types.js';

const runtimeRequire = createRequire(import.meta.url);
const remoteDatabases = new WeakSet<Db>();
const writeVersions = new WeakMap<Db, number>();

export function tursoWriteVersion(db: Db): number {
  return writeVersions.get(db) ?? 0;
}

export function tursoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const driver = env.FREEAPI_DB_DRIVER?.trim().toLowerCase() || 'sqlite';
  if (driver !== 'sqlite' && driver !== 'turso') {
    throw new Error('FREEAPI_DB_DRIVER must be sqlite or turso');
  }
  return driver === 'turso';
}

export function readTursoConfig(env: NodeJS.ProcessEnv = process.env): { url: string; authToken: string } {
  const url = env.TURSO_DATABASE_URL?.trim() || '';
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('TURSO_DATABASE_URL must be a libsql:// database URL'); }
  if (parsed.protocol !== 'libsql:' || !parsed.hostname || parsed.username || parsed.password
    || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error('TURSO_DATABASE_URL must be a libsql:// host without credentials, path or query');
  }
  const authToken = env.TURSO_AUTH_TOKEN?.trim() || '';
  if (!authToken) throw new Error('TURSO_AUTH_TOKEN is required for Turso');
  if (!/^[a-fA-F0-9]{64}$/.test(env.ENCRYPTION_KEY || '')) {
    throw new Error('ENCRYPTION_KEY must be explicitly set to 64 hex characters for Turso, including in development');
  }
  return { url, authToken };
}

export function isTursoDatabase(db?: Db): boolean {
  return tursoEnabled() || (db ? remoteDatabases.has(db) : false);
}

function sanitizedDriverError(error: unknown, secrets: readonly string[]): Error {
  let message = error instanceof Error ? error.message : 'native driver error';
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
  const sanitized = new Error(message);
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^SQLITE_[A-Z_]+$/.test(code)) Object.assign(sanitized, { code });
  return sanitized;
}

// --- Short-lived SELECT result cache (remote connections only) -------------
//
// Every statement on a remote database is a *blocking* network round trip: the
// native driver is synchronous, so while it waits nothing else on the event loop
// runs, including the health check the host uses to decide the service is alive.
// The dashboard polls many endpoints and each one re-reads the same session, user
// and settings rows, so on a hosted install most of the blocked time is spent
// re-fetching rows that cannot have changed.
//
// A result is reused only while (a) no statement this process ran has written a
// table the SELECT reads, and (b) it is younger than READ_CACHE_TTL_MS, which
// bounds staleness against writers outside this process. Anything the cache
// cannot reason about is not cached and any write it cannot attribute to a table
// drops everything: the failure mode is a cache miss, never a stale hit.
// Disable with FREEAPI_TURSO_READ_CACHE=0.
const READ_CACHE_TTL_MS = 3_000;
const READ_CACHE_MAX_ENTRIES = 256;
const READ_CACHE_MAX_ROWS = 500;
// Tables a write also changes through a trigger. migrations are scanned by a
// test so a new trigger cannot be added without being listed here.
const TRIGGER_SIDE_EFFECTS: Readonly<Record<string, readonly string[]>> = {
  requests: ['key_monthly_usage'],
};
// Results that depend on something other than table contents.
const NOT_CACHEABLE = /\b(?:datetime|date|time|strftime|julianday|unixepoch|random|randomblob|changes|total_changes|last_insert_rowid)\s*\(|\bcurrent_(?:time|date|timestamp)\b|\bpragma_|\bsqlite_|\bRETURNING\b/i;
const COMMA_JOIN = /\bFROM\s+[\w."`[\]]+(?:\s+(?:AS\s+)?\w+)?\s*,/i;

function readTables(sql: string): string[] | null {
  if (NOT_CACHEABLE.test(sql) || COMMA_JOIN.test(sql)) return null;
  const names = [...sql.matchAll(/\b(?:FROM|JOIN)\s+["`[]?([A-Za-z_]\w*)/gi)].map(m => m[1]!.toLowerCase());
  return names.length ? [...new Set(names)] : null;
}

/** Tables a write statement changes, or null when that cannot be known (deletes
 * may cascade, so they are never attributed to a single table). */
function writtenTables(sql: string): string[] | null {
  const m = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?)\s+["`[]?([A-Za-z_]\w*)/i.exec(sql);
  if (!m) return null;
  const table = m[1]!.toLowerCase();
  return [table, ...(TRIGGER_SIDE_EFFECTS[table] ?? [])];
}

function cacheKey(sql: string, args: unknown[]): string | null {
  try {
    return sql + '\0' + JSON.stringify(args, (_k, v) => {
      if (typeof v === 'bigint') return `${v}n`;
      if (ArrayBuffer.isView(v)) throw new Error('binary parameter');
      return v;
    });
  } catch { return null; }
}

const copyRow = (r: unknown): unknown => (r && typeof r === 'object' && !ArrayBuffer.isView(r) ? { ...(r as object) } : r);

/** Preserve the synchronous application contract and support nested migrations.
 * Remote connections deliberately expose no local filename or memory flag. */
export function wrapTursoDatabase(raw: Db, remote = true, secrets: readonly string[] = []): Db {
  let depth = 0;
  let sequence = 0;
  // Remote prepare is itself a network request. Retain a bounded set of SELECT
  // handles (never result rows); execution still reads current database state.
  const reads = new Map<string, DbStatement>();
  const cacheOn = remote && process.env.FREEAPI_TURSO_READ_CACHE !== '0';
  interface CacheEntry { at: number; epoch: number; tables: string[]; versions: number[]; kind: 'get' | 'all'; value: unknown }
  const resultCache = new Map<string, CacheEntry>();
  const tableVersions = new Map<string, number>();
  let epoch = 0;
  const versionOf = (t: string) => tableVersions.get(t) ?? 0;
  function dropResults(): void { epoch += 1; resultCache.clear(); }
  function noteWrite(sql: string): void {
    invalidateReads();
    const tables = writtenTables(sql);
    if (!tables) { dropResults(); return; }
    for (const t of tables) tableVersions.set(t, versionOf(t) + 1);
  }
  function prepare(sql: string): DbStatement {
    if (!remote || !/^\s*SELECT\b/i.test(sql)) return safe(() => raw.prepare(sql));
    let stmt = reads.get(sql);
    if (stmt) reads.delete(sql);
    else stmt = safe(() => raw.prepare(sql));
    reads.set(sql, stmt);
    if (reads.size > 128) reads.delete(reads.keys().next().value!);
    return stmt;
  }
  function invalidateReads(): void {
    writeVersions.set(db, tursoWriteVersion(db) + 1);
  }
  function safe<T>(operation: () => T): T {
    try { return operation(); } catch (error) {
      if (!(error instanceof Error) || secrets.length === 0) throw error;
      throw sanitizedDriverError(error, secrets);
    }
  }
  function row(value: unknown): unknown {
    if (value && typeof value === 'object' && '_metadata' in value) {
      const { _metadata, ...columns } = value as Record<string, unknown>;
      return columns;
    }
    return value;
  }
  function statement(sql: string): DbStatement {
    const stmt = prepare(sql);
    // libsql 0.5.x drops object bindings on the remote transport. Convert named
    // bindings to positional ones without touching quoted SQL or comments.
    const names: string[] = [];
    const positionalSql = sql.replace(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\/|([@:$][A-Za-z_][A-Za-z0-9_]*)/g,
      (token, name: string | undefined) => {
        if (!name) return token;
        names.push(name);
        return '?';
      },
    );
    let positional: DbStatement | undefined;
    function bound<T>(args: unknown[], run: (target: DbStatement, values: unknown[]) => T): T {
      const object = args[0];
      if (names.length && args.length === 1 && object && typeof object === 'object'
        && !Array.isArray(object) && !ArrayBuffer.isView(object)) {
        const values = object as Record<string, unknown>;
        const params = names.map(name => {
          if (Object.hasOwn(values, name)) return values[name];
          if (Object.hasOwn(values, name.slice(1))) return values[name.slice(1)];
          throw new Error(`Missing SQL named parameter ${name}`);
        });
        positional ??= prepare(positionalSql);
        return safe(() => run(positional!, params));
      }
      return safe(() => run(stmt, args));
    }
    const selecting = /^\s*SELECT\b/i.test(sql);
    const tables = cacheOn && selecting ? readTables(sql) : null;
    function cached(kind: 'get' | 'all', args: unknown[], load: () => unknown): unknown {
      const key = tables && depth === 0 ? cacheKey(sql, args) : null;
      if (!key) return load();
      const now = Date.now();
      const hit = resultCache.get(key);
      if (hit && hit.kind === kind && hit.epoch === epoch && now - hit.at < READ_CACHE_TTL_MS
        && hit.tables.every((t, i) => versionOf(t) === hit.versions[i])) {
        return kind === 'all' ? (hit.value as unknown[]).map(copyRow) : copyRow(hit.value);
      }
      const value = load();
      if (kind === 'get' || (value as unknown[]).length <= READ_CACHE_MAX_ROWS) {
        if (resultCache.size >= READ_CACHE_MAX_ENTRIES) resultCache.delete(resultCache.keys().next().value!);
        resultCache.set(key, { at: now, epoch, tables: tables!, versions: tables!.map(versionOf), kind, value });
        return kind === 'all' ? (value as unknown[]).map(copyRow) : copyRow(value);
      }
      return value;
    }
    return {
      get: (...args) => {
        if (!selecting) noteWrite(sql);
        return cached('get', args, () => row(bound(args, (target, values) => target.get(...values))));
      },
      all: (...args) => {
        if (!selecting) noteWrite(sql);
        return cached('all', args, () => bound(args, (target, values) => target.all(...values)).map(row)) as unknown[];
      },
      run: (...args) => {
        noteWrite(sql);
        return bound(args, (target, values) => target.run(...values));
      },
    };
  }
  const db: Db = {
    prepare: statement,
    exec: sql => {
      invalidateReads();
      dropResults();
      reads.clear();
      // Upstream's endpoint-identity migration parks child rows in TEMP tables.
      // Turso disallows TEMP. These reserved tables are created and dropped in
      // the same write transaction, so ordinary tables have the same lifetime.
      const compatible = remote && depth > 0
        ? sql.replace(/^(\s*CREATE\s+)TEMP(?:ORARY)?\s+(TABLE\s+"_endpoint_identity_[a-z_]+"\s+AS\b)/i, '$1$2')
        : sql;
      safe(() => raw.exec(compatible));
    },
    pragma: source => {
      // These are controlled by Turso, not by individual remote connections.
      if (remote && /^\s*(journal_mode|busy_timeout|wal_checkpoint)\b/i.test(source)) return [];
      invalidateReads();
      dropResults();
      reads.clear();
      return safe(() => raw.pragma(source));
    },
    close: () => { reads.clear(); resultCache.clear(); raw.close?.(); },
    transaction: <F extends (...args: any[]) => unknown>(fn: F): F => {
      const wrapped = function (this: unknown, ...args: Parameters<F>): ReturnType<F> {
        const outermost = depth === 0;
        const savepoint = `freellmapi_turso_${++sequence}`;
        db.exec(outermost ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
        depth += 1;
        try {
          const result = fn.apply(this, args) as ReturnType<F>;
          if (result && typeof (result as { then?: unknown }).then === 'function') {
            throw new Error('Turso transaction callbacks must be synchronous');
          }
          db.exec(outermost ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          try {
            if (outermost) raw.exec('ROLLBACK');
            else {
              raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
              raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
            }
          } catch { /* Preserve the original failure. */ }
          throw error;
        } finally { depth -= 1; invalidateReads(); dropResults(); }
      };
      return wrapped as F;
    },
  };
  if (remote) remoteDatabases.add(db);
  return db;
}

export const tursoFactory: DbFactory = () => {
  const config = readTursoConfig();
  let Libsql: new (url: string, opts: { authToken: string }) => Db;
  try { Libsql = runtimeRequire('libsql') as typeof Libsql; }
  catch { throw new Error('Turso requires the libsql native driver. Reinstall dependencies for this platform.'); }
  try {
    return wrapTursoDatabase(new Libsql(config.url, { authToken: config.authToken }), true, [config.authToken, config.url]);
  } catch (error) {
    // Native transport errors may contain the URL or auth headers.
    const detail = sanitizedDriverError(error, [config.authToken, config.url]);
    throw new Error(`Could not connect to Turso. Check TURSO_DATABASE_URL, TURSO_AUTH_TOKEN and network access. ${detail.message}`);
  }
};
