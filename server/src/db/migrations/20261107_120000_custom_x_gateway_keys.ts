import type { Db } from '../types.js';

/**
 * Dedicated X Gateway credential & monthly usage store (9Router integration).
 *
 * Completely independent from the main dashboard's `api_keys` table:
 * - Only links to `users(id)` via `created_by` for operator attribution.
 * - Stores encrypted credentials, OAuth/device subject identity, base URL,
 *   model scope, discovered/catalog models, and monthly caps per X Gateway account.
 * - Tracks per-account monthly requests and tokens in `x_gateway_key_monthly_usage`.
 */
export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_gateway_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      subject TEXT,
      auth_method TEXT NOT NULL DEFAULT 'api_key' CHECK (auth_method IN ('api_key', 'oauth_pkce', 'device_code', 'cookie')),
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      base_url TEXT,
      model_scope_json TEXT,
      models_json TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      enabled INTEGER NOT NULL DEFAULT 1,
      monthly_request_cap INTEGER NOT NULL DEFAULT 0,
      monthly_token_cap INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_x_gateway_keys_subject
      ON x_gateway_keys(provider, subject) WHERE subject IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_x_gateway_keys_provider
      ON x_gateway_keys(provider, enabled);

    CREATE TABLE IF NOT EXISTS x_gateway_key_monthly_usage (
      key_id INTEGER NOT NULL REFERENCES x_gateway_keys(id) ON DELETE CASCADE,
      month TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key_id, month)
    );
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS x_gateway_key_monthly_usage;
    DROP INDEX IF EXISTS idx_x_gateway_keys_provider;
    DROP INDEX IF EXISTS idx_x_gateway_keys_subject;
    DROP TABLE IF EXISTS x_gateway_keys;
  `);
}

