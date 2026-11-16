import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';
import { up as runClientProfiles } from '../../../db/migrations/20260805_000002_client_profiles.js';
import { up as runAiBase } from '../../../db/migrations/20261113_100000_custom_ai_platform_base.js';
import { up as runAiPromptVersions } from '../../../db/migrations/20261113_150000_custom_ai_prompt_versions.js';
import { down, up } from '../../../db/migrations/20261113_160000_custom_ai_orchestrator.js';

function listTables(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function listIndexes(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function listTriggers(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function listColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function setupPreOrchestratorDb(): Database.Database {
  const db = new Database(':memory:');
  runLegacyBaseline(db);
  runClientProfiles(db);
  runAiBase(db);
  runAiPromptVersions(db);
  return db;
}

describe('migration 20261113_160000_custom_ai_orchestrator', () => {
  it('supports idempotent up -> down -> up with all 5 tables, indexes, and trigger', () => {
    const db = setupPreOrchestratorDb();
    try {
      up(db);
      up(db); // idempotent

      const tables = listTables(db);
      expect(tables).toEqual(
        expect.arrayContaining([
          'custom_ai_agents',
          'custom_ai_flows',
          'custom_ai_flow_grants',
          'custom_ai_runs',
          'custom_ai_run_steps',
        ]),
      );

      expect(listColumns(db, 'custom_ai_agents')).toEqual([
        'id',
        'slug',
        'name',
        'description',
        'model',
        'knowledge_scope_kind',
        'knowledge_scope_id',
        'output_policy_scope',
        'max_output_tokens',
        'enabled',
        'revision',
      ]);
      expect(listColumns(db, 'custom_ai_flows')).toEqual([
        'id',
        'slug',
        'name',
        'description',
        'draft_json',
        'published_json',
        'published_version',
        'enabled',
        'revision',
      ]);
      expect(listColumns(db, 'custom_ai_flow_grants')).toEqual(['flow_id', 'profile_id']);
      expect(listColumns(db, 'custom_ai_runs')).toEqual([
        'id',
        'flow_id',
        'flow_slug',
        'flow_version',
        'profile_id',
        'end_user',
        'wire',
        'status',
        'stop_reason',
        'steps',
        'tool_calls',
        'handoffs',
        'prompt_tokens',
        'completion_tokens',
        'final_text_masked',
        'error',
        'state_json',
        'is_dry_run',
        'started_at',
        'finished_at',
      ]);
      expect(listColumns(db, 'custom_ai_run_steps')).toEqual([
        'run_id',
        'seq',
        'kind',
        'agent_slug',
        'model',
        'tool_name',
        'input_masked',
        'output_masked',
        'prompt_tokens',
        'completion_tokens',
        'duration_ms',
        'status',
        'error',
        'created_at',
      ]);

      const indexes = listIndexes(db);
      expect(indexes).toContain('idx_custom_ai_runs_profile_started');
      expect(indexes).toContain('idx_custom_ai_runs_status');
      expect(indexes).toContain('idx_custom_ai_runs_flow_started');
      expect(listTriggers(db)).toContain('trg_client_profiles_delete_orchestrator');

      down(db);

      const tablesAfterDown = listTables(db);
      expect(tablesAfterDown).not.toContain('custom_ai_agents');
      expect(tablesAfterDown).not.toContain('custom_ai_flows');
      expect(tablesAfterDown).not.toContain('custom_ai_flow_grants');
      expect(tablesAfterDown).not.toContain('custom_ai_runs');
      expect(tablesAfterDown).not.toContain('custom_ai_run_steps');
      expect(listIndexes(db)).not.toContain('idx_custom_ai_runs_profile_started');
      expect(listIndexes(db)).not.toContain('idx_custom_ai_runs_status');
      expect(listIndexes(db)).not.toContain('idx_custom_ai_runs_flow_started');
      expect(listTriggers(db)).not.toContain('trg_client_profiles_delete_orchestrator');

      // Re-up restores identical tables, indexes, and trigger
      up(db);
      expect(listTables(db)).toEqual(tables);
      expect(listIndexes(db)).toEqual(indexes);
      expect(listTriggers(db)).toContain('trg_client_profiles_delete_orchestrator');
    } finally {
      db.close();
    }
  });

  it('enforces CHECK and UNIQUE constraints and cascades client_profiles delete via trigger', () => {
    const db = setupPreOrchestratorDb();
    try {
      up(db);

      db.prepare(
        "INSERT INTO custom_ai_agents (slug, name, model) VALUES ('triage', 'Triage', 'auto')",
      ).run();
      expect(() =>
        db
          .prepare("INSERT INTO custom_ai_agents (slug, name, model) VALUES ('triage', 'Dup', 'auto')")
          .run(),
      ).toThrow(/UNIQUE/);

      db.prepare(
        "INSERT INTO custom_ai_flows (slug, name, draft_json) VALUES ('support', 'Support', '{}')",
      ).run();
      expect(() =>
        db
          .prepare(
            "INSERT INTO custom_ai_flows (slug, name, draft_json) VALUES ('support', 'Dup', '{}')",
          )
          .run(),
      ).toThrow(/UNIQUE/);

      expect(() =>
        db
          .prepare(
            "INSERT INTO custom_ai_runs (id, flow_id, flow_version, profile_id, wire, status) VALUES ('run_bad', 1, 1, 1, 'openai-chat', 'bogus')",
          )
          .run(),
      ).toThrow(/CHECK/);

      expect(() =>
        db
          .prepare(
            "INSERT INTO custom_ai_run_steps (run_id, seq, kind, agent_slug, status) VALUES ('run_1', 1, 'bogus', 'triage', 'ok')",
          )
          .run(),
      ).toThrow(/CHECK/);

      expect(() =>
        db
          .prepare(
            "INSERT INTO custom_ai_run_steps (run_id, seq, kind, agent_slug, status) VALUES ('run_1', 1, 'model', 'triage', 'bogus')",
          )
          .run(),
      ).toThrow(/CHECK/);

      db.prepare(
        "INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (1, 'P1', 'th1', 'ek1', 'iv1', 't1')",
      ).run();
      db.prepare(
        "INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (2, 'P2', 'th2', 'ek2', 'iv2', 't2')",
      ).run();

      db.prepare('INSERT INTO custom_ai_flow_grants (flow_id, profile_id) VALUES (1, 1), (1, 2)').run();
      db.prepare(
        "INSERT INTO custom_ai_runs (id, flow_id, flow_slug, flow_version, profile_id, wire, status) VALUES ('run_1', 1, 'support', 1, 1, 'openai-chat', 'completed')",
      ).run();
      db.prepare(
        "INSERT INTO custom_ai_runs (id, flow_id, flow_slug, flow_version, profile_id, wire, status) VALUES ('run_2', 1, 'support', 1, 2, 'openai-chat', 'completed')",
      ).run();
      db.prepare(
        "INSERT INTO custom_ai_run_steps (run_id, seq, kind, agent_slug, status) VALUES ('run_1', 1, 'model', 'triage', 'ok')",
      ).run();
      db.prepare(
        "INSERT INTO custom_ai_run_steps (run_id, seq, kind, agent_slug, status) VALUES ('run_2', 1, 'model', 'triage', 'ok')",
      ).run();

      db.prepare('DELETE FROM client_profiles WHERE id = 1').run();

      expect(db.prepare('SELECT flow_id, profile_id FROM custom_ai_flow_grants').all()).toEqual([
        { flow_id: 1, profile_id: 2 },
      ]);
      expect(db.prepare('SELECT id, profile_id FROM custom_ai_runs').all()).toEqual([
        { id: 'run_2', profile_id: 2 },
      ]);
      expect(db.prepare('SELECT run_id, seq FROM custom_ai_run_steps').all()).toEqual([
        { run_id: 'run_2', seq: 1 },
      ]);
    } finally {
      db.close();
    }
  });

  it('runs cleanly when client_profiles table does not exist', () => {
    const db = new Database(':memory:');
    try {
      up(db);
      expect(listTables(db)).toEqual([
        'custom_ai_agents',
        'custom_ai_flow_grants',
        'custom_ai_flows',
        'custom_ai_run_steps',
        'custom_ai_runs',
      ]);
      expect(listTriggers(db)).toEqual([]);
      down(db);
      expect(listTables(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
