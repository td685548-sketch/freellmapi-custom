// Migration: AI Platform Spec 035 — Hierarchical Request Span Tracing, Remote MCP OAuth 2.1 PKCE,
// Scheduled/Async Flow Triggers, and Outer-Chat Write Approval Auto-Resume Continuations
// Created: 2026-11-18
//
// DOWN: reversible

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_ai_request_traces (
      trace_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      thread_id TEXT,
      trace_source TEXT NOT NULL DEFAULT 'generated',
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      end_user TEXT,
      wire TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      served_model TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      spans_count INTEGER NOT NULL DEFAULT 1,
      error_summary TEXT,
      spans_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_custom_ai_request_traces_scope_started
      ON custom_ai_request_traces(scope_kind, scope_id, started_at DESC);

    CREATE INDEX IF NOT EXISTS idx_custom_ai_request_traces_started
      ON custom_ai_request_traces(started_at DESC);

    CREATE INDEX IF NOT EXISTS idx_custom_ai_request_traces_thread
      ON custom_ai_request_traces(thread_id) WHERE thread_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS custom_ai_mcp_oauth_credentials (
      server_id INTEGER PRIMARY KEY REFERENCES custom_ai_mcp_servers(id) ON DELETE CASCADE,
      issuer_url TEXT,
      authorization_endpoint TEXT NOT NULL,
      token_endpoint TEXT NOT NULL,
      revocation_endpoint TEXT,
      client_id TEXT NOT NULL,
      client_secret_ciphertext TEXT,
      client_secret_iv TEXT,
      client_secret_tag TEXT,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      redirect_uri TEXT NOT NULL,
      pkce_method TEXT NOT NULL DEFAULT 'S256',
      access_token_ciphertext TEXT,
      access_token_iv TEXT,
      access_token_tag TEXT,
      refresh_token_ciphertext TEXT,
      refresh_token_iv TEXT,
      refresh_token_tag TEXT,
      token_type TEXT NOT NULL DEFAULT 'Bearer',
      expires_at TEXT,
      last_refreshed_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS custom_ai_mcp_oauth_pkce_states (
      state_hash TEXT PRIMARY KEY,
      server_id INTEGER NOT NULL REFERENCES custom_ai_mcp_servers(id) ON DELETE CASCADE,
      code_verifier_ciphertext TEXT NOT NULL,
      code_verifier_iv TEXT NOT NULL,
      code_verifier_tag TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      actor_id INTEGER,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_custom_ai_mcp_oauth_pkce_expires
      ON custom_ai_mcp_oauth_pkce_states(expires_at);

    CREATE TABLE IF NOT EXISTS custom_ai_flow_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id INTEGER NOT NULL UNIQUE REFERENCES custom_ai_flows(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      schedule_kind TEXT NOT NULL DEFAULT 'interval',
      interval_seconds INTEGER,
      cron_expr TEXT,
      profile_id INTEGER NOT NULL DEFAULT 0,
      end_user TEXT,
      input_message TEXT NOT NULL,
      last_run_id TEXT,
      last_run_at TEXT,
      last_status TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_custom_ai_flow_schedules_due
      ON custom_ai_flow_schedules(enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS custom_ai_chat_continuations (
      approval_id INTEGER PRIMARY KEY REFERENCES custom_ai_approvals(id) ON DELETE CASCADE,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      end_user TEXT,
      wire TEXT NOT NULL,
      model TEXT NOT NULL,
      served_model TEXT,
      state_ciphertext TEXT NOT NULL,
      state_iv TEXT NOT NULL,
      state_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'awaiting_approval',
      assistant_message_masked TEXT,
      finish_reason TEXT,
      rounds INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      next_approval_id INTEGER,
      error_text TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_custom_ai_chat_continuations_scope
      ON custom_ai_chat_continuations(scope_kind, scope_id, created_at DESC);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_custom_ai_chat_continuations_scope;
    DROP TABLE IF EXISTS custom_ai_chat_continuations;
    DROP INDEX IF EXISTS idx_custom_ai_flow_schedules_due;
    DROP TABLE IF EXISTS custom_ai_flow_schedules;
    DROP INDEX IF EXISTS idx_custom_ai_mcp_oauth_pkce_expires;
    DROP TABLE IF EXISTS custom_ai_mcp_oauth_pkce_states;
    DROP TABLE IF EXISTS custom_ai_mcp_oauth_credentials;
    DROP INDEX IF EXISTS idx_custom_ai_request_traces_thread;
    DROP INDEX IF EXISTS idx_custom_ai_request_traces_started;
    DROP INDEX IF EXISTS idx_custom_ai_request_traces_scope_started;
    DROP TABLE IF EXISTS custom_ai_request_traces;
  `);
}
