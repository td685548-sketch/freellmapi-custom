import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';
import { up as runClientProfiles } from '../../../db/migrations/20260805_000002_client_profiles.js';
import { up as runAiBase } from '../../../db/migrations/20261113_100000_custom_ai_platform_base.js';
import { up as runAiPromptCache } from '../../../db/migrations/20261113_140000_custom_ai_prompt_cache.js';
import { down, up } from '../../../db/migrations/20261113_150000_custom_ai_prompt_versions.js';

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

function listTriggers(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function setupPrePromptsDb(): Database.Database {
  const db = new Database(':memory:');
  runLegacyBaseline(db);
  runClientProfiles(db);
  runAiBase(db);
  runAiPromptCache(db);
  return db;
}

describe('migration 20261113_150000_custom_ai_prompt_versions', () => {
  it('supports idempotent up -> down -> up and preserves existing system_prompt columns on down', () => {
    const db = setupPrePromptsDb();
    try {
      db.prepare(
        `INSERT INTO client_profiles
           (id, name, token_hash, encrypted_key, iv, auth_tag, system_prompt, created_at, updated_at)
         VALUES (1, 'Alpha', 'th1', 'ek1', 'iv1', 't1', 'Be concise.', '2026-11-10 00:00:00', '2026-11-12 05:00:00')`,
      ).run();
      db.prepare(
        `INSERT INTO client_profiles
           (id, name, token_hash, encrypted_key, iv, auth_tag, system_prompt, created_at, updated_at)
         VALUES (2, 'Empty', 'th2', 'ek2', 'iv2', 't2', NULL, '2026-11-10 00:00:00', '2026-11-12 05:00:00')`,
      ).run();
      db.prepare(
        `INSERT INTO client_profiles
           (id, name, token_hash, encrypted_key, iv, auth_tag, system_prompt, created_at, updated_at)
         VALUES (3, 'Blank', 'th3', 'ek3', 'iv3', 't3', '   \n\t  ', '2026-11-10 00:00:00', '2026-11-12 05:00:00')`,
      ).run();

      db.exec(`
        CREATE TABLE x_support_tenants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          public_key TEXT NOT NULL UNIQUE,
          secret_encrypted TEXT NOT NULL,
          secret_iv TEXT NOT NULL,
          secret_auth_tag TEXT NOT NULL,
          default_model TEXT NOT NULL DEFAULT 'auto',
          system_prompt TEXT NOT NULL DEFAULT '',
          allowed_origins_json TEXT NOT NULL DEFAULT '[]',
          allow_guest INTEGER NOT NULL DEFAULT 1,
          roles_config_json TEXT NOT NULL DEFAULT '[]',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO x_support_tenants
           (id, name, slug, public_key, secret_encrypted, secret_iv, secret_auth_tag, system_prompt, created_at, updated_at)
         VALUES (10, 'Acme Support', 'acme', 'pk1', 'se1', 'si1', 'st1', 'Help {{end_user_name}}.', '2026-11-11T00:00:00.000Z', '2026-11-12T12:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO x_support_tenants
           (id, name, slug, public_key, secret_encrypted, secret_iv, secret_auth_tag, system_prompt, created_at, updated_at)
         VALUES (11, 'Quiet Support', 'quiet', 'pk2', 'se2', 'si2', 'st2', '   ', '2026-11-11T00:00:00.000Z', '2026-11-12T12:00:00.000Z')`,
      ).run();

      up(db);
      up(db); // idempotent

      const tables = listTables(db);
      expect(tables).toContain('custom_ai_prompt_versions');
      expect(tables).toContain('custom_ai_prompt_heads');
      expect(listIndexes(db)).toContain('idx_custom_ai_prompt_versions_scope_status');
      expect(listTriggers(db)).toContain('trg_client_profiles_delete_prompts');

      const versions = db
        .prepare(
          'SELECT scope_kind, scope_id, version, body, variables_json, note, status, restored_from, author_id, created_at FROM custom_ai_prompt_versions ORDER BY scope_kind, scope_id',
        )
        .all();
      expect(versions).toEqual([
        {
          scope_kind: 'profile',
          scope_id: '1',
          version: 1,
          body: 'Be concise.',
          variables_json: '[]',
          note: '',
          status: 'published',
          restored_from: null,
          author_id: null,
          created_at: '2026-11-12 05:00:00',
        },
        {
          scope_kind: 'support_tenant',
          scope_id: '10',
          version: 1,
          body: 'Help {{end_user_name}}.',
          variables_json: '[]',
          note: '',
          status: 'published',
          restored_from: null,
          author_id: null,
          created_at: '2026-11-12T12:00:00.000Z',
        },
      ]);

      const heads = db
        .prepare(
          'SELECT scope_kind, scope_id, published_version, draft_version, revision FROM custom_ai_prompt_heads ORDER BY scope_kind, scope_id',
        )
        .all();
      expect(heads).toEqual([
        {
          scope_kind: 'profile',
          scope_id: '1',
          published_version: 1,
          draft_version: null,
          revision: 1,
        },
        {
          scope_kind: 'support_tenant',
          scope_id: '10',
          published_version: 1,
          draft_version: null,
          revision: 1,
        },
      ]);

      down(db);

      expect(listTables(db)).not.toContain('custom_ai_prompt_versions');
      expect(listTables(db)).not.toContain('custom_ai_prompt_heads');
      expect(listIndexes(db)).not.toContain('idx_custom_ai_prompt_versions_scope_status');
      expect(listTriggers(db)).not.toContain('trg_client_profiles_delete_prompts');

      // Legacy system_prompt columns must stay intact after down()
      expect(
        db.prepare('SELECT system_prompt FROM client_profiles WHERE id = 1').get(),
      ).toEqual({ system_prompt: 'Be concise.' });
      expect(
        db.prepare('SELECT system_prompt FROM x_support_tenants WHERE id = 10').get(),
      ).toEqual({ system_prompt: 'Help {{end_user_name}}.' });

      // Re-up restores identical backfilled rows
      up(db);
      expect(
        db
          .prepare(
            'SELECT scope_kind, scope_id, version, body, variables_json, note, status, restored_from, author_id, created_at FROM custom_ai_prompt_versions ORDER BY scope_kind, scope_id',
          )
          .all(),
      ).toEqual(versions);
    } finally {
      db.close();
    }
  });

  it('runs cleanly when x_support_tenants does not exist and enforces constraints + delete trigger', () => {
    const db = setupPrePromptsDb();
    try {
      up(db);

      expect(() =>
        db
          .prepare(
            "INSERT INTO custom_ai_prompt_versions (scope_kind, scope_id, version, body, status) VALUES ('profile', '1', 1, 'hi', 'invalid')",
          )
          .run(),
      ).toThrow(/CHECK/);

      db.prepare(
        "INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag, system_prompt) VALUES (1, 'p1', 'th1', 'ek1', 'iv1', 't1', 'p1 prompt')",
      ).run();
      db.prepare(
        "INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag, system_prompt) VALUES (2, 'p2', 'th2', 'ek2', 'iv2', 't2', 'p2 prompt')",
      ).run();

      db.prepare(
        "INSERT INTO custom_ai_prompt_versions (scope_kind, scope_id, version, body, status) VALUES ('profile', '1', 1, 'v1', 'published')",
      ).run();
      db.prepare(
        "INSERT INTO custom_ai_prompt_heads (scope_kind, scope_id, published_version, draft_version, revision) VALUES ('profile', '1', 1, NULL, 1)",
      ).run();
      db.prepare(
        "INSERT INTO custom_ai_prompt_versions (scope_kind, scope_id, version, body, status) VALUES ('profile', '2', 1, 'v1', 'published')",
      ).run();
      db.prepare(
        "INSERT INTO custom_ai_prompt_heads (scope_kind, scope_id, published_version, draft_version, revision) VALUES ('profile', '2', 1, NULL, 1)",
      ).run();
      db.prepare(
        "INSERT INTO custom_ai_prompt_versions (scope_kind, scope_id, version, body, status) VALUES ('agent', '1', 1, 'agent v1', 'published')",
      ).run();
      db.prepare(
        "INSERT INTO custom_ai_prompt_heads (scope_kind, scope_id, published_version, draft_version, revision) VALUES ('agent', '1', 1, NULL, 1)",
      ).run();

      // Unique (scope_kind, scope_id, version)
      expect(() =>
        db
          .prepare(
            "INSERT INTO custom_ai_prompt_versions (scope_kind, scope_id, version, body, status) VALUES ('profile', '1', 1, 'dup', 'draft')",
          )
          .run(),
      ).toThrow(/UNIQUE/);

      db.prepare('DELETE FROM client_profiles WHERE id = 1').run();

      expect(
        db
          .prepare('SELECT scope_kind, scope_id FROM custom_ai_prompt_versions ORDER BY scope_kind, scope_id')
          .all(),
      ).toEqual([
        { scope_kind: 'agent', scope_id: '1' },
        { scope_kind: 'profile', scope_id: '2' },
      ]);
      expect(
        db
          .prepare('SELECT scope_kind, scope_id FROM custom_ai_prompt_heads ORDER BY scope_kind, scope_id')
          .all(),
      ).toEqual([
        { scope_kind: 'agent', scope_id: '1' },
        { scope_kind: 'profile', scope_id: '2' },
      ]);
    } finally {
      db.close();
    }
  });
});
