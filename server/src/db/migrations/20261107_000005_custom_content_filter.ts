// Migration: content rules per client profile
// Created: 2026-11-07
//
// DOWN: reversible
//
// Each client key can flag requests before they reach a provider: an overlong message, the same
// message repeated, well-known prompt-injection phrases, or keywords of its own. `cf_mode` decides
// what a flag does ('off' by default, 'log', 'block'); every flag is recorded in
// custom_content_filter_events (kept 30 days).

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}
function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column);
}

const PROFILE_COLUMNS: Array<[string, string]> = [
  ['cf_mode', "TEXT NOT NULL DEFAULT 'off'"],
  ['cf_max_input_chars', 'INTEGER'],
  ['cf_block_injection', 'INTEGER NOT NULL DEFAULT 0'],
  ['cf_repeat_limit', 'INTEGER'],
  ['cf_keywords', 'TEXT'],
];

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_content_filter_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT NOT NULL,
      action TEXT NOT NULL,
      end_user TEXT,
      excerpt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_custom_content_filter_events_profile ON custom_content_filter_events(profile_id, id);
    CREATE INDEX IF NOT EXISTS idx_custom_content_filter_events_created ON custom_content_filter_events(created_at);
  `);
  if (hasTable(db, 'client_profiles')) {
    for (const [name, type] of PROFILE_COLUMNS) {
      if (!hasColumn(db, 'client_profiles', name)) db.prepare(`ALTER TABLE client_profiles ADD COLUMN ${name} ${type}`).run();
    }
  }
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS custom_content_filter_events;');
  if (hasTable(db, 'client_profiles')) {
    for (const [name] of [...PROFILE_COLUMNS].reverse()) {
      if (hasColumn(db, 'client_profiles', name)) db.prepare(`ALTER TABLE client_profiles DROP COLUMN ${name}`).run();
    }
  }
}
