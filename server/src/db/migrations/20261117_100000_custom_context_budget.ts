// Migration: token-budgeted context assembly policies, assembly reports, and conversation window start
// Created: 2026-11-17
//
// DOWN: reversible
//
// Stores per-profile context budget policies (`custom_context_policies`), per-request assembly
// allocation reports without message content (`custom_context_reports`), and the oldest
// included message id (`context_window_start_id`) on `custom_conversations` for budget-driven
// summary folding. Zero SQLite triggers are created.

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column);
}

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_context_policies (
      profile_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      preset TEXT NOT NULL DEFAULT 'balanced',
      max_input_tokens INTEGER,
      output_reserve_tokens INTEGER NOT NULL,
      safety_margin_pct INTEGER NOT NULL,
      summary_share_pct INTEGER NOT NULL,
      knowledge_share_pct INTEGER NOT NULL,
      drop_block_turns INTEGER NOT NULL,
      summarize INTEGER NOT NULL DEFAULT 1,
      client_history_mode TEXT NOT NULL DEFAULT 'passthrough',
      knowledge_min_score REAL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS custom_context_reports (
      request_id INTEGER PRIMARY KEY,
      profile_id INTEGER NOT NULL,
      end_user TEXT,
      conversation_key TEXT,
      model_key TEXT NOT NULL,
      context_window INTEGER,
      budget_tokens INTEGER NOT NULL,
      mandatory_tokens INTEGER NOT NULL,
      summary_tokens INTEGER NOT NULL,
      knowledge_tokens INTEGER NOT NULL,
      history_tokens INTEGER NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      heuristic_tokens INTEGER NOT NULL,
      history_sent INTEGER NOT NULL,
      history_dropped INTEGER NOT NULL,
      knowledge_sent INTEGER NOT NULL,
      knowledge_dropped INTEGER NOT NULL,
      summary_used INTEGER NOT NULL,
      client_history_dropped INTEGER NOT NULL,
      refits INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_custom_context_reports_profile
      ON custom_context_reports(profile_id, created_at);
  `);

  if (hasTable(db, 'custom_conversations') && !hasColumn(db, 'custom_conversations', 'context_window_start_id')) {
    db.prepare('ALTER TABLE custom_conversations ADD COLUMN context_window_start_id INTEGER').run();
  }
}

export function down(db: Db): void {
  if (hasTable(db, 'custom_conversations') && hasColumn(db, 'custom_conversations', 'context_window_start_id')) {
    db.prepare('ALTER TABLE custom_conversations DROP COLUMN context_window_start_id').run();
  }

  db.exec(`
    DROP INDEX IF EXISTS idx_custom_context_reports_profile;
    DROP TABLE IF EXISTS custom_context_reports;
    DROP TABLE IF EXISTS custom_context_policies;
  `);
}
