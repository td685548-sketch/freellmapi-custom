import type { Db } from '../db/index.js';
import { isTursoDatabase } from '../db/turso.js';

export interface SqlitePerformanceResult {
  applied: boolean;
  reason: 'applied' | 'disabled_by_override' | 'remote_turso' | 'in_memory';
  pragmas?: {
    synchronous: string;
    cacheSizeKib: number;
    tempStore: string;
    mmapSizeBytes: number;
    journalSizeLimitBytes: number;
  };
}

const CACHE_SIZE_KIB = 65_536; // 64 MiB page cache in RAM (negative value = KiB in SQLite)
const MMAP_SIZE_BYTES = 268_435_456; // 256 MiB memory-mapped read window
const JOURNAL_SIZE_LIMIT_BYTES = 67_108_864; // Cap -wal file size at 64 MiB after checkpoints

function isTuningDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.FREEAPI_SQLITE_TUNING?.trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'off' || raw === 'no';
}

function isFileBackedSqlite(db: Db): boolean {
  try {
    const list = db.pragma('database_list') as Array<{ name?: string; file?: string }>;
    const main = Array.isArray(list) ? list.find((entry) => entry.name === 'main') : undefined;
    const file = typeof main?.file === 'string' ? main.file.trim() : '';
    return file.length > 0 && file !== ':memory:';
  } catch {
    return false;
  }
}

/**
 * Applies safe WAL-mode throughput pragmas exclusively on local file-backed SQLite
 * connections (`!isTursoDatabase(db)` and not `:memory:`):
 * - `synchronous = NORMAL` (crash-safe in WAL mode without per-transaction fsync stalls)
 * - `cache_size = -65536` (64 MiB RAM page cache vs. default ~2 MiB)
 * - `temp_store = MEMORY` (in-RAM temporary B-trees / sorts)
 * - `mmap_size = 268435456` (256 MiB memory-mapped reads for analytics & RAG vectors)
 * - `journal_size_limit = 67108864` (bounds `-wal` sidecar growth at 64 MiB)
 *
 * Set `FREEAPI_SQLITE_TUNING=0` to opt out.
 */
export function applyLocalSqlitePerformancePragmas(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): SqlitePerformanceResult {
  if (isTuningDisabled(env)) {
    return { applied: false, reason: 'disabled_by_override' };
  }
  if (isTursoDatabase(db)) {
    return { applied: false, reason: 'remote_turso' };
  }
  if (!isFileBackedSqlite(db)) {
    return { applied: false, reason: 'in_memory' };
  }

  db.pragma('synchronous = NORMAL');
  db.pragma(`cache_size = -${CACHE_SIZE_KIB}`);
  db.pragma('temp_store = MEMORY');
  try {
    db.pragma(`mmap_size = ${MMAP_SIZE_BYTES}`);
  } catch {
    // Some constrained filesystems disallow mmap; keep remaining pragmas active.
  }
  db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`);

  return {
    applied: true,
    reason: 'applied',
    pragmas: {
      synchronous: 'NORMAL',
      cacheSizeKib: CACHE_SIZE_KIB,
      tempStore: 'MEMORY',
      mmapSizeBytes: MMAP_SIZE_BYTES,
      journalSizeLimitBytes: JOURNAL_SIZE_LIMIT_BYTES,
    },
  };
}
