// Migration: Opt-in Scoped Semantic Similarity Response Cache
// Created: 2026-11-18
//
// DOWN: reversible
//
// Creates `custom_semantic_cache_entries` and `idx_custom_semantic_cache_partition`
// to support optional SQLite persistence of embedding-indexed response cache entries.
// Zero SQLite triggers are created.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_semantic_cache_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      partition_hash TEXT NOT NULL,
      embedding_family TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      query_preview TEXT NOT NULL DEFAULT '',
      response_json TEXT NOT NULL,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      hit_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_custom_semantic_cache_partition
      ON custom_semantic_cache_entries(partition_hash, expires_at);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_custom_semantic_cache_partition;
    DROP TABLE IF EXISTS custom_semantic_cache_entries;
  `);
}
