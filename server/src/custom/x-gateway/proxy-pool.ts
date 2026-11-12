import crypto from 'node:crypto';
import { sanitizeProviderErrorMessage } from '../../lib/error-redaction.js';
import { getDb, getSetting, setSetting } from '../../db/index.js';
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
  webhookEnabled: boolean;
  webhookToken: string | null;
  lastWebhookAt: number;
  lastTestOk: boolean | null;
  lastTestLatency: number | null;
  lastTestMessage: string | null;
  lastTestAt: string | null;
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
  webhook_token?: string | null;
  webhook_enabled?: number;
  last_webhook_at?: number;
  last_test_ok?: number | null;
  last_test_latency?: number | null;
  last_test_message?: string | null;
  last_test_at?: string | null;
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
    webhookEnabled: Number(row.webhook_enabled ?? 0) === 1,
    webhookToken: row.webhook_token ?? null,
    lastWebhookAt: Number(row.last_webhook_at ?? 0),
    lastTestOk: row.last_test_ok === null || row.last_test_ok === undefined ? null : Number(row.last_test_ok) === 1,
    lastTestLatency: row.last_test_latency !== null && row.last_test_latency !== undefined ? Number(row.last_test_latency) : null,
    lastTestMessage: row.last_test_message ?? null,
    lastTestAt: row.last_test_at ?? null,
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

export function generateWebhookToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function createProxyPoolEntry(
  name: string,
  proxyUrl: string,
  createdBy?: number,
  webhookEnabled?: boolean,
): ProxyPoolEntry {
  const cleanName = validateName(name);
  const cleanUrl = validateUrl(proxyUrl);
  const count = getDb().prepare('SELECT COUNT(*) AS n FROM x_gateway_proxy_pool').get() as { n: number };
  if (Number(count.n) >= MAX_POOL_ENTRIES) {
    throw new ProxyPoolError(400, `Maximum limit of ${MAX_POOL_ENTRIES} proxy pool entries reached.`);
  }
  const enc = encryptProxyUrl(cleanUrl);
  const now = new Date().toISOString();
  const token = webhookEnabled ? generateWebhookToken() : null;
  try {
    const result = getDb().prepare(`
      INSERT INTO x_gateway_proxy_pool (
        name, proxy_encrypted, proxy_iv, proxy_auth_tag, enabled, created_by, created_at, updated_at,
        webhook_token, webhook_enabled
      )
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(cleanName, enc.encrypted, enc.iv, enc.authTag, createdBy ?? null, now, now, token, webhookEnabled ? 1 : 0);
    return entryWithCount(Number(result.lastInsertRowid));
  } catch (err) {
    if (isUniqueViolation(err)) throw new ProxyPoolError(409, 'An entry with this name already exists.');
    throw err;
  }
}

export function updateProxyPoolEntry(
  id: number,
  patch: {
    name?: string;
    proxyUrl?: string;
    enabled?: boolean;
    webhookEnabled?: boolean;
    webhookToken?: string | null;
  },
): ProxyPoolEntry {
  const existing = rowById(id);
  if (!existing) throw new ProxyPoolError(404, 'Proxy pool entry not found.');
  const nextName = patch.name !== undefined ? validateName(patch.name) : existing.name;
  let enc = { encrypted: existing.proxy_encrypted, iv: existing.proxy_iv, authTag: existing.proxy_auth_tag };
  if (patch.proxyUrl !== undefined) {
    enc = encryptProxyUrl(validateUrl(patch.proxyUrl));
  }
  const nextEnabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : Number(existing.enabled);

  let nextWebhookEnabled = existing.webhook_enabled ? Number(existing.webhook_enabled) : 0;
  let nextWebhookToken = existing.webhook_token ?? null;

  if (patch.webhookEnabled !== undefined) {
    nextWebhookEnabled = patch.webhookEnabled ? 1 : 0;
    if (nextWebhookEnabled && !nextWebhookToken && !patch.webhookToken) {
      nextWebhookToken = generateWebhookToken();
    }
  }
  if (patch.webhookToken !== undefined) {
    nextWebhookToken = patch.webhookToken;
  }

  try {
    getDb().prepare(`
      UPDATE x_gateway_proxy_pool
      SET name = ?, proxy_encrypted = ?, proxy_iv = ?, proxy_auth_tag = ?, enabled = ?,
          webhook_enabled = ?, webhook_token = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextName,
      enc.encrypted,
      enc.iv,
      enc.authTag,
      nextEnabled,
      nextWebhookEnabled,
      nextWebhookToken,
      new Date().toISOString(),
      id,
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new ProxyPoolError(409, 'An entry with this name already exists.');
    throw err;
  }
  return entryWithCount(id);
}

export function regenerateProxyWebhookToken(id: number): ProxyPoolEntry {
  const existing = rowById(id);
  if (!existing) throw new ProxyPoolError(404, 'Proxy pool entry not found.');
  const newToken = generateWebhookToken();
  getDb().prepare(`
    UPDATE x_gateway_proxy_pool
    SET webhook_token = ?, webhook_enabled = 1, updated_at = ?
    WHERE id = ?
  `).run(newToken, new Date().toISOString(), id);
  return entryWithCount(id);
}

export function recordProxyTestResult(
  id: number,
  ok: boolean,
  latencyMs: number,
  message?: string | null,
): void {
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE x_gateway_proxy_pool
    SET last_test_ok = ?, last_test_latency = ?, last_test_message = ?, last_test_at = ?, updated_at = ?
    WHERE id = ?
  `).run(ok ? 1 : 0, latencyMs, message ?? null, now, now, id);
}

export function updateProxyWebhookUrl(
  id: number,
  newUrl: string,
  timestamp: number,
): ProxyPoolEntry {
  const existing = rowById(id);
  if (!existing) throw new ProxyPoolError(404, 'Proxy pool entry not found.');
  const cleanUrl = validateUrl(newUrl);
  const enc = encryptProxyUrl(cleanUrl);
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE x_gateway_proxy_pool
    SET proxy_encrypted = ?, proxy_iv = ?, proxy_auth_tag = ?, last_webhook_at = ?, updated_at = ?
    WHERE id = ?
  `).run(enc.encrypted, enc.iv, enc.authTag, timestamp, now, id);
  return entryWithCount(id);
}

