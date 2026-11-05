import type { Db, DbStatement } from '../../db/types.js';
import { measureDb } from './metrics.js';

const observed = new WeakSet<Db>();

/** Never cache results or change the synchronous driver/transaction contract. */
export function observeDatabase(raw: Db): Db {
  if (process.env.CUSTOM_PERF_METRICS !== '1' || observed.has(raw)) return raw;
  // Preserve identity: Turso write versions and remote markers are WeakMaps /
  // WeakSets keyed on this exact object. An outer wrapper breaks invalidation.
  const prepare = raw.prepare.bind(raw);
  const exec = raw.exec.bind(raw);
  const pragma = raw.pragma.bind(raw);
  raw.prepare = (sql): DbStatement => {
    const stmt = measureDb('prepare', () => prepare(sql));
    return {
      get: (...args) => measureDb('execute', () => stmt.get(...args)),
      all: (...args) => measureDb('execute', () => stmt.all(...args)),
      run: (...args) => measureDb('execute', () => stmt.run(...args)),
    };
  };
  raw.exec = sql => measureDb('execute', () => exec(sql));
  raw.pragma = source => measureDb('execute', () => pragma(source));
  observed.add(raw);
  return raw;
}
