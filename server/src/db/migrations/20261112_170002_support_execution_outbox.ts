import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_support_action_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      action_id TEXT NOT NULL,
      tool_id INTEGER NOT NULL,
      requester_encrypted TEXT NOT NULL,
      requester_iv TEXT NOT NULL,
      requester_auth_tag TEXT NOT NULL,
      effective_args_encrypted TEXT NOT NULL,
      effective_args_iv TEXT NOT NULL,
      effective_args_auth_tag TEXT NOT NULL,
      target_hash TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      schema_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      claim_token TEXT,
      result_encrypted TEXT,
      result_iv TEXT,
      result_auth_tag TEXT,
      reviewer TEXT,
      review_note TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(tenant_id, action_id)
    );

    CREATE INDEX IF NOT EXISTS idx_x_sup_act_exec_tenant_status
      ON x_support_action_executions(tenant_id, status);

    CREATE TABLE IF NOT EXISTS x_support_partner_events (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      dedup_key TEXT NOT NULL,
      payload_encrypted TEXT NOT NULL,
      payload_iv TEXT NOT NULL,
      payload_auth_tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(tenant_id, type, dedup_key)
    );

    CREATE INDEX IF NOT EXISTS idx_x_sup_part_evt_tenant
      ON x_support_partner_events(tenant_id, created_at);

    CREATE TABLE IF NOT EXISTS x_support_partner_deliveries (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES x_support_partner_events(id) ON DELETE CASCADE,
      tenant_id INTEGER NOT NULL,
      webhook_id TEXT NOT NULL,
      target_snapshot_encrypted TEXT NOT NULL,
      target_snapshot_iv TEXT NOT NULL,
      target_snapshot_auth_tag TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      claim_until TEXT,
      last_status_code INTEGER,
      sanitized_last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(event_id, webhook_id)
    );

    CREATE INDEX IF NOT EXISTS idx_x_sup_part_deliv_tenant_state
      ON x_support_partner_deliveries(tenant_id, state);

    CREATE INDEX IF NOT EXISTS idx_x_sup_part_deliv_claim
      ON x_support_partner_deliveries(state, next_attempt_at);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS x_support_partner_deliveries;
    DROP TABLE IF EXISTS x_support_partner_events;
    DROP TABLE IF EXISTS x_support_action_executions;
  `);
}
