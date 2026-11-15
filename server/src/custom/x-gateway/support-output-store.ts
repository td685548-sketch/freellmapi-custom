import crypto from 'node:crypto';
import { getDb, type Db } from '../../db/index.js';
import { up as supportOutputUp } from '../../db/migrations/20261115_120001_support_output_controls.js';
import { decrypt, encrypt, initEncryptionKey, isEncryptionKeyInitialized } from '../../lib/crypto.js';
import { ensureSupportTables } from './support-store.js';
import {
  DEFAULT_SUPPORT_OUTPUT_POLICY,
  SUPPORT_OUTPUT_LIMITS,
  type SupportOutputDecision,
  type SupportOutputEvent,
  type SupportOutputMode,
  type SupportOutputPolicy,
  type SupportOutputReason,
  type SupportOutputRule,
  type SupportOutputSurface,
} from '@freellmapi/shared/support-output.js';

export class SupportOutputError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SupportOutputError';
    this.status = status;
    this.code = code;
  }
}

const initializedDbs = new WeakSet<Db>();

const RULE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const VALID_MODES = new Set<SupportOutputMode>(['off', 'log', 'enforce']);
const VALID_SURFACES = new Set<SupportOutputSurface>(['chat', 'copilot']);
const VALID_EVENT_ACTIONS = new Set<SupportOutputDecision['action']>(['observe', 'redact', 'block']);
const VALID_ALL_ACTIONS = new Set<SupportOutputDecision['action']>(['allow', 'observe', 'redact', 'block']);
const VALID_REASONS = new Set<SupportOutputReason>([
  'blocked_term',
  'too_long',
  'credential',
  'inspection_limit',
]);

const POLICY_INPUT_KEYS = new Set(['tenantId', 'expectedVersion', 'policy']);
const POLICY_BODY_KEYS = new Set(['mode', 'blockedTerms', 'maxOutputChars', 'redactCredentials']);
const RULE_KEYS = new Set(['id', 'text']);
const EVENT_INPUT_KEYS = new Set([
  'tenantId',
  'operationId',
  'surface',
  'policyVersion',
  'action',
  'reasons',
  'ruleIds',
  'redactionCount',
]);
const LIST_INPUT_KEYS = new Set(['tenantId', 'limit', 'before']);
const CURSOR_KEYS = new Set(['c', 'i']);

export function ensureSupportOutputTables(targetDb?: Db): Db {
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

  supportOutputUp(db);
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
    if (err instanceof SupportOutputError) throw err;
    throw new SupportOutputError(
      503,
      'output_policy_unavailable',
      'Support output policy storage is unavailable.',
    );
  }
}

function assertPlainObject(value: unknown, label: string, allowedKeys: Set<string>, errorCode = 'invalid_input'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SupportOutputError(400, errorCode, `${label} must be a JSON object.`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new SupportOutputError(400, errorCode, `${label} contains unknown field "${key}".`);
    }
  }
  return obj;
}

function assertPositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new SupportOutputError(400, 'invalid_input', `${label} must be a positive integer.`);
  }
  return value;
}

function assertNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new SupportOutputError(400, 'invalid_input', `${label} must be a non-negative integer.`);
  }
  return value;
}

function assertTenantExists(db: Db, tenantId: number): void {
  const row = db.prepare('SELECT id FROM x_support_tenants WHERE id = ?').get(tenantId) as
    | { id: number }
    | undefined;
  if (!row) {
    throw new SupportOutputError(404, 'tenant_not_found', 'Support tenant not found.');
  }
}

