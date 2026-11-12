import crypto from 'node:crypto';
import { getDb, type Db } from '../../db/index.js';
import { encrypt, decrypt, isEncryptionKeyInitialized, initEncryptionKey } from '../../lib/crypto.js';
import { up } from '../../db/migrations/20261112_170001_support_runtime_state.js';
import {
  DEFAULT_RUNTIME_POLICY,
  RUNTIME_POLICY_BOUNDS,
  type SupportRuntimePolicy,
} from '@freellmapi/shared/support-runtime.js';

export class SupportRuntimeError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'SupportRuntimeError';
  }
}

const POLICY_KEY = 'x_support_runtime_policy_v1';

let runtimeDb: Db | undefined;

/**
 * Ensures runtime tables exist and encryption key is initialized.
 * Reuses migration up() function directly to prevent schema drift.
 */
export function ensureSupportRuntimeTables(targetDb?: Db): Db {
  const db = targetDb || getDb();
  if (runtimeDb === db) return db;
  up(db);
  if (!isEncryptionKeyInitialized()) {
    initEncryptionKey(db);
  }
  runtimeDb = db;
  return db;
}

// ---------------------------------------------------------------------------
// Runtime Policy Storage
// ---------------------------------------------------------------------------

function readPolicyStore(): Record<string, Partial<SupportRuntimePolicy>> {
  const db = ensureSupportRuntimeTables();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(POLICY_KEY) as
    | { value: string }
    | undefined;
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, Partial<SupportRuntimePolicy>>)
      : {};
  } catch {
    return {};
  }
}

function writePolicyStore(store: Record<string, Partial<SupportRuntimePolicy>>): void {
  const db = ensureSupportRuntimeTables();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(POLICY_KEY, JSON.stringify(store));
}

export function getSupportRuntimePolicy(tenantId: number): SupportRuntimePolicy {
  const tid = String(tenantId);
  const store = readPolicyStore();
  const saved = store[tid];
  if (!saved) return { ...DEFAULT_RUNTIME_POLICY };

  return {
    allowedModels: Array.isArray(saved.allowedModels)
      ? saved.allowedModels.map((s) => String(s).trim()).filter(Boolean)
      : DEFAULT_RUNTIME_POLICY.allowedModels,
    toolPolicies: Array.isArray(saved.toolPolicies)
      ? saved.toolPolicies.filter(
          (tp) =>
            tp &&
            typeof tp.toolId === 'number' &&
            Number.isInteger(tp.toolId) &&
            tp.toolId > 0 &&
            (tp.mode === 'read' || tp.mode === 'approval_required'),
        )
      : DEFAULT_RUNTIME_POLICY.toolPolicies,
    maxCompletionTokens:
      typeof saved.maxCompletionTokens === 'number' &&
      saved.maxCompletionTokens >= RUNTIME_POLICY_BOUNDS.maxCompletionTokens.min &&
      saved.maxCompletionTokens <= RUNTIME_POLICY_BOUNDS.maxCompletionTokens.max
        ? Math.floor(saved.maxCompletionTokens)
        : DEFAULT_RUNTIME_POLICY.maxCompletionTokens,
    maxModelCalls:
      typeof saved.maxModelCalls === 'number' &&
      saved.maxModelCalls >= RUNTIME_POLICY_BOUNDS.maxModelCalls.min &&
      saved.maxModelCalls <= RUNTIME_POLICY_BOUNDS.maxModelCalls.max
        ? Math.floor(saved.maxModelCalls)
        : DEFAULT_RUNTIME_POLICY.maxModelCalls,
    maxToolCalls:
      typeof saved.maxToolCalls === 'number' &&
      saved.maxToolCalls >= RUNTIME_POLICY_BOUNDS.maxToolCalls.min &&
      saved.maxToolCalls <= RUNTIME_POLICY_BOUNDS.maxToolCalls.max
        ? Math.floor(saved.maxToolCalls)
        : DEFAULT_RUNTIME_POLICY.maxToolCalls,
    maxContextChars:
      typeof saved.maxContextChars === 'number' &&
      saved.maxContextChars >= RUNTIME_POLICY_BOUNDS.maxContextChars.min &&
      saved.maxContextChars <= RUNTIME_POLICY_BOUNDS.maxContextChars.max
        ? Math.floor(saved.maxContextChars)
        : DEFAULT_RUNTIME_POLICY.maxContextChars,
    maxToolResultChars:
      typeof saved.maxToolResultChars === 'number' &&
      saved.maxToolResultChars >= RUNTIME_POLICY_BOUNDS.maxToolResultChars.min &&
      saved.maxToolResultChars <= RUNTIME_POLICY_BOUNDS.maxToolResultChars.max
        ? Math.floor(saved.maxToolResultChars)
        : DEFAULT_RUNTIME_POLICY.maxToolResultChars,
    maxHistoryMessages:
      typeof saved.maxHistoryMessages === 'number' &&
      saved.maxHistoryMessages >= RUNTIME_POLICY_BOUNDS.maxHistoryMessages.min &&
      saved.maxHistoryMessages <= RUNTIME_POLICY_BOUNDS.maxHistoryMessages.max
        ? Math.floor(saved.maxHistoryMessages)
        : DEFAULT_RUNTIME_POLICY.maxHistoryMessages,
  };
}

