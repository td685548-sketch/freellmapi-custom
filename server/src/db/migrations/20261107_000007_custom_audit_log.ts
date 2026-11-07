// Migration: audit log of dashboard changes
// Created: 2026-11-07
//
// DOWN: reversible
//
// Every successful change made through the dashboard API (POST / PUT / PATCH / DELETE under /api, by a
// signed-in account) is recorded: who, when, from where, which route and target, and a summary of what
// was sent with secrets removed. Sign-in traffic and Playground chat saves are not recorded. Kept 180
// days and at most 100,000 entries.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      actor_id INTEGER,
      actor_email TEXT,
      ip TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      route TEXT NOT NULL,
      area TEXT NOT NULL,
      target_id INTEGER,
      status INTEGER NOT NULL,
      summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_custom_audit_log_created ON custom_audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_custom_audit_log_actor ON custom_audit_log(actor_id, id);
    CREATE INDEX IF NOT EXISTS idx_custom_audit_log_area ON custom_audit_log(area, id);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS custom_audit_log;');
}
