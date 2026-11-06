import crypto from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getDb } from '../db/index.js';
import { parseStoredPermissions, type Permission } from '@freellmapi/shared/permissions.js';

export const USER_KEY_PREFIX = 'sk-flm-';

export type { UserApiKey as UserApiKeyRow } from '@freellmapi/shared/user-access.js';
import type { UserApiKey as UserApiKeyRow } from '@freellmapi/shared/user-access.js';

export interface ValidatedUserKey {
  userId: number;
  email: string;
  role: 'admin' | 'member';
  rpmLimit: number;
  isPrimary: boolean;
  permissions: readonly Permission[];
}

function sha256(val: string): string {
  return crypto.createHash('sha256').update(val).digest('hex');
}

/**
 * Mint a new user API key. Returns the plaintext key once (only the SHA-256 hash is persisted for auth).
 */
export function mintUserApiKey(
  userId: number,
  name: string = 'Default Key',
): { id: number; key: string; keyPrefix: string; name: string; createdAt: string } {
  const db = getDb();
  const rawSecret = crypto.randomBytes(24).toString('hex');
  const key = `${USER_KEY_PREFIX}${rawSecret}`;
  const keyHash = sha256(key);
  const keyPrefix = `${key.slice(0, 11)}…${key.slice(-4)}`;

  const result = db.prepare(`
    INSERT INTO user_api_keys (user_id, name, key_hash, key_prefix)
    VALUES (?, ?, ?, ?)
  `).run(userId, name.trim() || 'Default Key', keyHash, keyPrefix);

  const row = db.prepare(`
    SELECT id, name, key_prefix, created_at
    FROM user_api_keys
    WHERE id = ?
  `).get(result.lastInsertRowid) as { id: number; name: string; key_prefix: string; created_at: string };

  return {
    id: row.id,
    key,
    keyPrefix: row.key_prefix,
    name: row.name,
    createdAt: row.created_at,
  };
}

/**
 * List all active/revoked API keys for a given user.
 */
export function listUserApiKeys(userId: number): UserApiKeyRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, user_id, name, key_prefix, rpm_limit, revoked, created_at, last_used_at
    FROM user_api_keys
    WHERE user_id = ?
    ORDER BY id DESC
  `).all(userId) as Array<{
    id: number;
    user_id: number;
    name: string;
    key_prefix: string;
    rpm_limit: number;
    revoked: number;
    created_at: string;
    last_used_at: string | null;
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
    SELECT k.id as key_id, k.user_id, k.rpm_limit, k.revoked, u.email, u.role, u.is_primary, u.permissions
    FROM user_api_keys k
    JOIN users u ON u.id = k.user_id
    WHERE k.key_hash = ?
  `).get(keyHash) as {
    key_id: number;
    user_id: number;
    rpm_limit: number;
    revoked: number;
    email: string;
    role: string;
    is_primary: number;
    permissions: string | null;
  } | undefined;

  if (!row || row.revoked) return null;

  touchLastUsed(keyHash, row.key_id);

  const role: 'admin' | 'member' = row.role === 'admin' ? 'admin' : 'member';
  const isPrimary = Boolean(row.is_primary);
  const permissions = parseStoredPermissions(row.permissions, role, isPrimary);

  return {
    userId: row.user_id,
    email: row.email,
    role,
    rpmLimit: row.rpm_limit || 60,
    isPrimary,
    permissions,
  };
}