export function deleteProxyPoolEntry(id: number): boolean {
  // FK ON DELETE SET NULL unbinds accounts; they fall back to the gateway proxy.
  const result = getDb().prepare('DELETE FROM x_gateway_proxy_pool WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Parse a raw proxy line in various formats:
 * - Scheme URLs: http://user:pass@host:port, https://..., socks5://..., socks4://...
 * - host:port:user:pass (converted to http://user:pass@host:port)
 * - host:port (converted to http://host:port)
 * - user:pass@host:port (converted to http://user:pass@host:port)
 * Optional explicit name prefix supported via "name=url" or "name|url"
 */
export function parseProxyLine(rawLine: string): { url: string; suggestedName: string } {
  let line = rawLine.trim();
  if (!line) {
    throw new ProxyPoolError(400, 'Empty proxy line.');
  }

  let explicitName: string | undefined;
  const nameSeparator = line.includes('|') ? '|' : (line.includes(' #') ? ' #' : undefined);
  if (nameSeparator) {
    const parts = line.split(nameSeparator);
    if (parts.length >= 2) {
      if (nameSeparator === '|') {
        explicitName = parts[0].trim();
        line = parts.slice(1).join('|').trim();
      } else {
        line = parts[0].trim();
        explicitName = parts.slice(1).join(' #').trim();
      }
    }
  }

  // If already starts with a recognized URL scheme
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(line)) {
    let parsed: URL;
    try {
      parsed = new URL(line);
    } catch {
      throw new ProxyPoolError(400, `Invalid URL format: ${line}`);
    }
    const host = parsed.hostname;
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol.startsWith('socks') ? '1080' : '80');
    return {
      url: line,
      suggestedName: explicitName || `proxy-${host}-${port}`,
    };
  }

  // Format: host:port:user:pass
  const colons = line.split(':');
  if (colons.length === 4) {
    const [host, port, user, pass] = colons;
    if (!host || !port || isNaN(Number(port))) {
      throw new ProxyPoolError(400, `Invalid host:port:user:pass format: ${line}`);
    }
    const safeUser = encodeURIComponent(decodeURIComponent(user));
    const safePass = encodeURIComponent(decodeURIComponent(pass));
    return {
      url: `http://${safeUser}:${safePass}@${host}:${port}`,
      suggestedName: explicitName || `proxy-${host}-${port}`,
    };
  }

  // Format: host:port
  if (colons.length === 2 && !isNaN(Number(colons[1]))) {
    const [host, port] = colons;
    return {
      url: `http://${host}:${port}`,
      suggestedName: explicitName || `proxy-${host}-${port}`,
    };
  }

  // Format: user:pass@host:port
  if (line.includes('@')) {
    const atIdx = line.indexOf('@');
    const auth = line.slice(0, atIdx);
    const hostPort = line.slice(atIdx + 1);
    const hostPortParts = hostPort.split(':');
    const host = hostPortParts[0];
    const port = hostPortParts[1] || '80';
    return {
      url: `http://${auth}@${host}:${port}`,
      suggestedName: explicitName || `proxy-${host}-${port}`,
    };
  }

  throw new ProxyPoolError(400, `Unsupported proxy format: ${line}`);
}

export function batchImportProxies(
  lines: string[],
  createdBy?: number,
): { imported: ProxyPoolEntry[]; failed: Array<{ line: string; error: string }> } {
  const imported: ProxyPoolEntry[] = [];
  const failed: Array<{ line: string; error: string }> = [];

  const existingRows = getDb().prepare('SELECT name FROM x_gateway_proxy_pool').all() as Array<{ name: string }>;
  const usedNames = new Set(existingRows.map(r => r.name.toLowerCase()));

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx].trim();
    if (!rawLine || rawLine.startsWith('#') || rawLine.startsWith('//')) {
      continue;
    }

    try {
      const parsed = parseProxyLine(rawLine);
      const cleanUrl = validateUrl(parsed.url);

      const count = getDb().prepare('SELECT COUNT(*) AS n FROM x_gateway_proxy_pool').get() as { n: number };
      if (Number(count.n) >= MAX_POOL_ENTRIES) {
        failed.push({ line: rawLine, error: `Maximum limit of ${MAX_POOL_ENTRIES} proxy pool entries reached.` });
        continue;
      }

      // Generate unique name
      const baseName = (parsed.suggestedName || `proxy-${idx + 1}`).trim().slice(0, POOL_NAME_MAX);
      let candidate = baseName;
      let counter = 1;
      while (usedNames.has(candidate.toLowerCase())) {
        counter++;
        const suffix = `-${counter}`;
        candidate = `${baseName.slice(0, POOL_NAME_MAX - suffix.length)}${suffix}`;
      }
      usedNames.add(candidate.toLowerCase());

      const enc = encryptProxyUrl(cleanUrl);
      const now = new Date().toISOString();
      const result = getDb().prepare(`
        INSERT INTO x_gateway_proxy_pool (name, proxy_encrypted, proxy_iv, proxy_auth_tag, enabled, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      `).run(candidate, enc.encrypted, enc.iv, enc.authTag, createdBy ?? null, now, now);

      imported.push(entryWithCount(Number(result.lastInsertRowid)));
    } catch (err: any) {
      failed.push({ line: rawLine, error: err?.message ?? String(err) });
    }
  }

  return { imported, failed };
}

export function bulkActionProxies(
  action: 'enable' | 'disable' | 'delete',
  ids: number[],
): { affected: number; ids: number[] } {
  if (!ids.length) return { affected: 0, ids: [] };
  const placeholders = ids.map(() => '?').join(',');
  const now = new Date().toISOString();
  let affected = 0;

  if (action === 'enable') {
    const res = getDb().prepare(`
      UPDATE x_gateway_proxy_pool
      SET enabled = 1, updated_at = ?
      WHERE id IN (${placeholders})
    `).run(now, ...ids);
    affected = res.changes;
  } else if (action === 'disable') {
    const res = getDb().prepare(`
      UPDATE x_gateway_proxy_pool
      SET enabled = 0, updated_at = ?
      WHERE id IN (${placeholders})
    `).run(now, ...ids);
    affected = res.changes;
  } else if (action === 'delete') {
    const res = getDb().prepare(`
      DELETE FROM x_gateway_proxy_pool
      WHERE id IN (${placeholders})
    `).run(...ids);
    affected = res.changes;
  }

  return { affected, ids };
}

export interface ProxyPoolConfig {
  noProxy: string[];
  strictProxy: boolean;
}

export function getProxyPoolConfig(): ProxyPoolConfig {
  const rawNoProxy = getSetting('x_gateway_proxy_pool_no_proxy') ?? '';
  const rawStrict = getSetting('x_gateway_proxy_pool_strict_proxy') ?? '0';
  const noProxy = rawNoProxy
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean);
  const strictProxy = rawStrict === '1' || rawStrict === 'true';
  return { noProxy, strictProxy };
}

