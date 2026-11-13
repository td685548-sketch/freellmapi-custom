import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDb, defaultDbFactory, type Db } from '../../../db/index.js';
import { nodeSqliteFactory } from '../../../db/node-sqlite.js';
import { getMigrationStatuses, runMigrations } from '../../../db/migrate/runner.js';
import { initEncryptionKey } from '../../../lib/crypto.js';
import { up as supportEvidenceUp, down as supportEvidenceDown } from '../../../db/migrations/20261113_090001_support_evidence.js';
import * as supportStore from '../../../custom/x-gateway/support-store.js';
import {
  createSupportEvidenceSource,
  ensureSupportEvidenceTables,
  importSupportEvidenceRevision,
  publishSupportEvidenceRevision,
  saveSupportAnswerEvidence,
  saveSupportEvidenceRun,
  saveSupportEvidenceSuite,
} from '../../../custom/x-gateway/support-evidence-store.js';

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

describe('20261113_090001_support_evidence migration', () => {
  let db: Db;

  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', 'cd'.repeat(32));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    db?.close?.();
  });

  it('registers 20261113_090001_support_evidence.ts and runs up/down/up cleanly before lazy tenant tables exist', async () => {
    db = openMemoryDb();
    await runMigrations(db, 'up');

    const applied = getMigrationStatuses(db)
      .filter((s) => s.status === 'applied')
      .map((s) => s.filename);
    expect(applied).toContain('20261113_090001_support_evidence.ts');

    const expectedTables = [
      'x_support_evidence_sources',
      'x_support_evidence_revisions',
      'x_support_evidence_chunks',
      'x_support_evidence_policies',
      'x_support_evidence_suites',
      'x_support_evidence_runs',
      'x_support_evidence_answers',
    ];
    for (const table of expectedTables) {
      expect(hasTable(db, table)).toBe(true);
    }

    // Also verify down() removes only 018 objects and preserves 017 tables
    expect(hasTable(db, 'x_support_runtime_turns')).toBe(true);
    supportEvidenceDown(db);
    for (const table of expectedTables) {
      expect(hasTable(db, table)).toBe(false);
    }
    expect(hasTable(db, 'x_support_runtime_turns')).toBe(true);

    // Re-up cleanly
    supportEvidenceUp(db);
    for (const table of expectedTables) {
      expect(hasTable(db, table)).toBe(true);
    }
  });

  it('supports down/up with populated 018 tables, lazy tenant schema, encryption at rest, and a second independent memory Db', async () => {
    db = openMemoryDb();
    await runMigrations(db, 'up');
    initEncryptionKey(db);
    supportStore.ensureSupportTables();
    ensureSupportEvidenceTables(db);

    const { tenant } = supportStore.createSupportTenant({ name: 'Acme', slug: 'acme-mig' });
    const src = createSupportEvidenceSource(tenant.id, {
      name: 'Migration Source',
      kind: 'text',
      allowedRoles: ['customer', 'admin'],
    });
    const imp = await importSupportEvidenceRevision({
      tenantId: tenant.id,
      sourceId: src.id,
      expectedVersion: src.version,
      title: 'Secret Policy Title',
      category: 'billing',
      tags: ['refund'],
      format: 'text',
      content: 'Sensitive body content that must be encrypted at rest.',
    });
    publishSupportEvidenceRevision(tenant.id, src.id, imp.revision.id, imp.source.version);

    const suite = saveSupportEvidenceSuite(tenant.id, {
      name: 'Smoke Suite',
      cases: [
        {
          id: 'c1',
          query: 'Sensitive query string',
          role: 'customer',
          expectedSourceIds: [src.id],
          forbiddenSourceIds: [],
          expectAbstention: false,
        },
      ],
    });
    saveSupportEvidenceRun(tenant.id, {
      suiteId: suite.id,
      suiteVersion: suite.version,
      status: 'completed',
      startedAt: '2026-11-13T00:00:00.000Z',
      completedAt: '2026-11-13T00:00:01.000Z',
      casesChecked: 1,
      totalCases: 1,
      matchedExpectedCases: 1,
      expectedCasesChecked: 1,
      casesWithoutForbiddenHits: 1,
      correctlyAbstainedCases: 0,
      hitAtK: 1,
      allPassed: true,
      snapshotIds: ['snap_1'],
      results: [
        {
          caseId: 'c1',
          role: 'customer',
          returnedSourceIds: [src.id],
          expectedHit: true,
          forbiddenHitCount: 0,
          abstentionMatched: true,
          passed: true,
        },
      ],
    });
    saveSupportAnswerEvidence({
      tenantId: tenant.id,
      userId: 'usr_1',
      role: 'customer',
      requestId: 'req_1',
      turnId: 'turn_1',
      conversationId: 'conv_1',
      customerMessageId: 'msg_c1',
      assistantMessageId: 'msg_a1',
      evidence: {
        requestId: 'req_1',
        status: 'cited',
        policyVersion: 1,
        snapshotId: 'snap_1',
        citations: [],
      },
    });

    // Verify encryption at rest in raw SQLite rows
    const rawRev = db
      .prepare('SELECT payload_encrypted FROM x_support_evidence_revisions WHERE id = ?')
      .get(imp.revision.id) as { payload_encrypted: string };
    expect(rawRev.payload_encrypted).not.toContain('Sensitive body content');
    expect(rawRev.payload_encrypted).not.toContain('Secret Policy Title');

    const rawSuite = db
      .prepare('SELECT cases_encrypted FROM x_support_evidence_suites WHERE id = ?')
      .get(suite.id) as { cases_encrypted: string };
    expect(rawSuite.cases_encrypted).not.toContain('Sensitive query string');

    // Verify down() succeeds even with populated tables (no circular FK)
    supportEvidenceDown(db);
    expect(hasTable(db, 'x_support_evidence_sources')).toBe(false);
    expect(hasTable(db, 'x_support_tenants')).toBe(true);

    // Verify second independent memory Db works cleanly
    const db2 = openMemoryDb();
    try {
      await runMigrations(db2, 'up');
      ensureSupportEvidenceTables(db2);
      expect(hasTable(db2, 'x_support_evidence_sources')).toBe(true);
      expect(hasTable(db2, 'x_support_evidence_answers')).toBe(true);
    } finally {
      db2.close?.();
    }
  });

  it('cascades tenant deletion to 018 tables and preserves answers when 017 turn-cache rows expire', async () => {
    db = openMemoryDb();
    await runMigrations(db, 'up');
    initEncryptionKey(db);
    supportStore.ensureSupportTables();
    ensureSupportEvidenceTables(db);

    const { tenant } = supportStore.createSupportTenant({ name: 'Cascade Co', slug: 'cascade-co' });
    const src = createSupportEvidenceSource(tenant.id, { name: 'Doc', kind: 'text' });
    await importSupportEvidenceRevision({
      tenantId: tenant.id,
      sourceId: src.id,
      expectedVersion: src.version,
      title: 'T',
      format: 'text',
      content: 'Body',
    });

    // Insert a 017 turn row and an 018 answer row
    db.prepare(
      `INSERT INTO x_support_runtime_turns (id, tenant_id, user_id, request_id, conversation_id, input_hash, state, created_at, updated_at, expires_at)
       VALUES ('turn_ttl', ?, 'u1', 'req_ttl', 'conv_ttl', 'hash', 'completed', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z', '2026-11-13T01:00:00Z')`,
    ).run(tenant.id);

    saveSupportAnswerEvidence({
      tenantId: tenant.id,
      userId: 'u1',
      role: 'customer',
      requestId: 'req_ttl',
      turnId: 'turn_ttl',
      conversationId: 'conv_ttl',
      customerMessageId: 'msg_1',
      assistantMessageId: 'msg_2',
      evidence: {
        requestId: 'req_ttl',
        status: 'cited',
        policyVersion: 1,
        snapshotId: 'snap_ttl',
        citations: [],
      },
    });

    // Deleting expired 017 turn row must NOT delete 018 answer row
    db.prepare('DELETE FROM x_support_runtime_turns WHERE id = ?').run('turn_ttl');
    const survivingAnswer = db
      .prepare('SELECT id FROM x_support_evidence_answers WHERE turn_id = ?')
      .get('turn_ttl');
    expect(survivingAnswer).toBeTruthy();

    // Deleting tenant must cascade delete 018 sources, revisions, chunks, and answers
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare('DELETE FROM x_support_tenants WHERE id = ?').run(tenant.id);
    expect(db.prepare('SELECT COUNT(*) AS c FROM x_support_evidence_sources WHERE tenant_id = ?').get(tenant.id)).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM x_support_evidence_answers WHERE tenant_id = ?').get(tenant.id)).toEqual({ c: 0 });
  });
});
