import { describe, expect, it } from 'vitest';
import { connectDb } from '../../../db/index.js';
import { runMigrations } from '../../../db/migrate/runner.js';

const FILENAME = '20261116_100000_custom_ai_mcp_profile_cleanup.ts';
type TestDb = ReturnType<typeof connectDb>;

function seedProfileMcpState(db: TestDb, toolId: number, profileId: number, tag: string): void {
  const scopeId = String(profileId);
  db.prepare("INSERT INTO custom_ai_tool_bindings (tool_id, scope_kind, scope_id) VALUES (?, 'profile', ?)").run(toolId, scopeId);
  db.prepare(
    `INSERT INTO custom_ai_tool_calls (scope_kind, scope_id, server_id, tool_name, status)
     VALUES ('profile', ?, 1, 'lookup_order', 'ok')`,
  ).run(scopeId);
  db.prepare(
    `INSERT INTO custom_ai_approvals
       (execution_key, scope_kind, scope_id, tool_id, args_ciphertext, args_iv, args_tag, args_masked, expires_at)
     VALUES (?, 'profile', ?, ?, 'c', 'i', 't', '{}', datetime('now', '+1 day'))`,
  ).run(`key-${tag}`, scopeId, toolId);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(`ai_platform_scope_profile_${profileId}_mcp_binding`, '{"revision":1}');
}

function countFor(db: TestDb, table: string, kind: string, id: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE scope_kind = ? AND scope_id = ?`).get(kind, id) as { n: number }).n;
}

function settingExists(db: TestDb, key: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key));
}

function triggerExists(db: TestDb): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_client_profiles_delete_mcp'").get());
}

describe(`migration ${FILENAME}`, () => {
  it('removes MCP state of a deleted client profile and leaves other scopes untouched', async () => {
    const db = connectDb(':memory:');
    try {
      await runMigrations(db, 'up');
      expect(triggerExists(db)).toBe(true);

      db.prepare("INSERT INTO custom_ai_mcp_servers (slug, name, url) VALUES ('orders', 'Orders', 'https://mcp.example.test')").run();
      db.prepare(
        `INSERT INTO custom_ai_mcp_tools (server_id, name, input_schema_json, schema_hash, exposed_name)
         VALUES (1, 'lookup_order', '{}', 'h', 'orders__lookup_order')`,
      ).run();
      // Profiles 1 and 10 share a textual prefix, so cleanup must match the id exactly.
      const insertProfile = db.prepare(
        "INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (?, ?, ?, 'e', 'i', 't')",
      );
      insertProfile.run(1, 'one', 'hash-1');
      insertProfile.run(10, 'ten', 'hash-10');
      const p1 = 1;

      seedProfileMcpState(db, 1, p1, 'p1');
      seedProfileMcpState(db, 1, 10, 'p10');
      // An agent scope that happens to share the numeric id must survive.
      db.prepare("INSERT INTO custom_ai_tool_bindings (tool_id, scope_kind, scope_id) VALUES (1, 'agent', ?)").run(String(p1));

      db.prepare('DELETE FROM client_profiles WHERE id = ?').run(p1);

      for (const table of ['custom_ai_tool_bindings', 'custom_ai_tool_calls', 'custom_ai_approvals']) {
        expect(countFor(db, table, 'profile', String(p1)), table).toBe(0);
        expect(countFor(db, table, 'profile', '10'), table).toBe(1);
      }
      expect(countFor(db, 'custom_ai_tool_bindings', 'agent', String(p1))).toBe(1);
      expect(settingExists(db, `ai_platform_scope_profile_${p1}_mcp_binding`)).toBe(false);
      expect(settingExists(db, 'ai_platform_scope_profile_10_mcp_binding')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('drops the trigger on down() and recreates it on up()', async () => {
    const db = connectDb(':memory:');
    try {
      await runMigrations(db, 'up');
      while (db.prepare('SELECT 1 FROM migrations WHERE filename = ?').get(FILENAME)) {
        await runMigrations(db, 'down');
      }
      expect(triggerExists(db)).toBe(false);
      await runMigrations(db, 'up');
      expect(triggerExists(db)).toBe(true);
    } finally {
      db.close();
    }
  });
});
