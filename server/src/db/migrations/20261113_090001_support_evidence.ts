import type { Db } from '../types.js';

/**
 * Migration 20261113_090001_support_evidence
 * Agent 1: Versioned encrypted knowledge sources, revisions, chunks, policies,
 * evaluation suites/runs, and durable answer evidence provenance.
 */

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_support_evidence_sources (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES x_support_tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('text', 'markdown', 'faq_json', 'url')),
      status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
      allowed_roles_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      published_revision_id TEXT,
      draft_revision_id TEXT,
      revision_count INTEGER NOT NULL DEFAULT 0,
      import_url_encrypted TEXT,
      import_url_iv TEXT,
      import_url_auth_tag TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(tenant_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_x_support_evidence_sources_tenant_status
      ON x_support_evidence_sources (tenant_id, status, published_revision_id);

    CREATE TABLE IF NOT EXISTS x_support_evidence_revisions (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES x_support_tenants(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      format TEXT NOT NULL CHECK(format IN ('text', 'markdown', 'faq_json')),
      content_hash TEXT NOT NULL,
      chunk_count INTEGER NOT NULL,
      payload_encrypted TEXT NOT NULL,
      payload_iv TEXT NOT NULL,
      payload_auth_tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(tenant_id, id),
      UNIQUE(tenant_id, source_id, id),
      UNIQUE(tenant_id, source_id, content_hash),
      FOREIGN KEY (tenant_id, source_id) REFERENCES x_support_evidence_sources(tenant_id, id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_x_support_evidence_revisions_source
      ON x_support_evidence_revisions (tenant_id, source_id, created_at);

    CREATE TABLE IF NOT EXISTS x_support_evidence_chunks (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES x_support_tenants(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      payload_encrypted TEXT NOT NULL,
      payload_iv TEXT NOT NULL,
      payload_auth_tag TEXT NOT NULL,
      UNIQUE(revision_id, ordinal),
      FOREIGN KEY (tenant_id, source_id, revision_id) REFERENCES x_support_evidence_revisions(tenant_id, source_id, id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_x_support_evidence_chunks_rev
      ON x_support_evidence_chunks (tenant_id, source_id, revision_id, ordinal);

    CREATE TABLE IF NOT EXISTS x_support_evidence_policies (
      tenant_id INTEGER PRIMARY KEY REFERENCES x_support_tenants(id) ON DELETE CASCADE,
      policy_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS x_support_evidence_suites (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES x_support_tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      cases_encrypted TEXT NOT NULL,
      cases_iv TEXT NOT NULL,
      cases_auth_tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(tenant_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_x_support_evidence_suites_tenant
      ON x_support_evidence_suites (tenant_id, updated_at);

    CREATE TABLE IF NOT EXISTS x_support_evidence_runs (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES x_support_tenants(id) ON DELETE CASCADE,
      suite_id TEXT NOT NULL,
      suite_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('completed', 'partial', 'failed')),
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      report_encrypted TEXT NOT NULL,
      report_iv TEXT NOT NULL,
      report_auth_tag TEXT NOT NULL,
      FOREIGN KEY (tenant_id, suite_id) REFERENCES x_support_evidence_suites(tenant_id, id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_x_support_evidence_runs_tenant
      ON x_support_evidence_runs (tenant_id, completed_at DESC);

    CREATE TABLE IF NOT EXISTS x_support_evidence_answers (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES x_support_tenants(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      request_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      conversation_id TEXT,
      customer_message_id TEXT,
      assistant_message_id TEXT,
      evidence_encrypted TEXT NOT NULL,
      evidence_iv TEXT NOT NULL,
      evidence_auth_tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(tenant_id, user_id, turn_id),
      UNIQUE(tenant_id, user_id, request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_x_support_evidence_answers_conv_msg
      ON x_support_evidence_answers (tenant_id, conversation_id, assistant_message_id);

    CREATE INDEX IF NOT EXISTS idx_x_support_evidence_answers_cust_msg
      ON x_support_evidence_answers (tenant_id, conversation_id, customer_message_id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_x_support_evidence_answers_cust_msg;
    DROP INDEX IF EXISTS idx_x_support_evidence_answers_conv_msg;
    DROP TABLE IF EXISTS x_support_evidence_answers;

    DROP INDEX IF EXISTS idx_x_support_evidence_runs_tenant;
    DROP TABLE IF EXISTS x_support_evidence_runs;

    DROP INDEX IF EXISTS idx_x_support_evidence_suites_tenant;
    DROP TABLE IF EXISTS x_support_evidence_suites;

    DROP TABLE IF EXISTS x_support_evidence_policies;

    DROP INDEX IF EXISTS idx_x_support_evidence_chunks_rev;
    DROP TABLE IF EXISTS x_support_evidence_chunks;

    DROP INDEX IF EXISTS idx_x_support_evidence_revisions_source;
    DROP TABLE IF EXISTS x_support_evidence_revisions;

    DROP INDEX IF EXISTS idx_x_support_evidence_sources_tenant_status;
    DROP TABLE IF EXISTS x_support_evidence_sources;
  `);
}
