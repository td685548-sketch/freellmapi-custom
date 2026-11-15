import type { Db } from '../types.js';

/**
 * Migration 20261115_120001_support_output_controls
 * Agent 1: Encrypted per-tenant output control policies and metadata-only audit events.
 */

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_support_output_policies (
      tenant_id INTEGER PRIMARY KEY REFERENCES x_support_tenants(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 1,
      payload_encrypted TEXT NOT NULL,
      payload_iv TEXT NOT NULL,
      payload_auth_tag TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS x_support_output_events (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES x_support_tenants(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      surface TEXT NOT NULL CHECK(surface IN ('chat', 'copilot')),
      policy_version INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('observe', 'redact', 'block')),
      reasons_json TEXT NOT NULL,
      rule_ids_json TEXT NOT NULL,
      redaction_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(tenant_id, surface, operation_id)
    );

    CREATE INDEX IF NOT EXISTS idx_x_support_output_events_tenant_created_id
      ON x_support_output_events (tenant_id, created_at DESC, id DESC);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_x_support_output_events_tenant_created_id;
    DROP TABLE IF EXISTS x_support_output_events;
    DROP TABLE IF EXISTS x_support_output_policies;
  `);
}