function normalizeTermForUniqueness(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

type MutablePolicyFields = Pick<
  SupportOutputPolicy,
  'mode' | 'blockedTerms' | 'maxOutputChars' | 'redactCredentials'
>;

function validateMutablePolicy(
  rawPolicy: unknown,
  onFailureStatus: 400 | 503,
  onFailureCode: string,
): MutablePolicyFields {
  if (typeof rawPolicy !== 'object' || rawPolicy === null || Array.isArray(rawPolicy)) {
    throw new SupportOutputError(onFailureStatus, onFailureCode, 'Support output policy must be an object.');
  }
  const obj = rawPolicy as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!POLICY_BODY_KEYS.has(key)) {
      throw new SupportOutputError(
        onFailureStatus,
        onFailureCode,
        'Support output policy contains an unknown field.',
      );
    }
  }

  const mode = obj.mode;
  if (typeof mode !== 'string' || !VALID_MODES.has(mode as SupportOutputMode)) {
    throw new SupportOutputError(
      onFailureStatus,
      onFailureCode,
      'Support output policy mode must be off, log, or enforce.',
    );
  }

  const maxOutputChars = obj.maxOutputChars;
  if (
    typeof maxOutputChars !== 'number' ||
    !Number.isInteger(maxOutputChars) ||
    maxOutputChars < SUPPORT_OUTPUT_LIMITS.maxOutputCharsMin ||
    maxOutputChars > SUPPORT_OUTPUT_LIMITS.maxOutputCharsMax
  ) {
    throw new SupportOutputError(
      onFailureStatus,
      onFailureCode,
      `maxOutputChars must be an integer between ${SUPPORT_OUTPUT_LIMITS.maxOutputCharsMin} and ${SUPPORT_OUTPUT_LIMITS.maxOutputCharsMax}.`,
    );
  }

  const redactCredentials = obj.redactCredentials;
  if (typeof redactCredentials !== 'boolean') {
    throw new SupportOutputError(onFailureStatus, onFailureCode, 'redactCredentials must be a boolean.');
  }

  const rawRules = obj.blockedTerms;
  if (!Array.isArray(rawRules) || rawRules.length > SUPPORT_OUTPUT_LIMITS.maxRules) {
    throw new SupportOutputError(
      onFailureStatus,
      onFailureCode,
      `blockedTerms must be an array of at most ${SUPPORT_OUTPUT_LIMITS.maxRules} rules.`,
    );
  }

  const seenIds = new Set<string>();
  const seenNormalized = new Set<string>();
  const blockedTerms: SupportOutputRule[] = [];

  for (const rawRule of rawRules) {
    if (typeof rawRule !== 'object' || rawRule === null || Array.isArray(rawRule)) {
      throw new SupportOutputError(
        onFailureStatus,
        onFailureCode,
        'Each blockedTerms entry must be an object.',
      );
    }
    const ruleObj = rawRule as Record<string, unknown>;
    for (const key of Object.keys(ruleObj)) {
      if (!RULE_KEYS.has(key)) {
        throw new SupportOutputError(
          onFailureStatus,
          onFailureCode,
          'Blocked term rule contains an unknown field.',
        );
      }
    }

    const id = ruleObj.id;
    if (typeof id !== 'string' || !RULE_ID_RE.test(id)) {
      throw new SupportOutputError(
        onFailureStatus,
        onFailureCode,
        'Blocked term rule id must match [A-Za-z0-9_-]{1,64}.',
      );
    }
    if (seenIds.has(id)) {
      throw new SupportOutputError(onFailureStatus, onFailureCode, 'Blocked term rule ids must be unique.');
    }
    seenIds.add(id);

    const text = ruleObj.text;
    if (typeof text !== 'string') {
      throw new SupportOutputError(onFailureStatus, onFailureCode, 'Blocked term rule text must be a string.');
    }
    const normalized = normalizeTermForUniqueness(text);
    if (
      normalized.length < SUPPORT_OUTPUT_LIMITS.ruleTextMinLength ||
      normalized.length > SUPPORT_OUTPUT_LIMITS.ruleTextMaxLength
    ) {
      throw new SupportOutputError(
        onFailureStatus,
        onFailureCode,
        `Blocked term text must be ${SUPPORT_OUTPUT_LIMITS.ruleTextMinLength}..${SUPPORT_OUTPUT_LIMITS.ruleTextMaxLength} code units after normalization.`,
      );
    }
    if (seenNormalized.has(normalized)) {
      throw new SupportOutputError(
        onFailureStatus,
        onFailureCode,
        'Blocked term rules must have unique normalized terms.',
      );
    }
    seenNormalized.add(normalized);

    blockedTerms.push({ id, text: text.trim() });
  }

  return {
    mode: mode as SupportOutputMode,
    blockedTerms,
    maxOutputChars,
    redactCredentials,
  };
}

function decryptStoredPolicy(encrypted: string, iv: string, authTag: string): MutablePolicyFields {
  let parsed: unknown;
  try {
    const raw = decrypt(encrypted, iv, authTag);
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new SupportOutputError(
      503,
      'output_policy_unavailable',
      'Support output policy storage is corrupted or unavailable.',
    );
  }
  return validateMutablePolicy(parsed, 503, 'output_policy_unavailable');
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt, i: id }), 'utf8').toString('base64url');
}

