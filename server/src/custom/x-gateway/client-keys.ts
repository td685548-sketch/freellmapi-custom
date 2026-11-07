import crypto from 'node:crypto';
import { getDb } from '../../db/index.js';
import { parseStoredPermissions } from '@freellmapi/shared/permissions.js';
import type { ValidatedUserKey } from '../../services/user-keys.js';

export const X_GATEWAY_KEY_PREFIX = 'sk-xgw-';

export interface XGatewayKeyAccess {
  restricted: boolean;
  allowedModels: string[];
}

export interface XGatewayClientKeyRow {
  id: number;
  userId: number;
  name: string;
  keyPrefix: string;
  rpmLimit: number;
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  access?: XGatewayKeyAccess;
}

export interface ValidatedXGatewayClientKey extends ValidatedUserKey {
  access?: XGatewayKeyAccess;
  keyId?: number;
}

function sha256(val: string): string {
  return crypto.createHash('sha256').update(val).digest('hex');
}

export function isXGatewayClientKey(token: string | undefined): boolean {
  return Boolean(token && token.startsWith(X_GATEWAY_KEY_PREFIX));
}

export function mintXGatewayClientKey(
  userId: number,
  name: string = 'X Gateway Key',
): { id: number; key: string; keyPrefix: string; name: string; createdAt: string } {
  const db = getDb();
  const rawSecret = crypto.randomBytes(24).toString('hex');
  const key = `${X_GATEWAY_KEY_PREFIX}${rawSecret}`;
  const keyHash = sha256(key);
  const keyPrefix = `${key.slice(0, 11)}…${key.slice(-4)}`;

  const result = db.prepare(`
    INSERT INTO x_gateway_client_keys (user_id, name, key_hash, key_prefix)
    VALUES (?, ?, ?, ?)
  `).run(userId, name.trim() || 'X Gateway Key', keyHash, keyPrefix);

  const row = db.prepare(`
    SELECT id, name, key_prefix, created_at
    FROM x_gateway_client_keys
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

export type XGatewayKeyAccessInput = {
  restricted: boolean;
  allowedModels?: string[];
  allow?: string[];
};

export function updateXGatewayClientKeyAccess(
  keyIdOrUserId: number,
  accessOrKeyId: number | XGatewayKeyAccessInput,
  maybeAccess?: XGatewayKeyAccessInput
): boolean {
  const db = getDb();
  let keyId: number;
  let access: { restricted: boolean; allowedModels: string[] };
  let userId: number | undefined;

  if (typeof accessOrKeyId === 'number') {
    userId = keyIdOrUserId;
    keyId = accessOrKeyId;
    const raw = maybeAccess || { restricted: false, allowedModels: [] };
    access = {
      restricted: Boolean(raw.restricted),
      allowedModels: raw.allowedModels || raw.allow || [],
    };
  } else {
    keyId = keyIdOrUserId;
    const raw = accessOrKeyId;
    access = {
      restricted: Boolean(raw.restricted),
      allowedModels: raw.allowedModels || raw.allow || [],
    };
  }

  const query = userId !== undefined
    ? 'UPDATE x_gateway_client_keys SET access_restricted = ?, allowed_models = ? WHERE id = ? AND user_id = ?'
    : 'UPDATE x_gateway_client_keys SET access_restricted = ?, allowed_models = ? WHERE id = ?';

  const params = userId !== undefined
    ? [access.restricted ? 1 : 0, JSON.stringify(access.allowedModels), keyId, userId]
    : [access.restricted ? 1 : 0, JSON.stringify(access.allowedModels), keyId];

  const result = db.prepare(query).run(...params);
  return result.changes > 0;
}

export function isModelAllowedForKey(access: XGatewayKeyAccess | undefined, requestedModel: string): boolean {
  if (!access || !access.restricted) return true;
  const clean = requestedModel.toLowerCase().trim();
  const withoutCombo = clean.startsWith('combo:') ? clean.slice(6) : clean;
  return access.allowedModels.some(m => {
    const mClean = m.toLowerCase().trim();
    const mWithoutCombo = mClean.startsWith('combo:') ? mClean.slice(6) : mClean;
    return mClean === clean || mWithoutCombo === withoutCombo;
  });
}

export function listXGatewayClientKeys(userId: number): XGatewayClientKeyRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, user_id, name, key_prefix, rpm_limit, revoked, created_at, last_used_at,
           access_restricted, allowed_models
    FROM x_gateway_client_keys
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
    access_restricted?: number;
    allowed_models?: string | null;
  }>;

  return rows.map(r => {
    let allowedModels: string[] = [];
    try {
      if (r.allowed_models) allowedModels = JSON.parse(r.allowed_models);
    } catch {
      allowedModels = [];
    }
    return {
      id: r.id,
      userId: r.user_id,
      name: r.name,
      keyPrefix: r.key_prefix,
      rpmLimit: r.rpm_limit,
      revoked: Boolean(r.revoked),
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      access: {
        restricted: Boolean(r.access_restricted),
        allowedModels,
      },
    };
  });
}

export function revokeXGatewayClientKey(userId: number, keyId: number): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE x_gateway_client_keys
    SET revoked = 1
    WHERE id = ? AND user_id = ? AND revoked = 0
  `).run(keyId, userId);
  return result.changes > 0;
}

const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const MAX_TRACKED_KEYS = 5_000;
const lastTouched = new Map<string, number>();

function touchLastUsed(keyHash: string, keyId: number): void {
  const now = Date.now();
  const prev = lastTouched.get(keyHash);
  if (prev !== undefined && now - prev < LAST_USED_WRITE_INTERVAL_MS) return;
  try {
    getDb().prepare("UPDATE x_gateway_client_keys SET last_used_at = datetime('now') WHERE id = ?").run(keyId);
    if (lastTouched.size >= MAX_TRACKED_KEYS) lastTouched.clear();
    lastTouched.set(keyHash, now);
  } catch {
    // Best-effort
  }
}

export function validateXGatewayClientKey(token: string | undefined): ValidatedXGatewayClientKey | null {
  if (!token || !token.startsWith(X_GATEWAY_KEY_PREFIX)) return null;
  const db = getDb();
  const keyHash = sha256(token);

  const row = db.prepare(`
    SELECT k.id as key_id, k.user_id, k.rpm_limit, k.revoked, k.access_restricted, k.allowed_models,
           u.email, u.role, u.is_primary, u.permissions
    FROM x_gateway_client_keys k
    JOIN users u ON u.id = k.user_id
    WHERE k.key_hash = ?
  `).get(keyHash) as {
    key_id: number;
    user_id: number;
    rpm_limit: number;
    revoked: number;
    access_restricted?: number;
    allowed_models?: string | null;
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

  let allowedModels: string[] = [];
  try {
    if (row.allowed_models) allowedModels = JSON.parse(row.allowed_models);
  } catch {
    allowedModels = [];
  }

  return {
    userId: row.user_id,
    email: row.email,
    role,
    rpmLimit: row.rpm_limit || 60,
    isPrimary,
    permissions,
    keyId: row.key_id,
    access: {
      restricted: Boolean(row.access_restricted),
      allowedModels,
    },
  };
}
