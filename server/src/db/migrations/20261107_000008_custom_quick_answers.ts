// Migration: ready answers per client profile
// Created: 2026-11-07
//
// DOWN: reversible
//
// Questions a site gets again and again (opening hours, shipping fee) can have a ready answer. When the
// visitor's latest message matches one of its questions closely enough (word overlap, accents ignored),
// the gateway answers at once in the requested format without calling a provider. Off unless
// `qa_enabled` is set; `qa_min_similarity` is the match threshold in percent.

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}
function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column);
}

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_quick_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      questions TEXT NOT NULL,
      answer TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      hits INTEGER NOT NULL DEFAULT 0,
      last_hit_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_custom_quick_answers_profile ON custom_quick_answers(profile_id);
  `);
  if (hasTable(db, 'client_profiles')) {
    if (!hasColumn(db, 'client_profiles', 'qa_enabled')) db.prepare('ALTER TABLE client_profiles ADD COLUMN qa_enabled INTEGER NOT NULL DEFAULT 0').run();
    if (!hasColumn(db, 'client_profiles', 'qa_min_similarity')) db.prepare('ALTER TABLE client_profiles ADD COLUMN qa_min_similarity INTEGER').run();
  }
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS custom_quick_answers;');
  if (hasTable(db, 'client_profiles')) {
    if (hasColumn(db, 'client_profiles', 'qa_min_similarity')) db.prepare('ALTER TABLE client_profiles DROP COLUMN qa_min_similarity').run();
    if (hasColumn(db, 'client_profiles', 'qa_enabled')) db.prepare('ALTER TABLE client_profiles DROP COLUMN qa_enabled').run();
  }
}
