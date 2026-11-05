// Migration: per-user ownership of Playground conversations
// Created: 2026-11-05
//
// DOWN: reversible
//
// playground_conversations was written for a single-user install, so every row
// was visible to (and editable by) any signed-in account. With invited members
// that leaks one account's chats to all the others. Rows gain an owner; the
// routes filter on it.
//
// Existing rows predate multi-user mode and belong to the operator, so they are
// assigned to the primary admin (or the lowest-id administrator, or the lowest
// id account as a last resort). On an install with no accounts the owner stays
// NULL, which no account can match.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const row = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return row.some(c => c.name === column);
}

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function up(db: Db): void {
  if (!hasTable(db, 'playground_conversations')) return;
  if (!hasColumn(db, 'playground_conversations', 'user_id')) {
    db.prepare('ALTER TABLE playground_conversations ADD COLUMN user_id INTEGER').run();
  }
  if (hasTable(db, 'users')) {
    const cols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
    const hasPrimary = cols.some(c => c.name === 'is_primary');
    const owner = (hasPrimary
      ? db.prepare("SELECT id FROM users ORDER BY is_primary DESC, (role = 'admin') DESC, id ASC LIMIT 1").get()
      : db.prepare("SELECT id FROM users ORDER BY (role = 'admin') DESC, id ASC LIMIT 1").get()) as { id: number } | undefined;
    if (owner) {
      db.prepare('UPDATE playground_conversations SET user_id = ? WHERE user_id IS NULL').run(owner.id);
    }
  }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_playground_conversations_user ON playground_conversations(user_id, updated_at_ms DESC)').run();
}

export function down(db: Db): void {
  if (!hasTable(db, 'playground_conversations')) return;
  db.prepare('DROP INDEX IF EXISTS idx_playground_conversations_user').run();
  if (hasColumn(db, 'playground_conversations', 'user_id')) {
    db.prepare('ALTER TABLE playground_conversations DROP COLUMN user_id').run();
  }
}
