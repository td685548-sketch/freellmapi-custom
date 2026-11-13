import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDb, defaultDbFactory, type Db } from '../../db/index.js';
import { runMigrations } from '../../db/migrate/runner.js';
import { nodeSqliteFactory } from '../../db/node-sqlite.js';
import { initEncryptionKey } from '../../lib/crypto.js';
import * as supportStore from '../../custom/x-gateway/support-store.js';
import {
  bindSupportDeskIntake,
  claimSupportDeskCopilot,
  ensureSupportServiceDeskTables,
  failSupportDeskCopilot,
  finishSupportDeskCopilot,
  getSupportDeskCopilotJob,
  getSupportDeskSlaPolicy,
  getSupportDeskTicketState,
  getSupportDeskWidgetConfig,
  insertSupportDeskTicketState,
  listSupportDeskTicketStates,
  readSupportDeskBoundIntake,
  readSupportDeskIntake,
  recordSupportDeskCopilotUsage,
  reserveSupportDeskCopilotAttempt,
  saveSupportDeskIntake,
  SupportDeskError,
  updateSupportDeskSlaPolicy,
  updateSupportDeskTicketState,
  updateSupportDeskWidgetConfig,
} from '../../custom/x-gateway/support-service-desk-store.js';
import { computeSupportDeskIntakeSchemaHash } from '../../custom/x-gateway/support-widget-profile.js';
import {
  DEFAULT_SUPPORT_DESK_SLA_POLICY,
  SUPPORT_DESK_LIMITS,
} from '@freellmapi/shared/support-service-desk.js';

let db: Db;
let tenantId: number;
let tenantBId: number;

