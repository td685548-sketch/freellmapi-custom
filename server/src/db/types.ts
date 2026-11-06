export interface DbStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { lastInsertRowid?: number | bigint; changes: number };
}

export interface Db {
  prepare(sql: string): DbStatement;
  exec(sql: string): void;
  // Mirrors better-sqlite3's pattern: transaction() wraps fn and returns a
  // callable with the same signature. The F extends constraint covers both
  // zero-arg transactions and the parameterised form used in routes/embeddings.
  transaction<F extends (...args: any[]) => unknown>(fn: F): F;
  pragma(source: string): unknown;
  /**
   * Run several writes atomically in ONE round trip. Only remote (Turso)
   * connections provide it; callers must fall back to transaction() without it.
   * Parameters are inlined as SQL literals, so this is for fixed, internal
   * statements only.
   */
  executeBatch?(statements: ReadonlyArray<{ sql: string; params: readonly unknown[] }>): void;
  // Optional file metadata, populated when the backing store is better-sqlite3
  // (the default factory passes the raw handle through). Consumers that need a
  // filesystem location (e.g. the dev encryption-key file) must treat absence
  // as "no file backing" and fall back accordingly.
  readonly name?: string;
  readonly memory?: boolean;
  /** Close the backing connection when the driver exposes that operation. */
  close?(): void;
}

/** Factory that opens (or creates) a database at the given resolved path and
 *  returns it as a Db. Pragmas and migrations are applied by the caller. */
export type DbFactory = (resolvedPath: string) => Db;
