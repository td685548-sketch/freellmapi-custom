import crypto from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getDb } from '../db/index.js';
import { parseStoredPermissions, type Permission } from '@freellmapi/shared/permissions.js';
import type { KeyRoutingMode } from '@freellmapi/shared/customer-ai.js';
import {
  assertBindableAssistant,
  composeUserKeySystemPrompt,
  normalizeRoutingMode,
} from '../custom/customer-ai/store.js';

export const USER_KEY_PREFIX = 'sk-flm-';

export type { UserApiKey as UserApiKeyRow } from '@freellmapi/shared/user-access.js';
import type { UserApiKey as UserApiKeyRow } from '@freellmapi/shared/user-access.js';

export interface ValidatedUserKey {
  keyId?: number;
  userId: number;
  email: string;
  role: 'admin' | 'member';
  rpmLimit: number;
  isPrimary: boolean;
  permissions: readonly Permission[];
  routingMode?: KeyRoutingMode;
  assistantId?: number | null;
  systemPrompt?: string | null;
}

function sha256(val: string): string {
  return crypto.createHash('sha256').update(val).digest('hex');
}

/**
 * SHA-256 hash of a user API key — the same value stored as `key_hash`.
 * Rate limiting buckets by this hash (middleware/rateLimit.ts) so the raw key
 * never lands in a map key, a log line, or a header, and a key keeps one
 * budget no matter which IP it arrives from.
 */
export function hashUserApiKey(token: string): string {
  return sha256(token);
}

/**
 * Mint a new user API key. Returns the plaintext key once (only the SHA-256 hash is persisted for auth).
 */
export function mintUserApiKey(
  userId: number,
  name: string = 'Default Key',
  options?: { routingMode?: KeyRoutingMode; assistantId?: number | null; callerRole?: 'admin' | 'member' },
): { id: number; key: string; keyPrefix: string; name: string; createdAt: string; routingMode: KeyRoutingMode; assistantId: number | null } {
  const db = getDb();
  const rawSecret = crypto.randomBytes(24).toString('hex');
  const key = `${USER_KEY_PREFIX}${rawSecret}`;
  const keyHash = sha256(key);
  const keyPrefix = `${key.slice(0, 11)}…${key.slice(-4)}`;
  const routingMode = normalizeRoutingMode(options?.routingMode, 'default');
  const assistantId = options?.assistantId !== undefined
    ? assertBindableAssistant(options.assistantId, options.callerRole ?? 'member')
    : null;

  const result = db.prepare(`
    INSERT INTO user_api_keys (user_id, name, key_hash, key_prefix, routing_mode, assistant_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, name.trim() || 'Default Key', keyHash, keyPrefix, routingMode, assistantId);

  const row = db.prepare(`
    SELECT id, name, key_prefix, created_at, routing_mode, assistant_id
    FROM user_api_keys
    WHERE id = ?
  `).get(result.lastInsertRowid) as {
    id: number;
    name: string;
    key_prefix: string;
    created_at: string;
    routing_mode: string;
    assistant_id: number | null;
  };

  return {
    id: row.id,
    key,
    keyPrefix: row.key_prefix,
    name: row.name,
    createdAt: row.created_at,
    routingMode: normalizeRoutingMode(row.routing_mode, 'default'),
    assistantId: row.assistant_id ?? null,
  };
}

/**
 * List all active/revoked API keys for a given user.
 */
export function listUserApiKeys(userId: number): UserApiKeyRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      k.id, k.user_id, k.name, k.key_prefix, k.rpm_limit, k.revoked, k.created_at, k.last_used_at,
      k.routing_mode,
      a.id AS active_assistant_id,
      a.slug AS assistant_slug,
      a.name AS assistant_name
    FROM user_api_keys k
    LEFT JOIN custom_ai_assistants a ON a.id = k.assistant_id AND a.enabled = 1
    WHERE k.user_id = ?
    ORDER BY k.id DESC
  `).all(userId) as Array<{
    id: number;
    user_id: number;
    name: string;
    key_prefix: string;
    rpm_limit: number;
    revoked: number;
    created_at: string;
    last_used_at: string | null;
    routing_mode: string | null;
    active_assistant_id: number | null;
    assistant_slug: string | null;
    assistant_name: string | null;
  }>;

  return rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    name: r.name,
    keyPrefix: r.key_prefix,
    rpmLimit: r.rpm_limit,
    revoked: Boolean(r.revoked),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    routingMode: normalizeRoutingMode(r.routing_mode, 'default'),
    assistantId: r.active_assistant_id ?? null,
    assistantSlug: r.assistant_slug ?? null,
    assistantName: r.assistant_name ?? null,
  }));
}

/**
 * Revoke an API key belonging to a specific user.
 */
export function revokeUserApiKey(userId: number, keyId: number): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE user_api_keys
    SET revoked = 1
    WHERE id = ? AND user_id = ? AND revoked = 0
  `).run(keyId, userId);
  return result.changes > 0;
}

/**
 * Rotate an existing personal API key: mints a new key inheriting the same name,
 * routingMode, and assistantId, and atomically marks the old key as revoked.
 */
export function rotateUserApiKey(
  userId: number,
  keyId: number,
  callerRole: 'admin' | 'member' = 'member',
): {
  oldKeyId: number;
  key: {
    id: number;
    key: string;
    keyPrefix: string;
    name: string;
    createdAt: string;
    routingMode: KeyRoutingMode;
    assistantId: number | null;
  };
} {
  const db = getDb();
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id, name, routing_mode, assistant_id, revoked
      FROM user_api_keys
      WHERE id = ? AND user_id = ?
    `).get(keyId, userId) as
      | {
          id: number;
          name: string;
          routing_mode: string | null;
          assistant_id: number | null;
          revoked: number;
        }
      | undefined;

    if (!existing || existing.revoked) {
      const err = new Error('Key not found or already revoked.') as any;
      err.code = 'key_not_found';
      err.status = 404;
      throw err;
    }

    const minted = mintUserApiKey(userId, existing.name, {
      routingMode: normalizeRoutingMode(existing.routing_mode, 'default'),
      assistantId: existing.assistant_id,
      callerRole,
    });

    db.prepare(`
      UPDATE user_api_keys
      SET revoked = 1
      WHERE id = ? AND user_id = ?
    `).run(keyId, userId);

    return {
      oldKeyId: keyId,
      key: minted,
    };
  })();
}

