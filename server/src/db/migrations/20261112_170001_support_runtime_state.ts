import type { Db } from '../types.js';

/**
 * Migration 20261112_170001_support_runtime_state
 * Agent 1: Durable runtime turn, conversation lease, quota reservation, and guest issuance state.
 */

export function up(db: Db): void {
  // Ensure settings table exists for runtime policy
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS x_support_runtime_turns (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      conversation_id TEXT,
      input_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('processing', 'completed', 'failed', 'interrupted')),
      masked_response_encrypted TEXT,
      iv TEXT,
      auth_tag TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      UNIQUE(tenant_id, user_id, request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_x_support_runtime_turns_exp ON x_support_runtime_turns (expires_at);

    CREATE TABLE IF NOT EXISTS x_support_runtime_leases (
      tenant_id INTEGER NOT NULL,
      conversation_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      lease_until INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, conversation_id)
    );

    CREATE TABLE IF NOT EXISTS x_support_runtime_reservations (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      turn_id TEXT NOT NULL UNIQUE,
      window_start INTEGER NOT NULL,
      window_seconds INTEGER NOT NULL,
      reserved_tokens INTEGER NOT NULL,
      actual_tokens INTEGER,
      state TEXT NOT NULL CHECK(state IN ('reserved', 'settled', 'released')),
      created_at TEXT NOT NULL,
      settled_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_x_support_runtime_reservations_tenant_user ON x_support_runtime_reservations (tenant_id, user_id);

    CREATE TABLE IF NOT EXISTS x_support_guest_issuance (
      tenant_id INTEGER NOT NULL,
      ip_hash TEXT NOT NULL,
      window_minute INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, ip_hash, window_minute)
    );

    CREATE INDEX IF NOT EXISTS idx_x_support_guest_issuance_exp ON x_support_guest_issuance (expires_at);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_x_support_guest_issuance_exp;
    DROP TABLE IF EXISTS x_support_guest_issuance;

    DROP INDEX IF EXISTS idx_x_support_runtime_reservations_tenant_user;
    DROP TABLE IF EXISTS x_support_runtime_reservations;

    DROP TABLE IF EXISTS x_support_runtime_leases;

    DROP INDEX IF EXISTS idx_x_support_runtime_turns_exp;
    DROP TABLE IF EXISTS x_support_runtime_turns;
  `);
}
