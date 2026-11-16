// Migration: AI Platform Upgrade — remove MCP state when a client profile is deleted
// Created: 2026-11-16
//
// The other AI platform pillars clean up their profile-scoped rows with an
// AFTER DELETE trigger on client_profiles; the MCP client migration did not.
// This trigger removes the profile's tool bindings, tool call journal,
// approvals and its binding revision key in settings.
//
// DOWN: reversible (drops the trigger; deleted rows are not restored)

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function up(db: Db): void {
  if (!hasTable(db, 'client_profiles') || !hasTable(db, 'custom_ai_tool_bindings')) return;
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_client_profiles_delete_mcp
    AFTER DELETE ON client_profiles
    BEGIN
      DELETE FROM custom_ai_tool_bindings
       WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
      DELETE FROM custom_ai_tool_calls
       WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
      DELETE FROM custom_ai_approvals
       WHERE scope_kind = 'profile' AND scope_id = CAST(OLD.id AS TEXT);
      DELETE FROM settings
       WHERE key = 'ai_platform_scope_profile_' || OLD.id || '_mcp_binding';
    END;
  `);
}

export function down(db: Db): void {
  db.exec('DROP TRIGGER IF EXISTS trg_client_profiles_delete_mcp;');
}
