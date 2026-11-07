import type { Db } from '../types.js';

const PROXY_COLUMNS = ['proxy_encrypted', 'proxy_iv', 'proxy_auth_tag'] as const;

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(candidate => candidate.name === column);
}

/**
 * Adds dedicated outbound proxy support and dedicated client API keys (`sk-xgw-...`)
 * for X Gateway:
 * 1. `proxy_encrypted`, `proxy_iv`, `proxy_auth_tag` on `x_gateway_keys` for per-account outbound IP/proxy override.
 * 2. `x_gateway_client_keys` table for dedicated `/x/v1` API keys linked to `users(id)` for token analytics.
 */
export function up(db: Db): void {
  for (const column of PROXY_COLUMNS) {
    if (!hasColumn(db, 'x_gateway_keys', column)) {
      db.prepare(`ALTER TABLE x_gateway_keys ADD COLUMN ${column} TEXT`).run();
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS x_gateway_client_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'X Gateway Key',
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      rpm_limit INTEGER NOT NULL DEFAULT 60,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_x_gateway_client_keys_user
      ON x_gateway_client_keys(user_id, revoked);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DELETE FROM x_gateway_config WHERE key = 'outbound_proxy';
    DROP INDEX IF EXISTS idx_x_gateway_client_keys_user;
    DROP TABLE IF EXISTS x_gateway_client_keys;
  `);

  for (const column of [...PROXY_COLUMNS].reverse()) {
    if (hasColumn(db, 'x_gateway_keys', column)) {
      db.prepare(`ALTER TABLE x_gateway_keys DROP COLUMN ${column}`).run();
    }
  }
}