export function updateProxyPoolConfig(patch: { noProxy?: string[] | string; strictProxy?: boolean }): ProxyPoolConfig {
  if (patch.noProxy !== undefined) {
    const list = Array.isArray(patch.noProxy)
      ? patch.noProxy.map(s => s.trim()).filter(Boolean)
      : patch.noProxy.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    setSetting('x_gateway_proxy_pool_no_proxy', list.join(','));
  }
  if (patch.strictProxy !== undefined) {
    setSetting('x_gateway_proxy_pool_strict_proxy', patch.strictProxy ? '1' : '0');
  }
  return getProxyPoolConfig();
}

export function shouldBypassProxyPool(targetOrProvider: string): boolean {
  if (!targetOrProvider) return false;
  const { noProxy } = getProxyPoolConfig();
  if (!noProxy.length) return false;
  const lower = targetOrProvider.toLowerCase().trim();
  return noProxy.some(rule => {
    const r = rule.toLowerCase().trim();
    if (!r) return false;
    return lower === r || lower.includes(r) || lower.endsWith(`.${r}`);
  });
}

export function isStrictProxyEnabled(): boolean {
  return getProxyPoolConfig().strictProxy;
}

export const CLOUDFLARE_WORKER_RELAY_CODE = `addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const target = request.headers.get('fetch-relay-target');
  if (!target) {
    return new Response(JSON.stringify({ status: 'ok', service: 'freellmapi-worker-relay' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }

  try {
    const reqHeaders = new Headers(request.headers);
    reqHeaders.delete('fetch-relay-target');
    reqHeaders.delete('fetch-relay-authorization');
    reqHeaders.delete('host');

    const response = await fetch(target, {
      method: request.method,
      headers: reqHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual'
    });

    return response;
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err && err.message ? err.message : err) }), {
      status: 502,
      headers: { 'content-type': 'application/json' }
    });
  }
}`;

