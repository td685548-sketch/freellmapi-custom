import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';
import { up as runClientProfiles } from '../../../db/migrations/20260805_000002_client_profiles.js';
import { up as runAiBase } from '../../../db/migrations/20261113_100000_custom_ai_platform_base.js';
import { up as runAiMcp } from '../../../db/migrations/20261113_110000_custom_ai_mcp_client.js';
import { up as runAiOutputGuard } from '../../../db/migrations/20261113_120000_custom_ai_output_guard.js';
import { down, up } from '../../../db/migrations/20261113_130000_custom_ai_retrieval.js';

function listTables(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function listIndexes(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function setupPreRetrievalDb(): Database.Database {
  const db = new Database(':memory:');
  runLegacyBaseline(db);
  runClientProfiles(db);
  runAiBase(db);
  runAiMcp(db);
  runAiOutputGuard(db);
  return db;
}

describe('migration 20261113_130000_custom_ai_retrieval', () => {
  it('supports idempotent up -> down -> up with expected defaults and preserves prior AI platform tables', () => {
    const db = setupPreRetrievalDb();
    try {
      up(db);
      up(db); // idempotent

      const tables = listTables(db);
      expect(tables).toContain('custom_ai_retrieval_settings');
      expect(tables).toContain('custom_ai_chunk_embeddings');
      expect(tables).toContain('custom_ai_index_jobs');
      expect(tables).toContain('custom_ai_embedding_usage');

      const indexes = listIndexes(db);
      expect(indexes).toContain('idx_ai_index_jobs_active');
      expect(indexes).toContain('idx_ai_chunk_embeddings_scope_status');
      expect(indexes).toContain('idx_ai_chunk_embeddings_scope_doc');
      expect(indexes).toContain('idx_ai_embedding_usage_scope_day');

      db.prepare("INSERT INTO custom_ai_retrieval_settings (scope_kind, scope_id) VALUES ('profile', '1')").run();
      const row = db
        .prepare(
          'SELECT mode, embedding_model, dimensions, top_k, min_score, citations_enabled, index_generation FROM custom_ai_retrieval_settings WHERE scope_id = ?',
        )
        .get('1') as Record<string, unknown>;
      expect(row).toEqual({
        mode: 'hybrid',
        embedding_model: null,
        dimensions: 768,
        top_k: 5,
        min_score: 0.25,
        citations_enabled: 1,
        index_generation: 1,
      });

      down(db);
      const tablesAfterDown = listTables(db);
      expect(tablesAfterDown).not.toContain('custom_ai_retrieval_settings');
      expect(tablesAfterDown).not.toContain('custom_ai_chunk_embeddings');
      expect(tablesAfterDown).not.toContain('custom_ai_index_jobs');
      expect(tablesAfterDown).not.toContain('custom_ai_embedding_usage');
      expect(tablesAfterDown).toContain('custom_ai_output_policies');
      expect(tablesAfterDown).toContain('custom_ai_mcp_servers');

      up(db);
      const tablesAfterReUp = listTables(db);
      expect(tablesAfterReUp).toContain('custom_ai_retrieval_settings');
      expect(tablesAfterReUp).toContain('custom_ai_chunk_embeddings');
      expect(tablesAfterReUp).toContain('custom_ai_index_jobs');
      expect(tablesAfterReUp).toContain('custom_ai_embedding_usage');
    } finally {
      db.close();
    }
  });

  it('enforces active-job partial unique index and table CHECK constraints', () => {
    const db = setupPreRetrievalDb();
    try {
      up(db);

      // First active queued job succeeds
      db.prepare(
        "INSERT INTO custom_ai_index_jobs (scope_kind, scope_id, reason, status) VALUES ('profile', '1', 'reindex', 'queued')",
      ).run();

      // Second active job (queued or running) for same scope fails
      expect(() =>
        db
          .prepare(
            "INSERT INTO custom_ai_index_jobs (scope_kind, scope_id, reason, status) VALUES ('profile', '1', 'doc_add', 'queued')",
          )
          .run(),
      ).toThrow(/UNIQUE/);
      expect(() =>
        db
          .prepare(
            "INSERT INTO custom_ai_index_jobs (scope_kind, scope_id, reason, status) VALUES ('profile', '1', 'doc_add', 'running')",
          )
          .run(),
      ).toThrow(/UNIQUE/);

      // Another scope can have an active job concurrently
      db.prepare(
        "INSERT INTO custom_ai_index_jobs (scope_kind, scope_id, reason, status) VALUES ('support_tenant', '1', 'reindex', 'running')",
      ).run();

      // Completing the job allows another queued job for the same scope
      db.prepare("UPDATE custom_ai_index_jobs SET status = 'succeeded' WHERE scope_kind = 'profile' AND scope_id = '1'").run();
      db.prepare(
        "INSERT INTO custom_ai_index_jobs (scope_kind, scope_id, reason, status) VALUES ('profile', '1', 'model_change', 'queued')",
      ).run();

      // Historical succeeded/failed jobs do not collide
      db.prepare(
        "INSERT INTO custom_ai_index_jobs (scope_kind, scope_id, reason, status) VALUES ('profile', '1', 'doc_edit', 'failed')",
      ).run();

      // CHECK constraints across all 4 tables
      expect(() =>
        db
          .prepare(
            "INSERT INTO custom_ai_retrieval_settings (scope_kind, scope_id, mode) VALUES ('profile', '2', 'vector_only')",
          )
          .run(),
      ).toThrow(/CHECK/);

      expect(() =>
        db
          .prepare(
            "INSERT INTO custom_ai_chunk_embeddings (scope_kind, scope_id, doc_id, chunk_id, content_hash, model, dims, status) VALUES ('profile', '1', '1', 1, 'h', 'm', 4, 'broken')",
          )
          .run(),
      ).toThrow(/CHECK/);

      expect(() =>
        db
          .prepare(
            "INSERT INTO custom_ai_index_jobs (scope_kind, scope_id, reason, status) VALUES ('profile', '9', 'invalid_reason', 'queued')",
          )
          .run(),
      ).toThrow(/CHECK/);

      expect(() =>
        db
          .prepare(
            "INSERT INTO custom_ai_index_jobs (scope_kind, scope_id, reason, status) VALUES ('profile', '9', 'reindex', 'done')",
          )
          .run(),
      ).toThrow(/CHECK/);

      expect(() =>
        db
          .prepare(
            "INSERT INTO custom_ai_embedding_usage (day, scope_kind, scope_id, model, purpose) VALUES ('2026-11-15', 'profile', '1', 'm', 'other')",
          )
          .run(),
      ).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });

  it('cascades profile deletion across all 4 retrieval tables via trigger without touching neighboring ids or support_tenant', () => {
    const db = setupPreRetrievalDb();
    try {
      up(db);

      db.prepare(
        "INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (1, 'p1', 'th1', 'ek1', 'iv1', 't1')",
      ).run();
      db.prepare(
        "INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (10, 'p10', 'th10', 'ek10', 'iv10', 't10')",
      ).run();

      for (const [kind, id] of [
        ['profile', '1'],
        ['profile', '10'],
        ['support_tenant', '1'],
      ] as const) {
        db.prepare(
          'INSERT INTO custom_ai_retrieval_settings (scope_kind, scope_id) VALUES (?, ?)',
        ).run(kind, id);
        db.prepare(
          "INSERT INTO custom_ai_chunk_embeddings (scope_kind, scope_id, doc_id, chunk_id, ord, content_hash, model, dims, status) VALUES (?, ?, 'doc-1', 1, 0, 'hash1', 'm', 4, 'ready')",
        ).run(kind, id);
        db.prepare(
          "INSERT INTO custom_ai_index_jobs (scope_kind, scope_id, reason, status) VALUES (?, ?, 'reindex', 'succeeded')",
        ).run(kind, id);
        db.prepare(
          "INSERT INTO custom_ai_embedding_usage (day, scope_kind, scope_id, model, purpose, input_tokens, requests) VALUES ('2026-11-15', ?, ?, 'm', 'index', 100, 1)",
        ).run(kind, id);
      }

      db.prepare('DELETE FROM client_profiles WHERE id = 1').run();

      for (const table of [
        'custom_ai_retrieval_settings',
        'custom_ai_chunk_embeddings',
        'custom_ai_index_jobs',
        'custom_ai_embedding_usage',
      ] as const) {
        const remaining = db
          .prepare(`SELECT scope_kind, scope_id FROM ${table} ORDER BY scope_kind, scope_id`)
          .all() as Array<{ scope_kind: string; scope_id: string }>;
        expect(remaining).toEqual([
          { scope_kind: 'profile', scope_id: '10' },
          { scope_kind: 'support_tenant', scope_id: '1' },
        ]);
      }
    } finally {
      db.close();
    }
  });
});
