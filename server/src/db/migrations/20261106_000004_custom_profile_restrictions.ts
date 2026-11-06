// Migration: per-client-profile model allowlist and max_tokens cap
// Created: 2026-11-06
//
// DOWN: reversible
//
// `allowed_models` is a JSON array of lowercase model ids the profile's key may use, `max_tokens_cap`
// the largest max_tokens a single request may ask for. NULL in either means no restriction, so every
// existing profile keeps behaving as before.

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some(c => c.name === column);
}

export function up(db: Db): void {
  if (!hasTable(db, 'client_profiles')) return;
  if (!hasColumn(db, 'client_profiles', 'allowed_models')) db.prepare('ALTER TABLE client_profiles ADD COLUMN allowed_models TEXT').run();
  if (!hasColumn(db, 'client_profiles', 'max_tokens_cap')) db.prepare('ALTER TABLE client_profiles ADD COLUMN max_tokens_cap INTEGER').run();
}

export function down(db: Db): void {
  if (!hasTable(db, 'client_profiles')) return;
  if (hasColumn(db, 'client_profiles', 'max_tokens_cap')) db.prepare('ALTER TABLE client_profiles DROP COLUMN max_tokens_cap').run();
  if (hasColumn(db, 'client_profiles', 'allowed_models')) db.prepare('ALTER TABLE client_profiles DROP COLUMN allowed_models').run();
}
