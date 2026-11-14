import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';
import { up, down } from '../../../db/migrations/20261113_100000_custom_ai_platform_base.js';

describe('migration 20261113_100000_custom_ai_platform_base', () => {
  it('supports idempotent up -> down -> up without creating flags row or touching pre-upgrade settings', () => {
    const db = new Database(':memory:');
    try {
      runLegacyBaseline(db);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('existing_setting', 'keep-me')").run();

      up(db);
      up(db); // idempotent

      const flagsRow = db.prepare("SELECT value FROM settings WHERE key = 'ai_platform_flags_v1'").get();
      expect(flagsRow).toBeUndefined();

      const retentionRow = db
        .prepare("SELECT value FROM settings WHERE key = 'ai_platform_retention_v1'")
        .get() as { value: string } | undefined;
      expect(retentionRow).toBeDefined();
      expect(JSON.parse(retentionRow!.value)).toEqual({
        runsDays: 30,
        toolCallsDays: 30,
        guardExcerptsDays: 7,
      });

      // Simulate flags having been toggled on a populated DB before down()
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_platform_flags_v1', '{\"prompts\":true}')").run();

      down(db);
      const aiRowsAfterDown = db
        .prepare("SELECT key FROM settings WHERE key LIKE 'ai_platform_%'")
        .all();
      expect(aiRowsAfterDown).toEqual([]);

      const existing = db
        .prepare("SELECT value FROM settings WHERE key = 'existing_setting'")
        .get() as { value: string } | undefined;
      expect(existing?.value).toBe('keep-me');

      // Re-up restores retention default and leaves flags unset
      up(db);
      expect(db.prepare("SELECT value FROM settings WHERE key = 'ai_platform_flags_v1'").get()).toBeUndefined();
      expect(db.prepare("SELECT value FROM settings WHERE key = 'ai_platform_retention_v1'").get()).toBeDefined();
    } finally {
      db.close();
    }
  });
});
