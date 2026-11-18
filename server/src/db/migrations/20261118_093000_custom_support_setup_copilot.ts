import type { Db } from '../types.js';

/**
 * Migration 20261118_093000_custom_support_setup_copilot
 * Persists consent-gated Support AI Setup Copilot proposals and audit outcomes.
 *
 * NOTE: Deliberately avoids a DDL `REFERENCES x_support_tenants(id)` clause because
 * `x_support_tenants` is initialized lazily by `ensureSupportTables()` rather than baseline migrations.
 */

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_support_setup_proposals (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      target_mode TEXT NOT NULL,
      tenant_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending_consent',
      requirements_json TEXT NOT NULL DEFAULT '{}',
      proposal_json TEXT NOT NULL,
      execution_result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      applied_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_support_setup_proposals_user_status
      ON custom_support_setup_proposals (user_id, status, created_at DESC);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_support_setup_proposals_user_status;
    DROP TABLE IF EXISTS custom_support_setup_proposals;
  `);
}
