import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDb, defaultDbFactory, type Db } from '../../../db/index.js';
import { nodeSqliteFactory } from '../../../db/node-sqlite.js';
import { getMigrationStatuses, runMigrations } from '../../../db/migrate/runner.js';
import { initEncryptionKey } from '../../../lib/crypto.js';
import {
  up as serviceDeskUp,
  down as serviceDeskDown,
} from '../../../db/migrations/20261113_180001_support_service_desk.js';
import * as supportStore from '../../../custom/x-gateway/support-store.js';
import {
  claimSupportDeskCopilot,
  ensureSupportServiceDeskTables,
  finishSupportDeskCopilot,
  insertSupportDeskTicketState,
  saveSupportDeskIntake,
  updateSupportDeskSlaPolicy,
  updateSupportDeskWidgetConfig,
} from '../../../custom/x-gateway/support-service-desk-store.js';
import { computeSupportDeskIntakeSchemaHash } from '../../../custom/x-gateway/support-widget-profile.js';
import { DEFAULT_SUPPORT_DESK_SLA_POLICY } from '@freellmapi/shared/support-service-desk.js';

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

describe('20261113_180001_support_service_desk migration', () => {
  let db: Db;

  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    db?.close?.();
  });

  it('registers 20261113_180001_support_service_desk.ts and runs up/down/up cleanly before lazy tenant tables exist', async () => {
    db = openMemoryDb();
    await runMigrations(db, 'up');

    const applied = getMigrationStatuses(db)
      .filter((s) => s.status === 'applied')
      .map((s) => s.filename);
    expect(applied).toContain('20261113_180001_support_service_desk.ts');

    const expectedTables = [
      'x_support_desk_widget_configs',
      'x_support_desk_intakes',
      'x_support_desk_copilot_jobs',
      'x_support_desk_sla_policies',
      'x_support_desk_ticket_state',
    ];
    for (const table of expectedTables) {
      expect(hasTable(db, table)).toBe(true);
    }

    expect(hasTable(db, 'x_support_evidence_sources')).toBe(true);
    serviceDeskDown(db);
    for (const table of expectedTables) {
      expect(hasTable(db, table)).toBe(false);
    }
    expect(hasTable(db, 'x_support_evidence_sources')).toBe(true);

    serviceDeskUp(db);
    for (const table of expectedTables) {
      expect(hasTable(db, table)).toBe(true);
    }
  });

  it('supports populated down/up, encryption at rest, cascade delete, and a second independent memory Db', async () => {
    db = openMemoryDb();
    await runMigrations(db, 'up');
    initEncryptionKey(db);
    supportStore.ensureSupportTables();
    ensureSupportServiceDeskTables(db);

    const { tenant } = supportStore.createSupportTenant({ name: 'Desk Co', slug: 'desk-co' });

    const cfg = updateSupportDeskWidgetConfig(
      tenant.id,
      {
        enabled: true,
        appearance: {
          primaryColor: '#112233',
          title: 'Secret Brand Title',
          welcomeMessage: 'Confidential welcome',
          position: 'bottom-left',
          quickPrompts: ['Order status'],
        },
        intake: {
          required: true,
          fields: [{ key: 'email', label: 'Work Email', type: 'email', required: true }],
        },
      },
      1,
    );

    const schemaHash = computeSupportDeskIntakeSchemaHash(cfg);
    const receipt = saveSupportDeskIntake({
      tenantId: tenant.id,
      userId: 'cust_1',
      role: 'customer',
      input: {
        requestId: 'req_mig_1',
        configVersion: cfg.version,
        values: { email: 'sensitive-user@example.com' },
      },
      schemaHash,
      validatedValues: { email: 'sensitive-user@example.com' },
    });
    expect(receipt.intakeReceiptId).toBeTruthy();

    const claim = claimSupportDeskCopilot({
      tenantId: tenant.id,
      actorId: 10,
      requestId: 'cp_mig_1',
      fingerprint: 'fp_1',
      conversationId: 'conv_1',
    });
    if (claim.status !== 'claimed') throw new Error('expected claim');
    finishSupportDeskCopilot({
      tenantId: tenant.id,
      actorId: 10,
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      result: {
        jobId: claim.jobId,
        requestId: 'cp_mig_1',
        conversationId: 'conv_1',
        status: 'abstained',
        reason: 'no_evidence',
        summary: '',
        drafts: [],
        summaryCitations: [],
        conversationSnapshot: 'cs1',
        evidenceSnapshot: 'es1',
        policyVersion: 1,
        modelUsed: null,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, accounting: 'actual' },
        replayed: false,
        createdAt: new Date().toISOString(),
      },
    });

    updateSupportDeskSlaPolicy(tenant.id, { enabled: true }, 1);
    insertSupportDeskTicketState({
      tenantId: tenant.id,
      ticketId: 'tkt_1',
      conversationId: 'conv_1',
      version: 1,
      cycle: 1,
      cycleOpenedAt: '2026-11-13T00:00:00.000Z',
      tracking: 'tracked',
      policyVersion: 2,
      policyTargets: DEFAULT_SUPPORT_DESK_SLA_POLICY.targets,
      priority: 'high',
      department: 'billing',
      routingSource: 'rule',
      firstHumanReplyAt: null,
      resolvedAt: null,
      terminal: false,
    });

    // Encryption at rest checks
    const rawIntake = db
      .prepare('SELECT payload_encrypted FROM x_support_desk_intakes WHERE tenant_id = ?')
      .get(tenant.id) as { payload_encrypted: string };
    expect(rawIntake.payload_encrypted).not.toContain('sensitive-user@example.com');
    expect(rawIntake.payload_encrypted).not.toContain(receipt.intakeReceiptId);

    const rawCfg = db
      .prepare('SELECT payload_encrypted FROM x_support_desk_widget_configs WHERE tenant_id = ?')
      .get(tenant.id) as { payload_encrypted: string };
    expect(rawCfg.payload_encrypted).not.toContain('Secret Brand Title');

    // Cascade delete check
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare('DELETE FROM x_support_tenants WHERE id = ?').run(tenant.id);
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM x_support_desk_intakes WHERE tenant_id = ?').get(tenant.id),
    ).toEqual({ c: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM x_support_desk_ticket_state WHERE tenant_id = ?').get(tenant.id),
    ).toEqual({ c: 0 });

    // Populated down/up
    serviceDeskDown(db);
    expect(hasTable(db, 'x_support_desk_widget_configs')).toBe(false);
    serviceDeskUp(db);
    expect(hasTable(db, 'x_support_desk_widget_configs')).toBe(true);

    // Second independent memory Db
    const db2 = openMemoryDb();
    try {
      await runMigrations(db2, 'up');
      ensureSupportServiceDeskTables(db2);
      expect(hasTable(db2, 'x_support_desk_widget_configs')).toBe(true);
      expect(hasTable(db2, 'x_support_desk_ticket_state')).toBe(true);
    } finally {
      db2.close?.();
    }
  });
});
