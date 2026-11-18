// Migration: persistent learned model caps and models.dev synced capability specs
// Created: 2026-11-18
//
// DOWN: reversible
//
// Stores write-through learned ceilings for max_tokens, thinking.budget_tokens, and
// reasoning_effort (`custom_learned_model_caps`), plus synced model capabilities and
// pricing metadata from models.dev (`custom_models_dev_specs`). Zero SQLite triggers.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_learned_model_caps (
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      endpoint_scope TEXT NOT NULL DEFAULT '',
      max_output_tokens INTEGER,
      max_thinking_budget INTEGER,
      supported_reasoning_efforts TEXT,
      last_error_sample TEXT,
      hit_count INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, model_id, endpoint_scope)
    );

    CREATE INDEX IF NOT EXISTS idx_custom_learned_model_caps_updated
      ON custom_learned_model_caps(updated_at DESC);

    CREATE TABLE IF NOT EXISTS custom_models_dev_specs (
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT,
      family TEXT,
      context_window INTEGER,
      max_input_tokens INTEGER,
      max_output_tokens INTEGER,
      modalities_input TEXT NOT NULL DEFAULT '[]',
      modalities_output TEXT NOT NULL DEFAULT '[]',
      supports_tools INTEGER,
      supports_reasoning INTEGER,
      supports_vision INTEGER,
      supports_structured_output INTEGER,
      reasoning_efforts TEXT,
      input_cost_per_1m REAL,
      output_cost_per_1m REAL,
      cached_cost_per_1m REAL,
      reasoning_cost_per_1m REAL,
      last_synced_at TEXT NOT NULL,
      PRIMARY KEY (provider, model_id)
    );

    CREATE INDEX IF NOT EXISTS idx_custom_models_dev_specs_model
      ON custom_models_dev_specs(model_id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_custom_models_dev_specs_model;
    DROP TABLE IF EXISTS custom_models_dev_specs;
    DROP INDEX IF EXISTS idx_custom_learned_model_caps_updated;
    DROP TABLE IF EXISTS custom_learned_model_caps;
  `);
}
