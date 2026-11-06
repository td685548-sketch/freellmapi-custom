// Migration: daily / monthly usage allowances per account and per client profile
// Created: 2026-11-06
//
// DOWN: reversible
//
// `custom_usage_quotas` holds the limits (NULL = unlimited); a subject without a row has none, so
// existing installs behave exactly as before. `custom_usage_counters` holds the running totals of
// subjects that DO have a limit, one row per window ('dYYYY-MM-DD' for a UTC day, 'mYYYY-MM' for a
// UTC month). The rate-limit window in memory resets on every restart; these totals do not.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_usage_quotas (
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user', 'profile')),
      subject_id INTEGER NOT NULL,
      daily_requests INTEGER,
      daily_tokens INTEGER,
      monthly_requests INTEGER,
      monthly_tokens INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (subject_kind, subject_id)
    );
    CREATE TABLE IF NOT EXISTS custom_usage_counters (
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user', 'profile')),
      subject_id INTEGER NOT NULL,
      period TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (subject_kind, subject_id, period)
    );
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS custom_usage_counters; DROP TABLE IF EXISTS custom_usage_quotas;');
}
