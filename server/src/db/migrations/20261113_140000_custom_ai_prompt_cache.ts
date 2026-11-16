// Migration: AI Platform Upgrade — US5 Prompt Cache capabilities, daily usage, and profile cleanup trigger
// Created: 2026-11-13
//
// DOWN: reversible

import type { Db } from '../types.js';

const BUILTIN_CAPABILITY_SEEDS: ReadonlyArray<
  readonly [string, string, 'builtin', 'explicit' | 'implicit' | 'none', number, number, number]
> = [
  ['anthropic', 'claude-3-5-haiku*', 'builtin', 'explicit', 4, 2048, 300],
  ['anthropic', 'claude-haiku*', 'builtin', 'explicit', 4, 2048, 300],
  ['anthropic', 'claude-*', 'builtin', 'explicit', 4, 1024, 300],
  ['claude', 'claude-*', 'builtin', 'explicit', 4, 1024, 300],
  ['openrouter', 'anthropic/claude-3-5-haiku*', 'builtin', 'explicit', 4, 2048, 300],
  ['openrouter', 'anthropic/claude-*', 'builtin', 'explicit', 4, 1024, 300],
  ['custom', 'claude-*', 'builtin', 'explicit', 4, 1024, 300],
  ['openai', 'gpt-*', 'builtin', 'implicit', 0, 1024, 300],
  ['openai', 'o*', 'builtin', 'implicit', 0, 1024, 300],
  ['codex', '*', 'builtin', 'implicit', 0, 1024, 300],
  ['google', 'gemini-*', 'builtin', 'implicit', 0, 1024, 300],
  ['gemini', 'gemini-*', 'builtin', 'implicit', 0, 1024, 300],
  ['deepseek', 'deepseek-*', 'builtin', 'implicit', 0, 64, 3600],
  ['openrouter', 'openai/*', 'builtin', 'implicit', 0, 1024, 300],
  ['openrouter', 'deepseek/*', 'builtin', 'implicit', 0, 64, 3600],
  ['openrouter', 'google/gemini-*', 'builtin', 'implicit', 0, 1024, 300],
  ['sail', '*', 'builtin', 'implicit', 0, 1024, 300],
  ['aclide', '*', 'builtin', 'implicit', 0, 1024, 300],
  ['kimi', 'kimi-*', 'builtin', 'implicit', 0, 1024, 300],
  ['xai', 'grok-*', 'builtin', 'implicit', 0, 1024, 300],
  ['groq', '*', 'builtin', 'none', 0, 0, 0],
  ['cerebras', '*', 'builtin', 'none', 0, 0, 0],
  ['mistral', '*', 'builtin', 'none', 0, 0, 0],
  ['nvidia', '*', 'builtin', 'none', 0, 0, 0],
  ['cloudflare', '*', 'builtin', 'none', 0, 0, 0],
  ['cohere', '*', 'builtin', 'none', 0, 0, 0],
  ['ollama', '*', 'builtin', 'none', 0, 0, 0],
  ['huggingface', '*', 'builtin', 'none', 0, 0, 0],
];

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_ai_cache_capabilities (
      platform TEXT NOT NULL,
      model_pattern TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('builtin', 'override')),
      mode TEXT NOT NULL CHECK (mode IN ('explicit', 'implicit', 'none')),
      max_breakpoints INTEGER NOT NULL DEFAULT 4,
      min_tokens INTEGER NOT NULL DEFAULT 1024,
      ttl_seconds INTEGER NOT NULL DEFAULT 300,
      updated_at TEXT NOT NULL DEFAULT '2026-11-13 00:00:00',
      PRIMARY KEY (platform, model_pattern, source)
    );

    CREATE TABLE IF NOT EXISTS custom_ai_cache_usage_daily (
      day TEXT NOT NULL,
      profile_id INTEGER NOT NULL DEFAULT 0,
      platform TEXT NOT NULL,
      model TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      requests_with_hit INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      est_saved_micro_usd INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, profile_id, platform, model)
    );

    CREATE INDEX IF NOT EXISTS idx_custom_ai_cache_usage_daily_profile
      ON custom_ai_cache_usage_daily (profile_id, day);
  `);

  const insertSeed = db.prepare(`
    INSERT OR IGNORE INTO custom_ai_cache_capabilities
      (platform, model_pattern, source, mode, max_breakpoints, min_tokens, ttl_seconds, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '2026-11-13 00:00:00')
  `);
  for (const row of BUILTIN_CAPABILITY_SEEDS) {
    insertSeed.run(...row);
  }

  if (hasTable(db, 'client_profiles')) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_client_profiles_delete_prompt_cache
      AFTER DELETE ON client_profiles
      BEGIN
        DELETE FROM custom_ai_cache_usage_daily WHERE profile_id = OLD.id;
      END;
    `);
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_client_profiles_delete_prompt_cache;
    DROP INDEX IF EXISTS idx_custom_ai_cache_usage_daily_profile;
    DROP TABLE IF EXISTS custom_ai_cache_usage_daily;
    DROP TABLE IF EXISTS custom_ai_cache_capabilities;
  `);

  if (hasTable(db, 'settings')) {
    db.prepare('DELETE FROM settings WHERE key = ?').run('ai_platform_prompt_cache_v1');
  }
}
