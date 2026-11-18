// Migration: Spec 034 — Versioned Prompt Eval Harness, Weighted Canary Traffic Split & Real-Time SSE Credential Scrubber
// Created: 2026-11-18
//
// DOWN: reversible

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_ai_prompt_golden_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      title TEXT NOT NULL,
      user_message TEXT NOT NULL,
      variables_json TEXT NOT NULL DEFAULT '{}',
      assertions_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_custom_ai_prompt_golden_cases_scope
      ON custom_ai_prompt_golden_cases (scope_kind, scope_id, id);

    CREATE TABLE IF NOT EXISTS custom_ai_prompt_golden_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'auto',
      baseline_version INTEGER,
      candidate_version INTEGER NOT NULL,
      candidate_label TEXT NOT NULL DEFAULT 'draft' CHECK (candidate_label IN ('draft', 'version')),
      baseline_summary_json TEXT,
      candidate_summary_json TEXT NOT NULL,
      regressions INTEGER NOT NULL DEFAULT 0,
      improvements INTEGER NOT NULL DEFAULT 0,
      cases_json TEXT NOT NULL DEFAULT '[]',
      actor_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_custom_ai_prompt_golden_runs_scope_created
      ON custom_ai_prompt_golden_runs (scope_kind, scope_id, id DESC);

    CREATE TABLE IF NOT EXISTS custom_ai_prompt_canary (
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      candidate_version INTEGER,
      traffic_percent INTEGER NOT NULL DEFAULT 10 CHECK (traffic_percent >= 1 AND traffic_percent <= 99),
      published_impressions INTEGER NOT NULL DEFAULT 0,
      published_errors INTEGER NOT NULL DEFAULT 0,
      published_total_latency_ms INTEGER NOT NULL DEFAULT 0,
      canary_impressions INTEGER NOT NULL DEFAULT 0,
      canary_errors INTEGER NOT NULL DEFAULT 0,
      canary_total_latency_ms INTEGER NOT NULL DEFAULT 0,
      updated_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (scope_kind, scope_id)
    );

    CREATE TABLE IF NOT EXISTS custom_ai_credential_scrub_settings (
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      updated_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (scope_kind, scope_id)
    );
  `);

  if (hasTable(db, 'client_profiles')) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_client_profiles_delete_eval_canary
      AFTER DELETE ON client_profiles
      BEGIN
        DELETE FROM custom_ai_prompt_golden_cases
         WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
        DELETE FROM custom_ai_prompt_golden_runs
         WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
        DELETE FROM custom_ai_prompt_canary
         WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
        DELETE FROM custom_ai_credential_scrub_settings
         WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
      END;
    `);
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_client_profiles_delete_eval_canary;
    DROP INDEX IF EXISTS idx_custom_ai_prompt_golden_runs_scope_created;
    DROP INDEX IF EXISTS idx_custom_ai_prompt_golden_cases_scope;
    DROP TABLE IF EXISTS custom_ai_credential_scrub_settings;
    DROP TABLE IF EXISTS custom_ai_prompt_canary;
    DROP TABLE IF EXISTS custom_ai_prompt_golden_runs;
    DROP TABLE IF EXISTS custom_ai_prompt_golden_cases;
  `);
}
