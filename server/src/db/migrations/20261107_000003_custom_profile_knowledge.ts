// Migration: a knowledge base per client profile
// Created: 2026-11-07
//
// DOWN: reversible
//
// Documents a web app's operator pastes on the dashboard (FAQ, policies, product facts). They are split
// into passages; for each chat request of the key the passages that best match the user's question are
// added as reference material, so the model answers from the site's own facts without the web app
// sending them every time. Off unless `kb_enabled` is set.

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}
function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column);
}

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_knowledge_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_custom_knowledge_docs_profile ON custom_knowledge_docs(profile_id);
    CREATE TABLE IF NOT EXISTS custom_knowledge_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL,
      profile_id INTEGER NOT NULL,
      ord INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_custom_knowledge_chunks_profile ON custom_knowledge_chunks(profile_id);
  `);
  if (hasTable(db, 'client_profiles')) {
    if (!hasColumn(db, 'client_profiles', 'kb_enabled')) db.prepare('ALTER TABLE client_profiles ADD COLUMN kb_enabled INTEGER NOT NULL DEFAULT 0').run();
    if (!hasColumn(db, 'client_profiles', 'kb_max_chars')) db.prepare('ALTER TABLE client_profiles ADD COLUMN kb_max_chars INTEGER').run();
  }
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS custom_knowledge_chunks; DROP TABLE IF EXISTS custom_knowledge_docs;');
  if (hasTable(db, 'client_profiles')) {
    if (hasColumn(db, 'client_profiles', 'kb_max_chars')) db.prepare('ALTER TABLE client_profiles DROP COLUMN kb_max_chars').run();
    if (hasColumn(db, 'client_profiles', 'kb_enabled')) db.prepare('ALTER TABLE client_profiles DROP COLUMN kb_enabled').run();
  }
}