export const VERCEL_RELAY_CODE = `export const config = { runtime: 'edge' };

export default async function handler(request) {
  const target = request.headers.get('fetch-relay-target');
  if (!target) {
    return new Response(JSON.stringify({ status: 'ok', service: 'freellmapi-vercel-relay' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }

  try {
    const reqHeaders = new Headers(request.headers);
    reqHeaders.delete('fetch-relay-target');
    reqHeaders.delete('fetch-relay-authorization');
    reqHeaders.delete('host');

    return await fetch(target, {
      method: request.method,
      headers: reqHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual'
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err && err.message ? err.message : err) }), {
      status: 502,
      headers: { 'content-type': 'application/json' }
    });
  }
}`;

export const DENO_RELAY_CODE = `Deno.serve(async (request) => {
  const target = request.headers.get('fetch-relay-target');
  if (!target) return Response.json({ status: 'ok', service: 'freellmapi-deno-relay' });
  let url;
  try { url = new URL(target); } catch { return Response.json({ error: 'Invalid relay target' }, { status: 400 }); }
  if (!['http:', 'https:'].includes(url.protocol)) return Response.json({ error: 'Unsupported target protocol' }, { status: 400 });
  const headers = new Headers(request.headers);
  for (const name of ['fetch-relay-target', 'fetch-relay-authorization', 'host', 'connection', 'content-length']) headers.delete(name);
  try {
    return await fetch(url, {
      method: request.method, headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual', signal: request.signal,
    });
  } catch {
    return Response.json({ error: 'Relay upstream request failed' }, { status: 502 });
  }
});`;

