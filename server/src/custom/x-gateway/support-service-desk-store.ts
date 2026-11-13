import crypto from 'node:crypto';
import { getDb, type Db } from '../../db/index.js';
import { encrypt, decrypt, isEncryptionKeyInitialized, initEncryptionKey } from '../../lib/crypto.js';
import { up as supportServiceDeskUp } from '../../db/migrations/20261113_180001_support_service_desk.js';
import { ensureSupportTables } from './support-store.js';
import {
  DEFAULT_SUPPORT_DESK_SLA_POLICY,
  DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
  SUPPORT_DESK_DEPARTMENTS,
  SUPPORT_DESK_INTAKE_MAX_LIVE_RECEIPTS,
  SUPPORT_DESK_INTAKE_MAX_PER_HOUR,
  SUPPORT_DESK_LIMITS,
  type SupportDeskCopilotResult,
  type SupportDeskDepartment,
  type SupportDeskIntakeInput,
  type SupportDeskIntakeReceipt,
  type SupportDeskRoutingRule,
  type SupportDeskSlaPolicy,
  type SupportDeskSlaTarget,
  type SupportDeskStoredIntake,
  type SupportDeskTicketState,
  type SupportDeskWidgetConfig,
  type SupportTicketPriority,
} from '@freellmapi/shared/support-service-desk.js';
import { SUPPORT_EVIDENCE_ROLES, type SupportEvidenceRole } from '@freellmapi/shared/support-evidence.js';
import { SupportDeskError, validateWidgetConfigPatch } from './support-widget-profile.js';

export { SupportDeskError };

const initializedDbs = new WeakSet<Db>();
const SAFE_ASCII_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PRIORITIES: readonly SupportTicketPriority[] = ['urgent', 'high', 'medium', 'low'];

export function ensureSupportServiceDeskTables(targetDb?: Db): Db {
  const db = targetDb ?? getDb();
  if (initializedDbs.has(db)) return db;

  if (!targetDb) {
    ensureSupportTables();
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  supportServiceDeskUp(db);
  if (!isEncryptionKeyInitialized()) {
    initEncryptionKey(db);
  }
  initializedDbs.add(db);
  return db;
}

function withStorageBoundary<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SupportDeskError) throw err;
    throw new SupportDeskError(
      503,
      'service_desk_storage_unavailable',
      'Service desk storage is unavailable.',
    );
  }
}

function encryptJson(value: unknown): { encrypted: string; iv: string; authTag: string } {
  return encrypt(JSON.stringify(value));
}

function decryptJson<T>(encrypted: string, iv: string, authTag: string): T {
  try {
    const raw = decrypt(encrypted, iv, authTag);
    return JSON.parse(raw) as T;
  } catch {
    throw new SupportDeskError(
      503,
      'service_desk_storage_unavailable',
      'Service desk encrypted payload is corrupted or unreadable.',
    );
  }
}

function assertPositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new SupportDeskError(400, 'invalid_input', `${label} must be a positive integer.`);
  }
  return value;
}

function assertTenantExists(db: Db, tenantId: number): void {
  assertPositiveInt(tenantId, 'tenantId');
  const row = db.prepare('SELECT id FROM x_support_tenants WHERE id = ?').get(tenantId) as
    | { id: number }
    | undefined;
  if (!row) {
    throw new SupportDeskError(404, 'tenant_not_found', 'Support tenant not found.');
  }
}

function assertSafeId(value: unknown, label: string, maxLen = 128): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLen || !SAFE_ASCII_ID_RE.test(value)) {
    throw new SupportDeskError(400, 'invalid_input', `${label} must be a valid ASCII identifier (1..${maxLen}).`);
  }
  return value;
}

function cloneDefaultWidgetConfig(): SupportDeskWidgetConfig {
  return {
    ...DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
    appearance: {
      ...DEFAULT_SUPPORT_DESK_WIDGET_CONFIG.appearance,
      quickPrompts: [...DEFAULT_SUPPORT_DESK_WIDGET_CONFIG.appearance.quickPrompts],
    },
    intake: {
      required: DEFAULT_SUPPORT_DESK_WIDGET_CONFIG.intake.required,
      fields: [],
    },
  };
}

function cloneDefaultSlaPolicy(): SupportDeskSlaPolicy {
  return {
    ...DEFAULT_SUPPORT_DESK_SLA_POLICY,
    targets: {
      urgent: { ...DEFAULT_SUPPORT_DESK_SLA_POLICY.targets.urgent },
      high: { ...DEFAULT_SUPPORT_DESK_SLA_POLICY.targets.high },
      medium: { ...DEFAULT_SUPPORT_DESK_SLA_POLICY.targets.medium },
      low: { ...DEFAULT_SUPPORT_DESK_SLA_POLICY.targets.low },
    },
    routingRules: [],
  };
}

// ---------------------------------------------------------------------------
// Widget Config (x_support_desk_widget_configs)
// ---------------------------------------------------------------------------

export function getSupportDeskWidgetConfig(tenantId: number): SupportDeskWidgetConfig {
  return withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, tenantId);

    const row = db
      .prepare(
        `SELECT version, payload_encrypted, payload_iv, payload_auth_tag, updated_at
           FROM x_support_desk_widget_configs
          WHERE tenant_id = ?`,
      )
      .get(tenantId) as
      | {
          version: number;
          payload_encrypted: string;
          payload_iv: string;
          payload_auth_tag: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return cloneDefaultWidgetConfig();
    }

    const parsed = decryptJson<SupportDeskWidgetConfig>(
      row.payload_encrypted,
      row.payload_iv,
      row.payload_auth_tag,
    );
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.enabled !== 'boolean' ||
      !parsed.appearance ||
      !parsed.intake
    ) {
      throw new SupportDeskError(
        503,
        'service_desk_storage_unavailable',
        'Stored widget config payload is invalid.',
      );
    }

    return {
      ...parsed,
      version: row.version,
      updatedAt: row.updated_at,
    };
  });
}

export function updateSupportDeskWidgetConfig(
  tenantId: number,
  patch: unknown,
  expectedVersion: number,
): SupportDeskWidgetConfig {
  return withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, tenantId);
    const expected = assertPositiveInt(expectedVersion, 'expectedVersion');

    return db.transaction(() => {
      const current = getSupportDeskWidgetConfig(tenantId);
      if (current.version !== expected) {
        throw new SupportDeskError(
          409,
          'version_conflict',
          `Widget config version conflict: expected ${expected}, current ${current.version}.`,
        );
      }

      const nowIso = new Date().toISOString();
      const next = validateWidgetConfigPatch(current, patch, nowIso);
      const enc = encryptJson(next);

      db.prepare(
        `INSERT INTO x_support_desk_widget_configs
           (tenant_id, version, payload_encrypted, payload_iv, payload_auth_tag, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           version = excluded.version,
           payload_encrypted = excluded.payload_encrypted,
           payload_iv = excluded.payload_iv,
           payload_auth_tag = excluded.payload_auth_tag,
           updated_at = excluded.updated_at`,
      ).run(tenantId, next.version, enc.encrypted, enc.iv, enc.authTag, next.updatedAt);

      return next;
    })();
  });
}

// ---------------------------------------------------------------------------
// Scoped Intake Receipts (x_support_desk_intakes)
// ---------------------------------------------------------------------------

interface EncryptedIntakeEnvelope {
  receiptId: string;
  stored: SupportDeskStoredIntake;
}

function hashReceiptId(receiptId: string): string {
  return crypto.createHash('sha256').update(receiptId).digest('hex');
}

