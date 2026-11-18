// Migration: Cross-turn Gemini thought-signature continuity persistence table (Spec 031)
// Created: 2026-11-18
//
// DOWN: reversible
//
// Persists opaque Gemini/Cloud-Code functionCall thought signatures scoped by
// (namespace/accountScope, modelFamily, toolCallId | canonicalCallFingerprint)
// with explicit TTL expiration. Claude signed thinking blocks are strictly
// memory-only and are never written to this table.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_x_thought_signatures (
      scope_key TEXT PRIMARY KEY,
      signature TEXT NOT NULL,
      model_family TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_custom_x_thought_signatures_expires_at
      ON custom_x_thought_signatures(expires_at);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_custom_x_thought_signatures_expires_at;
    DROP TABLE IF EXISTS custom_x_thought_signatures;
  `);
}
