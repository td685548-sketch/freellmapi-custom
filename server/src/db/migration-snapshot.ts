import { createBackup } from '../services/backups.js';
import { getMigrationStatuses } from './migrate/runner.js';
import { tursoEnabled } from './turso.js';
import type { Db } from './types.js';

/**
 * Pre-migration snapshot, run by the migration runner's hook (see
 * setBeforeMigrationsHook in migrate/runner.ts) before pending migrations
 * are applied.
 *
 * Boot used to call runMigrationsSync() with no safety net: a migration that
 * corrupted data left the operator with nothing to roll back to. The snapshot
 * is a full SQL dump through services/backups.ts createBackup() with source
 * 'pre-migration', so it shows up on the Backups page like any other dump and
 * is never auto-pruned (like manual and pre-restore dumps).
 *
 * When it runs:
 * - Only when the database already has applied migrations AND has pending
 *   ones — a fresh install has nothing to lose, and a fully-migrated boot
 *   has nothing to do.
 * - Never on Turso (a remote database; Turso owns its backups) and never
 *   when the `backups` index table does not exist yet (a database too old
 *   for the dump to be recorded — the migration that creates the table
 *   cannot be snapshotted by it).
 * - Never blocks the boot: any failure is logged as a warning and the
 *   migrations still run. A missing snapshot is visible in the log, not a
 *   crash at 3am.
 *
 * Restore note: a dump deliberately omits the `migrations` ledger (and the
 * `backups` index itself), so restoring one brings the data back but not the
 * schema version — after restoring a pre-migration dump, run
 * `npm run db:migration:down` (or delete the migration's row) to bring the
 * ledger back in line with the restored schema. The dump header records the
 * schema it was taken against ("N migrations, latest …") for exactly this.
 */
export function snapshotBeforeMigrations(db: Db, opts: { backupPath?: string } = {}): void {
  if (tursoEnabled()) return;

  const statuses = getMigrationStatuses(db);
  const applied = statuses.filter(status => status.status === 'applied');
  const pending = statuses.filter(status => status.status === 'pending');
  if (applied.length === 0 || pending.length === 0) return;

  const backupsTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backups'",
  ).get() as { name: string } | undefined;
  if (!backupsTable) {
    console.warn(
      '[db] skipping pre-migration snapshot: the backups table does not exist yet in this database',
    );
    return;
  }

  const latest = applied[applied.length - 1].filename;
  try {
    const snapshot = createBackup(db, {
      source: 'pre-migration',
      ...(opts.backupPath !== undefined ? { backupPath: opts.backupPath } : {}),
    });
    console.log(
      `[db] pre-migration snapshot ${snapshot.filename} ` +
        `(${applied.length} migrations, latest ${latest}) before applying ` +
        `${pending.length} migration(s): ${pending.map(status => status.filename).join(', ')}. ` +
        'To roll back, restore this dump from the Backups page, then run db:migration:down.',
    );
  } catch (err) {
    console.warn(
      `[db] pre-migration snapshot failed (${err instanceof Error ? err.message : String(err)}) — continuing without one`,
    );
  }
}