function canonicalIntakeFingerprint(
  configVersion: number,
  schemaHash: string,
  conversationId: string | null,
  values: Record<string, string | number>,
): string {
  const sortedKeys = Object.keys(values).sort();
  const canonicalValues: Record<string, string | number> = {};
  for (const k of sortedKeys) {
    canonicalValues[k] = values[k];
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ configVersion, schemaHash, conversationId, values: canonicalValues }))
    .digest('hex');
}

export function saveSupportDeskIntake(params: {
  tenantId: number;
  userId: string;
  role: SupportEvidenceRole;
  input: SupportDeskIntakeInput;
  schemaHash: string;
  validatedValues: Record<string, string | number>;
  now?: number;
}): SupportDeskIntakeReceipt {
  return withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, params.tenantId);

    if (typeof params.userId !== 'string' || params.userId.trim().length === 0 || params.userId.length > 128) {
      throw new SupportDeskError(400, 'invalid_input', 'userId must be a non-empty string.');
    }
    if (!(SUPPORT_EVIDENCE_ROLES as readonly string[]).includes(params.role)) {
      throw new SupportDeskError(400, 'invalid_input', 'Invalid support role.');
    }
    const requestId = assertSafeId(params.input.requestId, 'requestId', 100);
    assertPositiveInt(params.input.configVersion, 'configVersion');
    const conversationId =
      params.input.conversationId !== undefined
        ? assertSafeId(params.input.conversationId, 'conversationId', 128)
        : null;

    const nowMs = params.now ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const oneHourAgoIso = new Date(nowMs - 3600_000).toISOString();
    const fingerprint = canonicalIntakeFingerprint(
      params.input.configVersion,
      params.schemaHash,
      conversationId,
      params.validatedValues,
    );

    return db.transaction(() => {
      // Purge expired unbound receipts for THIS tenant only (never inside read).
      db.prepare(
        `DELETE FROM x_support_desk_intakes
          WHERE tenant_id = ? AND conversation_id IS NULL AND expires_at <= ? AND created_at <= ?`,
      ).run(params.tenantId, nowIso, oneHourAgoIso);

      const existing = db
        .prepare(
          `SELECT receipt_hash, fingerprint, schema_hash, expires_at, payload_encrypted, payload_iv, payload_auth_tag
             FROM x_support_desk_intakes
            WHERE tenant_id = ? AND user_id = ? AND role = ? AND request_id = ?`,
        )
        .get(params.tenantId, params.userId, params.role, requestId) as
        | {
            receipt_hash: string;
            fingerprint: string;
            schema_hash: string;
            expires_at: string;
            payload_encrypted: string;
            payload_iv: string;
            payload_auth_tag: string;
          }
        | undefined;

      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new SupportDeskError(
            409,
            'request_conflict',
            'Intake requestId already used with different payload.',
          );
        }
        if (existing.expires_at <= nowIso) {
          throw new SupportDeskError(410, 'intake_expired', 'Intake receipt has expired.');
        }
        const env = decryptJson<EncryptedIntakeEnvelope>(
          existing.payload_encrypted,
          existing.payload_iv,
          existing.payload_auth_tag,
        );
        return {
          intakeReceiptId: env.receiptId,
          expiresAt: existing.expires_at,
          schemaHash: existing.schema_hash,
          replayed: true,
        };
      }

      const hourlyRow = db
        .prepare(
          `SELECT COUNT(*) AS cnt
             FROM x_support_desk_intakes
            WHERE tenant_id = ? AND user_id = ? AND created_at > ?`,
        )
        .get(params.tenantId, params.userId, oneHourAgoIso) as { cnt: number };

      if (hourlyRow.cnt >= SUPPORT_DESK_INTAKE_MAX_PER_HOUR) {
        throw new SupportDeskError(
          429,
          'intake_rate_limited',
          'Hourly intake submission limit exceeded.',
          60,
        );
      }

      const liveRow = db
        .prepare(
          `SELECT COUNT(*) AS cnt
             FROM x_support_desk_intakes
            WHERE tenant_id = ? AND user_id = ? AND expires_at > ?`,
        )
        .get(params.tenantId, params.userId, nowIso) as { cnt: number };

      if (liveRow.cnt >= SUPPORT_DESK_INTAKE_MAX_LIVE_RECEIPTS) {
        throw new SupportDeskError(
          429,
          'intake_rate_limited',
          'Active intake receipt limit exceeded.',
          60,
        );
      }

      const receiptId = `rcpt_${crypto.randomBytes(24).toString('base64url')}`;
      const receiptHash = hashReceiptId(receiptId);
      const expiresAt = new Date(nowMs + SUPPORT_DESK_LIMITS.intakeTtlSeconds * 1000).toISOString();

      const stored: SupportDeskStoredIntake = {
        receiptHash,
        tenantId: params.tenantId,
        userId: params.userId,
        role: params.role,
        requestId,
        schemaHash: params.schemaHash,
        conversationId,
        expiresAt,
        createdAt: nowIso,
        values: { ...params.validatedValues },
      };

      const enc = encryptJson({ receiptId, stored } satisfies EncryptedIntakeEnvelope);
      db.prepare(
        `INSERT INTO x_support_desk_intakes
           (receipt_hash, tenant_id, user_id, role, request_id, fingerprint, schema_hash, conversation_id,
            expires_at, payload_encrypted, payload_iv, payload_auth_tag, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        receiptHash,
        params.tenantId,
        params.userId,
        params.role,
        requestId,
        fingerprint,
        params.schemaHash,
        conversationId,
        expiresAt,
        enc.encrypted,
        enc.iv,
        enc.authTag,
        nowIso,
      );

      return {
        intakeReceiptId: receiptId,
        expiresAt,
        schemaHash: params.schemaHash,
        replayed: false,
      };
    })();
  });
}

export function readSupportDeskIntake(params: {
  tenantId: number;
  userId: string;
  role: SupportEvidenceRole;
  receiptId: string;
  now?: number;
}): SupportDeskStoredIntake {
  return withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, params.tenantId);

    if (typeof params.receiptId !== 'string' || params.receiptId.length === 0 || params.receiptId.length > 256) {
      throw new SupportDeskError(404, 'intake_not_found', 'Intake receipt not found.');
    }

    const receiptHash = hashReceiptId(params.receiptId);
    const row = db
      .prepare(
        `SELECT expires_at, payload_encrypted, payload_iv, payload_auth_tag
           FROM x_support_desk_intakes
          WHERE receipt_hash = ? AND tenant_id = ? AND user_id = ? AND role = ?`,
      )
      .get(receiptHash, params.tenantId, params.userId, params.role) as
      | {
          expires_at: string;
          payload_encrypted: string;
          payload_iv: string;
          payload_auth_tag: string;
        }
      | undefined;

    if (!row) {
      throw new SupportDeskError(404, 'intake_not_found', 'Intake receipt not found.');
    }

    const env = decryptJson<EncryptedIntakeEnvelope>(
      row.payload_encrypted,
      row.payload_iv,
      row.payload_auth_tag,
    );

    const nowIso = new Date(params.now ?? Date.now()).toISOString();
    if (row.expires_at <= nowIso) {
      throw new SupportDeskError(410, 'intake_expired', 'Intake receipt has expired.');
    }

    return env.stored;
  });
}

export function bindSupportDeskIntake(params: {
  tenantId: number;
  userId: string;
  role: SupportEvidenceRole;
  receiptId: string;
  conversationId: string;
  schemaHash: string;
  now?: number;
}): void {
  withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, params.tenantId);
    const conversationId = assertSafeId(params.conversationId, 'conversationId', 128);

    if (typeof params.receiptId !== 'string' || params.receiptId.length === 0 || params.receiptId.length > 256) {
      throw new SupportDeskError(404, 'intake_not_found', 'Intake receipt not found.');
    }

    const receiptHash = hashReceiptId(params.receiptId);
    const row = db
      .prepare(
        `SELECT schema_hash, conversation_id, expires_at, payload_encrypted, payload_iv, payload_auth_tag
           FROM x_support_desk_intakes
          WHERE receipt_hash = ? AND tenant_id = ? AND user_id = ? AND role = ?`,
      )
      .get(receiptHash, params.tenantId, params.userId, params.role) as
      | {
          schema_hash: string;
          conversation_id: string | null;
          expires_at: string;
          payload_encrypted: string;
          payload_iv: string;
          payload_auth_tag: string;
        }
      | undefined;

    if (!row) {
      throw new SupportDeskError(404, 'intake_not_found', 'Intake receipt not found.');
    }
    if (row.schema_hash !== params.schemaHash) {
      throw new SupportDeskError(409, 'intake_schema_changed', 'Intake schema has changed.');
    }

    if (row.conversation_id !== null) {
      if (row.conversation_id === conversationId) {
        return; // Idempotent for same conversation
      }
      throw new SupportDeskError(
        409,
        'intake_already_bound',
        'Intake receipt is already bound to another conversation.',
      );
    }

    const nowIso = new Date(params.now ?? Date.now()).toISOString();
    if (row.expires_at <= nowIso) {
      throw new SupportDeskError(410, 'intake_expired', 'Intake receipt has expired.');
    }

    const env = decryptJson<EncryptedIntakeEnvelope>(
      row.payload_encrypted,
      row.payload_iv,
      row.payload_auth_tag,
    );
    const updatedEnv: EncryptedIntakeEnvelope = {
      receiptId: env.receiptId,
      stored: {
        ...env.stored,
        conversationId,
      },
    };
    const enc = encryptJson(updatedEnv);

    const res = db
      .prepare(
        `UPDATE x_support_desk_intakes
            SET conversation_id = ?, payload_encrypted = ?, payload_iv = ?, payload_auth_tag = ?
          WHERE receipt_hash = ? AND tenant_id = ? AND user_id = ? AND role = ? AND conversation_id IS NULL`,
      )
      .run(
        conversationId,
        enc.encrypted,
        enc.iv,
        enc.authTag,
        receiptHash,
        params.tenantId,
        params.userId,
        params.role,
      );

    if (res.changes === 0) {
      const recheck = db
        .prepare(
          `SELECT conversation_id FROM x_support_desk_intakes
            WHERE receipt_hash = ? AND tenant_id = ? AND user_id = ? AND role = ?`,
        )
        .get(receiptHash, params.tenantId, params.userId, params.role) as
        | { conversation_id: string | null }
        | undefined;
      if (recheck?.conversation_id === conversationId) {
        return;
      }
      throw new SupportDeskError(
        409,
        'intake_already_bound',
        'Intake receipt is already bound to another conversation.',
      );
    }
  });
}

export function readSupportDeskBoundIntake(params: {
  tenantId: number;
  conversationId: string;
  userId: string;
}): SupportDeskStoredIntake | null {
  return withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, params.tenantId);

    const row = db
      .prepare(
        `SELECT payload_encrypted, payload_iv, payload_auth_tag
           FROM x_support_desk_intakes
          WHERE tenant_id = ? AND conversation_id = ? AND user_id = ?
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get(params.tenantId, params.conversationId, params.userId) as
      | {
          payload_encrypted: string;
          payload_iv: string;
          payload_auth_tag: string;
        }
      | undefined;

    if (!row) return null;

    const env = decryptJson<EncryptedIntakeEnvelope>(
      row.payload_encrypted,
      row.payload_iv,
      row.payload_auth_tag,
    );
    return env.stored;
  });
}

