// DOWN: reversible. Drops the custom_x_account_resilience table and index.
import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_x_account_resilience (
      account_id INTEGER PRIMARY KEY REFERENCES x_gateway_keys(id) ON DELETE CASCADE,
      weight INTEGER NOT NULL DEFAULT 1,
      max_concurrency INTEGER,
      max_queue_size INTEGER NOT NULL DEFAULT 20,
      fail_fast INTEGER NOT NULL DEFAULT 0,
      refresh_circuit_until TEXT,
      refresh_failures INTEGER NOT NULL DEFAULT 0,
      last_refresh_error TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_custom_x_account_resilience_circuit
      ON custom_x_account_resilience(refresh_circuit_until);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_custom_x_account_resilience_circuit;
    DROP TABLE IF EXISTS custom_x_account_resilience;
  `);
}
