// Migration: Scenario-Based Auto-Routing Policies & Quota Savings Telemetry
// Created: 2026-11-18
//
// DOWN: reversible

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_scenario_routing_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key_id INTEGER REFERENCES user_api_keys(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      long_context_threshold INTEGER NOT NULL DEFAULT 60000,
      rules_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_scenario_policies_user_default
      ON custom_scenario_routing_policies(user_id)
      WHERE key_id IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_scenario_policies_user_key
      ON custom_scenario_routing_policies(user_id, key_id)
      WHERE key_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS custom_scenario_routing_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key_id INTEGER NOT NULL DEFAULT 0,
      scenario TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      offloaded_count INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_tokens_saved INTEGER NOT NULL DEFAULT 0,
      last_model TEXT,
      last_routed_mode TEXT,
      last_hit_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_scenario_stats_user_key_scenario
      ON custom_scenario_routing_stats(user_id, key_id, scenario);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_custom_scenario_stats_user_key_scenario;
    DROP TABLE IF EXISTS custom_scenario_routing_stats;
    DROP INDEX IF EXISTS idx_custom_scenario_policies_user_key;
    DROP INDEX IF EXISTS idx_custom_scenario_policies_user_default;
    DROP TABLE IF EXISTS custom_scenario_routing_policies;
  `);
}
