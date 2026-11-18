// Migration: Async chat continuation state and completion tracking for MCP write-tool approvals
// Created: 2026-11-18
//
// DOWN: reversible
//
// Adds encrypted chat continuation snapshot columns and public completion status fields to
// `custom_ai_approvals` so non-Flow MCP tool-loop requests can resume asynchronously after an
// administrator approves or rejects a write action. Zero SQLite triggers are created.

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
  if (!hasTable(db, 'custom_ai_approvals')) return;
  addColumnIfMissing(db, 'custom_ai_approvals', 'continuation_ciphertext', 'TEXT');
  addColumnIfMissing(db, 'custom_ai_approvals', 'continuation_iv', 'TEXT');
  addColumnIfMissing(db, 'custom_ai_approvals', 'continuation_tag', 'TEXT');
  addColumnIfMissing(db, 'custom_ai_approvals', 'continuation_status', 'TEXT');
  addColumnIfMissing(db, 'custom_ai_approvals', 'continuation_reply_masked', 'TEXT');
  addColumnIfMissing(db, 'custom_ai_approvals', 'continuation_next_approval_id', 'INTEGER');
  addColumnIfMissing(db, 'custom_ai_approvals', 'continuation_model', 'TEXT');
  addColumnIfMissing(db, 'custom_ai_approvals', 'continuation_error', 'TEXT');
  addColumnIfMissing(db, 'custom_ai_approvals', 'continuation_finished_at', 'TEXT');
}

export function down(db: Db): void {
  if (!hasTable(db, 'custom_ai_approvals')) return;
  dropColumnIfExists(db, 'custom_ai_approvals', 'continuation_finished_at');
  dropColumnIfExists(db, 'custom_ai_approvals', 'continuation_error');
  dropColumnIfExists(db, 'custom_ai_approvals', 'continuation_model');
  dropColumnIfExists(db, 'custom_ai_approvals', 'continuation_next_approval_id');
  dropColumnIfExists(db, 'custom_ai_approvals', 'continuation_reply_masked');
  dropColumnIfExists(db, 'custom_ai_approvals', 'continuation_status');
  dropColumnIfExists(db, 'custom_ai_approvals', 'continuation_tag');
  dropColumnIfExists(db, 'custom_ai_approvals', 'continuation_iv');
  dropColumnIfExists(db, 'custom_ai_approvals', 'continuation_ciphertext');
}
