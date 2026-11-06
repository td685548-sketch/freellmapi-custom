// Migration: per-client-profile request attribution and RPM limit
// Created: 2026-11-06
//
// DOWN: reversible
//
// `requests.profile_id` records which `sk-cp-…` client profile made a request
// (NULL for every other credential and for all earlier rows), so usage can be
// read per web/app. `client_profiles.rpm_limit` is the per-minute request cap for
// the profile's key; NULL means unlimited.
//
// Profiles that exist today were never limited and must stay that way, so the
// column is added with a default of 60 for profiles created from now on and the
// existing rows are then reset to NULL.

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some(c => c.name === column);
}

export function up(db: Db): void {
  if (hasTable(db, 'client_profiles') && !hasColumn(db, 'client_profiles', 'rpm_limit')) {
    db.prepare('ALTER TABLE client_profiles ADD COLUMN rpm_limit INTEGER DEFAULT 60').run();
    db.prepare('UPDATE client_profiles SET rpm_limit = NULL').run();
  }
  if (hasTable(db, 'requests')) {
    if (!hasColumn(db, 'requests', 'profile_id')) {
      db.prepare('ALTER TABLE requests ADD COLUMN profile_id INTEGER').run();
    }
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_requests_profile_created ON requests(profile_id, created_at) WHERE profile_id IS NOT NULL',
    ).run();
  }
}

export function down(db: Db): void {
  if (hasTable(db, 'requests')) {
    db.prepare('DROP INDEX IF EXISTS idx_requests_profile_created').run();
    if (hasColumn(db, 'requests', 'profile_id')) db.prepare('ALTER TABLE requests DROP COLUMN profile_id').run();
  }
  if (hasTable(db, 'client_profiles') && hasColumn(db, 'client_profiles', 'rpm_limit')) {
    db.prepare('ALTER TABLE client_profiles DROP COLUMN rpm_limit').run();
  }
}
