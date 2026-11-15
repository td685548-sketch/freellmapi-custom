import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDb, defaultDbFactory, type Db } from '../../../db/index.js';
import { nodeSqliteFactory } from '../../../db/node-sqlite.js';
import { getMigrationStatuses, runMigrations } from '../../../db/migrate/runner.js';
import { initEncryptionKey } from '../../../lib/crypto.js';
import {
  down as outputControlsDown,
  up as outputControlsUp,
} from '../../../db/migrations/20261115_120001_support_output_controls.js';
import * as supportStore from '../../../custom/x-gateway/support-store.js';
import {
  appendSupportOutputEvent,
  ensureSupportOutputTables,
  getSupportOutputPolicy,
  listSupportOutputEvents,
  saveSupportOutputPolicy,
} from '../../../custom/x-gateway/support-output-store.js';

function openMemoryDb(): Db {
  return connectDb(':memory:', {
    factory: (dbPath) => {
      try {
        return defaultDbFactory()(dbPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ERR_DLOPEN_FAILED') throw error;
        return nodeSqliteFactory(dbPath);
      }
    },
  });
}

function hasTable(db: Db, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row);
}

function createTenantTableAndRow(db: Db, id: number, slug: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_support_tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL UNIQUE,
      secret_encrypted TEXT NOT NULL,
      secret_iv TEXT NOT NULL,
      secret_auth_tag TEXT NOT NULL,
      default_model TEXT NOT NULL DEFAULT 'auto',
      system_prompt TEXT NOT NULL DEFAULT '',
      allowed_origins_json TEXT NOT NULL DEFAULT '[]',
      allow_guest INTEGER NOT NULL DEFAULT 1,
      roles_config_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO x_support_tenants (
       id, name, slug, public_key, secret_encrypted, secret_iv, secret_auth_tag, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'x', 'x', 'x', ?, ?)`,
  ).run(id, `Tenant ${id}`, slug, `pk_${slug}`, now, now);
}

describe('20261115_120001_support_output_controls migration', () => {
  let db: Db;
  let db2: Db | undefined;

  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', 'cd'.repeat(32));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    db?.close?.();
    db2?.close?.();
    db2 = undefined;
  });

  it('registers 20261115_120001_support_output_controls.ts and runs up/down/up cleanly before lazy tenant tables exist', async () => {
    db = openMemoryDb();
    await runMigrations(db, 'up');

    const applied = getMigrationStatuses(db)
      .filter((s) => s.status === 'applied')
      .map((s) => s.filename);
    expect(applied).toContain('20261115_120001_support_output_controls.ts');

    expect(hasTable(db, 'x_support_output_policies')).toBe(true);
    expect(hasTable(db, 'x_support_output_events')).toBe(true);

    outputControlsDown(db);
    expect(hasTable(db, 'x_support_output_policies')).toBe(false);
    expect(hasTable(db, 'x_support_output_events')).toBe(false);

    outputControlsUp(db);
    expect(hasTable(db, 'x_support_output_policies')).toBe(true);
    expect(hasTable(db, 'x_support_output_events')).toBe(true);
  });

  it('supports populated down/up, FK cascade delete, encryption at rest, transaction rollback, and a second independent memory Db', async () => {
    db = openMemoryDb();
    await runMigrations(db, 'up');
    initEncryptionKey(db);
    db.exec('PRAGMA foreign_keys = ON;');
    createTenantTableAndRow(db, 1, 'alpha');
    ensureSupportOutputTables(db);

    const saved = saveSupportOutputPolicy(
      {
        tenantId: 1,
        expectedVersion: 0,
        policy: {
          mode: 'enforce',
          blockedTerms: [{ id: 'r1', text: 'CONFIDENTIAL_PHRASE' }],
          maxOutputChars: 4000,
          redactCredentials: true,
        },
      },
      db,
    );
    expect(saved.version).toBe(1);

    const rawPolicyRow = db
      .prepare('SELECT payload_encrypted FROM x_support_output_policies WHERE tenant_id = ?')
      .get(1) as { payload_encrypted: string };
    expect(rawPolicyRow.payload_encrypted).not.toContain('CONFIDENTIAL_PHRASE');

    appendSupportOutputEvent(
      {
        tenantId: 1,
        operationId: 'turn_1',
        surface: 'chat',
        policyVersion: 1,
        action: 'block',
        reasons: ['blocked_term'],
        ruleIds: ['r1'],
        redactionCount: 0,
      },
      db,
    );
    expect(listSupportOutputEvents({ tenantId: 1, limit: 10 }, db).items).toHaveLength(1);

    // Caller transaction rollback must roll back store writes using explicit db
    expect(() => {
      db.transaction(() => {
        saveSupportOutputPolicy(
          {
            tenantId: 1,
            expectedVersion: 1,
            policy: {
              mode: 'log',
              blockedTerms: [],
              maxOutputChars: 8000,
              redactCredentials: false,
            },
          },
          db,
        );
        appendSupportOutputEvent(
          {
            tenantId: 1,
            operationId: 'turn_rollback',
            surface: 'chat',
            policyVersion: 2,
            action: 'observe',
            reasons: ['too_long'],
            ruleIds: [],
            redactionCount: 0,
          },
          db,
        );
        throw new Error('force_rollback');
      })();
    }).toThrow('force_rollback');

    expect(getSupportOutputPolicy(1, db).version).toBe(1);
    expect(listSupportOutputEvents({ tenantId: 1, limit: 10 }, db).items).toHaveLength(1);

    // FK cascade delete removes policy and events when tenant is deleted
    db.prepare('DELETE FROM x_support_tenants WHERE id = ?').run(1);
    expect(db.prepare('SELECT COUNT(*) AS c FROM x_support_output_policies').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM x_support_output_events').get()).toEqual({ c: 0 });

    // Populated down/up
    outputControlsDown(db);
    expect(hasTable(db, 'x_support_output_policies')).toBe(false);
    expect(hasTable(db, 'x_support_output_events')).toBe(false);
    outputControlsUp(db);
    expect(hasTable(db, 'x_support_output_policies')).toBe(true);
    expect(hasTable(db, 'x_support_output_events')).toBe(true);

    // Second independent in-memory Db must not be skipped by a global cache
    db2 = openMemoryDb();
    await runMigrations(db2, 'up');
    createTenantTableAndRow(db2, 1, 'beta');
    ensureSupportOutputTables(db2);
    expect(getSupportOutputPolicy(1, db2).mode).toBe('off');
    expect(getSupportOutputPolicy(1, db2).version).toBe(0);
    // Keep supportStore import referenced to ensure compatibility with support-store exports
    expect(typeof supportStore.ensureSupportTables).toBe('function');
  });
});
