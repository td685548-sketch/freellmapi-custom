import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_gateway_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT,
      updated_by INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS x_gateway_combos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      entries_json TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS x_gateway_usage_hourly (
      hour TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      requests INTEGER DEFAULT 0,
      input_tokens_saved INTEGER DEFAULT 0,
      output_savers_applied INTEGER DEFAULT 0,
      PRIMARY KEY (hour, user_id)
    )
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS x_gateway_usage_hourly');
  db.exec('DROP TABLE IF EXISTS x_gateway_combos');
  db.exec('DROP TABLE IF EXISTS x_gateway_config');
}