function decodeCursor(before: string): { createdAt: string; id: string } {
  if (typeof before !== 'string' || before.length === 0 || before.length > SUPPORT_OUTPUT_LIMITS.eventsCursorMaxLength) {
    throw new SupportOutputError(400, 'invalid_cursor', 'Pagination cursor is invalid.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(before)) {
    throw new SupportOutputError(400, 'invalid_cursor', 'Pagination cursor is invalid.');
  }
  let parsed: unknown;
  try {
    const json = Buffer.from(before, 'base64url').toString('utf8');
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new SupportOutputError(400, 'invalid_cursor', 'Pagination cursor is invalid.');
  }
  const obj = assertPlainObject(parsed, 'cursor', CURSOR_KEYS, 'invalid_cursor');
  if (
    typeof obj.c !== 'string' ||
    obj.c.length === 0 ||
    obj.c.length > 64 ||
    Number.isNaN(Date.parse(obj.c)) ||
    typeof obj.i !== 'string' ||
    obj.i.length === 0 ||
    obj.i.length > 128
  ) {
    throw new SupportOutputError(400, 'invalid_cursor', 'Pagination cursor is invalid.');
  }
  return { createdAt: obj.c, id: obj.i };
}

export function getSupportOutputPolicy(tenantId: number, targetDb?: Db): SupportOutputPolicy {
  assertPositiveInt(tenantId, 'tenantId');

  return withStorageBoundary(() => {
    const db = ensureSupportOutputTables(targetDb);
    assertTenantExists(db, tenantId);

    const row = db
      .prepare(
        `SELECT version, payload_encrypted, payload_iv, payload_auth_tag, updated_at
           FROM x_support_output_policies
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
      return {
        tenantId,
        ...DEFAULT_SUPPORT_OUTPUT_POLICY,
        blockedTerms: [],
      };
    }

    if (
      typeof row.version !== 'number' ||
      !Number.isInteger(row.version) ||
      row.version < 1 ||
      typeof row.updated_at !== 'string' ||
      row.updated_at.length === 0
    ) {
      throw new SupportOutputError(
        503,
        'output_policy_unavailable',
        'Support output policy storage is corrupted or unavailable.',
      );
    }

    const mutable = decryptStoredPolicy(row.payload_encrypted, row.payload_iv, row.payload_auth_tag);
    return {
      tenantId,
      version: row.version,
      ...mutable,
      updatedAt: row.updated_at,
    };
  });
}

export function saveSupportOutputPolicy(
  input: {
    tenantId: number;
    expectedVersion: number;
    policy: Pick<SupportOutputPolicy, 'mode' | 'blockedTerms' | 'maxOutputChars' | 'redactCredentials'>;
  },
  targetDb?: Db,
): SupportOutputPolicy {
  const inputObj = assertPlainObject(input, 'input', POLICY_INPUT_KEYS);
  const tenantId = assertPositiveInt(inputObj.tenantId, 'tenantId');
  const expectedVersion = assertNonNegativeInt(inputObj.expectedVersion, 'expectedVersion');
  const validatedPolicy = validateMutablePolicy(inputObj.policy, 400, 'invalid_input');

  return withStorageBoundary(() => {
    const db = ensureSupportOutputTables(targetDb);

    return db.transaction(() => {
      assertTenantExists(db, tenantId);

      const { encrypted, iv, authTag } = encrypt(JSON.stringify(validatedPolicy));
      const now = new Date().toISOString();

      if (expectedVersion === 0) {
        const info = db
          .prepare(
            `INSERT OR IGNORE INTO x_support_output_policies (
               tenant_id, version, payload_encrypted, payload_iv, payload_auth_tag, updated_at
             ) VALUES (?, 1, ?, ?, ?, ?)`,
          )
          .run(tenantId, encrypted, iv, authTag, now);

        if (info.changes === 0) {
          throw new SupportOutputError(
            409,
            'output_policy_conflict',
            'Support output policy version conflict.',
          );
        }

        return {
          tenantId,
          version: 1,
          ...validatedPolicy,
          blockedTerms: validatedPolicy.blockedTerms.map((r) => ({ ...r })),
          updatedAt: now,
        };
      }

      const info = db
        .prepare(
          `UPDATE x_support_output_policies
              SET version = version + 1,
                  payload_encrypted = ?,
                  payload_iv = ?,
                  payload_auth_tag = ?,
                  updated_at = ?
            WHERE tenant_id = ?
              AND version = ?`,
        )
        .run(encrypted, iv, authTag, now, tenantId, expectedVersion);

      if (info.changes === 0) {
        throw new SupportOutputError(
          409,
          'output_policy_conflict',
          'Support output policy version conflict.',
        );
      }

      return {
        tenantId,
        version: expectedVersion + 1,
        ...validatedPolicy,
        blockedTerms: validatedPolicy.blockedTerms.map((r) => ({ ...r })),
        updatedAt: now,
      };
    })();
  });
}

export function appendSupportOutputEvent(
  input: Omit<SupportOutputEvent, 'id' | 'createdAt'>,
  targetDb?: Db,
): void {
  const obj = assertPlainObject(input, 'event', EVENT_INPUT_KEYS);
  const tenantId = assertPositiveInt(obj.tenantId, 'tenantId');

  const operationId = obj.operationId;
  if (typeof operationId !== 'string' || !OPERATION_ID_RE.test(operationId)) {
    throw new SupportOutputError(400, 'invalid_input', 'operationId must be an opaque safe identifier.');
  }

  const surface = obj.surface;
  if (typeof surface !== 'string' || !VALID_SURFACES.has(surface as SupportOutputSurface)) {
    throw new SupportOutputError(400, 'invalid_input', 'surface must be chat or copilot.');
  }

  const policyVersion = assertNonNegativeInt(obj.policyVersion, 'policyVersion');

  const action = obj.action;
  if (typeof action !== 'string' || !VALID_ALL_ACTIONS.has(action as SupportOutputDecision['action'])) {
    throw new SupportOutputError(400, 'invalid_input', 'action is invalid.');
  }

  if (!Array.isArray(obj.reasons) || obj.reasons.length > VALID_REASONS.size) {
    throw new SupportOutputError(400, 'invalid_input', 'reasons must be an array of valid output reasons.');
  }
  const reasonsSet = new Set<SupportOutputReason>();
  for (const r of obj.reasons) {
    if (typeof r !== 'string' || !VALID_REASONS.has(r as SupportOutputReason) || reasonsSet.has(r as SupportOutputReason)) {
      throw new SupportOutputError(400, 'invalid_input', 'reasons contains invalid or duplicate entry.');
    }
    reasonsSet.add(r as SupportOutputReason);
  }

  if (!Array.isArray(obj.ruleIds) || obj.ruleIds.length > SUPPORT_OUTPUT_LIMITS.maxRules) {
    throw new SupportOutputError(400, 'invalid_input', 'ruleIds must be an array of valid rule identifiers.');
  }
  const ruleIdsSet = new Set<string>();
  for (const id of obj.ruleIds) {
    if (typeof id !== 'string' || !RULE_ID_RE.test(id) || ruleIdsSet.has(id)) {
      throw new SupportOutputError(400, 'invalid_input', 'ruleIds contains invalid or duplicate entry.');
    }
    ruleIdsSet.add(id);
  }

  const redactionCount = assertNonNegativeInt(obj.redactionCount, 'redactionCount');

  if (action === 'allow') {
    return;
  }

  return withStorageBoundary(() => {
    const db = ensureSupportOutputTables(targetDb);

    db.transaction(() => {
      assertTenantExists(db, tenantId);

      const id = crypto.randomUUID();
      const nowMs = Date.now();
      const createdAt = new Date(nowMs).toISOString();

      db.prepare(
        `INSERT OR IGNORE INTO x_support_output_events (
           id, tenant_id, operation_id, surface, policy_version, action,
           reasons_json, rule_ids_json, redaction_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        tenantId,
        operationId,
        surface,
        policyVersion,
        action,
        JSON.stringify([...reasonsSet]),
        JSON.stringify([...ruleIdsSet]),
        redactionCount,
        createdAt,
      );

      const retentionCutoff = new Date(
        nowMs - SUPPORT_OUTPUT_LIMITS.eventsRetentionDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      db.prepare(
        `DELETE FROM x_support_output_events
          WHERE tenant_id = ?
            AND created_at < ?`,
      ).run(tenantId, retentionCutoff);

      db.prepare(
        `DELETE FROM x_support_output_events
          WHERE tenant_id = ?
            AND id NOT IN (
              SELECT id
                FROM x_support_output_events
               WHERE tenant_id = ?
               ORDER BY created_at DESC, id DESC
               LIMIT ?
            )`,
      ).run(tenantId, tenantId, SUPPORT_OUTPUT_LIMITS.eventsMaxPerTenant);
    })();
  });
}

function parseStoredReasons(raw: string): SupportOutputReason[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new SupportOutputError(503, 'output_policy_unavailable', 'Support output event storage is corrupted.');
  }
  if (!Array.isArray(parsed)) {
    throw new SupportOutputError(503, 'output_policy_unavailable', 'Support output event storage is corrupted.');
  }
  for (const r of parsed) {
    if (typeof r !== 'string' || !VALID_REASONS.has(r as SupportOutputReason)) {
      throw new SupportOutputError(503, 'output_policy_unavailable', 'Support output event storage is corrupted.');
    }
  }
  return parsed as SupportOutputReason[];
}