export function updateSupportRuntimePolicy(
  tenantId: number,
  patch: Partial<SupportRuntimePolicy>,
): SupportRuntimePolicy {
  const tid = String(tenantId);
  const cur = getSupportRuntimePolicy(tenantId);

  // Validate allowedModels
  let nextAllowedModels = cur.allowedModels;
  if (patch.allowedModels !== undefined) {
    if (!Array.isArray(patch.allowedModels)) {
      throw new SupportRuntimeError(400, 'invalid_input', 'allowedModels must be an array of strings');
    }
    nextAllowedModels = patch.allowedModels.map((s) => String(s).trim()).filter(Boolean);
  }

  // Validate toolPolicies
  let nextToolPolicies = cur.toolPolicies;
  if (patch.toolPolicies !== undefined) {
    if (!Array.isArray(patch.toolPolicies)) {
      throw new SupportRuntimeError(400, 'invalid_input', 'toolPolicies must be an array');
    }
    const seen = new Set<number>();
    for (const item of patch.toolPolicies) {
      if (!item || typeof item.toolId !== 'number' || !Number.isInteger(item.toolId) || item.toolId <= 0) {
        throw new SupportRuntimeError(400, 'invalid_input', 'Each tool policy must have a positive integer toolId');
      }
      if (item.mode !== 'read' && item.mode !== 'approval_required') {
        throw new SupportRuntimeError(400, 'invalid_input', "Tool policy mode must be 'read' or 'approval_required'");
      }
      if (seen.has(item.toolId)) {
        throw new SupportRuntimeError(400, 'invalid_input', `Duplicate toolId ${item.toolId} in toolPolicies`);
      }
      seen.add(item.toolId);
    }
    nextToolPolicies = patch.toolPolicies.map((tp) => ({ toolId: tp.toolId, mode: tp.mode }));
  }

  // Validate integer bounds
  const validateInt = (val: unknown, name: keyof typeof RUNTIME_POLICY_BOUNDS, current: number): number => {
    if (val === undefined) return current;
    if (typeof val !== 'number' || !Number.isInteger(val)) {
      throw new SupportRuntimeError(400, 'invalid_input', `${name} must be an integer`);
    }
    const bounds = RUNTIME_POLICY_BOUNDS[name];
    if (val < bounds.min || val > bounds.max) {
      throw new SupportRuntimeError(
        400,
        'invalid_input',
        `${name} must be between ${bounds.min} and ${bounds.max}`,
      );
    }
    return val;
  };

  const next: SupportRuntimePolicy = {
    allowedModels: nextAllowedModels,
    toolPolicies: nextToolPolicies,
    maxCompletionTokens: validateInt(patch.maxCompletionTokens, 'maxCompletionTokens', cur.maxCompletionTokens),
    maxModelCalls: validateInt(patch.maxModelCalls, 'maxModelCalls', cur.maxModelCalls),
    maxToolCalls: validateInt(patch.maxToolCalls, 'maxToolCalls', cur.maxToolCalls),
    maxContextChars: validateInt(patch.maxContextChars, 'maxContextChars', cur.maxContextChars),
    maxToolResultChars: validateInt(patch.maxToolResultChars, 'maxToolResultChars', cur.maxToolResultChars),
    maxHistoryMessages: validateInt(patch.maxHistoryMessages, 'maxHistoryMessages', cur.maxHistoryMessages),
  };

  const db = ensureSupportRuntimeTables();
  const runTx = db.transaction(() => {
    const store = readPolicyStore();
    store[tid] = next;
    writePolicyStore(store);
    return next;
  });

  return runTx();
}

