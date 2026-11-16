// Migration: AI Platform Upgrade — US7 Orchestrator agents, flows, grants, runs, steps, and cleanup trigger
// Created: 2026-11-13
//
// DOWN: reversible

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_ai_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      knowledge_scope_kind TEXT,
      knowledge_scope_id TEXT,
      output_policy_scope TEXT,
      max_output_tokens INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS custom_ai_flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      draft_json TEXT NOT NULL,
      published_json TEXT,
      published_version INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS custom_ai_flow_grants (
      flow_id INTEGER NOT NULL,
      profile_id INTEGER NOT NULL,
      PRIMARY KEY (flow_id, profile_id)
    );

    CREATE TABLE IF NOT EXISTS custom_ai_runs (
      id TEXT PRIMARY KEY,
      flow_id INTEGER NOT NULL,
      flow_slug TEXT NOT NULL DEFAULT '',
      flow_version INTEGER NOT NULL,
      profile_id INTEGER NOT NULL,
      end_user TEXT,
      wire TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'awaiting_approval', 'completed', 'stopped', 'cancelled', 'failed', 'interrupted')),
      stop_reason TEXT,
      steps INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      handoffs INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      final_text_masked TEXT,
      error TEXT,
      state_json TEXT,
      is_dry_run INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS custom_ai_run_steps (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('model', 'tool', 'handoff', 'approval', 'guard', 'stop')),
      agent_slug TEXT NOT NULL,
      model TEXT,
      tool_name TEXT,
      input_masked TEXT NOT NULL DEFAULT '',
      output_masked TEXT NOT NULL DEFAULT '',
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (run_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_custom_ai_runs_profile_started
      ON custom_ai_runs (profile_id, started_at);

    CREATE INDEX IF NOT EXISTS idx_custom_ai_runs_status
      ON custom_ai_runs (status);

    CREATE INDEX IF NOT EXISTS idx_custom_ai_runs_flow_started
      ON custom_ai_runs (flow_id, started_at);
  `);

  if (hasTable(db, 'client_profiles')) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_client_profiles_delete_orchestrator
      AFTER DELETE ON client_profiles
      BEGIN
        DELETE FROM custom_ai_flow_grants WHERE profile_id = OLD.id;
        DELETE FROM custom_ai_run_steps WHERE run_id IN (SELECT id FROM custom_ai_runs WHERE profile_id = OLD.id);
        DELETE FROM custom_ai_runs WHERE profile_id = OLD.id;
      END;
    `);
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_client_profiles_delete_orchestrator;
    DROP INDEX IF EXISTS idx_custom_ai_runs_flow_started;
    DROP INDEX IF EXISTS idx_custom_ai_runs_status;
    DROP INDEX IF EXISTS idx_custom_ai_runs_profile_started;
    DROP TABLE IF EXISTS custom_ai_run_steps;
    DROP TABLE IF EXISTS custom_ai_runs;
    DROP TABLE IF EXISTS custom_ai_flow_grants;
    DROP TABLE IF EXISTS custom_ai_flows;
    DROP TABLE IF EXISTS custom_ai_agents;
  `);
}