// Digest-deployed Netlify Functions use the Lambda handler contract. Binary
// bodies round-trip as base64; SSE remains valid but is buffered by this runtime.
export const NETLIFY_RELAY_CODE = `exports.handler = async (event) => {
  const headers = {};
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (value != null) headers[key.toLowerCase()] = value;
  }
  const reply = (statusCode, data) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const target = headers['fetch-relay-target'];
  if (!target) return reply(200, { status: 'ok', service: 'freellmapi-netlify-relay' });
  let url;
  try { url = new URL(target); } catch { return reply(400, { error: 'Invalid relay target' }); }
  if (!['http:', 'https:'].includes(url.protocol)) return reply(400, { error: 'Unsupported target protocol' });
  for (const name of ['fetch-relay-target', 'fetch-relay-authorization', 'host', 'connection', 'content-length']) delete headers[name];
  const method = (event.httpMethod || 'GET').toUpperCase();
  try {
    const upstream = await fetch(url, {
      method, headers, redirect: 'manual',
      body: ['GET', 'HEAD'].includes(method) || event.body == null ? undefined
        : event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body,
    });
    const responseHeaders = Object.fromEntries(upstream.headers);
    for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) delete responseHeaders[name];
    return { statusCode: upstream.status, headers: responseHeaders,
      body: Buffer.from(await upstream.arrayBuffer()).toString('base64'), isBase64Encoded: true };
  } catch {
    return reply(502, { error: 'Relay upstream request failed' });
  }
};`;

export type RelayProvider = 'cloudflare' | 'vercel' | 'deno' | 'netlify';

export interface DeployWorkerParams {
  provider: RelayProvider;
  apiToken: string;
  accountId?: string;
  orgDomain?: string;
  workerName: string;
  createdBy?: number;
}

export type DeployRelayOptions = DeployWorkerParams;

export interface DeployWorkerResult {
  ok: true;
  provider: RelayProvider;
  workerName: string;
  url: string;
  entry: ProxyPoolEntry;
}

/** Single-file ZIP (stored method), built in memory without a CLI or dependency. */
function netlifyRelayZip(): Buffer {
  const name = Buffer.from('relay.js');
  const content = Buffer.from(NETLIFY_RELAY_CODE);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x21, 12); // DOS date: 1980-01-01
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  local.copy(central, 8, 6, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + content.length, 16);
  return Buffer.concat([local, name, content, central, name, end]);
}

interface RelayApiData {
  id?: string;
  slug?: string;
  status?: string;
  state?: string;
  ssl_url?: string;
  url?: string;
  required?: string[];
  required_functions?: string[];
  error_message?: string;
  failure_detail?: { message?: string } | null;
  timelines?: Array<{ context?: string; name?: string; hostnames?: string[] }>;
}