// ---------------------------------------------------------------------------
// Guest Session Issuance Throttle
// ---------------------------------------------------------------------------

export function consumeSupportGuestSessionIssuance(
  tenantId: number,
  trustedClientIp: string,
): { allowed: boolean; retryAfterSeconds: number } {
  const db = ensureSupportRuntimeTables();
  const safeIp = String(trustedClientIp || 'unknown').trim() || 'unknown';
  const ipHash = crypto.createHash('sha256').update(safeIp).digest('hex');
  const now = Date.now();
  const windowMinute = Math.floor(now / 60000);
  const expiresAt = new Date((windowMinute + 2) * 60000).toISOString();

  const runTx = db.transaction(() => {
    // Opportunistic cleanup of expired rows
    const nowIso = new Date(now).toISOString();
    db.prepare('DELETE FROM x_support_guest_issuance WHERE expires_at < ?').run(nowIso);

    const row = db.prepare(
      'SELECT count FROM x_support_guest_issuance WHERE tenant_id = ? AND ip_hash = ? AND window_minute = ?',
    ).get(tenantId, ipHash, windowMinute) as { count: number } | undefined;

    const currentCount = row ? row.count : 0;
    if (currentCount >= 20) {
      const retryAfter = Math.max(1, Math.ceil(((windowMinute + 1) * 60000 - now) / 1000));
      return { allowed: false, retryAfterSeconds: retryAfter };
    }

    db.prepare(
      `INSERT INTO x_support_guest_issuance (tenant_id, ip_hash, window_minute, count, expires_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(tenant_id, ip_hash, window_minute)
       DO UPDATE SET count = count + 1`,
    ).run(tenantId, ipHash, windowMinute, expiresAt);

    return { allowed: true, retryAfterSeconds: 0 };
  });

  return runTx();
}

// ---------------------------------------------------------------------------
// Durable Turn Claim, Lease & Replay State
// ---------------------------------------------------------------------------

