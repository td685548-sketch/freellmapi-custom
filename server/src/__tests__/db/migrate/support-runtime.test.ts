import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
import { up, down } from '../../../db/migrations/20261112_170001_support_runtime_state.js';

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
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'x_support_%') ORDER BY name").all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe('20261112_170001_support_runtime_state migration', () => {
  it('creates turns, leases, reservations, and guest issuance tables', () => {
    const db = makeDb();
    up(db);

    const tables = tableNames(db);
    expect(tables).toContain('x_support_runtime_turns');
    expect(tables).toContain('x_support_runtime_leases');
    expect(tables).toContain('x_support_runtime_reservations');
    expect(tables).toContain('x_support_guest_issuance');
  });

  it('enforces unique constraint on x_support_runtime_turns (tenant_id, user_id, request_id)', () => {
    const db = makeDb();
    up(db);

    const insert = db.prepare(`
      INSERT INTO x_support_runtime_turns (
        id, tenant_id, user_id, request_id, conversation_id, input_hash, state,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run('turn_1', 1, 'usr_1', 'req_1', 'conv_1', 'hash1', 'processing', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z', '2026-11-13T00:00:00Z');

    expect(() => {
      insert.run('turn_2', 1, 'usr_1', 'req_1', 'conv_1', 'hash1', 'processing', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z', '2026-11-13T00:00:00Z');
    }).toThrow(/UNIQUE constraint failed/);

    // Different user_id is fine
    insert.run('turn_3', 1, 'usr_2', 'req_1', 'conv_1', 'hash1', 'processing', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z', '2026-11-13T00:00:00Z');
    // Different tenant_id is fine
    insert.run('turn_4', 2, 'usr_1', 'req_1', 'conv_1', 'hash1', 'processing', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z', '2026-11-13T00:00:00Z');
  });

  it('enforces primary key constraint on x_support_runtime_leases (tenant_id, conversation_id)', () => {
    const db = makeDb();
    up(db);

    const insert = db.prepare(`
      INSERT INTO x_support_runtime_leases (tenant_id, conversation_id, turn_id, lease_until)
      VALUES (?, ?, ?, ?)
    `);

    insert.run(1, 'conv_1', 'turn_1', 1700000000);

    expect(() => {
      insert.run(1, 'conv_1', 'turn_2', 1700000100);
    }).toThrow(/UNIQUE constraint failed|PRIMARY KEY constraint failed/);

    // Different conversation_id or tenant_id is fine
    insert.run(1, 'conv_2', 'turn_2', 1700000100);
    insert.run(2, 'conv_1', 'turn_3', 1700000100);
  });

  it('enforces unique constraint on x_support_runtime_reservations (turn_id)', () => {
    const db = makeDb();
    up(db);

    const insert = db.prepare(`
      INSERT INTO x_support_runtime_reservations (
        id, tenant_id, user_id, turn_id, window_start, window_seconds, reserved_tokens,
        state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run('res_1', 1, 'usr_1', 'turn_1', 1700000000, 3600, 500, 'reserved', '2026-11-12T00:00:00Z');

    expect(() => {
      insert.run('res_2', 1, 'usr_1', 'turn_1', 1700000000, 3600, 500, 'reserved', '2026-11-12T00:00:00Z');
    }).toThrow(/UNIQUE constraint failed/);

    // Different turn_id is fine
    insert.run('res_3', 1, 'usr_1', 'turn_2', 1700000000, 3600, 500, 'reserved', '2026-11-12T00:00:00Z');
  });

  it('enforces primary key on x_support_guest_issuance (tenant_id, ip_hash, window_minute)', () => {
    const db = makeDb();
    up(db);

    const insert = db.prepare(`
      INSERT INTO x_support_guest_issuance (tenant_id, ip_hash, window_minute, count, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    insert.run(1, 'hash_ip', 29000000, 1, '2026-11-12T00:00:00Z');

    expect(() => {
      insert.run(1, 'hash_ip', 29000000, 2, '2026-11-12T00:00:00Z');
    }).toThrow(/UNIQUE constraint failed|PRIMARY KEY constraint failed/);

    // Different window_minute is fine
    insert.run(1, 'hash_ip', 29000001, 1, '2026-11-12T00:00:00Z');
  });

  it('roundtrip: down() removes tables and up() recreates them', () => {
    const db = makeDb();
    up(db);
    expect(tableNames(db)).toHaveLength(4);

    down(db);
    expect(tableNames(db)).toHaveLength(0);

    up(db);
    expect(tableNames(db)).toHaveLength(4);
  });

  it('works independently across multiple isolated in-memory databases', () => {
    const db1 = makeDb();
    const db2 = makeDb();

    up(db1);
    expect(tableNames(db1)).toHaveLength(4);
    expect(tableNames(db2)).toHaveLength(0);

    up(db2);
    expect(tableNames(db2)).toHaveLength(4);
  });
});
