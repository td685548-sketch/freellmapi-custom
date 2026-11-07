// Migration: visitor feedback on replies, per client profile
// Created: 2026-11-07
//
// DOWN: reversible
//
// A web app's backend reports a visitor's thumbs up / down on a reply (POST /v1/feedback with its client
// key), optionally with a comment, the model that answered, the end user, the conversation and its own
// reference for the reply. With a reference, a second vote on the same reply replaces the first. Kept
// one year.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      rating INTEGER NOT NULL CHECK (rating IN (-1, 1)),
      comment TEXT,
      model TEXT,
      end_user TEXT,
      conversation_key TEXT,
      reference TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_custom_feedback_profile ON custom_feedback(profile_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_feedback_reference ON custom_feedback(profile_id, reference) WHERE reference IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_custom_feedback_created ON custom_feedback(created_at);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS custom_feedback;');
}
