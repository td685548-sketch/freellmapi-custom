import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';
import { up as runClientProfiles } from '../../../db/migrations/20260805_000002_client_profiles.js';
import { up as runAiBase } from '../../../db/migrations/20261113_100000_custom_ai_platform_base.js';
import { up as runAiMcp } from '../../../db/migrations/20261113_110000_custom_ai_mcp_client.js';
import { down, up } from '../../../db/migrations/20261113_120000_custom_ai_output_guard.js';

function listTables(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function listColumns(db: Database.Database, table: string): Array<{ name: string; dflt_value: string | null }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; dflt_value: string | null }>;
}

describe('migration 20261113_120000_custom_ai_output_guard', () => {
  it('creates output guard tables with expected defaults, supports idempotent up -> down -> up without touching MCP tables', () => {
    const db = new Database(':memory:');
    try {
      runLegacyBaseline(db);
      runClientProfiles(db);
      runAiBase(db);
      runAiMcp(db);

      up(db);
      up(db); // idempotent

      const tables = listTables(db);
      expect(tables).toContain('custom_ai_output_policies');
      expect(tables).toContain('custom_ai_guard_events');
      // Must NOT create US7 tables
      expect(tables).not.toContain('custom_ai_agents');
      expect(tables).not.toContain('custom_ai_runs');
      expect(tables).not.toContain('custom_ai_flows');

      const policyCols = listColumns(db, 'custom_ai_output_policies');
      expect(policyCols.find((c) => c.name === 'mode')?.dflt_value).toBe("'off'");
      expect(policyCols.find((c) => c.name === 'fail_mode')?.dflt_value).toBe("'allow'");
      expect(policyCols.find((c) => c.name === 'hold_chars')?.dflt_value).toBe('200');
      expect(policyCols.find((c) => c.name === 'max_delay_ms')?.dflt_value).toBe('300');

      db.prepare(
        `INSERT INTO custom_ai_output_policies (scope_kind, scope_id, detectors_json, replacement_text)
         VALUES ('profile', '1', '{}', 'Blocked')`,
      ).run();
      const row = db
        .prepare("SELECT mode, fail_mode, hold_chars, max_delay_ms, revision FROM custom_ai_output_policies WHERE scope_id = '1'")
        .get() as { mode: string; fail_mode: string; hold_chars: number; max_delay_ms: number; revision: number };
      expect(row).toEqual({
        mode: 'off',
        fail_mode: 'allow',
        hold_chars: 200,
        max_delay_ms: 300,
        revision: 1,
      });

      // Single-step rollback removes only output guard tables and trigger, preserving MCP tables/columns
      down(db);
      const tablesAfterDown = listTables(db);
      expect(tablesAfterDown).not.toContain('custom_ai_output_policies');
      expect(tablesAfterDown).not.toContain('custom_ai_guard_events');
      expect(tablesAfterDown).toContain('custom_ai_mcp_servers');
      expect(tablesAfterDown).toContain('custom_ai_mcp_tools');
      expect(listColumns(db, 'client_profiles').map((c) => c.name)).toContain('ai_tools_enabled');

      // Re-up restores cleanly
      up(db);
      expect(listTables(db)).toContain('custom_ai_output_policies');
      expect(listTables(db)).toContain('custom_ai_guard_events');
    } finally {
      db.close();
    }
  });

  it('cleans up only the deleted profile scope via trigger without touching neighboring ids or support_tenant', () => {
    const db = new Database(':memory:');
    try {
      runLegacyBaseline(db);
      runClientProfiles(db);
      runAiBase(db);
      runAiMcp(db);
      up(db);

      db.prepare(
        "INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (1, 'p1', 'th1', 'ek1', 'iv1', 't1')",
      ).run();
      db.prepare(
        "INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (10, 'p10', 'th10', 'ek10', 'iv10', 't10')",
      ).run();

      for (const [kind, id] of [
        ['profile', '1'],
        ['profile', '10'],
        ['support_tenant', '1'],
      ] as const) {
        db.prepare(
          `INSERT INTO custom_ai_output_policies (scope_kind, scope_id, detectors_json, replacement_text)
           VALUES (?, ?, '{}', 'Blocked')`,
        ).run(kind, id);
        db.prepare(
          `INSERT INTO custom_ai_guard_events (scope_kind, scope_id, detector, action, wire)
           VALUES (?, ?, 'keywords', 'blocked', 'openai-chat')`,
        ).run(kind, id);
      }

      db.prepare('DELETE FROM client_profiles WHERE id = 1').run();

      const remainingPolicies = db
        .prepare('SELECT scope_kind, scope_id FROM custom_ai_output_policies ORDER BY scope_kind, scope_id')
        .all() as Array<{ scope_kind: string; scope_id: string }>;
      expect(remainingPolicies).toEqual([
        { scope_kind: 'profile', scope_id: '10' },
        { scope_kind: 'support_tenant', scope_id: '1' },
      ]);

      const remainingEvents = db
        .prepare('SELECT scope_kind, scope_id FROM custom_ai_guard_events ORDER BY scope_kind, scope_id')
        .all() as Array<{ scope_kind: string; scope_id: string }>;
      expect(remainingEvents).toEqual([
        { scope_kind: 'profile', scope_id: '10' },
        { scope_kind: 'support_tenant', scope_id: '1' },
      ]);
    } finally {
      db.close();
    }
  });
});