// last_used_at is informational (shown in the key list), but it used to be an
// UPDATE on every authenticated request, and each request authenticates twice
// (the /v1 limit gate, then resolveAuth). SQLite serialises writers and a remote
// Turso write is a network round trip, so that put a write on the hot path of
// every inference call. Writing at most once a minute per key keeps the column
// accurate to the minute for a fraction of the cost. Keyed by hash, not row id,
// so a recreated database never inherits another database's throttle state.
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;
const lastTouched = new Map<string, number>();

function touchLastUsed(keyHash: string, keyId: number): void {
  const now = Date.now();
  const prev = lastTouched.get(keyHash);
  if (prev !== undefined && now - prev < LAST_USED_WRITE_INTERVAL_MS) return;
  try {
    getDb().prepare("UPDATE user_api_keys SET last_used_at = datetime('now') WHERE id = ?").run(keyId);
    if (lastTouched.size >= MAX_TRACKED_KEYS) lastTouched.clear();
    lastTouched.set(keyHash, now);
  } catch {
    // Best effort: a lock/concurrency error must never fail authentication.
  }
}

/**
 * Validate an incoming user API key (used by /v1 inference routing).
 */
// One inference request authenticates the same personal key twice: in the /v1
// limit gate and again in resolveAuth. The gate opens this scope so the second
// lookup reuses the first answer instead of repeating the query (a network round
// trip on a remote database). It lives only as long as the request that opened
// it, so a revocation is honoured by the very next request.
const requestMemo = new AsyncLocalStorage<Map<string, ValidatedUserKey | null>>();

export function withUserKeyMemo<T>(run: () => T): T {
  // Reuse an enclosing memo when one already exists for this request: the
  // proxy rate limiter (middleware/rateLimit.ts) opens a memo so the key
  // validation it performs is reused by the user gate and resolveAuth
  // downstream, instead of each of them repeating the lookup. A memo still
  // lives only as long as its request, so a revocation is honoured by the
  // very next request either way.
  if (requestMemo.getStore()) return run();
  return requestMemo.run(new Map(), run);
}

export function getMemoizedUserKey(): ValidatedUserKey | null {
  const memo = requestMemo.getStore();
  if (!memo) return null;
  for (const userKey of memo.values()) {
    if (userKey) return userKey;
  }
  return null;
}

export function validateUserApiKey(token: string | undefined): ValidatedUserKey | null {
  if (!token || !token.startsWith(USER_KEY_PREFIX)) return null;
  const memo = requestMemo.getStore();
  if (memo?.has(token)) return memo.get(token) ?? null;
  const result = lookupUserApiKey(token);
  memo?.set(token, result);
  return result;
}

function lookupUserApiKey(token: string): ValidatedUserKey | null {

  const db = getDb();
  const keyHash = sha256(token);

  const row = db.prepare(`
    SELECT
      k.id as key_id, k.user_id, k.rpm_limit, k.revoked,
      k.routing_mode, k.assistant_id,
      u.email, u.role, u.is_primary, u.permissions,
      a.id as active_assistant_id,
      a.system_prompt as assistant_prompt,
      p.custom_instructions as custom_instructions,
      p.apply_to_keys as apply_to_keys
    FROM user_api_keys k
    JOIN users u ON u.id = k.user_id
    LEFT JOIN custom_ai_assistants a
      ON a.id = k.assistant_id
      AND a.enabled = 1
      AND (u.role = 'admin' OR a.audience <> 'admin_only')
    LEFT JOIN custom_user_ai_preferences p ON p.user_id = u.id
    WHERE k.key_hash = ?
  `).get(keyHash) as {
    key_id: number;
    user_id: number;
    rpm_limit: number;
    revoked: number;
    routing_mode: string | null;
    assistant_id: number | null;
    email: string;
    role: string;
    is_primary: number;
    permissions: string | null;
    active_assistant_id: number | null;
    assistant_prompt: string | null;
    custom_instructions: string | null;
    apply_to_keys: number | null;
  } | undefined;

  if (!row || row.revoked) return null;

  touchLastUsed(keyHash, row.key_id);

  const role: 'admin' | 'member' = row.role === 'admin' ? 'admin' : 'member';
  const isPrimary = Boolean(row.is_primary);
  const permissions = parseStoredPermissions(row.permissions, role, isPrimary);
  const routingMode = normalizeRoutingMode(row.routing_mode, 'default');
  const applyToKeys = row.apply_to_keys === null ? true : Boolean(row.apply_to_keys);
  const systemPrompt = composeUserKeySystemPrompt(row.assistant_prompt, row.custom_instructions, applyToKeys);

  return {
    keyId: row.key_id,
    userId: row.user_id,
    email: row.email,
    role,
    rpmLimit: row.rpm_limit || 60,
    isPrimary,
    permissions,
    routingMode,
    assistantId: row.active_assistant_id ?? null,
    systemPrompt,
  };
}