function parseStoredRuleIds(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new SupportOutputError(503, 'output_policy_unavailable', 'Support output event storage is corrupted.');
  }
  if (!Array.isArray(parsed)) {
    throw new SupportOutputError(503, 'output_policy_unavailable', 'Support output event storage is corrupted.');
  }
  for (const id of parsed) {
    if (typeof id !== 'string' || !RULE_ID_RE.test(id)) {
      throw new SupportOutputError(503, 'output_policy_unavailable', 'Support output event storage is corrupted.');
    }
  }
  return parsed as string[];
}

export function listSupportOutputEvents(
  input: { tenantId: number; limit: number; before?: string },
  targetDb?: Db,
): { items: SupportOutputEvent[]; nextCursor?: string } {
  const obj = assertPlainObject(input, 'input', LIST_INPUT_KEYS);
  const tenantId = assertPositiveInt(obj.tenantId, 'tenantId');

  const limit = obj.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < SUPPORT_OUTPUT_LIMITS.eventsLimitMin ||
    limit > SUPPORT_OUTPUT_LIMITS.eventsLimitMax
  ) {
    throw new SupportOutputError(
      400,
      'invalid_input',
      `limit must be an integer between ${SUPPORT_OUTPUT_LIMITS.eventsLimitMin} and ${SUPPORT_OUTPUT_LIMITS.eventsLimitMax}.`,
    );
  }

  let cursor: { createdAt: string; id: string } | undefined;
  if (obj.before !== undefined) {
    if (typeof obj.before !== 'string') {
      throw new SupportOutputError(400, 'invalid_cursor', 'Pagination cursor is invalid.');
    }
    cursor = decodeCursor(obj.before);
  }

  return withStorageBoundary(() => {
    const db = ensureSupportOutputTables(targetDb);
    assertTenantExists(db, tenantId);

    type EventRow = {
      id: string;
      tenant_id: number;
      operation_id: string;
      surface: string;
      policy_version: number;
      action: string;
      reasons_json: string;
      rule_ids_json: string;
      redaction_count: number;
      created_at: string;
    };

    const rows = (
      cursor
        ? db
            .prepare(
              `SELECT id, tenant_id, operation_id, surface, policy_version, action,
                      reasons_json, rule_ids_json, redaction_count, created_at
                 FROM x_support_output_events
                WHERE tenant_id = ?
                  AND (created_at < ? OR (created_at = ? AND id < ?))
                ORDER BY created_at DESC, id DESC
                LIMIT ?`,
            )
            .all(tenantId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
        : db
            .prepare(
              `SELECT id, tenant_id, operation_id, surface, policy_version, action,
                      reasons_json, rule_ids_json, redaction_count, created_at
                 FROM x_support_output_events
                WHERE tenant_id = ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?`,
            )
            .all(tenantId, limit + 1)
    ) as EventRow[];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const items: SupportOutputEvent[] = pageRows.map((row) => {
      if (!VALID_SURFACES.has(row.surface as SupportOutputSurface) || !VALID_EVENT_ACTIONS.has(row.action as SupportOutputDecision['action'])) {
        throw new SupportOutputError(503, 'output_policy_unavailable', 'Support output event storage is corrupted.');
      }
      return {
        id: row.id,
        tenantId: row.tenant_id,
        operationId: row.operation_id,
        surface: row.surface as SupportOutputSurface,
        policyVersion: row.policy_version,
        action: row.action as SupportOutputDecision['action'],
        reasons: parseStoredReasons(row.reasons_json),
        ruleIds: parseStoredRuleIds(row.rule_ids_json),
        redactionCount: row.redaction_count,
        createdAt: row.created_at,
      };
    });

    if (hasMore && items.length > 0) {
      const last = items[items.length - 1]!;
      return { items, nextCursor: encodeCursor(last.createdAt, last.id) };
    }
    return { items };
  });
}
