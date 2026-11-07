// Migration: long-term daily usage per account, client key and end user
// Created: 2026-11-07
//
// DOWN: reversible
//
// The request log keeps 90 days / 100,000 rows. Each finished UTC day is rolled up from it once into
// this table (one row per day and subject), which is kept for two years (end users: 400 days), so
// usage history and CSV exports outlive the log. subject_kind: 'user' (personal key), 'profile'
// (client key) or 'end_user' (an end user of a client key: subject_id is the key, end_user the id).

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_usage_daily (
      day TEXT NOT NULL,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user', 'profile', 'end_user')),
      subject_id INTEGER NOT NULL,
      end_user TEXT NOT NULL DEFAULT '',
      requests INTEGER NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms_sum INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (subject_kind, subject_id, end_user, day)
    );
    CREATE INDEX IF NOT EXISTS idx_custom_usage_daily_day ON custom_usage_daily(day);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS custom_usage_daily;');
}