// ---------------------------------------------------------------------------
// Copilot Jobs, Claims, Lease Fencing & Budget (x_support_desk_copilot_jobs)
// ---------------------------------------------------------------------------

interface CopilotAttemptRecord {
  attemptId: string;
  estimatedTokens: number;
  actualTokens: number | null;
  settled: boolean;
}

interface StoredCopilotJobPayload {
  leaseToken: string | null;
  attempts: CopilotAttemptRecord[];
  result?: SupportDeskCopilotResult;
  errorCode?: string;
}

function getUtcHourWindow(nowMs: number): { startIso: string; endIso: string; retryAfterSeconds: number } {
  const hourStartMs = Math.floor(nowMs / 3_600_000) * 3_600_000;
  const hourEndMs = hourStartMs + 3_600_000;
  return {
    startIso: new Date(hourStartMs).toISOString(),
    endIso: new Date(hourEndMs).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((hourEndMs - nowMs) / 1000)),
  };
}

function getUtcDayWindow(nowMs: number): { startIso: string; endIso: string; retryAfterSeconds: number } {
  const d = new Date(nowMs);
  const dayStartMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dayEndMs = dayStartMs + 86_400_000;
  return {
    startIso: new Date(dayStartMs).toISOString(),
    endIso: new Date(dayEndMs).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((dayEndMs - nowMs) / 1000)),
  };
}

