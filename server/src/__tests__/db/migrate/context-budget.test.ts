import { describe, expect, it } from 'vitest';
import { connectDb } from '../../../db/index.js';
import { runMigrations } from '../../../db/migrate/runner.js';

const FILENAME = '20261117_100000_custom_context_budget.ts';
type TestDb = ReturnType<typeof connectDb>;

function hasTable(db: TestDb, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasIndex(db: TestDb, index: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index));
}

function getColumnNames(db: TestDb, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
}

function getTriggerNames(db: TestDb): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map(r => r.name);
}

async function rollDownThroughTarget(db: TestDb): Promise<void> {
  while (db.prepare('SELECT 1 FROM migrations WHERE filename = ?').get(FILENAME)) {
    await runMigrations(db, 'down');
  }
}

describe(`migration ${FILENAME}`, () => {
  it('creates custom_context_policies, custom_context_reports, index, and custom_conversations.context_window_start_id without adding triggers', async () => {
    const db = connectDb(':memory:');
    try {
      await runMigrations(db, 'up');
      const triggersBeforeDown = getTriggerNames(db);

      expect(db.prepare('SELECT 1 FROM migrations WHERE filename = ?').get(FILENAME)).toBeTruthy();
      expect(hasTable(db, 'custom_context_policies')).toBe(true);
      expect(hasTable(db, 'custom_context_reports')).toBe(true);
      expect(hasIndex(db, 'idx_custom_context_reports_profile')).toBe(true);

      expect(getColumnNames(db, 'custom_context_policies')).toEqual([
        'profile_id',
        'enabled',
        'preset',
        'max_input_tokens',
        'output_reserve_tokens',
        'safety_margin_pct',
        'summary_share_pct',
        'knowledge_share_pct',
        'drop_block_turns',
        'summarize',
        'client_history_mode',
        'knowledge_min_score',
        'updated_at',
      ]);

      expect(getColumnNames(db, 'custom_context_reports')).toEqual([
        'request_id',
        'profile_id',
        'end_user',
        'conversation_key',
        'model_key',
        'context_window',
        'budget_tokens',
        'mandatory_tokens',
        'summary_tokens',
        'knowledge_tokens',
        'history_tokens',
        'estimated_tokens',
        'heuristic_tokens',
        'history_sent',
        'history_dropped',
        'knowledge_sent',
        'knowledge_dropped',
        'summary_used',
        'client_history_dropped',
        'refits',
        'created_at',
      ]);

      expect(getColumnNames(db, 'custom_conversations')).toContain('context_window_start_id');

      // Re-running up when already applied (and re-running the migration up directly) is idempotent.
      await runMigrations(db, 'up');
      const mod = await import('../../../db/migrations/20261117_100000_custom_context_budget.js');
      expect(() => mod.up(db)).not.toThrow();

      // Zero new SQLite triggers added by this migration.
      await rollDownThroughTarget(db);
      expect(getTriggerNames(db)).toEqual(triggersBeforeDown);
    } finally {
      db.close();
    }
  });

  it('reverses tables, index, and column cleanly on down() while preserving existing conversation data across up/down', async () => {
    const db = connectDb(':memory:');
    try {
      await runMigrations(db, 'up');

      // Roll back just this migration first to seed pre-migration conversation data, then up -> down -> up.
      await rollDownThroughTarget(db);
      expect(hasTable(db, 'custom_context_policies')).toBe(false);
      expect(hasTable(db, 'custom_context_reports')).toBe(false);
      expect(hasIndex(db, 'idx_custom_context_reports_profile')).toBe(false);
      expect(getColumnNames(db, 'custom_conversations')).not.toContain('context_window_start_id');

      db.prepare(
        `INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag)
         VALUES (7, 'ctx-test', 'hash-7', 'e', 'i', 't')`,
      ).run();
      db.prepare(
        `INSERT INTO custom_conversations (id, profile_id, conv_key, end_user, message_count, chars, created_at, updated_at)
         VALUES (42, 7, 'conv-1', 'user-a', 2, 120, '2026-11-17T00:00:00Z', '2026-11-17T00:00:00Z')`,
      ).run();
      db.prepare(
        `INSERT INTO custom_conversation_messages (id, conversation_id, role, content, created_at)
         VALUES (100, 42, 'user', 'hello', '2026-11-17T00:00:00Z'),
                (101, 42, 'assistant', 'hi there', '2026-11-17T00:00:01Z')`,
      ).run();

      await runMigrations(db, 'up');
      expect(getColumnNames(db, 'custom_conversations')).toContain('context_window_start_id');
      const convAfterUp = db.prepare('SELECT id, profile_id, conv_key, end_user, message_count, chars, context_window_start_id FROM custom_conversations WHERE id = 42').get() as Record<string, unknown>;
      expect(convAfterUp).toEqual({
        id: 42,
        profile_id: 7,
        conv_key: 'conv-1',
        end_user: 'user-a',
        message_count: 2,
        chars: 120,
        context_window_start_id: null,
      });

      // Verify inserting into new tables works after up().
      db.prepare(
        `INSERT INTO custom_context_policies (
           profile_id, enabled, preset, max_input_tokens, output_reserve_tokens,
           safety_margin_pct, summary_share_pct, knowledge_share_pct, drop_block_turns,
           summarize, client_history_mode, knowledge_min_score, updated_at
         ) VALUES (7, 1, 'balanced', 16000, 1024, 10, 15, 25, 4, 1, 'passthrough', NULL, '2026-11-17T00:00:00Z')`,
      ).run();
      db.prepare(
        `INSERT INTO custom_context_reports (
           request_id, profile_id, end_user, conversation_key, model_key, context_window,
           budget_tokens, mandatory_tokens, summary_tokens, knowledge_tokens, history_tokens,
           estimated_tokens, heuristic_tokens, history_sent, history_dropped,
           knowledge_sent, knowledge_dropped, summary_used, client_history_dropped, refits, created_at
         ) VALUES (99, 7, 'user-a', 'conv-1', 'openai:gpt-4o', 128000, 16000, 500, 0, 0, 1000, 1500, 1400, 2, 0, 0, 0, 0, 0, 0, '2026-11-17T00:00:00Z')`,
      ).run();

      await rollDownThroughTarget(db);
      expect(hasTable(db, 'custom_context_policies')).toBe(false);
      expect(hasTable(db, 'custom_context_reports')).toBe(false);
      expect(hasIndex(db, 'idx_custom_context_reports_profile')).toBe(false);
      expect(getColumnNames(db, 'custom_conversations')).not.toContain('context_window_start_id');

      const convAfterDown = db.prepare('SELECT id, profile_id, conv_key, end_user, message_count, chars FROM custom_conversations WHERE id = 42').get() as Record<string, unknown>;
      expect(convAfterDown).toEqual({
        id: 42,
        profile_id: 7,
        conv_key: 'conv-1',
        end_user: 'user-a',
        message_count: 2,
        chars: 120,
      });
      const msgsAfterDown = db.prepare('SELECT id, role, content FROM custom_conversation_messages WHERE conversation_id = 42 ORDER BY id').all();
      expect(msgsAfterDown).toEqual([
        { id: 100, role: 'user', content: 'hello' },
        { id: 101, role: 'assistant', content: 'hi there' },
      ]);
    } finally {
      db.close();
    }
  });
});
