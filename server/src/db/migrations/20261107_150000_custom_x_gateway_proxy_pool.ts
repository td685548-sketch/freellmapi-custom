import type { Db } from '../types.js';

/**
 * X Gateway proxy pool (9Router port): several named outbound proxies, each
 * account sticky-bound to one entry via x_gateway_keys.proxy_pool_id.
 * Deleting an entry unbinds its accounts (SET NULL) so they fall back to the
 * gateway-wide proxy instead of a dead proxy.
 */
export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_gateway_proxy_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      proxy_encrypted TEXT,
      proxy_iv TEXT,
      proxy_auth_tag TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const columns = db.prepare('PRAGMA table_info(x_gateway_keys)').all() as { name: string }[];
  if (!columns.some(c => c.name === 'proxy_pool_id')) {
    db.prepare(
      'ALTER TABLE x_gateway_keys ADD COLUMN proxy_pool_id INTEGER REFERENCES x_gateway_proxy_pool(id) ON DELETE SET NULL'
    ).run();
  }
}

export function down(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(x_gateway_keys)').all() as { name: string }[];
  if (columns.some(c => c.name === 'proxy_pool_id')) {
    db.prepare('ALTER TABLE x_gateway_keys DROP COLUMN proxy_pool_id').run();
  }
  db.exec('DROP TABLE IF EXISTS x_gateway_proxy_pool;');
}