function getDailyUsedTokens(db: Db, tenantId: number, actorId: number, dayStartIso: string, dayEndIso: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(
         CASE
           WHEN state = 'running' THEN MAX(spent_tokens, reserved_tokens)
           ELSE spent_tokens
         END
       ), 0) AS total
         FROM x_support_desk_copilot_jobs
        WHERE tenant_id = ? AND actor_id = ? AND created_at >= ? AND created_at < ?`,
    )
    .get(tenantId, actorId, dayStartIso, dayEndIso) as { total: number };
  return row.total;
}

export function claimSupportDeskCopilot(params: {
  tenantId: number;
  actorId: number;
  requestId: string;
  fingerprint: string;
  conversationId: string;
  now?: number;
}):
  | { status: 'claimed'; jobId: string; leaseToken: string }
  | { status: 'replayed'; result: SupportDeskCopilotResult }
  | { status: 'running'; retryAfterSeconds: number } {
  return withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, params.tenantId);
    assertPositiveInt(params.actorId, 'actorId');
    const requestId = assertSafeId(params.requestId, 'requestId', 100);
    const conversationId = assertSafeId(params.conversationId, 'conversationId', 128);
    if (typeof params.fingerprint !== 'string' || params.fingerprint.length === 0) {
      throw new SupportDeskError(400, 'invalid_input', 'fingerprint is required.');
    }

    const nowMs = params.now ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const hourWin = getUtcHourWindow(nowMs);
    const dayWin = getUtcDayWindow(nowMs);

    const outcome = db.transaction(() => {
      const existing = db
        .prepare(
          `SELECT id, fingerprint, state, lease_until, dispatched_calls, reserved_tokens, spent_tokens,
                  payload_encrypted, payload_iv, payload_auth_tag, created_at
             FROM x_support_desk_copilot_jobs
            WHERE tenant_id = ? AND actor_id = ? AND request_id = ?`,
        )
        .get(params.tenantId, params.actorId, requestId) as
        | {
            id: string;
            fingerprint: string;
            state: 'running' | 'completed' | 'abstained' | 'failed';
            lease_until: string;
            dispatched_calls: number;
            reserved_tokens: number;
            spent_tokens: number;
            payload_encrypted: string;
            payload_iv: string;
            payload_auth_tag: string;
            created_at: string;
          }
        | undefined;

      if (existing) {
        const payload = decryptJson<StoredCopilotJobPayload>(
          existing.payload_encrypted,
          existing.payload_iv,
          existing.payload_auth_tag,
        );

        if (existing.fingerprint !== params.fingerprint) {
          throw new SupportDeskError(
            409,
            'request_conflict',
            'Copilot requestId already used with different parameters.',
          );
        }

        const jobExpiresMs = Date.parse(existing.created_at) + SUPPORT_DESK_LIMITS.copilotJobTtlSeconds * 1000;

        if (existing.state === 'completed' || existing.state === 'abstained') {
          if (jobExpiresMs <= nowMs) {
            throw new SupportDeskError(410, 'job_expired', 'Copilot job has expired.');
          }
          if (!payload.result) {
            throw new SupportDeskError(
              503,
              'service_desk_storage_unavailable',
              'Completed Copilot job is missing stored result.',
            );
          }
          return {
            status: 'replayed' as const,
            result: { ...payload.result, replayed: true },
          };
        }

        if (existing.state === 'running') {
          const leaseUntilMs = Date.parse(existing.lease_until);
          if (leaseUntilMs > nowMs) {
            return {
              status: 'running' as const,
              retryAfterSeconds: Math.max(1, Math.ceil((leaseUntilMs - nowMs) / 1000)),
            };
          }

          // Lease expired: if dispatch was recorded, settle conservatively and fail.
          if (existing.dispatched_calls > 0) {
            const settledAttempts = payload.attempts.map((a) => ({
              ...a,
              settled: true,
              actualTokens: a.actualTokens ?? a.estimatedTokens,
            }));
            const conservativeSpent = Math.max(
              existing.spent_tokens,
              settledAttempts.reduce((acc, a) => acc + (a.actualTokens ?? a.estimatedTokens), 0),
              existing.reserved_tokens,
            );
            const updatedPayload: StoredCopilotJobPayload = {
              leaseToken: null,
              attempts: settledAttempts,
              errorCode: 'copilot_timeout',
            };
            const enc = encryptJson(updatedPayload);
            db.prepare(
              `UPDATE x_support_desk_copilot_jobs
                  SET state = 'failed', spent_tokens = ?, reserved_tokens = ?,
                      payload_encrypted = ?, payload_iv = ?, payload_auth_tag = ?, updated_at = ?
                WHERE id = ?`,
            ).run(
              conservativeSpent,
              conservativeSpent,
              enc.encrypted,
              enc.iv,
              enc.authTag,
              nowIso,
              existing.id,
            );
            return { status: 'expired' as const };
          }

          // Lease expired before any dispatch: reclaim with fresh leaseToken
          const newLeaseToken = crypto.randomBytes(24).toString('base64url');
          const newLeaseUntil = new Date(nowMs + SUPPORT_DESK_LIMITS.copilotDeadlineMs + 5000).toISOString();
          const reclaimedPayload: StoredCopilotJobPayload = {
            ...payload,
            leaseToken: newLeaseToken,
          };
          const enc = encryptJson(reclaimedPayload);
          db.prepare(
            `UPDATE x_support_desk_copilot_jobs
                SET lease_until = ?, payload_encrypted = ?, payload_iv = ?, payload_auth_tag = ?, updated_at = ?
              WHERE id = ?`,
          ).run(newLeaseUntil, enc.encrypted, enc.iv, enc.authTag, nowIso, existing.id);

          return {
            status: 'claimed' as const,
            jobId: existing.id,
            leaseToken: newLeaseToken,
          };
        }

        // existing.state === 'failed'
        if (jobExpiresMs <= nowMs) {
          throw new SupportDeskError(410, 'job_expired', 'Copilot job has expired.');
        }
        const errCode = payload.errorCode ?? 'model_unavailable';
        const status = errCode === 'copilot_timeout' ? 504 : 503;
        throw new SupportDeskError(status, errCode, 'Previous Copilot job failed.');
      }

      // Check hourly request cap
      const hourRow = db
        .prepare(
          `SELECT COUNT(*) AS cnt
             FROM x_support_desk_copilot_jobs
            WHERE tenant_id = ? AND actor_id = ? AND created_at >= ? AND created_at < ?`,
        )
        .get(params.tenantId, params.actorId, hourWin.startIso, hourWin.endIso) as { cnt: number };

      if (hourRow.cnt >= SUPPORT_DESK_LIMITS.copilotRequestsPerHour) {
        throw new SupportDeskError(
          429,
          'copilot_quota_exceeded',
          'Copilot hourly request limit exceeded.',
          hourWin.retryAfterSeconds,
        );
      }

      // Check daily token cap
      const usedToday = getDailyUsedTokens(db, params.tenantId, params.actorId, dayWin.startIso, dayWin.endIso);
      if (usedToday >= SUPPORT_DESK_LIMITS.copilotTokensPerDay) {
        throw new SupportDeskError(
          429,
          'copilot_quota_exceeded',
          'Copilot daily token limit exceeded.',
          dayWin.retryAfterSeconds,
        );
      }

      const jobId = `cpj_${crypto.randomUUID()}`;
      const leaseToken = crypto.randomBytes(24).toString('base64url');
      const leaseUntil = new Date(nowMs + SUPPORT_DESK_LIMITS.copilotDeadlineMs + 5000).toISOString();
      const payload: StoredCopilotJobPayload = {
        leaseToken,
        attempts: [],
      };
      const enc = encryptJson(payload);

      db.prepare(
        `INSERT INTO x_support_desk_copilot_jobs
           (id, tenant_id, actor_id, request_id, fingerprint, conversation_id, state, lease_until,
            dispatched_calls, reserved_tokens, spent_tokens, payload_encrypted, payload_iv, payload_auth_tag,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, 0, 0, 0, ?, ?, ?, ?, ?)`,
      ).run(
        jobId,
        params.tenantId,
        params.actorId,
        requestId,
        params.fingerprint,
        conversationId,
        leaseUntil,
        enc.encrypted,
        enc.iv,
        enc.authTag,
        nowIso,
        nowIso,
      );

      return {
        status: 'claimed' as const,
        jobId,
        leaseToken,
      };
    })();
    if (outcome.status === 'expired') {
      throw new SupportDeskError(504, 'copilot_timeout', 'Copilot job lease expired after model dispatch.');
    }
    return outcome;
  });
}

export function reserveSupportDeskCopilotAttempt(params: {
  tenantId: number;
  actorId: number;
  jobId: string;
  leaseToken: string;
  estimatedTokens: number;
  now?: number;
}): { attemptId: string } {
  return withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, params.tenantId);
    assertPositiveInt(params.actorId, 'actorId');
    if (
      typeof params.estimatedTokens !== 'number' ||
      !Number.isFinite(params.estimatedTokens) ||
      !Number.isInteger(params.estimatedTokens) ||
      params.estimatedTokens < 0
    ) {
      throw new SupportDeskError(400, 'invalid_input', 'estimatedTokens must be a non-negative integer.');
    }

    const nowMs = params.now ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const dayWin = getUtcDayWindow(nowMs);

    return db.transaction(() => {
      const row = db
        .prepare(
          `SELECT id, state, lease_until, dispatched_calls, reserved_tokens,
                  payload_encrypted, payload_iv, payload_auth_tag
             FROM x_support_desk_copilot_jobs
            WHERE id = ? AND tenant_id = ? AND actor_id = ?`,
        )
        .get(params.jobId, params.tenantId, params.actorId) as
        | {
            id: string;
            state: string;
            lease_until: string;
            dispatched_calls: number;
            reserved_tokens: number;
            payload_encrypted: string;
            payload_iv: string;
            payload_auth_tag: string;
          }
        | undefined;

      if (!row) {
        throw new SupportDeskError(404, 'job_not_found', 'Copilot job not found.');
      }

      const payload = decryptJson<StoredCopilotJobPayload>(
        row.payload_encrypted,
        row.payload_iv,
        row.payload_auth_tag,
      );

      if (row.state !== 'running' || !payload.leaseToken || payload.leaseToken !== params.leaseToken) {
        throw new SupportDeskError(409, 'copilot_in_progress', 'Invalid or fenced Copilot lease token.');
      }
      if (Date.parse(row.lease_until) <= nowMs) {
        throw new SupportDeskError(504, 'copilot_timeout', 'Copilot job lease has expired.');
      }
      if (row.dispatched_calls >= SUPPORT_DESK_LIMITS.copilotMaxModelCalls) {
        throw new SupportDeskError(
          429,
          'copilot_quota_exceeded',
          'Maximum Copilot model calls per job exceeded.',
        );
      }

      const usedToday = getDailyUsedTokens(db, params.tenantId, params.actorId, dayWin.startIso, dayWin.endIso);
      if (usedToday + params.estimatedTokens > SUPPORT_DESK_LIMITS.copilotTokensPerDay) {
        throw new SupportDeskError(
          429,
          'copilot_quota_exceeded',
          'Copilot daily token budget exceeded.',
          dayWin.retryAfterSeconds,
        );
      }

      const attemptId = `att_${crypto.randomUUID()}`;
      payload.attempts.push({
        attemptId,
        estimatedTokens: params.estimatedTokens,
        actualTokens: null,
        settled: false,
      });

      const nextReserved = payload.attempts.reduce(
        (acc, a) => acc + (a.settled ? (a.actualTokens ?? a.estimatedTokens) : a.estimatedTokens),
        0,
      );

      const enc = encryptJson(payload);
      db.prepare(
        `UPDATE x_support_desk_copilot_jobs
            SET dispatched_calls = dispatched_calls + 1,
                reserved_tokens = ?,
                payload_encrypted = ?,
                payload_iv = ?,
                payload_auth_tag = ?,
                updated_at = ?
          WHERE id = ?`,
      ).run(nextReserved, enc.encrypted, enc.iv, enc.authTag, nowIso, row.id);

      return { attemptId };
    })();
  });
}

export function recordSupportDeskCopilotUsage(params: {
  tenantId: number;
  actorId: number;
  jobId: string;
  leaseToken: string;
  attemptId: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  now?: number;
}): void {
  withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, params.tenantId);
    assertPositiveInt(params.actorId, 'actorId');

    const nowIso = new Date(params.now ?? Date.now()).toISOString();

    db.transaction(() => {
      const row = db
        .prepare(
          `SELECT id, state, lease_until, payload_encrypted, payload_iv, payload_auth_tag
             FROM x_support_desk_copilot_jobs
            WHERE id = ? AND tenant_id = ? AND actor_id = ?`,
        )
        .get(params.jobId, params.tenantId, params.actorId) as
        | {
            id: string;
            state: string;
            lease_until: string;
            payload_encrypted: string;
            payload_iv: string;
            payload_auth_tag: string;
          }
        | undefined;

      if (!row) {
        throw new SupportDeskError(404, 'job_not_found', 'Copilot job not found.');
      }

      if (Date.parse(row.lease_until) <= Date.parse(nowIso)) {
        throw new SupportDeskError(504, 'copilot_timeout', 'Copilot job lease has expired.');
      }

      const payload = decryptJson<StoredCopilotJobPayload>(
        row.payload_encrypted,
        row.payload_iv,
        row.payload_auth_tag,
      );

      if (row.state !== 'running' || !payload.leaseToken || payload.leaseToken !== params.leaseToken) {
        throw new SupportDeskError(409, 'copilot_in_progress', 'Invalid or fenced Copilot lease token.');
      }

      const attempt = payload.attempts.find((a) => a.attemptId === params.attemptId);
      if (!attempt) {
        throw new SupportDeskError(400, 'invalid_input', 'Unknown Copilot attemptId.');
      }

      if (attempt.settled) {
        return; // Idempotent by attemptId
      }

      let actualTokens = attempt.estimatedTokens;
      if (params.usage) {
        const computed =
          params.usage.totalTokens ??
          (params.usage.promptTokens ?? 0) + (params.usage.completionTokens ?? 0);
        if (typeof computed === 'number' && Number.isFinite(computed) && computed >= 0) {
          actualTokens = Math.floor(computed);
        }
      }

      attempt.settled = true;
      attempt.actualTokens = actualTokens;

      const spentTokens = payload.attempts.reduce(
        (acc, a) => acc + (a.settled ? (a.actualTokens ?? 0) : 0),
        0,
      );
      const reservedTokens = payload.attempts.reduce(
        (acc, a) => acc + (a.settled ? (a.actualTokens ?? a.estimatedTokens) : a.estimatedTokens),
        0,
      );

      const enc = encryptJson(payload);
      db.prepare(
        `UPDATE x_support_desk_copilot_jobs
            SET spent_tokens = ?, reserved_tokens = ?,
                payload_encrypted = ?, payload_iv = ?, payload_auth_tag = ?, updated_at = ?
          WHERE id = ?`,
      ).run(spentTokens, reservedTokens, enc.encrypted, enc.iv, enc.authTag, nowIso, row.id);
    })();
  });
}

export function finishSupportDeskCopilot(params: {
  tenantId: number;
  actorId: number;
  jobId: string;
  leaseToken: string;
  result: SupportDeskCopilotResult;
  now?: number;
}): void {
  withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, params.tenantId);
    assertPositiveInt(params.actorId, 'actorId');

    const nowIso = new Date(params.now ?? Date.now()).toISOString();

    db.transaction(() => {
      const row = db
        .prepare(
          `SELECT id, state, lease_until, payload_encrypted, payload_iv, payload_auth_tag
             FROM x_support_desk_copilot_jobs
            WHERE id = ? AND tenant_id = ? AND actor_id = ?`,
        )
        .get(params.jobId, params.tenantId, params.actorId) as
        | {
            id: string;
            state: string;
            lease_until: string;
            payload_encrypted: string;
            payload_iv: string;
            payload_auth_tag: string;
          }
        | undefined;

      if (!row) {
        throw new SupportDeskError(404, 'job_not_found', 'Copilot job not found.');
      }

      if (Date.parse(row.lease_until) <= Date.parse(nowIso)) {
        throw new SupportDeskError(504, 'copilot_timeout', 'Copilot job lease has expired.');
      }

      const payload = decryptJson<StoredCopilotJobPayload>(
        row.payload_encrypted,
        row.payload_iv,
        row.payload_auth_tag,
      );

      if (row.state !== 'running' || !payload.leaseToken || payload.leaseToken !== params.leaseToken) {
        throw new SupportDeskError(409, 'copilot_in_progress', 'Invalid or fenced Copilot lease token.');
      }

      for (const a of payload.attempts) {
        if (!a.settled) {
          a.settled = true;
          a.actualTokens = a.estimatedTokens;
        }
      }

      const finalSpent = payload.attempts.reduce(
        (acc, a) => acc + (a.actualTokens ?? a.estimatedTokens),
        0,
      );

      const nextState = params.result.status === 'abstained' ? 'abstained' : 'completed';
      const updatedPayload: StoredCopilotJobPayload = {
        leaseToken: null,
        attempts: payload.attempts,
        result: { ...params.result, replayed: false },
      };

      const enc = encryptJson(updatedPayload);
      db.prepare(
        `UPDATE x_support_desk_copilot_jobs
            SET state = ?, lease_until = ?, spent_tokens = ?, reserved_tokens = ?,
                payload_encrypted = ?, payload_iv = ?, payload_auth_tag = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        nextState,
        nowIso,
        finalSpent,
        finalSpent,
        enc.encrypted,
        enc.iv,
        enc.authTag,
        nowIso,
        row.id,
      );
    })();
  });
}