export interface SupportTurnRecord {
  id: string;
  tenantId: number;
  userId: string;
  requestId: string;
  conversationId: string | null;
  inputHash: string;
  state: 'processing' | 'completed' | 'failed' | 'interrupted';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export function claimSupportTurn(options: {
  tenantId: number;
  userId: string;
  requestId: string;
  conversationId?: string;
  inputHash: string;
}):
  | { status: 'claimed'; turnId: string }
  | { status: 'replayed'; turnId: string; cachedResponse: unknown }
  | { status: 'conflict'; reason: 'request_conflict' | 'turn_in_progress' | 'turn_interrupted'; message: string } {
  const db = ensureSupportRuntimeTables();
  const { tenantId, userId, requestId, conversationId, inputHash } = options;

  const runTx = db.transaction(() => {
    const existing = db.prepare(
      `SELECT id, input_hash, state, masked_response_encrypted, iv, auth_tag, created_at, updated_at
       FROM x_support_runtime_turns
       WHERE tenant_id = ? AND user_id = ? AND request_id = ?`,
    ).get(tenantId, userId, requestId) as {
      id: string;
      input_hash: string;
      state: 'processing' | 'completed' | 'failed' | 'interrupted';
      masked_response_encrypted: string | null;
      iv: string | null;
      auth_tag: string | null;
      created_at: string;
      updated_at: string;
    } | undefined;

    if (existing) {
      if (existing.input_hash !== inputHash) {
        return {
          status: 'conflict' as const,
          reason: 'request_conflict' as const,
          message: 'Request ID already used with different input parameters',
        };
      }

      if (existing.state === 'completed') {
        if (!existing.masked_response_encrypted || !existing.iv || !existing.auth_tag) {
          return {
            status: 'conflict' as const,
            reason: 'turn_interrupted' as const,
            message: 'Previous turn response was empty or corrupted',
          };
        }
        try {
          const decrypted = decrypt(existing.masked_response_encrypted, existing.iv, existing.auth_tag);
          const cachedResponse = JSON.parse(decrypted);
          return { status: 'replayed' as const, turnId: existing.id, cachedResponse };
        } catch {
          return {
            status: 'conflict' as const,
            reason: 'turn_interrupted' as const,
            message: 'Failed to decrypt cached turn response',
          };
        }
      }

      if (existing.state === 'processing') {
        const elapsed = Date.now() - new Date(existing.updated_at).getTime();
        if (elapsed > 120_000) {
          // Lease expired; mark interrupted
          db.prepare("UPDATE x_support_runtime_turns SET state = 'interrupted', updated_at = ? WHERE id = ?").run(
            new Date().toISOString(),
            existing.id,
          );
          return {
            status: 'conflict' as const,
            reason: 'turn_interrupted' as const,
            message: 'Previous turn with this request ID timed out and was interrupted',
          };
        }
        return {
          status: 'conflict' as const,
          reason: 'turn_in_progress' as const,
          message: 'Turn is currently processing',
        };
      }

      return {
        status: 'conflict' as const,
        reason: 'turn_interrupted' as const,
        message: 'Previous turn for this request ID was interrupted or failed',
      };
    }

    // New claim
    const turnId = `turn_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    db.prepare(
      `INSERT INTO x_support_runtime_turns (
        id, tenant_id, user_id, request_id, conversation_id, input_hash, state,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?)`,
    ).run(turnId, tenantId, userId, requestId, conversationId ?? null, inputHash, now, now, expiresAt);

    return { status: 'claimed' as const, turnId };
  });

  return runTx();
}

export function assertSupportTurnActive(turnId: string, tenantId: number, conversationId?: string): void {
  const db = ensureSupportRuntimeTables();
  const turn = db.prepare('SELECT state, created_at FROM x_support_runtime_turns WHERE id = ? AND tenant_id = ?')
    .get(turnId, tenantId) as { state: string; created_at: string } | undefined;
  if (!turn || turn.state !== 'processing' || Date.now() - Date.parse(turn.created_at) >= 90_000) {
    throw new SupportRuntimeError(503, 'generation_timeout', 'This support turn is no longer active.');
  }
  if (conversationId) {
    const lease = db.prepare('SELECT turn_id, lease_until FROM x_support_runtime_leases WHERE tenant_id = ? AND conversation_id = ?')
      .get(tenantId, conversationId) as { turn_id: string; lease_until: number } | undefined;
    if (!lease || lease.turn_id !== turnId || lease.lease_until <= Date.now()) {
      throw new SupportRuntimeError(409, 'conversation_busy', 'Conversation lease is no longer owned by this turn.');
    }
  }
}

export function completeSupportTurn(options: {
  turnId: string;
  responsePayload: unknown;
}): boolean {
  const db = ensureSupportRuntimeTables();
  const text = JSON.stringify(options.responsePayload);
  const enc = encrypt(text);
  const now = new Date().toISOString();

  const res = db.prepare(
    `UPDATE x_support_runtime_turns
     SET state = 'completed',
         masked_response_encrypted = ?,
         iv = ?,
         auth_tag = ?,
         updated_at = ?
     WHERE id = ? AND state = 'processing'`,
  ).run(enc.encrypted, enc.iv, enc.authTag, now, options.turnId);

  return res.changes > 0;
}

export function failSupportTurn(options: {
  turnId: string;
  interrupted?: boolean;
}): void {
  const db = ensureSupportRuntimeTables();
  const now = new Date().toISOString();
  const nextState = options.interrupted ? 'interrupted' : 'failed';

  db.prepare(
    `UPDATE x_support_runtime_turns
     SET state = ?, updated_at = ?
     WHERE id = ? AND state = 'processing'`,
  ).run(nextState, now, options.turnId);
}

// ---------------------------------------------------------------------------
// Conversation Lease Management
// ---------------------------------------------------------------------------

export function acquireSupportConversationLease(
  tenantId: number,
  conversationId: string,
  turnId: string,
  ttlMs: number = 120_000,
): boolean {
  const db = ensureSupportRuntimeTables();
  const now = Date.now();
  const leaseUntil = now + ttlMs;

  const runTx = db.transaction(() => {
    const existing = db.prepare(
      `SELECT turn_id, lease_until
       FROM x_support_runtime_leases
       WHERE tenant_id = ? AND conversation_id = ?`,
    ).get(tenantId, conversationId) as { turn_id: string; lease_until: number } | undefined;

    if (existing && existing.lease_until > now && existing.turn_id !== turnId) {
      return false;
    }
    if (existing && existing.turn_id !== turnId) {
      db.prepare("UPDATE x_support_runtime_turns SET state = 'interrupted' WHERE id = ? AND state = 'processing'").run(existing.turn_id);
    }

    db.prepare(
      `INSERT INTO x_support_runtime_leases (tenant_id, conversation_id, turn_id, lease_until)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, conversation_id)
       DO UPDATE SET turn_id = excluded.turn_id, lease_until = excluded.lease_until`,
    ).run(tenantId, conversationId, turnId, leaseUntil);

    return true;
  });

  return runTx();
}

export function releaseSupportConversationLease(
  tenantId: number,
  conversationId: string,
  turnId: string,
): void {
  const db = ensureSupportRuntimeTables();
  db.prepare(
    `DELETE FROM x_support_runtime_leases
     WHERE tenant_id = ? AND conversation_id = ? AND turn_id = ?`,
  ).run(tenantId, conversationId, turnId);
}

// ---------------------------------------------------------------------------
// Quota Reservation Storage
// ---------------------------------------------------------------------------

export interface SupportQuotaReservationRecord {
  id: string;
  tenantId: number;
  userId: string;
  turnId: string;
  windowStart: number;
  windowSeconds: number;
  reservedTokens: number;
  actualTokens: number | null;
  state: 'reserved' | 'settled' | 'released';
  createdAt: string;
  settledAt: string | null;
}

export function createSupportQuotaReservation(options: {
  tenantId: number;
  userId: string;
  turnId: string;
  windowStart: number;
  windowSeconds: number;
  reservedTokens: number;
}): { id: string } {
  const db = ensureSupportRuntimeTables();
  const id = `res_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO x_support_runtime_reservations (
      id, tenant_id, user_id, turn_id, window_start, window_seconds, reserved_tokens,
      state, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`,
  ).run(
    id,
    options.tenantId,
    options.userId,
    options.turnId,
    options.windowStart,
    options.windowSeconds,
    options.reservedTokens,
    now,
  );

  return { id };
}

export function settleSupportQuotaReservation(options: {
  turnId: string;
  actualTokens?: number;
  released?: boolean;
}): SupportQuotaReservationRecord | null {
  const db = ensureSupportRuntimeTables();

  const runTx = db.transaction(() => {
    const row = db.prepare(
      `SELECT id, tenant_id, user_id, turn_id, window_start, window_seconds, reserved_tokens,
              actual_tokens, state, created_at, settled_at
       FROM x_support_runtime_reservations
       WHERE turn_id = ?`,
    ).get(options.turnId) as {
      id: string;
      tenant_id: number;
      user_id: string;
      turn_id: string;
      window_start: number;
      window_seconds: number;
      reserved_tokens: number;
      actual_tokens: number | null;
      state: 'reserved' | 'settled' | 'released';
      created_at: string;
      settled_at: string | null;
    } | undefined;

    if (!row) return null;

    const nextState: 'reserved' | 'settled' | 'released' = options.released ? 'released' : 'settled';
    const now = new Date().toISOString();
    const actual = options.actualTokens !== undefined ? options.actualTokens : row.actual_tokens;

    db.prepare(
      `UPDATE x_support_runtime_reservations
       SET state = ?, actual_tokens = ?, settled_at = ?
       WHERE turn_id = ? AND state = 'reserved'`,
    ).run(nextState, actual, now, options.turnId);

    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      turnId: row.turn_id,
      windowStart: row.window_start,
      windowSeconds: row.window_seconds,
      reservedTokens: row.reserved_tokens,
      actualTokens: actual,
      state: nextState,
      createdAt: row.created_at,
      settledAt: now,
    };
  });

  return runTx();
}

export function getSupportQuotaReservation(turnId: string): SupportQuotaReservationRecord | null {
  const db = ensureSupportRuntimeTables();
  const row = db.prepare(
    `SELECT id, tenant_id, user_id, turn_id, window_start, window_seconds, reserved_tokens,
            actual_tokens, state, created_at, settled_at
     FROM x_support_runtime_reservations
     WHERE turn_id = ?`,
  ).get(turnId) as {
    id: string;
    tenant_id: number;
    user_id: string;
    turn_id: string;
    window_start: number;
    window_seconds: number;
    reserved_tokens: number;
    actual_tokens: number | null;
    state: 'reserved' | 'settled' | 'released';
    created_at: string;
    settled_at: string | null;
  } | undefined;

  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    turnId: row.turn_id,
    windowStart: row.window_start,
    windowSeconds: row.window_seconds,
    reservedTokens: row.reserved_tokens,
    actualTokens: row.actual_tokens,
    state: row.state,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}
