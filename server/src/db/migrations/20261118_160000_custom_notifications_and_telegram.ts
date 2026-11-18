// Migration: In-App Notification Center & Two-Way Telegram Ops Alerting
// Created: 2026-11-18
//
// DOWN: reversible

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL DEFAULT 'system',
      severity TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      action_url TEXT,
      dedupe_key TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_custom_notifications_user_unread
      ON custom_notifications(user_id, read_at, id DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_notifications_user_dedupe
      ON custom_notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_custom_notifications_user_dedupe;
    DROP INDEX IF EXISTS idx_custom_notifications_user_unread;
    DROP TABLE IF EXISTS custom_notifications;
  `);
}
