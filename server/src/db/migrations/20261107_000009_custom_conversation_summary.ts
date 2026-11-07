// Migration: running summaries of long stored conversations
// Created: 2026-11-07
//
// DOWN: reversible
//
// With `conv_summarize` on, the turns of a stored conversation that no longer fit the key's history
// limits are folded into a running summary (one extra model call through the key itself) instead of
// being forgotten; the summary is sent ahead of the kept turns. `summarized_through` is the id of the
// last message folded in; only folded messages are ever trimmed from storage.

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}
function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column);
}

export function up(db: Db): void {
  if (hasTable(db, 'custom_conversations')) {
    if (!hasColumn(db, 'custom_conversations', 'summary')) db.prepare('ALTER TABLE custom_conversations ADD COLUMN summary TEXT').run();
    if (!hasColumn(db, 'custom_conversations', 'summarized_through')) db.prepare('ALTER TABLE custom_conversations ADD COLUMN summarized_through INTEGER NOT NULL DEFAULT 0').run();
  }
  if (hasTable(db, 'client_profiles') && !hasColumn(db, 'client_profiles', 'conv_summarize')) {
    db.prepare('ALTER TABLE client_profiles ADD COLUMN conv_summarize INTEGER NOT NULL DEFAULT 0').run();
  }
}

export function down(db: Db): void {
  if (hasTable(db, 'client_profiles') && hasColumn(db, 'client_profiles', 'conv_summarize')) db.prepare('ALTER TABLE client_profiles DROP COLUMN conv_summarize').run();
  if (hasTable(db, 'custom_conversations')) {
    if (hasColumn(db, 'custom_conversations', 'summarized_through')) db.prepare('ALTER TABLE custom_conversations DROP COLUMN summarized_through').run();
    if (hasColumn(db, 'custom_conversations', 'summary')) db.prepare('ALTER TABLE custom_conversations DROP COLUMN summary').run();
  }
}
