import type { Db } from '../types.js';

/**
 * MiProxy webhook support for X Gateway proxy pool.
 * Stores webhook token, webhook enabled flag, last webhook update timestamp,
 * and probe test results directly on the proxy entry.
 */
export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(x_gateway_proxy_pool)').all() as { name: string }[];
  if (!columns.some(c => c.name === 'webhook_token')) {
    db.prepare('ALTER TABLE x_gateway_proxy_pool ADD COLUMN webhook_token TEXT').run();
  }
  if (!columns.some(c => c.name === 'webhook_enabled')) {
    db.prepare('ALTER TABLE x_gateway_proxy_pool ADD COLUMN webhook_enabled INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!columns.some(c => c.name === 'last_webhook_at')) {
    db.prepare('ALTER TABLE x_gateway_proxy_pool ADD COLUMN last_webhook_at INTEGER DEFAULT 0').run();
  }
  if (!columns.some(c => c.name === 'last_test_ok')) {
    db.prepare('ALTER TABLE x_gateway_proxy_pool ADD COLUMN last_test_ok INTEGER').run();
  }
  if (!columns.some(c => c.name === 'last_test_latency')) {
    db.prepare('ALTER TABLE x_gateway_proxy_pool ADD COLUMN last_test_latency INTEGER').run();
  }
  if (!columns.some(c => c.name === 'last_test_message')) {
    db.prepare('ALTER TABLE x_gateway_proxy_pool ADD COLUMN last_test_message TEXT').run();
  }
  if (!columns.some(c => c.name === 'last_test_at')) {
    db.prepare('ALTER TABLE x_gateway_proxy_pool ADD COLUMN last_test_at TEXT').run();
  }
}

export function down(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(x_gateway_proxy_pool)').all() as { name: string }[];
  for (const col of [
    'last_test_at',
    'last_test_message',
    'last_test_latency',
    'last_test_ok',
    'last_webhook_at',
    'webhook_enabled',
    'webhook_token',
  ]) {
    if (columns.some(c => c.name === col)) {
      try {
        db.prepare(`ALTER TABLE x_gateway_proxy_pool DROP COLUMN ${col}`).run();
      } catch {
        // Ignored if SQLite does not support DROP COLUMN
      }
    }
  }
}