async function relayApiRequest(base: string, path: string, token: string, provider: string, init: RequestInit = {}, signal?: AbortSignal): Promise<RelayApiData> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  headers.set('User-Agent', 'FreeLLMAPI');
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000), redirect: 'error' });
  } catch {
    throw new ProxyPoolError(502, `${provider} API request failed or timed out.`);
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    const detail = sanitizeProviderErrorMessage(raw.split(token).join('[redacted]') || response.statusText);
    const status = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw new ProxyPoolError(provider === 'Netlify' && status === 422 ? 409 : status, `${provider} API ${init.method ?? 'GET'} ${path.split('?')[0]} failed (${response.status}): ${detail}`);
  }
  if (response.status === 204 || init.method === 'PUT' || init.method === 'DELETE') return {};
  try {
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected an object');
    return data as RelayApiData;
  }
  catch { throw new ProxyPoolError(502, `${provider} API returned an invalid JSON response.`); }
}

function saveDeployedRelay(params: DeployWorkerParams, name: string, url: string): DeployWorkerResult {
  const baseName = `${params.provider}-${name}`.slice(0, POOL_NAME_MAX);
  let entryName = baseName;
  for (let suffix = 2; getDb().prepare('SELECT 1 FROM x_gateway_proxy_pool WHERE name = ?').get(entryName); suffix++) {
    entryName = `${baseName.slice(0, POOL_NAME_MAX - String(suffix).length - 1)}-${suffix}`;
  }
  return { ok: true, provider: params.provider, workerName: name, url, entry: createProxyPoolEntry(entryName, url, params.createdBy) };
}

async function deployDenoRelay(params: DeployWorkerParams, name: string, token: string): Promise<DeployWorkerResult> {
  const base = 'https://api.deno.com/v2';
  const org = params.orgDomain?.trim().toLowerCase();
  if (org && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.deno\.(?:net|dev))?$/.test(org)) throw new ProxyPoolError(400, 'Invalid Deno organization / subdomain.');
  if (name.length < 3 || name.length > 32) throw new ProxyPoolError(400, 'Deno project names must contain 3–32 characters.');
  const signal = AbortSignal.timeout(90_000);
  const app = await relayApiRequest(base, '/apps', token, 'Deno', {
    method: 'POST', body: JSON.stringify({ slug: name, config: { runtime: { type: 'dynamic', entrypoint: 'main.ts' } } }),
  }, signal);
  if (!app.id) throw new ProxyPoolError(502, 'Deno app creation returned no app ID.');
  const path = `/apps/${encodeURIComponent(app.id)}`;
  try {
    let revision = await relayApiRequest(base, `${path}/deploy`, token, 'Deno', {
      method: 'POST', body: JSON.stringify({ assets: { 'main.ts': { kind: 'file', content: DENO_RELAY_CODE, encoding: 'utf-8' } }, production: true }),
    }, signal);
    if (!revision.id) throw new ProxyPoolError(502, 'Deno deployment returned no revision ID.');
    const revisionId = revision.id;
    for (let attempt = 0; ['queued', 'building'].includes(revision.status ?? '') && attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      revision = await relayApiRequest(base, `/revisions/${encodeURIComponent(revisionId)}`, token, 'Deno', {}, signal);
    }
    if (revision.status !== 'succeeded') throw new ProxyPoolError(502, `Deno deployment did not succeed (${revision.status ?? 'unknown'}): ${sanitizeProviderErrorMessage((revision.failure_detail?.message ?? 'Check the Deno build logs.').split(token).join('[redacted]'))}`);
    const host = revision.timelines?.find(t => t.context?.toLowerCase() === 'production' || t.name?.toLowerCase() === 'production')?.hostnames?.[0];
    // v2 returns its real production hostname; do not fabricate a legacy .deno.dev URL.
    const hostname = host ?? (org ? `${app.slug ?? name}.${org.includes('.') ? org : `${org}.deno.net`}` : undefined);
    if (!hostname || !/^[a-z0-9.-]+\.(?:deno\.net|deno\.dev)$/.test(hostname)) throw new ProxyPoolError(502, 'Deno deployment returned no valid production hostname. Enter the organization subdomain.');
    return saveDeployedRelay(params, name, `https://${hostname}`);
  } catch (err) {
    await relayApiRequest(base, path, token, 'Deno', { method: 'DELETE' }).catch(() => {});
    throw err;
  }
}

