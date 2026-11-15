// Migration: AI Platform Upgrade — US4 Semantic Retrieval tables and profile cleanup trigger
// Created: 2026-11-13
//
// DOWN: reversible

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_ai_retrieval_settings (
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'hybrid' CHECK (mode IN ('keyword', 'semantic', 'hybrid')),
      embedding_model TEXT,
      dimensions INTEGER NOT NULL DEFAULT 768,
      top_k INTEGER NOT NULL DEFAULT 5,
      min_score REAL NOT NULL DEFAULT 0.25,
      citations_enabled INTEGER NOT NULL DEFAULT 1,
      index_generation INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (scope_kind, scope_id)
    );

    CREATE TABLE IF NOT EXISTS custom_ai_chunk_embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      chunk_id INTEGER NOT NULL,
      ord INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      dims INTEGER NOT NULL,
      vector BLOB,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'error')),
      error_text TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (scope_kind, scope_id, doc_id, chunk_id)
    );

    CREATE TABLE IF NOT EXISTS custom_ai_index_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('doc_add', 'doc_edit', 'doc_delete', 'reindex', 'model_change')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
      model TEXT,
      total_chunks INTEGER NOT NULL DEFAULT 0,
      processed_chunks INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      retry_after TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS custom_ai_embedding_usage (
      day TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      model TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('index', 'query')),
      input_tokens INTEGER NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, scope_kind, scope_id, model, purpose)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_index_jobs_active
      ON custom_ai_index_jobs (scope_kind, scope_id)
      WHERE status IN ('queued', 'running');

    CREATE INDEX IF NOT EXISTS idx_ai_chunk_embeddings_scope_status
      ON custom_ai_chunk_embeddings (scope_kind, scope_id, status);

    CREATE INDEX IF NOT EXISTS idx_ai_chunk_embeddings_scope_doc
      ON custom_ai_chunk_embeddings (scope_kind, scope_id, doc_id);

    CREATE INDEX IF NOT EXISTS idx_ai_embedding_usage_scope_day
      ON custom_ai_embedding_usage (scope_kind, scope_id, day);
  `);

  if (hasTable(db, 'client_profiles')) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_client_profiles_delete_retrieval
      AFTER DELETE ON client_profiles
      BEGIN
        DELETE FROM custom_ai_retrieval_settings
         WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
        DELETE FROM custom_ai_chunk_embeddings
         WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
        DELETE FROM custom_ai_index_jobs
         WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
        DELETE FROM custom_ai_embedding_usage
         WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
      END;
    `);
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_client_profiles_delete_retrieval;
    DROP INDEX IF EXISTS idx_ai_embedding_usage_scope_day;
    DROP INDEX IF EXISTS idx_ai_chunk_embeddings_scope_doc;
    DROP INDEX IF EXISTS idx_ai_chunk_embeddings_scope_status;
    DROP INDEX IF EXISTS idx_ai_index_jobs_active;
    DROP TABLE IF EXISTS custom_ai_embedding_usage;
    DROP TABLE IF EXISTS custom_ai_index_jobs;
    DROP TABLE IF EXISTS custom_ai_chunk_embeddings;
    DROP TABLE IF EXISTS custom_ai_retrieval_settings;
  `);
}
