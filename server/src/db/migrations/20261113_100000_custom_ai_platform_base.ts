// Migration: AI Platform Upgrade foundation base (retention default + reversible cleanup)
// Created: 2026-11-13
//
// DOWN: reversible
//
// Deliberately does NOT create `ai_platform_flags_v1` so all 6 pillars remain
// disabled by default until an operator explicitly toggles them.

import type { Db } from '../types.js';

const DEFAULT_RETENTION_JSON = JSON.stringify({
  runsDays: 30,
  toolCallsDays: 30,
  guardExcerptsDays: 7,
});

export function up(db: Db): void {
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_platform_retention_v1', ?)",
  ).run(DEFAULT_RETENTION_JSON);
}

export function down(db: Db): void {
  db.prepare("DELETE FROM settings WHERE key LIKE 'ai_platform_%'").run();
}
