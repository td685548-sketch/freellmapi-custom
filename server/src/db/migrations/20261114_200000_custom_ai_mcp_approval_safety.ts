// Migration: AI Platform Upgrade — MCP approval snapshot safety, server revision, and call journal outcome columns
// Created: 2026-11-14
//
// DOWN: reversible

import type { Db } from '../types.js';

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
  addColumnIfMissing(db, 'custom_ai_mcp_servers', 'server_revision', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'custom_ai_mcp_servers', 'credential_generation', 'INTEGER NOT NULL DEFAULT 1');

  addColumnIfMissing(db, 'custom_ai_approvals', 'snapshot_json', 'TEXT');
  addColumnIfMissing(db, 'custom_ai_approvals', 'result_masked', 'TEXT');
  addColumnIfMissing(db, 'custom_ai_approvals', 'error_text', 'TEXT');
  addColumnIfMissing(db, 'custom_ai_approvals', 'duration_ms', 'INTEGER');
  addColumnIfMissing(db, 'custom_ai_approvals', 'result_bytes', 'INTEGER');
  addColumnIfMissing(db, 'custom_ai_approvals', 'executed_at', 'TEXT');
  addColumnIfMissing(db, 'custom_ai_approvals', 'owner_instance_id', 'TEXT');

  addColumnIfMissing(db, 'custom_ai_tool_calls', 'error_text', 'TEXT');
  addColumnIfMissing(db, 'custom_ai_tool_calls', 'updated_at', 'TEXT');
}

export function down(db: Db): void {
  dropColumnIfExists(db, 'custom_ai_tool_calls', 'updated_at');
  dropColumnIfExists(db, 'custom_ai_tool_calls', 'error_text');

  dropColumnIfExists(db, 'custom_ai_approvals', 'owner_instance_id');
  dropColumnIfExists(db, 'custom_ai_approvals', 'executed_at');
  dropColumnIfExists(db, 'custom_ai_approvals', 'result_bytes');
  dropColumnIfExists(db, 'custom_ai_approvals', 'duration_ms');
  dropColumnIfExists(db, 'custom_ai_approvals', 'error_text');
  dropColumnIfExists(db, 'custom_ai_approvals', 'result_masked');
  dropColumnIfExists(db, 'custom_ai_approvals', 'snapshot_json');

  dropColumnIfExists(db, 'custom_ai_mcp_servers', 'credential_generation');
  dropColumnIfExists(db, 'custom_ai_mcp_servers', 'server_revision');
}
