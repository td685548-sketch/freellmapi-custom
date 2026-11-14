import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';
import { up as runClientProfiles } from '../../../db/migrations/20260805_000002_client_profiles.js';
import { up as runAiBase } from '../../../db/migrations/20261113_100000_custom_ai_platform_base.js';
import { up, down } from '../../../db/migrations/20261113_110000_custom_ai_mcp_client.js';

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

describe('migration 20261113_110000_custom_ai_mcp_client', () => {
  it('creates exactly the 5 MCP tables and 2 client_profiles columns, supports idempotent up -> down -> up', () => {
    const db = new Database(':memory:');
    try {
      runLegacyBaseline(db);
      runClientProfiles(db);
      runAiBase(db);

      up(db);
      up(db); // idempotent

      const tables = listTables(db);
      expect(tables).toContain('custom_ai_mcp_servers');
      expect(tables).toContain('custom_ai_mcp_tools');
      expect(tables).toContain('custom_ai_tool_bindings');
      expect(tables).toContain('custom_ai_tool_calls');
      expect(tables).toContain('custom_ai_approvals');

      // Must NOT create US7 tables early
      expect(tables).not.toContain('custom_ai_agents');
      expect(tables).not.toContain('custom_ai_runs');
      expect(tables).not.toContain('custom_ai_flows');

      // client_profiles columns with backward-compatible defaults
      const profileCols = listColumns(db, 'client_profiles');
      const aiToolsEnabled = profileCols.find((c) => c.name === 'ai_tools_enabled');
      const aiToolMaxRounds = profileCols.find((c) => c.name === 'ai_tool_max_rounds');
      expect(aiToolsEnabled).toBeDefined();
      expect(aiToolsEnabled?.dflt_value).toBe('0');
      expect(aiToolMaxRounds).toBeDefined();

      // Insert a legacy-style client_profile row and verify default ai_tools_enabled = 0
      db.prepare(
        "INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag) VALUES ('legacy', 'th1', 'ek1', 'iv1', 'tag1')",
      ).run();
      const row = db.prepare("SELECT ai_tools_enabled, ai_tool_max_rounds FROM client_profiles WHERE name = 'legacy'").get() as {
        ai_tools_enabled: number;
        ai_tool_max_rounds: number | null;
      };
      expect(row.ai_tools_enabled).toBe(0);
      expect(row.ai_tool_max_rounds).toBeNull();

      // Down removes the 5 tables and 2 columns
      down(db);
      const tablesAfterDown = listTables(db);
      expect(tablesAfterDown).not.toContain('custom_ai_mcp_servers');
      expect(tablesAfterDown).not.toContain('custom_ai_mcp_tools');
      expect(tablesAfterDown).not.toContain('custom_ai_tool_bindings');
      expect(tablesAfterDown).not.toContain('custom_ai_tool_calls');
      expect(tablesAfterDown).not.toContain('custom_ai_approvals');

      const profileColsAfterDown = listColumns(db, 'client_profiles').map((c) => c.name);
      expect(profileColsAfterDown).not.toContain('ai_tools_enabled');
      expect(profileColsAfterDown).not.toContain('ai_tool_max_rounds');

      // Re-up restores cleanly
      up(db);
      expect(listTables(db)).toContain('custom_ai_mcp_servers');
      expect(listColumns(db, 'client_profiles').map((c) => c.name)).toContain('ai_tools_enabled');
    } finally {
      db.close();
    }
  });
});