async function deployNetlifyRelay(params: DeployWorkerParams, name: string, token: string): Promise<DeployWorkerResult> {
  const base = 'https://api.netlify.com/api/v1';
  const signal = AbortSignal.timeout(90_000);
  const site = await relayApiRequest(base, '/sites', token, 'Netlify', { method: 'POST', body: JSON.stringify({ name }) }, signal);
  if (!site.id) throw new ProxyPoolError(502, 'Netlify site creation returned no site ID.');
  try {
    const siteUrl = site.ssl_url ?? site.url ?? `https://${name}.netlify.app`;
    let origin: URL;
    try { origin = new URL(siteUrl); }
    catch { throw new ProxyPoolError(502, 'Netlify returned an invalid site URL.'); }
    if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.netlify.app') || origin.username || origin.password) throw new ProxyPoolError(502, 'Netlify returned an invalid site URL.');
    const zip = netlifyRelayZip();
    const digest = crypto.createHash('sha256').update(zip).digest('hex');
    const index = '<!doctype html><title>FreeLLMAPI Relay</title><p>Relay: /.netlify/functions/relay</p>';
    const sha1 = crypto.createHash('sha1').update(index).digest('hex');
    let deployment = await relayApiRequest(base, `/sites/${encodeURIComponent(site.id)}/deploys`, token, 'Netlify', {
      method: 'POST', body: JSON.stringify({ files: { '/index.html': sha1 }, functions: { relay: digest } }),
    }, signal);
    if (!deployment.id) throw new ProxyPoolError(502, 'Netlify deployment returned no deploy ID.');
    const deployPath = `/deploys/${encodeURIComponent(deployment.id)}`;
    if (deployment.required?.includes(sha1)) await relayApiRequest(base, `${deployPath}/files/index.html`, token, 'Netlify', {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: index,
    }, signal);
    if (deployment.required_functions?.includes(digest)) await relayApiRequest(base, `${deployPath}/functions/relay?runtime=js`, token, 'Netlify', {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(zip),
    }, signal);
    for (let attempt = 0; deployment.state !== 'ready' && deployment.state !== 'error' && attempt < 30; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 1000));
      deployment = await relayApiRequest(base, deployPath, token, 'Netlify', {}, signal);
    }
    if (deployment.state !== 'ready') throw new ProxyPoolError(502, `Netlify deployment did not become ready (${deployment.state ?? 'unknown'}): ${sanitizeProviderErrorMessage((deployment.error_message ?? 'Check the Netlify deploy logs.').split(token).join('[redacted]'))}`);
    return saveDeployedRelay(params, name, `${origin.origin}/.netlify/functions/relay`);
  } catch (err) {
    await relayApiRequest(base, `/sites/${encodeURIComponent(site.id)}`, token, 'Netlify', { method: 'DELETE' }).catch(() => {});
    throw err;
  }
}

