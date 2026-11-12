import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { up as baseUp } from '../../../db/migrations/20261112_170002_support_execution_outbox.js';
import { up, down } from '../../../db/migrations/20261112_180001_support_runtime_fencing.js';

describe('support runtime fencing migration', () => {
  it('upgrades an existing schema idempotently, preserves rows and rolls back', () => {
    const db = new Database(':memory:');
    try {
      baseUp(db);
      db.prepare(`INSERT INTO x_support_action_executions (tenant_id, action_id, tool_id, requester_encrypted, requester_iv, requester_auth_tag, effective_args_encrypted, effective_args_iv, effective_args_auth_tag, target_hash, args_hash, schema_hash, status, created_at, updated_at) VALUES (1, 'act_old', 1, 'e', 'iv', 'tag', 'e', 'iv', 'tag', 'th', 'ah', 'sh', 'pending', 'now', 'now')`).run();
      up(db);
      up(db);
      expect(db.prepare('SELECT decision FROM x_support_action_executions WHERE action_id = ?').get('act_old')).toEqual({ decision: null });
      expect((db.prepare('PRAGMA table_info(x_support_partner_deliveries)').all() as { name: string }[]).some(c => c.name === 'claim_token')).toBe(true);
      down(db);
      expect(db.prepare('SELECT status FROM x_support_action_executions').get()).toEqual({ status: 'pending' });
      expect((db.prepare('PRAGMA table_info(x_support_partner_deliveries)').all() as { name: string }[]).some(c => c.name === 'claim_token')).toBe(false);
      up(db);
      expect(db.prepare('SELECT decision FROM x_support_action_executions').get()).toEqual({ decision: null });
    } finally { db.close(); }
  });
});