export function failSupportDeskCopilot(params: {
  tenantId: number;
  actorId: number;
  jobId: string;
  leaseToken: string;
  code: string;
  now?: number;
}): void {
  withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, params.tenantId);
    assertPositiveInt(params.actorId, 'actorId');

    const nowIso = new Date(params.now ?? Date.now()).toISOString();

    db.transaction(() => {
      const row = db
        .prepare(
          `SELECT id, state, payload_encrypted, payload_iv, payload_auth_tag
             FROM x_support_desk_copilot_jobs
            WHERE id = ? AND tenant_id = ? AND actor_id = ?`,
        )
        .get(params.jobId, params.tenantId, params.actorId) as
        | {
            id: string;
            state: string;
            payload_encrypted: string;
            payload_iv: string;
            payload_auth_tag: string;
          }
        | undefined;

      if (!row) {
        throw new SupportDeskError(404, 'job_not_found', 'Copilot job not found.');
      }

      const payload = decryptJson<StoredCopilotJobPayload>(
        row.payload_encrypted,
        row.payload_iv,
        row.payload_auth_tag,
      );

      if (row.state !== 'running' || !payload.leaseToken || payload.leaseToken !== params.leaseToken) {
        throw new SupportDeskError(409, 'copilot_in_progress', 'Invalid or fenced Copilot lease token.');
      }

      for (const a of payload.attempts) {
        if (!a.settled) {
          a.settled = true;
          a.actualTokens = a.estimatedTokens;
        }
      }

      const finalSpent = payload.attempts.reduce(
        (acc, a) => acc + (a.actualTokens ?? a.estimatedTokens),
        0,
      );

      const updatedPayload: StoredCopilotJobPayload = {
        leaseToken: null,
        attempts: payload.attempts,
        errorCode: params.code,
      };

      const enc = encryptJson(updatedPayload);
      db.prepare(
        `UPDATE x_support_desk_copilot_jobs
            SET state = 'failed', lease_until = ?, spent_tokens = ?, reserved_tokens = ?,
                payload_encrypted = ?, payload_iv = ?, payload_auth_tag = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        nowIso,
        finalSpent,
        finalSpent,
        enc.encrypted,
        enc.iv,
        enc.authTag,
        nowIso,
        row.id,
      );
    })();
  });
}

export function getSupportDeskCopilotJob(params: {
  tenantId: number;
  actorId: number;
  jobId: string;
  now?: number;
}): SupportDeskCopilotResult {
  return withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, params.tenantId);
    assertPositiveInt(params.actorId, 'actorId');

    const row = db
      .prepare(
        `SELECT state, lease_until, payload_encrypted, payload_iv, payload_auth_tag, created_at
           FROM x_support_desk_copilot_jobs
          WHERE id = ? AND tenant_id = ? AND actor_id = ?`,
      )
      .get(params.jobId, params.tenantId, params.actorId) as
      | {
          state: 'running' | 'completed' | 'abstained' | 'failed';
          lease_until: string;
          payload_encrypted: string;
          payload_iv: string;
          payload_auth_tag: string;
          created_at: string;
        }
      | undefined;

    if (!row) {
      throw new SupportDeskError(404, 'job_not_found', 'Copilot job not found.');
    }

    const payload = decryptJson<StoredCopilotJobPayload>(
      row.payload_encrypted,
      row.payload_iv,
      row.payload_auth_tag,
    );

    const nowMs = params.now ?? Date.now();
    const jobExpiresMs = Date.parse(row.created_at) + SUPPORT_DESK_LIMITS.copilotJobTtlSeconds * 1000;

    if (row.state === 'running') {
      const leaseUntilMs = Date.parse(row.lease_until);
      if (leaseUntilMs > nowMs) {
        throw new SupportDeskError(
          409,
          'copilot_in_progress',
          'Copilot job is still running.',
          Math.max(1, Math.ceil((leaseUntilMs - nowMs) / 1000)),
        );
      }
      throw new SupportDeskError(504, 'copilot_timeout', 'Copilot job lease expired.');
    }

    if (jobExpiresMs <= nowMs) {
      throw new SupportDeskError(410, 'job_expired', 'Copilot job has expired.');
    }

    if (row.state === 'failed') {
      const errCode = payload.errorCode ?? 'model_unavailable';
      const status = errCode === 'copilot_timeout' ? 504 : 503;
      throw new SupportDeskError(status, errCode, 'Copilot job failed.');
    }

    if (!payload.result) {
      throw new SupportDeskError(
        503,
        'service_desk_storage_unavailable',
        'Copilot job result is missing.',
      );
    }

    return payload.result;
  });
}

// ---------------------------------------------------------------------------
// SLA Policy (x_support_desk_sla_policies)
// ---------------------------------------------------------------------------

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function validateSlaTarget(raw: unknown, priority: string): SupportDeskSlaTarget {
  if (!isPlainObject(raw)) {
    throw new SupportDeskError(400, 'invalid_input', `targets.${priority} must be an object.`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'firstResponseMinutes' && key !== 'resolutionMinutes') {
      throw new SupportDeskError(400, 'invalid_input', `Unsupported field "${key}" in targets.${priority}.`);
    }
  }
  const first = raw.firstResponseMinutes;
  const res = raw.resolutionMinutes;
  if (
    typeof first !== 'number' ||
    !Number.isInteger(first) ||
    first < 1 ||
    first > SUPPORT_DESK_LIMITS.maxSlaMinutes
  ) {
    throw new SupportDeskError(
      400,
      'invalid_input',
      `targets.${priority}.firstResponseMinutes must be integer 1..${SUPPORT_DESK_LIMITS.maxSlaMinutes}.`,
    );
  }
  if (
    typeof res !== 'number' ||
    !Number.isInteger(res) ||
    res < 1 ||
    res > SUPPORT_DESK_LIMITS.maxSlaMinutes
  ) {
    throw new SupportDeskError(
      400,
      'invalid_input',
      `targets.${priority}.resolutionMinutes must be integer 1..${SUPPORT_DESK_LIMITS.maxSlaMinutes}.`,
    );
  }
  if (res < first) {
    throw new SupportDeskError(
      400,
      'invalid_input',
      `targets.${priority}.resolutionMinutes must be >= firstResponseMinutes.`,
    );
  }
  return { firstResponseMinutes: first, resolutionMinutes: res };
}

function validateSlaPolicyPatch(
  current: SupportDeskSlaPolicy,
  patch: unknown,
  updatedAt: string,
): SupportDeskSlaPolicy {
  if (!isPlainObject(patch)) {
    throw new SupportDeskError(400, 'invalid_input', 'SLA policy patch must be a plain object.');
  }
  for (const key of Object.getOwnPropertyNames(patch)) {
    if (key !== 'enabled' && key !== 'targets' && key !== 'routingRules') {
      throw new SupportDeskError(400, 'invalid_input', `Unsupported field "${key}" in SLA policy.`);
    }
  }

  let enabled = current.enabled;
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') {
      throw new SupportDeskError(400, 'invalid_input', 'enabled must be a boolean.');
    }
    enabled = patch.enabled;
  }

  let targets = {
    urgent: { ...current.targets.urgent },
    high: { ...current.targets.high },
    medium: { ...current.targets.medium },
    low: { ...current.targets.low },
  };
  if (patch.targets !== undefined) {
    if (!isPlainObject(patch.targets)) {
      throw new SupportDeskError(400, 'invalid_input', 'targets must be an object.');
    }
    for (const key of Object.getOwnPropertyNames(patch.targets)) {
      if (!(PRIORITIES as readonly string[]).includes(key)) {
        throw new SupportDeskError(400, 'invalid_input', `Unsupported priority "${key}" in targets.`);
      }
    }
    for (const p of PRIORITIES) {
      if (!(p in patch.targets)) {
        throw new SupportDeskError(400, 'invalid_input', `targets.${p} is required when targets is supplied.`);
      }
    }
    targets = {
      urgent: validateSlaTarget(patch.targets.urgent, 'urgent'),
      high: validateSlaTarget(patch.targets.high, 'high'),
      medium: validateSlaTarget(patch.targets.medium, 'medium'),
      low: validateSlaTarget(patch.targets.low, 'low'),
    };
  }

  let routingRules: SupportDeskRoutingRule[] = current.routingRules.map((r) => ({
    ...r,
    keywords: [...r.keywords],
  }));
  if (patch.routingRules !== undefined) {
    if (!Array.isArray(patch.routingRules) || patch.routingRules.length > SUPPORT_DESK_LIMITS.maxRoutingRules) {
      throw new SupportDeskError(
        400,
        'invalid_input',
        `routingRules must be an array of at most ${SUPPORT_DESK_LIMITS.maxRoutingRules} rules.`,
      );
    }
    const seenIds = new Set<string>();
    routingRules = patch.routingRules.map((rawRule, idx) => {
      if (!isPlainObject(rawRule)) {
        throw new SupportDeskError(400, 'invalid_input', `routingRules[${idx}] must be an object.`);
      }
      for (const key of Object.getOwnPropertyNames(rawRule)) {
        if (key !== 'id' && key !== 'department' && key !== 'keywords') {
          throw new SupportDeskError(400, 'invalid_input', `Unsupported field "${key}" in routingRules[${idx}].`);
        }
      }
      const id = assertSafeId(rawRule.id, `routingRules[${idx}].id`, 80);
      if (seenIds.has(id)) {
        throw new SupportDeskError(400, 'invalid_input', `Duplicate routing rule id "${id}".`);
      }
      seenIds.add(id);

      if (
        typeof rawRule.department !== 'string' ||
        !(SUPPORT_DESK_DEPARTMENTS as readonly string[]).includes(rawRule.department)
      ) {
        throw new SupportDeskError(400, 'invalid_input', `routingRules[${idx}].department is invalid.`);
      }

      if (
        !Array.isArray(rawRule.keywords) ||
        rawRule.keywords.length < 1 ||
        rawRule.keywords.length > SUPPORT_DESK_LIMITS.maxKeywordsPerRule
      ) {
        throw new SupportDeskError(
          400,
          'invalid_input',
          `routingRules[${idx}].keywords must contain 1..${SUPPORT_DESK_LIMITS.maxKeywordsPerRule} items.`,
        );
      }
      const keywords = rawRule.keywords.map((kw, kIdx) => {
        if (typeof kw !== 'string') {
          throw new SupportDeskError(
            400,
            'invalid_input',
            `routingRules[${idx}].keywords[${kIdx}] must be a string.`,
          );
        }
        const trimmed = kw.trim().normalize('NFC');
        if (trimmed.length === 0 || trimmed.length > SUPPORT_DESK_LIMITS.maxKeywordChars) {
          throw new SupportDeskError(
            400,
            'invalid_input',
            `routingRules[${idx}].keywords[${kIdx}] must be 1..${SUPPORT_DESK_LIMITS.maxKeywordChars} chars.`,
          );
        }
        return trimmed;
      });

      return {
        id,
        department: rawRule.department as SupportDeskDepartment,
        keywords,
      };
    });
  }

  return {
    version: current.version + 1,
    updatedAt,
    enabled,
    targets,
    routingRules,
  };
}

export function getSupportDeskSlaPolicy(tenantId: number): SupportDeskSlaPolicy {
  return withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, tenantId);

    const row = db
      .prepare(
        `SELECT version, payload_encrypted, payload_iv, payload_auth_tag, updated_at
           FROM x_support_desk_sla_policies
          WHERE tenant_id = ?`,
      )
      .get(tenantId) as
      | {
          version: number;
          payload_encrypted: string;
          payload_iv: string;
          payload_auth_tag: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return cloneDefaultSlaPolicy();
    }

    const parsed = decryptJson<SupportDeskSlaPolicy>(
      row.payload_encrypted,
      row.payload_iv,
      row.payload_auth_tag,
    );
    if (!parsed || typeof parsed !== 'object' || typeof parsed.enabled !== 'boolean' || !parsed.targets) {
      throw new SupportDeskError(
        503,
        'service_desk_storage_unavailable',
        'Stored SLA policy payload is invalid.',
      );
    }

    return {
      ...parsed,
      version: row.version,
      updatedAt: row.updated_at,
    };
  });
}

export function updateSupportDeskSlaPolicy(
  tenantId: number,
  patch: unknown,
  expectedVersion: number,
): SupportDeskSlaPolicy {
  return withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, tenantId);
    const expected = assertPositiveInt(expectedVersion, 'expectedVersion');

    return db.transaction(() => {
      const current = getSupportDeskSlaPolicy(tenantId);
      if (current.version !== expected) {
        throw new SupportDeskError(
          409,
          'version_conflict',
          `SLA policy version conflict: expected ${expected}, current ${current.version}.`,
        );
      }

      const nowIso = new Date().toISOString();
      const next = validateSlaPolicyPatch(current, patch, nowIso);
      const enc = encryptJson(next);

      db.prepare(
        `INSERT INTO x_support_desk_sla_policies
           (tenant_id, version, payload_encrypted, payload_iv, payload_auth_tag, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           version = excluded.version,
           payload_encrypted = excluded.payload_encrypted,
           payload_iv = excluded.payload_iv,
           payload_auth_tag = excluded.payload_auth_tag,
           updated_at = excluded.updated_at`,
      ).run(tenantId, next.version, enc.encrypted, enc.iv, enc.authTag, next.updatedAt);

      return next;
    })();
  });
}

// ---------------------------------------------------------------------------
// Ticket SLA / Routing State (x_support_desk_ticket_state)
// ---------------------------------------------------------------------------

interface StoredTicketMeta {
  policyTargets: SupportDeskTicketState['policyTargets'];
  routingSource: SupportDeskTicketState['routingSource'];
  historicalCycles?: SupportDeskTicketState[];
}

function rowToTicketState(row: {
  tenant_id: number;
  ticket_id: string;
  conversation_id: string | null;
  version: number;
  cycle: number;
  cycle_opened_at: string;
  priority: string;
  department: string;
  policy_version: number;
  first_human_reply_at: string | null;
  resolved_at: string | null;
  tracking: string;
  terminal: number;
  meta_encrypted: string;
  meta_iv: string;
  meta_auth_tag: string;
}): SupportDeskTicketState {
  const meta = decryptJson<StoredTicketMeta>(row.meta_encrypted, row.meta_iv, row.meta_auth_tag);
  if (!meta || !meta.policyTargets || !meta.routingSource) {
    throw new SupportDeskError(
      503,
      'service_desk_storage_unavailable',
      'Stored ticket SLA metadata is invalid.',
    );
  }
  return {
    tenantId: row.tenant_id,
    ticketId: row.ticket_id,
    ...(row.conversation_id !== null ? { conversationId: row.conversation_id } : {}),
    version: row.version,
    cycle: row.cycle,
    cycleOpenedAt: row.cycle_opened_at,
    tracking: row.tracking as 'tracked' | 'paused',
    policyVersion: row.policy_version,
    policyTargets: meta.policyTargets,
    priority: row.priority as SupportTicketPriority,
    department: row.department as SupportDeskDepartment,
    routingSource: meta.routingSource,
    firstHumanReplyAt: row.first_human_reply_at,
    resolvedAt: row.resolved_at,
    terminal: row.terminal === 1,
  };
}

export function getSupportDeskTicketState(
  tenantId: number,
  ticketId: string,
): SupportDeskTicketState | null {
  return withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, tenantId);

    const row = db
      .prepare(
        `SELECT tenant_id, ticket_id, conversation_id, version, cycle, cycle_opened_at,
                priority, department, policy_version, first_human_reply_at, resolved_at,
                tracking, terminal, meta_encrypted, meta_iv, meta_auth_tag
           FROM x_support_desk_ticket_state
          WHERE tenant_id = ? AND ticket_id = ?`,
      )
      .get(tenantId, ticketId) as Parameters<typeof rowToTicketState>[0] | undefined;

    if (!row) return null;
    return rowToTicketState(row);
  });
}

export function insertSupportDeskTicketState(state: SupportDeskTicketState): SupportDeskTicketState {
  return withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, state.tenantId);

    const nowIso = new Date().toISOString();
    const enc = encryptJson({
      policyTargets: state.policyTargets,
      routingSource: state.routingSource,
    } satisfies StoredTicketMeta);

    db.prepare(
      `INSERT INTO x_support_desk_ticket_state
         (tenant_id, ticket_id, conversation_id, version, cycle, cycle_opened_at, priority, department,
          policy_version, first_human_reply_at, resolved_at, tracking, terminal,
          meta_encrypted, meta_iv, meta_auth_tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      state.tenantId,
      state.ticketId,
      state.conversationId ?? null,
      state.version,
      state.cycle,
      state.cycleOpenedAt,
      state.priority,
      state.department,
      state.policyVersion,
      state.firstHumanReplyAt,
      state.resolvedAt,
      state.tracking,
      state.terminal ? 1 : 0,
      enc.encrypted,
      enc.iv,
      enc.authTag,
      nowIso,
      nowIso,
    );

    return { ...state };
  });
}

export function updateSupportDeskTicketState(
  tenantId: number,
  ticketId: string,
  patch: Partial<SupportDeskTicketState>,
  expectedVersion: number,
): SupportDeskTicketState {
  return withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, tenantId);
    const expected = assertPositiveInt(expectedVersion, 'expectedVersion');

    const current = getSupportDeskTicketState(tenantId, ticketId);
    if (!current) {
      throw new SupportDeskError(404, 'ticket_not_found', 'Ticket SLA state not found.');
    }
    if (current.version !== expected) {
      throw new SupportDeskError(
        409,
        'version_conflict',
        `Ticket SLA state version conflict: expected ${expected}, current ${current.version}.`,
      );
    }

    const next: SupportDeskTicketState = {
      ...current,
      ...patch,
      tenantId,
      ticketId,
      version: expected + 1,
    };
    const nowIso = new Date().toISOString();
    const metaRow = db.prepare(
      'SELECT meta_encrypted, meta_iv, meta_auth_tag FROM x_support_desk_ticket_state WHERE tenant_id = ? AND ticket_id = ?',
    ).get(tenantId, ticketId) as { meta_encrypted: string; meta_iv: string; meta_auth_tag: string };
    const previousMeta = decryptJson<StoredTicketMeta>(metaRow.meta_encrypted, metaRow.meta_iv, metaRow.meta_auth_tag);
    const historicalCycles = [...(previousMeta.historicalCycles ?? [])];
    if (next.cycle > current.cycle && current.terminal) historicalCycles.push(current);
    const enc = encryptJson({
      policyTargets: next.policyTargets,
      routingSource: next.routingSource,
      historicalCycles: historicalCycles.slice(-20),
    } satisfies StoredTicketMeta);

    const res = db
      .prepare(
        `UPDATE x_support_desk_ticket_state
            SET conversation_id = ?, version = ?, cycle = ?, cycle_opened_at = ?,
                priority = ?, department = ?, policy_version = ?,
                first_human_reply_at = ?, resolved_at = ?, tracking = ?, terminal = ?,
                meta_encrypted = ?, meta_iv = ?, meta_auth_tag = ?, updated_at = ?
          WHERE tenant_id = ? AND ticket_id = ? AND version = ?`,
      )
      .run(
        next.conversationId ?? null,
        next.version,
        next.cycle,
        next.cycleOpenedAt,
        next.priority,
        next.department,
        next.policyVersion,
        next.firstHumanReplyAt,
        next.resolvedAt,
        next.tracking,
        next.terminal ? 1 : 0,
        enc.encrypted,
        enc.iv,
        enc.authTag,
        nowIso,
        tenantId,
        ticketId,
        expected,
      );

    if (res.changes === 0) {
      throw new SupportDeskError(409, 'version_conflict', 'Ticket SLA state modified concurrently.');
    }

    return next;
  });
}

