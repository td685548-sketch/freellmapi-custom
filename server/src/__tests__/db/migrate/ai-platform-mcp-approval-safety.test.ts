import { describe, expect, it } from 'vitest';
import { connectDb } from '../../../db/index.js';
import { runMigrations } from '../../../db/migrate/runner.js';

describe('migration 20261114_200000_custom_ai_mcp_approval_safety', () => {
  it('adds approval snapshot, journal outcome, and server revision columns and supports clean down()', async () => {
    const db = connectDb(':memory:');
    try {
      await runMigrations(db, 'up');

      const approvalCols = db
        .prepare("PRAGMA table_info('custom_ai_approvals')")
        .all()
        .map((c) => (c as { name: string }).name);
      expect(approvalCols).toEqual(
        expect.arrayContaining([
          'snapshot_json',
          'result_masked',
          'error_text',
          'duration_ms',
          'result_bytes',
          'executed_at',
          'owner_instance_id',
        ]),
      );

      const serverCols = db
        .prepare("PRAGMA table_info('custom_ai_mcp_servers')")
        .all()
        .map((c) => (c as { name: string }).name);
      expect(serverCols).toEqual(expect.arrayContaining(['server_revision', 'credential_generation']));

      const callCols = db
        .prepare("PRAGMA table_info('custom_ai_tool_calls')")
        .all()
        .map((c) => (c as { name: string }).name);
      expect(callCols).toEqual(expect.arrayContaining(['error_text', 'updated_at']));

      // Roll back just this migration
      db.prepare("INSERT INTO custom_ai_mcp_servers (slug, name, url, credential_generation) VALUES ('rollback', 'Rollback', 'https://mcp.example.test', 7)").run();
      await runMigrations(db, 'down');
      expect(db.prepare("SELECT credential_generation FROM custom_ai_mcp_servers WHERE slug = 'rollback'").get()).toEqual({ credential_generation: 7 });
      const approvalColsAfterDown = db
        .prepare("PRAGMA table_info('custom_ai_approvals')")
        .all()
        .map((c) => (c as { name: string }).name);
      expect(approvalColsAfterDown).not.toContain('snapshot_json');
      expect(approvalColsAfterDown).not.toContain('owner_instance_id');
      await runMigrations(db, 'up');
      expect(db.prepare("SELECT credential_generation FROM custom_ai_mcp_servers WHERE slug = 'rollback'").get()).toEqual({ credential_generation: 7 });
    } finally {
      db.close();
    }
  });
});
