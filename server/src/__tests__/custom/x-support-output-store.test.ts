import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDb, defaultDbFactory, type Db } from '../../db/index.js';
import { nodeSqliteFactory } from '../../db/node-sqlite.js';
import { runMigrations } from '../../db/migrate/runner.js';
import { encrypt, initEncryptionKey } from '../../lib/crypto.js';
import {
  DEFAULT_SUPPORT_OUTPUT_POLICY,
  SUPPORT_OUTPUT_LIMITS,
} from '@freellmapi/shared/support-output.js';
import {
  SupportOutputError,
  appendSupportOutputEvent,
  ensureSupportOutputTables,
  getSupportOutputPolicy,
  listSupportOutputEvents,
  saveSupportOutputPolicy,
} from '../../custom/x-gateway/support-output-store.js';

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

function seedTenant(db: Db, id: number, slug: string): void {
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

describe('support-output-store', () => {
  let db: Db;

  beforeEach(async () => {
    vi.stubEnv('ENCRYPTION_KEY', 'ef'.repeat(32));
    db = openMemoryDb();
    await runMigrations(db, 'up');
    initEncryptionKey(db);
    seedTenant(db, 1, 'tenant-one');
    seedTenant(db, 2, 'tenant-two');
    ensureSupportOutputTables(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    db?.close?.();
  });

  it('returns default off policy (version 0, epoch updatedAt) when absent for an existing tenant and 404 for missing tenant', () => {
    const policy = getSupportOutputPolicy(1, db);
    expect(policy).toEqual({
      tenantId: 1,
      ...DEFAULT_SUPPORT_OUTPUT_POLICY,
    });
    expect(policy.version).toBe(0);
    expect(policy.mode).toBe('off');
    expect(policy.updatedAt).toBe('1970-01-01T00:00:00.000Z');

    expect(() => getSupportOutputPolicy(999, db)).toThrowError(SupportOutputError);
    try {
      getSupportOutputPolicy(999, db);
    } catch (err) {
      expect((err as SupportOutputError).status).toBe(404);
      expect((err as SupportOutputError).code).toBe('tenant_not_found');
    }
  });

  it('enforces atomic OCC versions (0 -> 1 -> 2) and rejects stale expectedVersion with 409 output_policy_conflict', () => {
    // Stale expectedVersion=1 when no row exists
    expect(() =>
      saveSupportOutputPolicy(
        {
          tenantId: 1,
          expectedVersion: 1,
          policy: { mode: 'log', blockedTerms: [], maxOutputChars: 8000, redactCredentials: false },
        },
        db,
      ),
    ).toThrowError(SupportOutputError);

    const v1 = saveSupportOutputPolicy(
      {
        tenantId: 1,
        expectedVersion: 0,
        policy: {
          mode: 'enforce',
          blockedTerms: [{ id: 'rule_1', text: 'internal-secret-token' }],
          maxOutputChars: 4096,
          redactCredentials: true,
        },
      },
      db,
    );
    expect(v1.version).toBe(1);
    expect(v1.mode).toBe('enforce');

    // Concurrent/stale expectedVersion=0 or 2 must 409
    for (const stale of [0, 2]) {
      try {
        saveSupportOutputPolicy(
          {
            tenantId: 1,
            expectedVersion: stale,
            policy: { mode: 'off', blockedTerms: [], maxOutputChars: 16000, redactCredentials: false },
          },
          db,
        );
        expect.unreachable('Expected 409 conflict');
      } catch (err) {
        expect(err).toBeInstanceOf(SupportOutputError);
        expect((err as SupportOutputError).status).toBe(409);
        expect((err as SupportOutputError).code).toBe('output_policy_conflict');
      }
    }

    const v2 = saveSupportOutputPolicy(
      {
        tenantId: 1,
        expectedVersion: 1,
        policy: {
          mode: 'log',
          blockedTerms: [{ id: 'rule_2', text: 'another-term' }],
          maxOutputChars: 12000,
          redactCredentials: false,
        },
      },
      db,
    );
    expect(v2.version).toBe(2);
    expect(getSupportOutputPolicy(1, db)).toEqual(v2);

    // Tenant 2 remains isolated at version 0
    expect(getSupportOutputPolicy(2, db).version).toBe(0);
  });

  it('fails closed with 503 output_policy_unavailable when stored policy is corrupt (never falls back to off)', () => {
    saveSupportOutputPolicy(
      {
        tenantId: 1,
        expectedVersion: 0,
        policy: {
          mode: 'enforce',
          blockedTerms: [{ id: 'r1', text: 'SECRET_CANARY_VALUE' }],
          maxOutputChars: 2048,
          redactCredentials: true,
        },
      },
      db,
    );

    // 1. Corrupt ciphertext
    db.prepare('UPDATE x_support_output_policies SET payload_auth_tag = ? WHERE tenant_id = ?').run(
      '00'.repeat(16),
      1,
    );
    try {
      getSupportOutputPolicy(1, db);
      expect.unreachable('Expected 503');
    } catch (err) {
      expect(err).toBeInstanceOf(SupportOutputError);
      expect((err as SupportOutputError).status).toBe(503);
      expect((err as SupportOutputError).code).toBe('output_policy_unavailable');
      expect((err as Error).message).not.toContain('SECRET_CANARY_VALUE');
    }

    // 2. Valid encryption but invalid schema inside JSON
    const badSchemaEnc = encrypt(
      JSON.stringify({
        mode: 'enforce',
        blockedTerms: [{ id: 'r1', text: 'SECRET_CANARY_VALUE' }],
        maxOutputChars: 'not-a-number',
        redactCredentials: false,
      }),
    );
    db.prepare(
      'UPDATE x_support_output_policies SET payload_encrypted = ?, payload_iv = ?, payload_auth_tag = ? WHERE tenant_id = ?',
    ).run(badSchemaEnc.encrypted, badSchemaEnc.iv, badSchemaEnc.authTag, 1);

    try {
      getSupportOutputPolicy(1, db);
      expect.unreachable('Expected 503');
    } catch (err) {
      expect(err).toBeInstanceOf(SupportOutputError);
      expect((err as SupportOutputError).status).toBe(503);
      expect((err as SupportOutputError).code).toBe('output_policy_unavailable');
      expect((err as Error).message).not.toContain('SECRET_CANARY_VALUE');
    }
  });

  it('rejects unknown fields, type coercion, duplicate IDs/normalized terms, and out-of-bounds values', () => {
    const base = { mode: 'enforce' as const, blockedTerms: [], maxOutputChars: 1000, redactCredentials: false };

    const invalidPayloads: unknown[] = [
      { ...base, extra: true },
      { ...base, maxOutputChars: '1000' },
      { ...base, maxOutputChars: Number.NaN },
      { ...base, maxOutputChars: 255 },
      { ...base, maxOutputChars: 64001 },
      { ...base, redactCredentials: 'false' },
      { ...base, blockedTerms: [{ id: 'bad id!', text: 'abc' }] },
      { ...base, blockedTerms: [{ id: 'r1', text: 'abc', extra: 1 }] },
      { ...base, blockedTerms: [{ id: 'r1', text: '   ' }] },
      { ...base, blockedTerms: [{ id: 'r1', text: 'a'.repeat(101) }] },
      {
        ...base,
        blockedTerms: [
          { id: 'r1', text: 'Alpha' },
          { id: 'r1', text: 'Beta' },
        ],
      },
      {
        ...base,
        blockedTerms: [
          { id: 'r1', text: 'Foo   Bar' },
          { id: 'r2', text: 'foo\u200B bar' },
        ],
      },
      {
        ...base,
        blockedTerms: Array.from({ length: SUPPORT_OUTPUT_LIMITS.maxRules + 1 }, (_, i) => ({
          id: `r_${i}`,
          text: `term_${i}`,
        })),
      },
    ];

    for (const bad of invalidPayloads) {
      expect(() =>
        saveSupportOutputPolicy(
          {
            tenantId: 1,
            expectedVersion: 0,
            policy: bad as typeof base,
          },
          db,
        ),
      ).toThrowError(SupportOutputError);
    }
  });

  it('skips allow events, deduplicates by (tenant, surface, operationId), isolates tenants, and paginates tie timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T10:00:00.000Z'));

    // allow -> no-op
    appendSupportOutputEvent(
      {
        tenantId: 1,
        operationId: 'op_allow',
        surface: 'chat',
        policyVersion: 1,
        action: 'allow',
        reasons: [],
        ruleIds: [],
        redactionCount: 0,
      },
      db,
    );
    expect(listSupportOutputEvents({ tenantId: 1, limit: 10 }, db).items).toHaveLength(0);

    // Same timestamp for 3 events to test tie-breaker pagination (createdAt DESC, id DESC)
    appendSupportOutputEvent(
      {
        tenantId: 1,
        operationId: 'op_1',
        surface: 'chat',
        policyVersion: 1,
        action: 'observe',
        reasons: ['blocked_term'],
        ruleIds: ['r1'],
        redactionCount: 0,
      },
      db,
    );
    // Duplicate (tenant=1, surface='chat', operationId='op_1') is ignored
    appendSupportOutputEvent(
      {
        tenantId: 1,
        operationId: 'op_1',
        surface: 'chat',
        policyVersion: 1,
        action: 'block',
        reasons: ['blocked_term'],
        ruleIds: ['r1'],
        redactionCount: 0,
      },
      db,
    );
    appendSupportOutputEvent(
      {
        tenantId: 1,
        operationId: 'op_2',
        surface: 'copilot',
        policyVersion: 1,
        action: 'redact',
        reasons: ['credential'],
        ruleIds: [],
        redactionCount: 2,
      },
      db,
    );
    appendSupportOutputEvent(
      {
        tenantId: 1,
        operationId: 'op_3',
        surface: 'chat',
        policyVersion: 1,
        action: 'block',
        reasons: ['too_long'],
        ruleIds: [],
        redactionCount: 0,
      },
      db,
    );

    // Tenant 2 event must not leak into Tenant 1
    appendSupportOutputEvent(
      {
        tenantId: 2,
        operationId: 'op_1',
        surface: 'chat',
        policyVersion: 1,
        action: 'block',
        reasons: ['blocked_term'],
        ruleIds: ['r2'],
        redactionCount: 0,
      },
      db,
    );

    const page1 = listSupportOutputEvents({ tenantId: 1, limit: 2 }, db);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = listSupportOutputEvents({ tenantId: 1, limit: 2, before: page1.nextCursor }, db);
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();

    const allIds = [...page1.items, ...page2.items].map((e) => e.operationId);
    expect(new Set(allIds)).toEqual(new Set(['op_1', 'op_2', 'op_3']));
    // Deduplication kept the first insert ('observe')
    expect([...page1.items, ...page2.items].find((e) => e.operationId === 'op_1')?.action).toBe('observe');

    // Tenant 2 sees only its own event
    const t2 = listSupportOutputEvents({ tenantId: 2, limit: 10 }, db);
    expect(t2.items).toHaveLength(1);
    expect(t2.items[0]?.ruleIds).toEqual(['r2']);

    // Invalid cursor rejected with 400
    expect(() => listSupportOutputEvents({ tenantId: 1, limit: 10, before: 'not-valid!' }, db)).toThrowError(
      SupportOutputError,
    );
  });

  it('prunes events older than 30 days and caps at 10000 per tenant on write, while GET never cleans up', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));

    appendSupportOutputEvent(
      {
        tenantId: 1,
        operationId: 'old_op',
        surface: 'chat',
        policyVersion: 1,
        action: 'observe',
        reasons: ['blocked_term'],
        ruleIds: ['r1'],
        redactionCount: 0,
      },
      db,
    );

    // Advance 31 days; GET must NOT prune old_op
    vi.setSystemTime(new Date('2026-11-01T00:00:01.000Z'));
    expect(listSupportOutputEvents({ tenantId: 1, limit: 10 }, db).items.map((i) => i.operationId)).toEqual([
      'old_op',
    ]);

    // Writing a new event prunes old_op (>30 days)
    appendSupportOutputEvent(
      {
        tenantId: 1,
        operationId: 'fresh_op',
        surface: 'chat',
        policyVersion: 1,
        action: 'observe',
        reasons: ['blocked_term'],
        ruleIds: ['r1'],
        redactionCount: 0,
      },
      db,
    );
    expect(listSupportOutputEvents({ tenantId: 1, limit: 10 }, db).items.map((i) => i.operationId)).toEqual([
      'fresh_op',
    ]);

    // Seed 10,000 rows directly, then write one more via appendSupportOutputEvent -> capped at 10,000
    const insertStmt = db.prepare(
      `INSERT INTO x_support_output_events (
         id, tenant_id, operation_id, surface, policy_version, action,
         reasons_json, rule_ids_json, redaction_count, created_at
       ) VALUES (?, 1, ?, 'chat', 1, 'observe', '["blocked_term"]', '["r1"]', 0, ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < SUPPORT_OUTPUT_LIMITS.eventsMaxPerTenant; i += 1) {
        insertStmt.run(`seed_${i}`, `seed_op_${i}`, '2026-10-20T00:00:00.000Z');
      }
    })();

    vi.setSystemTime(new Date('2026-11-01T00:00:02.000Z'));
    appendSupportOutputEvent(
      {
        tenantId: 1,
        operationId: 'cap_trigger_op',
        surface: 'chat',
        policyVersion: 1,
        action: 'block',
        reasons: ['too_long'],
        ruleIds: [],
        redactionCount: 0,
      },
      db,
    );

    const countRow = db
      .prepare('SELECT COUNT(*) AS count FROM x_support_output_events WHERE tenant_id = 1')
      .get() as { count: number };
    expect(countRow.count).toBe(SUPPORT_OUTPUT_LIMITS.eventsMaxPerTenant);
  });
});
