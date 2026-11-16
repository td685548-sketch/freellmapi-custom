// Migration: AI Platform Upgrade — US6 Versioned Prompts, heads, backfill, and cleanup trigger
// Created: 2026-11-13
//
// DOWN: reversible

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_ai_prompt_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      variables_json TEXT NOT NULL DEFAULT '[]',
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
      restored_from INTEGER,
      author_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(scope_kind, scope_id, version)
    );

    CREATE TABLE IF NOT EXISTS custom_ai_prompt_heads (
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      published_version INTEGER,
      draft_version INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (scope_kind, scope_id)
    );

    CREATE INDEX IF NOT EXISTS idx_custom_ai_prompt_versions_scope_status
      ON custom_ai_prompt_versions (scope_kind, scope_id, status, version);
  `);

  if (hasTable(db, 'client_profiles')) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_client_profiles_delete_prompts
      AFTER DELETE ON client_profiles
      BEGIN
        DELETE FROM custom_ai_prompt_versions
         WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
        DELETE FROM custom_ai_prompt_heads
         WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
      END;

      INSERT OR IGNORE INTO custom_ai_prompt_versions
        (scope_kind, scope_id, version, body, variables_json, note, status, restored_from, author_id, created_at)
      SELECT
        'profile',
        CAST(id AS TEXT),
        1,
        system_prompt,
        '[]',
        '',
        'published',
        NULL,
        NULL,
        COALESCE(NULLIF(TRIM(updated_at), ''), NULLIF(TRIM(created_at), ''), '2026-11-13 00:00:00')
      FROM client_profiles
      WHERE system_prompt IS NOT NULL AND TRIM(system_prompt, ' ' || char(9) || char(10) || char(13)) != '';

      INSERT OR IGNORE INTO custom_ai_prompt_heads
        (scope_kind, scope_id, published_version, draft_version, revision)
      SELECT
        'profile',
        CAST(id AS TEXT),
        1,
        NULL,
        1
      FROM client_profiles
      WHERE system_prompt IS NOT NULL AND TRIM(system_prompt, ' ' || char(9) || char(10) || char(13)) != '';
    `);
  }

  if (hasTable(db, 'x_support_tenants')) {
    db.exec(`
      INSERT OR IGNORE INTO custom_ai_prompt_versions
        (scope_kind, scope_id, version, body, variables_json, note, status, restored_from, author_id, created_at)
      SELECT
        'support_tenant',
        CAST(id AS TEXT),
        1,
        system_prompt,
        '[]',
        '',
        'published',
        NULL,
        NULL,
        COALESCE(NULLIF(TRIM(updated_at), ''), NULLIF(TRIM(created_at), ''), '2026-11-13 00:00:00')
      FROM x_support_tenants
      WHERE system_prompt IS NOT NULL AND TRIM(system_prompt, ' ' || char(9) || char(10) || char(13)) != '';

      INSERT OR IGNORE INTO custom_ai_prompt_heads
        (scope_kind, scope_id, published_version, draft_version, revision)
      SELECT
        'support_tenant',
        CAST(id AS TEXT),
        1,
        NULL,
        1
      FROM x_support_tenants
      WHERE system_prompt IS NOT NULL AND TRIM(system_prompt, ' ' || char(9) || char(10) || char(13)) != '';
    `);
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_client_profiles_delete_prompts;
    DROP INDEX IF EXISTS idx_custom_ai_prompt_versions_scope_status;
    DROP TABLE IF EXISTS custom_ai_prompt_versions;
    DROP TABLE IF EXISTS custom_ai_prompt_heads;
  `);
}
