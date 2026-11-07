import { getDb } from '../../db/index.js';
import { decryptProxyUrl, encryptProxyUrl, isValidKeyProxyUrl, KEY_PROXY_URL_ERROR, maskProxyUrl } from '../../lib/key-proxy.js';

/**
 * X Gateway proxy pool (9Router port). Entries are named outbound proxies;
 * accounts bind stickily via x_gateway_keys.proxy_pool_id. URLs are stored
 * encrypted like per-account overrides and only leave this module masked,
 * except resolvePoolProxyUrl/proxyPoolEntryUrl which feed the dispatch layer.
 */

export const MAX_POOL_ENTRIES = 100;
export const POOL_NAME_MAX = 64;

export interface ProxyPoolEntry {
  id: number;
  name: string;
  proxyUrl: string;
  enabled: boolean;
  boundAccounts: number;
  createdAt: string;
  updatedAt: string;
}

export class ProxyPoolError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

interface PoolRow {
  id: number;
  name: string;
  proxy_encrypted: string | null;
  proxy_iv: string | null;
  proxy_auth_tag: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
  boundAccounts?: number;
}

function toEntry(row: PoolRow): ProxyPoolEntry {
  return {
    id: Number(row.id),
    name: row.name,
    proxyUrl: maskProxyUrl(decryptProxyUrl(row)),
    enabled: Number(row.enabled) === 1,
    boundAccounts: Number(row.boundAccounts ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > POOL_NAME_MAX || [...trimmed].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    throw new ProxyPoolError(400, `Name must be 1-${POOL_NAME_MAX} printable characters.`);
  }
  return trimmed;
}

function validateUrl(proxyUrl: string): string {
  const trimmed = proxyUrl.trim();
  if (!trimmed || !isValidKeyProxyUrl(trimmed)) {
    throw new ProxyPoolError(400, KEY_PROXY_URL_ERROR);
  }
  return trimmed;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

function rowById(id: number): PoolRow | undefined {
  return getDb().prepare('SELECT * FROM x_gateway_proxy_pool WHERE id = ?').get(id) as PoolRow | undefined;
}

function entryWithCount(id: number): ProxyPoolEntry {
  const row = getDb().prepare(`
    SELECT p.*, COUNT(k.id) AS boundAccounts
    FROM x_gateway_proxy_pool p
    LEFT JOIN x_gateway_keys k ON k.proxy_pool_id = p.id
    WHERE p.id = ?
    GROUP BY p.id
  `).get(id) as PoolRow | undefined;
  if (!row) throw new ProxyPoolError(404, 'Proxy pool entry not found.');
  return toEntry(row);
}

export function listProxyPool(): ProxyPoolEntry[] {
  const rows = getDb().prepare(`
    SELECT p.*, COUNT(k.id) AS boundAccounts
    FROM x_gateway_proxy_pool p
    LEFT JOIN x_gateway_keys k ON k.proxy_pool_id = p.id
    GROUP BY p.id
    ORDER BY p.id
  `).all() as PoolRow[];
  return rows.map(toEntry);
}

export function proxyPoolExists(id: number): boolean {
  return Boolean(getDb().prepare('SELECT 1 FROM x_gateway_proxy_pool WHERE id = ?').get(id));
}

/** Plaintext URL of an enabled entry, '' when missing/disabled/undecryptable. */
export function resolvePoolProxyUrl(poolId: number | null | undefined): string {
  if (poolId == null) return '';
  const row = getDb()
    .prepare('SELECT proxy_encrypted, proxy_iv, proxy_auth_tag, enabled FROM x_gateway_proxy_pool WHERE id = ?')
    .get(poolId) as PoolRow | undefined;
  if (!row || Number(row.enabled) !== 1) return '';
  return decryptProxyUrl(row);
}

/** Plaintext URL for the test probe — works on disabled entries too. */
export function proxyPoolEntryUrl(id: number): string {
  const row = rowById(id);
  if (!row) throw new ProxyPoolError(404, 'Proxy pool entry not found.');
  return decryptProxyUrl(row);
}

/**
 * Round-robin assignment: the enabled entry with the fewest bound accounts
 * (ties → lowest id). Counting rows instead of keeping a cursor survives
 * restarts and rebalances after deletions.
 */
export function pickAutoProxyPoolId(): number | null {
  const row = getDb().prepare(`
    SELECT p.id, COUNT(k.id) AS bound
    FROM x_gateway_proxy_pool p
    LEFT JOIN x_gateway_keys k ON k.proxy_pool_id = p.id
    WHERE p.enabled = 1
    GROUP BY p.id
    ORDER BY bound ASC, p.id ASC
    LIMIT 1
  `).get() as { id: number } | undefined;
  return row ? Number(row.id) : null;
}

export function createProxyPoolEntry(name: string, proxyUrl: string, createdBy?: number): ProxyPoolEntry {
  const cleanName = validateName(name);
  const cleanUrl = validateUrl(proxyUrl);
  const count = getDb().prepare('SELECT COUNT(*) AS n FROM x_gateway_proxy_pool').get() as { n: number };
  if (Number(count.n) >= MAX_POOL_ENTRIES) {
    throw new ProxyPoolError(400, `Maximum limit of ${MAX_POOL_ENTRIES} proxy pool entries reached.`);
  }
  const enc = encryptProxyUrl(cleanUrl);
  const now = new Date().toISOString();
  try {
    const result = getDb().prepare(`
      INSERT INTO x_gateway_proxy_pool (name, proxy_encrypted, proxy_iv, proxy_auth_tag, enabled, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    `).run(cleanName, enc.encrypted, enc.iv, enc.authTag, createdBy ?? null, now, now);
    return entryWithCount(Number(result.lastInsertRowid));
  } catch (err) {
    if (isUniqueViolation(err)) throw new ProxyPoolError(409, 'An entry with this name already exists.');
    throw err;
  }
}

export function updateProxyPoolEntry(
  id: number,
  patch: { name?: string; proxyUrl?: string; enabled?: boolean },
): ProxyPoolEntry {
  const existing = rowById(id);
  if (!existing) throw new ProxyPoolError(404, 'Proxy pool entry not found.');
  const nextName = patch.name !== undefined ? validateName(patch.name) : existing.name;
  let enc = { encrypted: existing.proxy_encrypted, iv: existing.proxy_iv, authTag: existing.proxy_auth_tag };
  if (patch.proxyUrl !== undefined) {
    enc = encryptProxyUrl(validateUrl(patch.proxyUrl));
  }
  const nextEnabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : Number(existing.enabled);
  try {
    getDb().prepare(`
      UPDATE x_gateway_proxy_pool
      SET name = ?, proxy_encrypted = ?, proxy_iv = ?, proxy_auth_tag = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(nextName, enc.encrypted, enc.iv, enc.authTag, nextEnabled, new Date().toISOString(), id);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ProxyPoolError(409, 'An entry with this name already exists.');
    throw err;
  }
  return entryWithCount(id);
}

export function deleteProxyPoolEntry(id: number): boolean {
  // FK ON DELETE SET NULL unbinds accounts; they fall back to the gateway proxy.
  const result = getDb().prepare('DELETE FROM x_gateway_proxy_pool WHERE id = ?').run(id);
  return result.changes > 0;
}