// Migration: AI Platform Upgrade — US2 MCP Client tables and client_profiles columns
// Created: 2026-11-13
//
// DOWN: reversible

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (c) => c.name === column,
  );
}

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_ai_mcp_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      auth_kind TEXT NOT NULL DEFAULT 'none',
      auth_header_name TEXT,
      auth_ciphertext TEXT,
      auth_iv TEXT,
      auth_tag TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      timeout_ms INTEGER NOT NULL DEFAULT 20000,
      max_result_bytes INTEGER NOT NULL DEFAULT 262144,
      max_concurrency INTEGER NOT NULL DEFAULT 4,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_error TEXT,
      last_connected_at TEXT,
      fail_count INTEGER NOT NULL DEFAULT 0,
      paused_until TEXT,
      protocol_version TEXT,
      server_info_json TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      revision INTEGER NOT NULL DEFAULT 1,
      credential_generation INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS custom_ai_mcp_tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL REFERENCES custom_ai_mcp_servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      input_schema_json TEXT NOT NULL,
      output_schema_json TEXT,
      schema_hash TEXT NOT NULL,
      exposed_name TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'pending',
      effect TEXT NOT NULL DEFAULT 'write',
      reviewed_by INTEGER,
      reviewed_at TEXT,
      missing_since TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(server_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_custom_ai_mcp_tools_server_state
      ON custom_ai_mcp_tools(server_id, state);

    CREATE TABLE IF NOT EXISTS custom_ai_tool_bindings (
      tool_id INTEGER NOT NULL REFERENCES custom_ai_mcp_tools(id) ON DELETE CASCADE,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tool_id, scope_kind, scope_id)
    );
    CREATE INDEX IF NOT EXISTS idx_custom_ai_tool_bindings_scope
      ON custom_ai_tool_bindings(scope_kind, scope_id);

    CREATE TABLE IF NOT EXISTS custom_ai_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      execution_key TEXT,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      end_user TEXT,
      server_id INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      args_masked TEXT,
      result_masked TEXT,
      status TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      result_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_custom_ai_tool_calls_scope_created
      ON custom_ai_tool_calls(scope_kind, scope_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_custom_ai_tool_calls_created
      ON custom_ai_tool_calls(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_ai_tool_calls_execution_key
      ON custom_ai_tool_calls(execution_key) WHERE execution_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS custom_ai_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_key TEXT NOT NULL UNIQUE,
      run_id TEXT,
      step_seq INTEGER NOT NULL DEFAULT 0,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      end_user TEXT,
      tool_id INTEGER NOT NULL REFERENCES custom_ai_mcp_tools(id) ON DELETE CASCADE,
      args_ciphertext TEXT NOT NULL,
      args_iv TEXT NOT NULL,
      args_tag TEXT NOT NULL,
      args_masked TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by INTEGER,
      decided_at TEXT,
      decision_note TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_custom_ai_approvals_status_expires
      ON custom_ai_approvals(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_custom_ai_approvals_scope
      ON custom_ai_approvals(scope_kind, scope_id, created_at);
  `);

  if (hasTable(db, 'client_profiles')) {
    if (!hasColumn(db, 'client_profiles', 'ai_tools_enabled')) {
      db.prepare('ALTER TABLE client_profiles ADD COLUMN ai_tools_enabled INTEGER NOT NULL DEFAULT 0').run();
    }
    if (!hasColumn(db, 'client_profiles', 'ai_tool_max_rounds')) {
      db.prepare('ALTER TABLE client_profiles ADD COLUMN ai_tool_max_rounds INTEGER').run();
    }
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS custom_ai_approvals;
    DROP TABLE IF EXISTS custom_ai_tool_calls;
    DROP TABLE IF EXISTS custom_ai_tool_bindings;
    DROP TABLE IF EXISTS custom_ai_mcp_tools;
    DROP TABLE IF EXISTS custom_ai_mcp_servers;
  `);

  if (hasTable(db, 'client_profiles')) {
    if (hasColumn(db, 'client_profiles', 'ai_tool_max_rounds')) {
      db.prepare('ALTER TABLE client_profiles DROP COLUMN ai_tool_max_rounds').run();
    }
    if (hasColumn(db, 'client_profiles', 'ai_tools_enabled')) {
      db.prepare('ALTER TABLE client_profiles DROP COLUMN ai_tools_enabled').run();
    }
  }
}