function encodeQueueCursor(cycleOpenedAt: string, ticketId: string): string {
  return Buffer.from(JSON.stringify({ cycleOpenedAt, ticketId }), 'utf8').toString('base64url');
}

function decodeQueueCursor(cursor: string): { cycleOpenedAt: string; ticketId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      cycleOpenedAt?: unknown;
      ticketId?: unknown;
    };
    if (typeof parsed.cycleOpenedAt !== 'string' || typeof parsed.ticketId !== 'string') {
      throw new Error('bad cursor');
    }
    return { cycleOpenedAt: parsed.cycleOpenedAt, ticketId: parsed.ticketId };
  } catch {
    throw new SupportDeskError(400, 'invalid_input', 'Invalid queue cursor.');
  }
}

export function listSupportDeskTicketStates(
  tenantId: number,
  opts?: { cursor?: string; limit?: number },
): { items: SupportDeskTicketState[]; nextCursor: string | null } {
  return withStorageBoundary(() => {
    const db = ensureSupportServiceDeskTables();
    assertTenantExists(db, tenantId);

    const rawLimit = opts?.limit ?? 50;
    if (
      typeof rawLimit !== 'number' ||
      !Number.isInteger(rawLimit) ||
      rawLimit < 1 ||
      rawLimit > SUPPORT_DESK_LIMITS.maxQueuePageSize
    ) {
      throw new SupportDeskError(
        400,
        'invalid_input',
        `limit must be an integer between 1 and ${SUPPORT_DESK_LIMITS.maxQueuePageSize}.`,
      );
    }

    let rows: Array<Parameters<typeof rowToTicketState>[0]>;
    if (opts?.cursor) {
      const { cycleOpenedAt, ticketId } = decodeQueueCursor(opts.cursor);
      rows = db
        .prepare(
          `SELECT tenant_id, ticket_id, conversation_id, version, cycle, cycle_opened_at,
                  priority, department, policy_version, first_human_reply_at, resolved_at,
                  tracking, terminal, meta_encrypted, meta_iv, meta_auth_tag
             FROM x_support_desk_ticket_state
            WHERE tenant_id = ?
              AND (cycle_opened_at > ? OR (cycle_opened_at = ? AND ticket_id > ?))
            ORDER BY cycle_opened_at ASC, ticket_id ASC
            LIMIT ?`,
        )
        .all(tenantId, cycleOpenedAt, cycleOpenedAt, ticketId, rawLimit + 1) as Array<
        Parameters<typeof rowToTicketState>[0]
      >;
    } else {
      rows = db
        .prepare(
          `SELECT tenant_id, ticket_id, conversation_id, version, cycle, cycle_opened_at,
                  priority, department, policy_version, first_human_reply_at, resolved_at,
                  tracking, terminal, meta_encrypted, meta_iv, meta_auth_tag
             FROM x_support_desk_ticket_state
            WHERE tenant_id = ?
            ORDER BY cycle_opened_at ASC, ticket_id ASC
            LIMIT ?`,
        )
        .all(tenantId, rawLimit + 1) as Array<Parameters<typeof rowToTicketState>[0]>;
    }

    const hasMore = rows.length > rawLimit;
    const sliced = hasMore ? rows.slice(0, rawLimit) : rows;
    const items = sliced.map(rowToTicketState);
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? encodeQueueCursor(last.cycleOpenedAt, last.ticketId) : null;

    return { items, nextCursor };
  });
}