export async function deployServerlessRelay(params: DeployWorkerParams): Promise<DeployWorkerResult> {
  const token = params.apiToken?.trim();
  if (!token) throw new ProxyPoolError(400, 'API token is required.');

  const rawName = params.workerName?.trim() || '';
  const cleanName = rawName.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').slice(0, 60);
  if (!cleanName) throw new ProxyPoolError(400, 'Invalid workerName.');

  if (params.provider === 'deno' || params.provider === 'netlify') {
    const name = rawName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, params.provider === 'deno' ? 32 : 60).replace(/-$/, '');
    if (!name) throw new ProxyPoolError(400, 'Invalid project name.');
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM x_gateway_proxy_pool').get() as { n: number };
    if (Number(count.n) >= MAX_POOL_ENTRIES) throw new ProxyPoolError(400, `Maximum limit of ${MAX_POOL_ENTRIES} proxy pool entries reached.`);
    return params.provider === 'deno' ? deployDenoRelay(params, name, token) : deployNetlifyRelay(params, name, token);
  }

  if (params.provider === 'cloudflare') {
    let accountId = params.accountId?.trim();
    if (!accountId) {
      const accRes = await fetch('https://api.cloudflare.com/client/v4/accounts', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!accRes.ok) {
        const errText = await accRes.text().catch(() => '');
        throw new ProxyPoolError(400, `Cloudflare API authentication failed (${accRes.status}): ${errText || accRes.statusText}`);
      }
      const accData = await accRes.json() as any;
      if (!accData.result?.length) {
        throw new ProxyPoolError(400, 'No Cloudflare accounts found for this API token.');
      }
      accountId = String(accData.result[0].id);
    }

    // Retrieve or check workers.dev subdomain
    let subdomain = '';
    const subRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (subRes.ok) {
      const subData = await subRes.json() as any;
      subdomain = subData.result?.subdomain || '';
    }
    if (!subdomain) {
      subdomain = 'workers';
    }

    // Upload worker script
    const uploadRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${cleanName}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/javascript',
      },
      body: CLOUDFLARE_WORKER_RELAY_CODE,
    });
    if (!uploadRes.ok) {
      const errData = await uploadRes.json().catch(() => null) as any;
      const msg = errData?.errors?.[0]?.message || uploadRes.statusText;
      throw new ProxyPoolError(400, `Cloudflare Worker upload failed: ${msg}`);
    }

    // Enable workers.dev subdomain route
    await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${cleanName}/subdomain`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: true }),
    }).catch(() => {/* non-fatal */});

    const relayUrl = `https://${cleanName}.${subdomain}.workers.dev`;

    // Pick unique pool entry name
    const baseEntryName = `cf-${cleanName}`.slice(0, POOL_NAME_MAX);
    let finalEntryName = baseEntryName;
    let counter = 1;
    while (getDb().prepare('SELECT 1 FROM x_gateway_proxy_pool WHERE name = ?').get(finalEntryName)) {
      counter++;
      const suffix = `-${counter}`;
      finalEntryName = `${baseEntryName.slice(0, POOL_NAME_MAX - suffix.length)}${suffix}`;
    }

    const entry = createProxyPoolEntry(finalEntryName, relayUrl, params.createdBy);
    return { ok: true, provider: 'cloudflare', workerName: cleanName, url: relayUrl, entry };
  }

  if (params.provider === 'vercel') {
    const deployRes = await fetch('https://api.vercel.com/v13/deployments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: cleanName,
        files: [
          {
            file: 'api/relay.js',
            data: VERCEL_RELAY_CODE,
          },
          {
            file: 'vercel.json',
            data: JSON.stringify({
              routes: [{ src: '/(.*)', dest: '/api/relay.js' }],
            }),
          },
        ],
        projectSettings: {
          framework: null,
        },
      }),
    });

    if (!deployRes.ok) {
      const errData = await deployRes.json().catch(() => null) as any;
      const msg = errData?.error?.message || deployRes.statusText;
      throw new ProxyPoolError(400, `Vercel deployment failed: ${msg}`);
    }

    const deployData = await deployRes.json() as any;
    const hostUrl = deployData.url || deployData.alias?.[0] || `${cleanName}.vercel.app`;
    const relayUrl = hostUrl.startsWith('http') ? hostUrl : `https://${hostUrl}`;

    const baseEntryName = `vercel-${cleanName}`.slice(0, POOL_NAME_MAX);
    let finalEntryName = baseEntryName;
    let counter = 1;
    while (getDb().prepare('SELECT 1 FROM x_gateway_proxy_pool WHERE name = ?').get(finalEntryName)) {
      counter++;
      const suffix = `-${counter}`;
      finalEntryName = `${baseEntryName.slice(0, POOL_NAME_MAX - suffix.length)}${suffix}`;
    }

    const entry = createProxyPoolEntry(finalEntryName, relayUrl, params.createdBy);
    return { ok: true, provider: 'vercel', workerName: cleanName, url: relayUrl, entry };
  }

  throw new ProxyPoolError(400, 'Unsupported provider. Must be cloudflare, vercel, deno or netlify.');
}
