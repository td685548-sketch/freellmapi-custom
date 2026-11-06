// Migration: attribute analytics rows to the account that made the request
// Created: 2026-11-06
//
// DOWN: reversible
//
// `requests` has no notion of who called: every row belongs to "the instance".
// Per-user analytics needs the owner of a row, so it gains a nullable `user_id`.
// It stays NULL for traffic that carries no personal identity (the unified key,
// client profiles, dashboard sessions) and for every row written before this
// migration, so single-user installs and old history read exactly as before.
//
// The index is partial: only attributed rows are indexed, which keeps it empty
// on an install that never issues personal keys.

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some(c => c.name === column);
}

export function up(db: Db): void {
  if (!hasTable(db, 'requests')) return;
  if (!hasColumn(db, 'requests', 'user_id')) {
    db.prepare('ALTER TABLE requests ADD COLUMN user_id INTEGER').run();
  }
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_requests_user_created ON requests(user_id, created_at) WHERE user_id IS NOT NULL',
  ).run();
}

export function down(db: Db): void {
  if (!hasTable(db, 'requests')) return;
  db.prepare('DROP INDEX IF EXISTS idx_requests_user_created').run();
  if (hasColumn(db, 'requests', 'user_id')) {
    db.prepare('ALTER TABLE requests DROP COLUMN user_id').run();
  }
}
