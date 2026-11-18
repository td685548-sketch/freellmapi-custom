// Migration: Versioned Prompts Golden Evaluation Suite & A/B Traffic Rollout
// Created: 2026-11-18
//
// DOWN: reversible
//
// Adds `ab_draft_weight_pct` on `custom_ai_prompt_heads` and creates `custom_ai_prompt_eval_cases`
// and `custom_ai_prompt_eval_runs` for automated Draft vs Published prompt evaluations.
// Zero SQLite triggers are created.

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (c) => c.name === column,
  );
}

function addColumnIfMissing(db: Db, table: string, column: string, definition: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function dropColumnIfExists(db: Db, table: string, column: string): void {
  if (hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}

export function up(db: Db): void {
  if (hasTable(db, 'custom_ai_prompt_heads')) {
    addColumnIfMissing(db, 'custom_ai_prompt_heads', 'ab_draft_weight_pct', 'INTEGER NOT NULL DEFAULT 0');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_ai_prompt_eval_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      name TEXT NOT NULL,
      user_message TEXT NOT NULL,
      variables_json TEXT NOT NULL DEFAULT '{}',
      must_contain_json TEXT NOT NULL DEFAULT '[]',
      must_not_contain_json TEXT NOT NULL DEFAULT '[]',
      expected_regex TEXT,
      judge_rubric TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_custom_ai_prompt_eval_cases_scope
      ON custom_ai_prompt_eval_cases(scope_kind, scope_id, id);

    CREATE TABLE IF NOT EXISTS custom_ai_prompt_eval_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      baseline_version INTEGER,
      candidate_version INTEGER,
      model TEXT NOT NULL,
      use_judge INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT NOT NULL,
      results_json TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_custom_ai_prompt_eval_runs_scope
      ON custom_ai_prompt_eval_runs(scope_kind, scope_id, id DESC);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_custom_ai_prompt_eval_runs_scope;
    DROP TABLE IF EXISTS custom_ai_prompt_eval_runs;
    DROP INDEX IF EXISTS idx_custom_ai_prompt_eval_cases_scope;
    DROP TABLE IF EXISTS custom_ai_prompt_eval_cases;
  `);

  if (hasTable(db, 'custom_ai_prompt_heads')) {
    dropColumnIfExists(db, 'custom_ai_prompt_heads', 'ab_draft_weight_pct');
  }
}
