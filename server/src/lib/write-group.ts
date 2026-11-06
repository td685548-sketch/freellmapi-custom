import type { Db } from '../db/types.js';

export interface WriteStatement { sql: string; params: readonly unknown[] }

/** Whether remote write groups go out as one round trip (FREEAPI_TURSO_BATCH_WRITES=1). */
export function batchedWritesEnabled(db: Db): boolean {
  return process.env.FREEAPI_TURSO_BATCH_WRITES === '1' && typeof db.executeBatch === 'function';
}

/**
 * Run a few related writes atomically. On a remote database with batching on this
 * is ONE network round trip (BEGIN ... COMMIT sent as one script); otherwise it
 * is the ordinary transaction, whose BEGIN and COMMIT are two more round trips
 * on top of the statements. Same rows either way.
 */
export function runWriteGroup(db: Db, statements: readonly WriteStatement[]): void {
  if (batchedWritesEnabled(db)) {
    db.executeBatch!(statements);
    return;
  }
  db.transaction(() => {
    for (const s of statements) db.prepare(s.sql).run(...s.params);
  })();
}
