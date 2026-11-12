import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
import { up, down } from '../../../db/migrations/20261112_170002_support_execution_outbox.js';

const dbs: Database.Database[] = [];

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
});

function tableNames(db: Database.Database): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'x_support_%' ORDER BY name").all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe('20261112_170002_support_execution_outbox migration', () => {
  it('creates execution, events, and deliveries tables', () => {
    const db = makeDb();
    up(db);

    const tables = tableNames(db);
    expect(tables).toContain('x_support_action_executions');
    expect(tables).toContain('x_support_partner_events');
    expect(tables).toContain('x_support_partner_deliveries');
  });

  it('enforces unique constraint on x_support_action_executions (tenant_id, action_id)', () => {
    const db = makeDb();
    up(db);

    const insert = db.prepare(`
      INSERT INTO x_support_action_executions (
        tenant_id, action_id, tool_id, requester_encrypted, requester_iv, requester_auth_tag,
        effective_args_encrypted, effective_args_iv, effective_args_auth_tag,
        target_hash, args_hash, schema_hash, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run(1, 'act_1', 10, 'e', 'iv', 'tag', 'e', 'iv', 'tag', 'th', 'ah', 'sh', 'pending', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z');

    expect(() => {
      insert.run(1, 'act_1', 10, 'e', 'iv', 'tag', 'e', 'iv', 'tag', 'th', 'ah', 'sh', 'pending', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z');
    }).toThrow(/UNIQUE constraint failed/);

    // Different tenant is fine
    insert.run(2, 'act_1', 10, 'e', 'iv', 'tag', 'e', 'iv', 'tag', 'th', 'ah', 'sh', 'pending', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z');
  });

  it('enforces unique constraint on x_support_partner_events (tenant_id, type, dedup_key)', () => {
    const db = makeDb();
    up(db);

    const insert = db.prepare(`
      INSERT INTO x_support_partner_events (
        id, tenant_id, type, dedup_key, payload_encrypted, payload_iv, payload_auth_tag, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run('evt_1', 1, 'ticket.created', 'dedup_1', 'e', 'iv', 'tag', '2026-11-12T00:00:00Z');

    expect(() => {
      insert.run('evt_2', 1, 'ticket.created', 'dedup_1', 'e', 'iv', 'tag', '2026-11-12T00:00:00Z');
    }).toThrow(/UNIQUE constraint failed/);

    // Different type or different tenant is fine
    insert.run('evt_3', 1, 'ticket.resolved', 'dedup_1', 'e', 'iv', 'tag', '2026-11-12T00:00:00Z');
    insert.run('evt_4', 2, 'ticket.created', 'dedup_1', 'e', 'iv', 'tag', '2026-11-12T00:00:00Z');
  });

  it('enforces unique constraint on x_support_partner_deliveries (event_id, webhook_id)', () => {
    const db = makeDb();
    up(db);

    const insertEvent = db.prepare(`
      INSERT INTO x_support_partner_events (
        id, tenant_id, type, dedup_key, payload_encrypted, payload_iv, payload_auth_tag, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertEvent.run('evt_1', 1, 'ticket.created', 'dedup_1', 'e', 'iv', 'tag', '2026-11-12T00:00:00Z');

    const insertDelivery = db.prepare(`
      INSERT INTO x_support_partner_deliveries (
        id, event_id, tenant_id, webhook_id, target_snapshot_encrypted, target_snapshot_iv, target_snapshot_auth_tag,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertDelivery.run('dlv_1', 'evt_1', 1, 'wh_1', 'e', 'iv', 'tag', 'pending', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z');

    expect(() => {
      insertDelivery.run('dlv_2', 'evt_1', 1, 'wh_1', 'e', 'iv', 'tag', 'pending', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z');
    }).toThrow(/UNIQUE constraint failed/);

    // Different webhook_id is fine
    insertDelivery.run('dlv_3', 'evt_1', 1, 'wh_2', 'e', 'iv', 'tag', 'pending', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z');
  });

  it('roundtrip: down() removes tables and up() recreates them', () => {
    const db = makeDb();
    up(db);
    expect(tableNames(db)).toHaveLength(3);

    down(db);
    expect(tableNames(db)).toHaveLength(0);

    up(db);
    expect(tableNames(db)).toHaveLength(3);
  });

  it('works independently across multiple isolated in-memory databases', () => {
    const db1 = makeDb();
    const db2 = makeDb();

    up(db1);
    expect(tableNames(db1)).toHaveLength(3);
    expect(tableNames(db2)).toHaveLength(0);

    up(db2);
    expect(tableNames(db2)).toHaveLength(3);
  });
});
