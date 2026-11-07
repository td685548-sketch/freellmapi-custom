// Migration: attribute client-key traffic to the web app's own end users, with a per-end-user allowance
// Created: 2026-11-07
//
// DOWN: reversible
//
// A web app calls with ONE client key for all of its visitors. When it also names the visitor
// (X-End-User header, or the OpenAI `user` field), the request row records it in `requests.end_user`,
// so usage can be read per visitor. `client_profiles.eu_*` is the allowance EVERY end user of that key
// gets (NULL = unlimited), and `custom_end_user_counters` holds the running totals per visitor and
// window, kept only for keys with such an allowance.

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}
function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column);
}

const PROFILE_COLUMNS = ['eu_daily_requests', 'eu_daily_tokens', 'eu_monthly_requests', 'eu_monthly_tokens'];

export function up(db: Db): void {
  if (hasTable(db, 'requests')) {
    if (!hasColumn(db, 'requests', 'end_user')) db.prepare('ALTER TABLE requests ADD COLUMN end_user TEXT').run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_requests_profile_end_user ON requests(profile_id, end_user, created_at) WHERE end_user IS NOT NULL',
    ).run();
  }
  if (hasTable(db, 'client_profiles')) {
    for (const c of PROFILE_COLUMNS) if (!hasColumn(db, 'client_profiles', c)) db.prepare(`ALTER TABLE client_profiles ADD COLUMN ${c} INTEGER`).run();
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_end_user_counters (
      profile_id INTEGER NOT NULL,
      end_user TEXT NOT NULL,
      period TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (profile_id, end_user, period)
    );
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS custom_end_user_counters;');
  if (hasTable(db, 'client_profiles')) {
    for (const c of PROFILE_COLUMNS) if (hasColumn(db, 'client_profiles', c)) db.prepare(`ALTER TABLE client_profiles DROP COLUMN ${c}`).run();
  }
  if (hasTable(db, 'requests')) {
    db.prepare('DROP INDEX IF EXISTS idx_requests_profile_end_user').run();
    if (hasColumn(db, 'requests', 'end_user')) db.prepare('ALTER TABLE requests DROP COLUMN end_user').run();
  }
}
