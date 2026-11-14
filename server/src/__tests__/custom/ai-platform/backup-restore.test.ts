import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import { DEFAULT_MIGRATIONS } from '../../../db/migrate/defaults.js';
import { runMigrationsSync } from '../../../db/migrate/runner.js';
import { getFlags, resetFlagsCacheForTests } from '../../../custom/ai-platform/flags.js';

describe('ai-platform pre-upgrade backup restore (T033)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    try {
      getDb().close();
    } catch { /* ignore */ }
    resetFlagsCacheForTests();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restores a pre-upgrade backup cleanly, migrates forward, and keeps all 6 pillars disabled', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-platform-backup-'));
    tempDirs.push(tmpDir);
    const backupFile = path.join(tmpDir, 'pre-upgrade-backup.db');
    const restoredFile = path.join(tmpDir, 'restored.db');

    // 1. Create a pre-upgrade database snapshot (all migrations prior to 20261113_100000_custom_ai_platform_base).
    const preDb = new Database(backupFile);
    const preUpgradeMigrations = DEFAULT_MIGRATIONS.filter(
      m => !m.filename.includes('custom_ai_platform_base'),
    );
    runMigrationsSync(preDb, 'up', { migrations: preUpgradeMigrations });
    preDb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('custom_pre_upgrade_key', 'preserved-value')").run();
    preDb.prepare(
      "INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, system_prompt, enabled) VALUES ('pre-upgrade-shop', 'hash_pre_1', 'e', 'i', 't', 'Be helpful.', 1)",
    ).run();
    await preDb.backup(restoredFile);
    preDb.close();

    // 2. Boot the upgraded app DB engine against the restored pre-upgrade snapshot.
    initDb(restoredFile);
    resetFlagsCacheForTests();

    // 3. Pre-upgrade settings & client profiles are preserved intact.
    const db = getDb();
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'custom_pre_upgrade_key'").get() as { value: string } | undefined;
    expect(setting?.value).toBe('preserved-value');

    const profile = db.prepare("SELECT id, name, system_prompt FROM client_profiles WHERE name = 'pre-upgrade-shop'").get() as
      | { id: number; name: string; system_prompt: string }
      | undefined;
    expect(profile?.name).toBe('pre-upgrade-shop');
    expect(profile?.system_prompt).toBe('Be helpful.');

    // 4. All 6 pillars default to false after restoring pre-upgrade backup.
    expect(getFlags()).toEqual({
      prompts: false,
      retrieval: false,
      promptCache: false,
      mcpClient: false,
      outputGuard: false,
      orchestrator: false,
    });

    // 5. Retention default was seeded without creating ai_platform_flags_v1.
    const flagsRow = db.prepare("SELECT value FROM settings WHERE key = 'ai_platform_flags_v1'").get();
    expect(flagsRow).toBeUndefined();

    // 6. Deleting the restored client profile succeeds with the new AFTER DELETE trigger.
    expect(() => db.prepare('DELETE FROM client_profiles WHERE id = ?').run(profile!.id)).not.toThrow();
  });
});
