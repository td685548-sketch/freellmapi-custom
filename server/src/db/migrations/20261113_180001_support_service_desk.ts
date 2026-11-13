import type { Db } from '../types.js';

/**
 * Migration 20261113_180001_support_service_desk
 * Agent 1: Encrypted widget profile configs, scoped intake receipts,
 * operator Copilot jobs/budgets, SLA policies, and ticket SLA/routing state.
 */

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_support_desk_widget_configs (
      tenant_id INTEGER PRIMARY KEY REFERENCES x_support_tenants(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 1,
      payload_encrypted TEXT NOT NULL,
      payload_iv TEXT NOT NULL,
      payload_auth_tag TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS x_support_desk_intakes (
      receipt_hash TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES x_support_tenants(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      schema_hash TEXT NOT NULL,
      conversation_id TEXT,
      expires_at TEXT NOT NULL,
      payload_encrypted TEXT NOT NULL,
      payload_iv TEXT NOT NULL,
      payload_auth_tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(tenant_id, user_id, role, request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_x_support_desk_intakes_tenant_user_created
      ON x_support_desk_intakes (tenant_id, user_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_x_support_desk_intakes_tenant_conv
      ON x_support_desk_intakes (tenant_id, conversation_id);

    CREATE INDEX IF NOT EXISTS idx_x_support_desk_intakes_tenant_expires
      ON x_support_desk_intakes (tenant_id, expires_at);

    CREATE TABLE IF NOT EXISTS x_support_desk_copilot_jobs (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES x_support_tenants(id) ON DELETE CASCADE,
      actor_id INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'abstained', 'failed')),
      lease_until TEXT NOT NULL,
      dispatched_calls INTEGER NOT NULL DEFAULT 0,
      reserved_tokens INTEGER NOT NULL DEFAULT 0,
      spent_tokens INTEGER NOT NULL DEFAULT 0,
      payload_encrypted TEXT NOT NULL,
      payload_iv TEXT NOT NULL,
      payload_auth_tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(tenant_id, actor_id, request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_x_support_desk_copilot_jobs_tenant_actor_created
      ON x_support_desk_copilot_jobs (tenant_id, actor_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_x_support_desk_copilot_jobs_tenant_conv
      ON x_support_desk_copilot_jobs (tenant_id, conversation_id);

    CREATE TABLE IF NOT EXISTS x_support_desk_sla_policies (
      tenant_id INTEGER PRIMARY KEY REFERENCES x_support_tenants(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 1,
      payload_encrypted TEXT NOT NULL,
      payload_iv TEXT NOT NULL,
      payload_auth_tag TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS x_support_desk_ticket_state (
      tenant_id INTEGER NOT NULL REFERENCES x_support_tenants(id) ON DELETE CASCADE,
      ticket_id TEXT NOT NULL,
      conversation_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      cycle INTEGER NOT NULL DEFAULT 1,
      cycle_opened_at TEXT NOT NULL,
      priority TEXT NOT NULL,
      department TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      first_human_reply_at TEXT,
      resolved_at TEXT,
      tracking TEXT NOT NULL CHECK(tracking IN ('tracked', 'paused')),
      terminal INTEGER NOT NULL DEFAULT 0 CHECK(terminal IN (0, 1)),
      meta_encrypted TEXT NOT NULL,
      meta_iv TEXT NOT NULL,
      meta_auth_tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, ticket_id)
    );

    CREATE INDEX IF NOT EXISTS idx_x_support_desk_ticket_state_tenant_opened
      ON x_support_desk_ticket_state (tenant_id, cycle_opened_at, ticket_id);

    CREATE INDEX IF NOT EXISTS idx_x_support_desk_ticket_state_tenant_dept
      ON x_support_desk_ticket_state (tenant_id, department, tracking);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_x_support_desk_ticket_state_tenant_dept;
    DROP INDEX IF EXISTS idx_x_support_desk_ticket_state_tenant_opened;
    DROP TABLE IF EXISTS x_support_desk_ticket_state;

    DROP TABLE IF EXISTS x_support_desk_sla_policies;

    DROP INDEX IF EXISTS idx_x_support_desk_copilot_jobs_tenant_conv;
    DROP INDEX IF EXISTS idx_x_support_desk_copilot_jobs_tenant_actor_created;
    DROP TABLE IF EXISTS x_support_desk_copilot_jobs;

    DROP INDEX IF EXISTS idx_x_support_desk_intakes_tenant_expires;
    DROP INDEX IF EXISTS idx_x_support_desk_intakes_tenant_conv;
    DROP INDEX IF EXISTS idx_x_support_desk_intakes_tenant_user_created;
    DROP TABLE IF EXISTS x_support_desk_intakes;

    DROP TABLE IF EXISTS x_support_desk_widget_configs;
  `);
}
