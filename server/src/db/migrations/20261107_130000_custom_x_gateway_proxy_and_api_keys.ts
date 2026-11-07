import type { Db } from '../types.js';

/**
 * Adds dedicated outbound proxy support and dedicated client API keys (`sk-xgw-...`)
 * for X Gateway:
 * 1. `proxy_encrypted`, `proxy_iv`, `proxy_auth_tag` on `x_gateway_keys` for per-account outbound IP/proxy override.
 * 2. `x_gateway_client_keys` table for dedicated `/x/v1` API keys linked to `users(id)` for token analytics.
 */
export function up(db: Db): void {
  db.exec(`
    ALTER TABLE x_gateway_keys ADD COLUMN proxy_encrypted TEXT;
    ALTER TABLE x_gateway_keys ADD COLUMN proxy_iv TEXT;
    ALTER TABLE x_gateway_keys ADD COLUMN proxy_auth_tag TEXT;

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
    ALTER TABLE x_gateway_keys DROP COLUMN proxy_auth_tag;
    ALTER TABLE x_gateway_keys DROP COLUMN proxy_iv;
    ALTER TABLE x_gateway_keys DROP COLUMN proxy_encrypted;
  `);
}