beforeEach(async () => {
  db = connectDb(':memory:', {
    factory: (dbPath) => {
      try {
        return defaultDbFactory()(dbPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ERR_DLOPEN_FAILED') throw error;
        return nodeSqliteFactory(dbPath);
      }
    },
  });
  await runMigrations(db, 'up');
  vi.stubEnv('ENCRYPTION_KEY', 'ef'.repeat(32));
  initEncryptionKey(db);
  supportStore.ensureSupportTables();
  ensureSupportServiceDeskTables(db);
  tenantId = supportStore.createSupportTenant({ name: 'Tenant A', slug: 'tenant-a' }).tenant.id;
  tenantBId = supportStore.createSupportTenant({ name: 'Tenant B', slug: 'tenant-b' }).tenant.id;
});

afterEach(() => {
  vi.unstubAllEnvs();
  db?.close?.();
});

describe('support-service-desk-store', () => {
  it('returns fresh default widget config and enforces OCC on update', () => {
    const def = getSupportDeskWidgetConfig(tenantId);
    expect(def.enabled).toBe(false);
    expect(def.version).toBe(1);

    const updated = updateSupportDeskWidgetConfig(tenantId, { enabled: true }, 1);
    expect(updated.version).toBe(2);
    expect(updated.enabled).toBe(true);

    expect(() => updateSupportDeskWidgetConfig(tenantId, { enabled: false }, 1)).toThrowError(
      /version conflict/i,
    );
  });

  it('fails closed with 503 when widget config or SLA policy storage is corrupted or missing', () => {
    updateSupportDeskWidgetConfig(tenantId, { enabled: true }, 1);
    db.prepare('UPDATE x_support_desk_widget_configs SET payload_encrypted = ? WHERE tenant_id = ?').run(
      'corrupt_hex',
      tenantId,
    );

    try {
      getSupportDeskWidgetConfig(tenantId);
      expect.unreachable('should fail closed');
    } catch (err) {
      expect(err).toBeInstanceOf(SupportDeskError);
      expect((err as SupportDeskError).status).toBe(503);
      expect((err as SupportDeskError).code).toBe('service_desk_storage_unavailable');
    }

    db.exec('DROP TABLE x_support_desk_sla_policies');
    try {
      getSupportDeskSlaPolicy(tenantId);
      expect.unreachable('should fail closed on missing table');
    } catch (err) {
      expect(err).toBeInstanceOf(SupportDeskError);
      expect((err as SupportDeskError).status).toBe(503);
      expect((err as SupportDeskError).code).toBe('service_desk_storage_unavailable');
    }
  });

  it('issues scoped intake receipts, replays same payload, rejects conflicts, and enforces hourly cap', () => {
    const cfg = updateSupportDeskWidgetConfig(
      tenantId,
      {
        enabled: true,
        intake: {
          required: true,
          fields: [{ key: 'topic', label: 'Topic', type: 'text', required: true }],
        },
      },
      1,
    );
    const schemaHash = computeSupportDeskIntakeSchemaHash(cfg);
    const now = Date.UTC(2026, 10, 13, 10, 0, 0);

    const first = saveSupportDeskIntake({
      tenantId,
      userId: 'u_1',
      role: 'customer',
      input: { requestId: 'req_1', configVersion: cfg.version, values: { topic: 'billing' } },
      schemaHash,
      validatedValues: { topic: 'billing' },
      now,
    });
    expect(first.replayed).toBe(false);

    const replay = saveSupportDeskIntake({
      tenantId,
      userId: 'u_1',
      role: 'customer',
      input: { requestId: 'req_1', configVersion: cfg.version, values: { topic: 'billing' } },
      schemaHash,
      validatedValues: { topic: 'billing' },
      now: now + 1000,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.intakeReceiptId).toBe(first.intakeReceiptId);

    // Different payload under same requestId -> 409 request_conflict
    expect(() =>
      saveSupportDeskIntake({
        tenantId,
        userId: 'u_1',
        role: 'customer',
        input: { requestId: 'req_1', configVersion: cfg.version, values: { topic: 'returns' } },
        schemaHash,
        validatedValues: { topic: 'returns' },
        now: now + 2000,
      }),
    ).toThrow(SupportDeskError);

    // Hourly cap (10 per hour)
    for (let i = 2; i <= 10; i += 1) {
      saveSupportDeskIntake({
        tenantId,
        userId: 'u_1',
        role: 'customer',
        input: { requestId: `req_${i}`, configVersion: cfg.version, values: { topic: 'billing' } },
        schemaHash,
        validatedValues: { topic: 'billing' },
        now: now + i * 1000,
      });
    }
    try {
      saveSupportDeskIntake({
        tenantId,
        userId: 'u_1',
        role: 'customer',
        input: { requestId: 'req_11', configVersion: cfg.version, values: { topic: 'billing' } },
        schemaHash,
        validatedValues: { topic: 'billing' },
        now: now + 20_000,
      });
      expect.unreachable('should rate limit');
    } catch (err) {
      expect((err as SupportDeskError).status).toBe(429);
      expect((err as SupportDeskError).code).toBe('intake_rate_limited');
    }
  });

  it('enforces intake ownership, expiry, atomic binding, idempotency, and bound hydration', () => {
    const schemaHash = 'hash_v1';
    const now = Date.UTC(2026, 10, 13, 12, 0, 0);
    const receipt = saveSupportDeskIntake({
      tenantId,
      userId: 'u_1',
      role: 'customer',
      input: { requestId: 'req_bind', configVersion: 1, values: { topic: 'login' } },
      schemaHash,
      validatedValues: { topic: 'login' },
      now,
    });

    // Wrong tenant / user / role -> 404 intake_not_found
    expect(() =>
      readSupportDeskIntake({ tenantId: tenantBId, userId: 'u_1', role: 'customer', receiptId: receipt.intakeReceiptId, now }),
    ).toThrow(SupportDeskError);
    expect(() =>
      readSupportDeskIntake({ tenantId, userId: 'u_1', role: 'guest', receiptId: receipt.intakeReceiptId, now }),
    ).toThrow(SupportDeskError);

    // Bind idempotently to conv_1
    bindSupportDeskIntake({
      tenantId,
      userId: 'u_1',
      role: 'customer',
      receiptId: receipt.intakeReceiptId,
      conversationId: 'conv_1',
      schemaHash,
      now: now + 1000,
    });
    bindSupportDeskIntake({
      tenantId,
      userId: 'u_1',
      role: 'customer',
      receiptId: receipt.intakeReceiptId,
      conversationId: 'conv_1',
      schemaHash,
      now: now + SUPPORT_DESK_LIMITS.intakeTtlSeconds * 1000 + 5000, // Already bound stays idempotent
    });

    // Binding same receipt to another conversation -> 409 intake_already_bound
    try {
      bindSupportDeskIntake({
        tenantId,
        userId: 'u_1',
        role: 'customer',
        receiptId: receipt.intakeReceiptId,
        conversationId: 'conv_2',
        schemaHash,
        now: now + 2000,
      });
      expect.unreachable('should reject second conversation');
    } catch (err) {
      expect((err as SupportDeskError).status).toBe(409);
      expect((err as SupportDeskError).code).toBe('intake_already_bound');
    }

    const hydrated = readSupportDeskBoundIntake({ tenantId, conversationId: 'conv_1', userId: 'u_1' });
    expect(hydrated?.values).toEqual({ topic: 'login' });
    expect(readSupportDeskBoundIntake({ tenantId: tenantBId, conversationId: 'conv_1', userId: 'u_1' })).toBeNull();
  });

  it('enforces Copilot claim, lease fencing, attemptId idempotency, hourly/daily budgets, and job expiry', () => {
    const now = Date.UTC(2026, 10, 13, 14, 0, 0);
    const claim = claimSupportDeskCopilot({
      tenantId,
      actorId: 42,
      requestId: 'cp_1',
      fingerprint: 'fp_a',
      conversationId: 'conv_1',
      now,
    });
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') throw new Error('expected claimed');

    // Concurrent claim while running -> running
    const running = claimSupportDeskCopilot({
      tenantId,
      actorId: 42,
      requestId: 'cp_1',
      fingerprint: 'fp_a',
      conversationId: 'conv_1',
      now: now + 1000,
    });
    expect(running.status).toBe('running');

    // Conflicting fingerprint -> 409
    expect(() =>
      claimSupportDeskCopilot({
        tenantId,
        actorId: 42,
        requestId: 'cp_1',
        fingerprint: 'fp_b',
        conversationId: 'conv_1',
        now: now + 1000,
      }),
    ).toThrow(SupportDeskError);

    // Reserve attempt & settle idempotently
    const { attemptId } = reserveSupportDeskCopilotAttempt({
      tenantId,
      actorId: 42,
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      estimatedTokens: 1000,
      now: now + 2000,
    });

    // Wrong leaseToken fenced
    expect(() =>
      recordSupportDeskCopilotUsage({
        tenantId,
        actorId: 42,
        jobId: claim.jobId,
        leaseToken: 'wrong_lease',
        attemptId,
        usage: { totalTokens: 500 },
        now: now + 2500,
      }),
    ).toThrow(SupportDeskError);

    recordSupportDeskCopilotUsage({
      tenantId,
      actorId: 42,
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      attemptId,
      usage: { promptTokens: 300, completionTokens: 150, totalTokens: 450 },
      now: now + 3000,
    });
    // Idempotent second call
    recordSupportDeskCopilotUsage({
      tenantId,
      actorId: 42,
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      attemptId,
      usage: { totalTokens: 999 },
      now: now + 3100,
    });

    finishSupportDeskCopilot({
      tenantId,
      actorId: 42,
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      result: {
        jobId: claim.jobId,
        requestId: 'cp_1',
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
        usage: { promptTokens: 300, completionTokens: 150, totalTokens: 450, accounting: 'actual' },
        replayed: false,
        createdAt: new Date(now).toISOString(),
      },
      now: now + 3500,
    });

    const fetched = getSupportDeskCopilotJob({ tenantId, actorId: 42, jobId: claim.jobId, now: now + 4000 });
    expect(fetched.status).toBe('abstained');

    // Cross-actor lookup -> 404
    expect(() =>
      getSupportDeskCopilotJob({ tenantId, actorId: 99, jobId: claim.jobId, now: now + 4000 }),
    ).toThrow(SupportDeskError);

    // Expired job -> 410 job_expired
    try {
      getSupportDeskCopilotJob({
        tenantId,
        actorId: 42,
        jobId: claim.jobId,
        now: now + SUPPORT_DESK_LIMITS.copilotJobTtlSeconds * 1000 + 1,
      });
      expect.unreachable('should expire');
    } catch (err) {
      expect((err as SupportDeskError).status).toBe(410);
      expect((err as SupportDeskError).code).toBe('job_expired');
    }
  });

  it('enforces Copilot hourly request cap, daily token cap, and expired lease conservative settlement', () => {
    const now = Date.UTC(2026, 10, 13, 15, 0, 0);

    // Claim & exhaust daily token budget on actor 7
    const c1 = claimSupportDeskCopilot({
      tenantId,
      actorId: 7,
      requestId: 'tok_1',
      fingerprint: 'fp_1',
      conversationId: 'conv_1',
      now,
    });
    if (c1.status !== 'claimed') throw new Error('expected claim');
    reserveSupportDeskCopilotAttempt({
      tenantId,
      actorId: 7,
      jobId: c1.jobId,
      leaseToken: c1.leaseToken,
      estimatedTokens: SUPPORT_DESK_LIMITS.copilotTokensPerDay,
      now: now + 100,
    });

    // Let lease expire with dispatch recorded -> claim must fail conservatively, not re-dispatch
    try {
      claimSupportDeskCopilot({
        tenantId,
        actorId: 7,
        requestId: 'tok_1',
        fingerprint: 'fp_1',
        conversationId: 'conv_1',
        now: now + SUPPORT_DESK_LIMITS.copilotDeadlineMs + 10_000,
      });
      expect.unreachable('should fail expired dispatched lease');
    } catch (err) {
      expect((err as SupportDeskError).status).toBe(504);
      expect((err as SupportDeskError).code).toBe('copilot_timeout');
    }

    // Next request on same UTC day hits daily token cap
    try {
      claimSupportDeskCopilot({
        tenantId,
        actorId: 7,
        requestId: 'tok_2',
        fingerprint: 'fp_2',
        conversationId: 'conv_1',
        now: now + SUPPORT_DESK_LIMITS.copilotDeadlineMs + 11_000,
      });
      expect.unreachable('should hit daily token cap');
    } catch (err) {
      expect((err as SupportDeskError).status).toBe(429);
      expect((err as SupportDeskError).code).toBe('copilot_quota_exceeded');
    }

    // Actor 8 tests hourly 10-request cap
    for (let i = 1; i <= SUPPORT_DESK_LIMITS.copilotRequestsPerHour; i += 1) {
      const ci = claimSupportDeskCopilot({
        tenantId,
        actorId: 8,
        requestId: `hr_${i}`,
        fingerprint: `fp_${i}`,
        conversationId: 'conv_1',
        now: now + i * 100,
      });
      if (ci.status !== 'claimed') throw new Error('expected claim');
      failSupportDeskCopilot({
        tenantId,
        actorId: 8,
        jobId: ci.jobId,
        leaseToken: ci.leaseToken,
        code: 'model_unavailable',
        now: now + i * 100 + 50,
      });
      // Note: failed with 0 dispatched_calls does not consume hourly quota; dispatch 1 call or finish:
    }

    // Now test 10 completed requests on actor 9
    for (let i = 1; i <= SUPPORT_DESK_LIMITS.copilotRequestsPerHour; i += 1) {
      const ci = claimSupportDeskCopilot({
        tenantId,
        actorId: 9,
        requestId: `hr9_${i}`,
        fingerprint: `fp_${i}`,
        conversationId: 'conv_1',
        now: now + i * 100,
      });
      if (ci.status !== 'claimed') throw new Error('expected claim');
      finishSupportDeskCopilot({
        tenantId,
        actorId: 9,
        jobId: ci.jobId,
        leaseToken: ci.leaseToken,
        result: {
          jobId: ci.jobId,
          requestId: `hr9_${i}`,
          conversationId: 'conv_1',
          status: 'abstained',
          reason: 'no_evidence',
          summary: '',
          drafts: [],
          summaryCitations: [],
          conversationSnapshot: 'cs',
          evidenceSnapshot: 'es',
          policyVersion: 1,
          modelUsed: null,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, accounting: 'actual' },
          replayed: false,
          createdAt: new Date(now).toISOString(),
        },
        now: now + i * 100 + 50,
      });
    }

    try {
      claimSupportDeskCopilot({
        tenantId,
        actorId: 9,
        requestId: 'hr9_11',
        fingerprint: 'fp_11',
        conversationId: 'conv_1',
        now: now + 5000,
      });
      expect.unreachable('should hit hourly request cap');
    } catch (err) {
      expect((err as SupportDeskError).status).toBe(429);
      expect((err as SupportDeskError).code).toBe('copilot_quota_exceeded');
    }
  });

  it('manages SLA policy OCC and ticket state CRUD with deterministic tie-safe cursor pagination', () => {
    const policy = getSupportDeskSlaPolicy(tenantId);
    expect(policy.enabled).toBe(false);
    expect(policy.targets.urgent.firstResponseMinutes).toBe(5);

    const updatedPolicy = updateSupportDeskSlaPolicy(
      tenantId,
      {
        enabled: true,
        routingRules: [{ id: 'rule_1', department: 'billing', keywords: ['invoice', 'refund'] }],
      },
      1,
    );
    expect(updatedPolicy.version).toBe(2);
    expect(updatedPolicy.enabled).toBe(true);

    // Insert 3 tickets with identical cycleOpenedAt to verify tie-safe cursor pagination
    for (const id of ['tkt_c', 'tkt_a', 'tkt_b']) {
      insertSupportDeskTicketState({
        tenantId,
        ticketId: id,
        conversationId: `conv_${id}`,
        version: 1,
        cycle: 1,
        cycleOpenedAt: '2026-11-13T10:00:00.000Z',
        tracking: 'tracked',
        policyVersion: updatedPolicy.version,
        policyTargets: DEFAULT_SUPPORT_DESK_SLA_POLICY.targets,
        priority: 'medium',
        department: 'billing',
        routingSource: 'rule',
        firstHumanReplyAt: null,
        resolvedAt: null,
        terminal: false,
      });
    }

    const page1 = listSupportDeskTicketStates(tenantId, { limit: 2 });
    expect(page1.items.map((i) => i.ticketId)).toEqual(['tkt_a', 'tkt_b']);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = listSupportDeskTicketStates(tenantId, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((i) => i.ticketId)).toEqual(['tkt_c']);
    expect(page2.nextCursor).toBeNull();

    const updatedTicket = updateSupportDeskTicketState(
      tenantId,
      'tkt_a',
      { department: 'technical', routingSource: 'manual' },
      1,
    );
    expect(updatedTicket.version).toBe(2);
    expect(getSupportDeskTicketState(tenantId, 'tkt_a')?.department).toBe('technical');

    expect(() =>
      updateSupportDeskTicketState(tenantId, 'tkt_a', { department: 'returns' }, 1),
    ).toThrow(SupportDeskError);
  });

  it('enforces intake TTL expiry on read/bind and schema mismatch on bind', () => {
    const now = Date.UTC(2026, 10, 13, 16, 0, 0);
    const receipt = saveSupportDeskIntake({
      tenantId,
      userId: 'u_exp',
      role: 'guest',
      input: { requestId: 'req_exp', configVersion: 1, values: { topic: 'help' } },
      schemaHash: 'schema_1',
      validatedValues: { topic: 'help' },
      now,
    });

    // Schema mismatch on bind -> 409 intake_schema_changed
    try {
      bindSupportDeskIntake({
        tenantId,
        userId: 'u_exp',
        role: 'guest',
        receiptId: receipt.intakeReceiptId,
        conversationId: 'conv_exp',
        schemaHash: 'schema_2',
        now: now + 1000,
      });
      expect.unreachable('should reject schema mismatch');
    } catch (err) {
      expect((err as SupportDeskError).status).toBe(409);
      expect((err as SupportDeskError).code).toBe('intake_schema_changed');
    }

    // Expired on read -> 410 intake_expired
    const afterTtl = now + SUPPORT_DESK_LIMITS.intakeTtlSeconds * 1000 + 1;
    try {
      readSupportDeskIntake({
        tenantId,
        userId: 'u_exp',
        role: 'guest',
        receiptId: receipt.intakeReceiptId,
        now: afterTtl,
      });
      expect.unreachable('should expire');
    } catch (err) {
      expect((err as SupportDeskError).status).toBe(410);
      expect((err as SupportDeskError).code).toBe('intake_expired');
    }
  });

  it('enforces copilotMaxModelCalls=2 and running job retryAfterSeconds on GET', () => {
    const now = Date.UTC(2026, 10, 13, 17, 0, 0);
    const claim = claimSupportDeskCopilot({
      tenantId,
      actorId: 55,
      requestId: 'cp_max',
      fingerprint: 'fp_max',
      conversationId: 'conv_1',
      now,
    });
    if (claim.status !== 'claimed') throw new Error('expected claim');

    // GET while running -> 409 copilot_in_progress with retryAfterSeconds
    try {
      getSupportDeskCopilotJob({ tenantId, actorId: 55, jobId: claim.jobId, now: now + 1000 });
      expect.unreachable('should be running');
    } catch (err) {
      expect((err as SupportDeskError).status).toBe(409);
      expect((err as SupportDeskError).code).toBe('copilot_in_progress');
      expect((err as SupportDeskError).retryAfterSeconds).toBeGreaterThan(0);
    }

    reserveSupportDeskCopilotAttempt({
      tenantId,
      actorId: 55,
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      estimatedTokens: 500,
      now: now + 1000,
    });
    reserveSupportDeskCopilotAttempt({
      tenantId,
      actorId: 55,
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      estimatedTokens: 500,
      now: now + 1500,
    });

    // 3rd attempt rejected
    expect(() =>
      reserveSupportDeskCopilotAttempt({
        tenantId,
        actorId: 55,
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        estimatedTokens: 500,
        now: now + 2000,
      }),
    ).toThrow(SupportDeskError);
  });

  it('rejects invalid SLA policy targets, incomplete targets, and OCC conflicts', () => {
    expect(() =>
      updateSupportDeskSlaPolicy(
        tenantId,
        {
          targets: {
            urgent: { firstResponseMinutes: 100, resolutionMinutes: 50 },
            high: { firstResponseMinutes: 15, resolutionMinutes: 240 },
            medium: { firstResponseMinutes: 60, resolutionMinutes: 1440 },
            low: { firstResponseMinutes: 240, resolutionMinutes: 4320 },
          },
        },
        1,
      ),
    ).toThrow(SupportDeskError);

    expect(() =>
      updateSupportDeskSlaPolicy(
        tenantId,
        { targets: { urgent: { firstResponseMinutes: 5, resolutionMinutes: 60 } } },
        1,
      ),
    ).toThrow(SupportDeskError);

    updateSupportDeskSlaPolicy(tenantId, { enabled: true }, 1);
    expect(() => updateSupportDeskSlaPolicy(tenantId, { enabled: false }, 1)).toThrow(
      SupportDeskError,
    );
  });
});

it('persists expired dispatched claim failure and fences late callbacks', () => {
  const now = Date.parse('2026-11-13T10:00:00Z');
  const params = {tenantId, actorId:42, requestId:'expired_lease', fingerprint:'fingerprint', conversationId:'conv_expired', now};
  const claim = claimSupportDeskCopilot(params);
  if (claim.status !== 'claimed') throw new Error('expected claim');
  const {attemptId} = reserveSupportDeskCopilotAttempt({tenantId,actorId:42,jobId:claim.jobId,leaseToken:claim.leaseToken,estimatedTokens:500,now});
  const expired = now + 21000;
  expect(() => recordSupportDeskCopilotUsage({tenantId,actorId:42,jobId:claim.jobId,leaseToken:claim.leaseToken,attemptId,usage:{totalTokens:0},now:expired})).toThrowError(/expired/i);
  expect(() => claimSupportDeskCopilot({...params, now:expired})).toThrowError(/lease expired/i);
  const row = db.prepare('SELECT state,spent_tokens,reserved_tokens FROM x_support_desk_copilot_jobs WHERE id = ?').get(claim.jobId);
  expect(row).toMatchObject({state:'failed',spent_tokens:500,reserved_tokens:500});
  expect(() => recordSupportDeskCopilotUsage({tenantId,actorId:42,jobId:claim.jobId,leaseToken:claim.leaseToken,attemptId,usage:{totalTokens:0},now:expired})).toThrow();
});
it('retains hourly intake issuance evidence after receipt expiry', () => {
  const now = Date.parse('2026-11-13T10:00:00Z');
  const issue = (id:string, at:number) => saveSupportDeskIntake({tenantId,userId:'rate_user',role:'customer',input:{requestId:id,configVersion:1,values:{}},schemaHash:'schema',validatedValues:{},now:at});
  for(let i=0;i<10;i++) issue('hourly_'+i,now);
  expect(() => issue('hourly_11',now+31*60000)).toThrowError(/Hourly intake/i);
  expect(() => issue('hourly_12',now+61*60000)).not.toThrow();
});

it('counts accepted failures before model dispatch against the hourly request limit', () => {
  const now = Date.parse('2026-11-13T10:00:00Z');
  for(let i=0;i<10;i++) {
    const claim=claimSupportDeskCopilot({tenantId,actorId:42,requestId:'failed_'+i,fingerprint:'fp',conversationId:'conv',now});
    if(claim.status!=='claimed') throw new Error('expected claimed');
    failSupportDeskCopilot({tenantId,actorId:42,jobId:claim.jobId,leaseToken:claim.leaseToken,code:'invalid_input',now});
  }
  expect(()=>claimSupportDeskCopilot({tenantId,actorId:42,requestId:'eleventh',fingerprint:'fp',conversationId:'conv',now})).toThrowError(/hourly request/i);
});
