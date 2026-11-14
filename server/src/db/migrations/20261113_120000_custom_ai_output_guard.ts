// Migration: AI Platform Upgrade — US3 Output Guard policies and events
// Created: 2026-11-13
//
// DOWN: reversible

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_ai_output_policies (
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'off',
      detectors_json TEXT NOT NULL,
      replacement_text TEXT NOT NULL,
      fail_mode TEXT NOT NULL DEFAULT 'allow',
      bypass_roles_json TEXT NOT NULL DEFAULT '[]',
      hold_chars INTEGER NOT NULL DEFAULT 200,
      max_delay_ms INTEGER NOT NULL DEFAULT 300,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (scope_kind, scope_id)
    );

    CREATE TABLE IF NOT EXISTS custom_ai_guard_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      end_user TEXT,
      detector TEXT NOT NULL,
      action TEXT NOT NULL,
      wire TEXT NOT NULL,
      streamed INTEGER NOT NULL DEFAULT 0,
      run_id TEXT,
      excerpt_ciphertext TEXT,
      excerpt_iv TEXT,
      excerpt_tag TEXT,
      excerpt_expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_custom_ai_guard_events_scope_created
      ON custom_ai_guard_events(scope_kind, scope_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_custom_ai_guard_events_expires
      ON custom_ai_guard_events(excerpt_expires_at);
    CREATE INDEX IF NOT EXISTS idx_custom_ai_guard_events_created
      ON custom_ai_guard_events(created_at);
  `);

  if (hasTable(db, 'client_profiles')) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_client_profiles_delete_output_guard
      AFTER DELETE ON client_profiles
      BEGIN
        DELETE FROM custom_ai_output_policies
         WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
        DELETE FROM custom_ai_guard_events
         WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
      END;
    `);
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_client_profiles_delete_output_guard;
    DROP TABLE IF EXISTS custom_ai_guard_events;
    DROP TABLE IF EXISTS custom_ai_output_policies;
  `);
}
