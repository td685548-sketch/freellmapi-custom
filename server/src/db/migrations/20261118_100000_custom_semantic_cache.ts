// Migration: AI Platform Upgrade — Spec 030 Multi-Scope Semantic Response Cache
// Created: 2026-11-18
//
// DOWN: reversible

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_ai_semantic_cache_settings (
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      semantic_enabled INTEGER NOT NULL DEFAULT 1,
      min_similarity REAL NOT NULL DEFAULT 0.94,
      max_temperature REAL NOT NULL DEFAULT 0.2,
      ttl_seconds INTEGER NOT NULL DEFAULT 3600,
      max_entries INTEGER NOT NULL DEFAULT 1000,
      persist_to_db INTEGER NOT NULL DEFAULT 1,
      isolate_by_end_user INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (scope_kind, scope_id)
    );

    CREATE TABLE IF NOT EXISTS custom_ai_semantic_cache_entries (
      id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      end_user_scope TEXT NOT NULL DEFAULT '',
      wire TEXT NOT NULL DEFAULT 'openai-chat',
      model TEXT NOT NULL DEFAULT 'auto',
      contract_hash TEXT NOT NULL,
      prompt_version_hash TEXT NOT NULL,
      exact_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      embedding BLOB,
      embedding_model TEXT,
      embedding_dims INTEGER,
      tokens_saved INTEGER NOT NULL DEFAULT 0,
      hit_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      UNIQUE (scope_kind, scope_id, end_user_scope, contract_hash, prompt_version_hash, exact_hash)
    );

    CREATE TABLE IF NOT EXISTS custom_ai_semantic_cache_metrics (
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      exact_hits INTEGER NOT NULL DEFAULT 0,
      semantic_hits INTEGER NOT NULL DEFAULT 0,
      misses INTEGER NOT NULL DEFAULT 0,
      bypassed INTEGER NOT NULL DEFAULT 0,
      tokens_saved_est INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (scope_kind, scope_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ai_sem_cache_entries_lookup
      ON custom_ai_semantic_cache_entries (
        scope_kind,
        scope_id,
        end_user_scope,
        contract_hash,
        prompt_version_hash
      );

    CREATE INDEX IF NOT EXISTS idx_ai_sem_cache_entries_expires
      ON custom_ai_semantic_cache_entries (scope_kind, scope_id, expires_at);
  `);

  if (hasTable(db, 'client_profiles')) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_client_profiles_delete_semantic_cache
      AFTER DELETE ON client_profiles
      BEGIN
        DELETE FROM custom_ai_semantic_cache_settings
         WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
        DELETE FROM custom_ai_semantic_cache_entries
         WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
        DELETE FROM custom_ai_semantic_cache_metrics
         WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
      END;
    `);
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_client_profiles_delete_semantic_cache;
    DROP INDEX IF EXISTS idx_ai_sem_cache_entries_expires;
    DROP INDEX IF EXISTS idx_ai_sem_cache_entries_lookup;
    DROP TABLE IF EXISTS custom_ai_semantic_cache_metrics;
    DROP TABLE IF EXISTS custom_ai_semantic_cache_entries;
    DROP TABLE IF EXISTS custom_ai_semantic_cache_settings;
  `);
}
