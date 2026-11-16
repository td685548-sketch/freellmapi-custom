import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';
import { up as runClientProfiles } from '../../../db/migrations/20260805_000002_client_profiles.js';
import { up as runAiBase } from '../../../db/migrations/20261113_100000_custom_ai_platform_base.js';
import { up as runAiRetrieval } from '../../../db/migrations/20261113_130000_custom_ai_retrieval.js';
import { down, up } from '../../../db/migrations/20261113_140000_custom_ai_prompt_cache.js';

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

function setupPrePromptCacheDb(): Database.Database {
  const db = new Database(':memory:');
  runLegacyBaseline(db);
  runClientProfiles(db);
  runAiBase(db);
  runAiRetrieval(db);
  return db;
}

describe('migration 20261113_140000_custom_ai_prompt_cache', () => {
  it('supports idempotent up -> down -> up with deterministic 28 builtin seeds and index/trigger cleanup', () => {
    const db = setupPrePromptCacheDb();
    try {
      up(db);
      up(db); // idempotent

      const tables = listTables(db);
      expect(tables).toContain('custom_ai_cache_capabilities');
      expect(tables).toContain('custom_ai_cache_usage_daily');

      const indexes = listIndexes(db);
      expect(indexes).toContain('idx_custom_ai_cache_usage_daily_profile');

      const triggers = listTriggers(db);
      expect(triggers).toContain('trg_client_profiles_delete_prompt_cache');

      const seeds = db
        .prepare('SELECT * FROM custom_ai_cache_capabilities ORDER BY platform, model_pattern, source')
        .all() as Array<Record<string, unknown>>;
      expect(seeds).toHaveLength(28);
      for (const row of seeds) {
        expect(row.source).toBe('builtin');
        expect(row.updated_at).toBe('2026-11-13 00:00:00');
      }

      // Check representative seeds across explicit / implicit / none
      expect(
        db
          .prepare(
            "SELECT mode, max_breakpoints, min_tokens, ttl_seconds FROM custom_ai_cache_capabilities WHERE platform = 'anthropic' AND model_pattern = 'claude-3-5-haiku*' AND source = 'builtin'",
          )
          .get(),
      ).toEqual({ mode: 'explicit', max_breakpoints: 4, min_tokens: 2048, ttl_seconds: 300 });

      expect(
        db
          .prepare(
            "SELECT mode, max_breakpoints, min_tokens, ttl_seconds FROM custom_ai_cache_capabilities WHERE platform = 'deepseek' AND model_pattern = 'deepseek-*' AND source = 'builtin'",
          )
          .get(),
      ).toEqual({ mode: 'implicit', max_breakpoints: 0, min_tokens: 64, ttl_seconds: 3600 });

      expect(
        db
          .prepare(
            "SELECT mode, max_breakpoints, min_tokens, ttl_seconds FROM custom_ai_cache_capabilities WHERE platform = 'groq' AND model_pattern = '*' AND source = 'builtin'",
          )
          .get(),
      ).toEqual({ mode: 'none', max_breakpoints: 0, min_tokens: 0, ttl_seconds: 0 });

      // Settings key deleted on down()
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_platform_prompt_cache_v1', '{\"forward\":false}')",
      ).run();

      down(db);

      expect(listTables(db)).not.toContain('custom_ai_cache_capabilities');
      expect(listTables(db)).not.toContain('custom_ai_cache_usage_daily');
      expect(listIndexes(db)).not.toContain('idx_custom_ai_cache_usage_daily_profile');
      expect(listTriggers(db)).not.toContain('trg_client_profiles_delete_prompt_cache');
      expect(
        db.prepare("SELECT value FROM settings WHERE key = 'ai_platform_prompt_cache_v1'").get(),
      ).toBeUndefined();

      // Re-up produces identical deterministic seeds
      up(db);
      const seedsAfterReUp = db
        .prepare('SELECT * FROM custom_ai_cache_capabilities ORDER BY platform, model_pattern, source')
        .all();
      expect(seedsAfterReUp).toEqual(seeds);
    } finally {
      db.close();
    }
  });

  it('enforces CHECK constraints and deletes only the deleted profile rows via trigger', () => {
    const db = setupPrePromptCacheDb();
    try {
      up(db);

      expect(() =>
        db
          .prepare(
            "INSERT INTO custom_ai_cache_capabilities (platform, model_pattern, source, mode) VALUES ('x', '*', 'invalid', 'none')",
          )
          .run(),
      ).toThrow(/CHECK/);

      expect(() =>
        db
          .prepare(
            "INSERT INTO custom_ai_cache_capabilities (platform, model_pattern, source, mode) VALUES ('x', '*', 'override', 'invalid')",
          )
          .run(),
      ).toThrow(/CHECK/);

      db.prepare(
        "INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (1, 'p1', 'th1', 'ek1', 'iv1', 't1')",
      ).run();
      db.prepare(
        "INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (2, 'p2', 'th2', 'ek2', 'iv2', 't2')",
      ).run();

      db.prepare(
        "INSERT INTO custom_ai_cache_usage_daily (day, profile_id, platform, model, requests) VALUES ('2026-11-16', 0, 'anthropic', 'claude-sonnet-4-6', 3)",
      ).run();
      db.prepare(
        "INSERT INTO custom_ai_cache_usage_daily (day, profile_id, platform, model, requests) VALUES ('2026-11-16', 1, 'anthropic', 'claude-sonnet-4-6', 5)",
      ).run();
      db.prepare(
        "INSERT INTO custom_ai_cache_usage_daily (day, profile_id, platform, model, requests) VALUES ('2026-11-16', 2, 'anthropic', 'claude-sonnet-4-6', 7)",
      ).run();

      db.prepare('DELETE FROM client_profiles WHERE id = 1').run();

      const remaining = db
        .prepare('SELECT profile_id, requests FROM custom_ai_cache_usage_daily ORDER BY profile_id')
        .all();
      expect(remaining).toEqual([
        { profile_id: 0, requests: 3 },
        { profile_id: 2, requests: 7 },
      ]);
    } finally {
      db.close();
    }
  });
});
