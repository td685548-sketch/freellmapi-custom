import { getDb } from '../../db/index.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { maskProxyUrl } from '../../lib/key-proxy.js';
import type { SaverLevel } from '../output-savers/prompts.js';
import type { ComboEntry } from './combos.js';

export interface XGatewaySaverDefaults {
  caveman: boolean;
  ponytail: SaverLevel;
  input: 'off' | 'lossless' | 'standard';
}

export interface XGatewayCombo {
  id: number;
  name: string;
  entries: ComboEntry[];
  createdBy?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface XGatewayConfigSnapshot {
  enabled: boolean;
  savers: XGatewaySaverDefaults;
  combos: XGatewayCombo[];
  outboundProxyUrl: string;
  maskedOutboundProxyUrl: string;
}

const DEFAULT_SAVERS: XGatewaySaverDefaults = {
  caveman: false,
  ponytail: 'off',
  input: 'off',
};

let cachedSnapshot: XGatewayConfigSnapshot | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5000;

export function invalidateConfigCache(): void {
  cachedSnapshot = null;
  cacheExpiry = 0;
}

function parseSavers(raw: string | undefined): XGatewaySaverDefaults {
  if (!raw) return { ...DEFAULT_SAVERS };
  try {
    const parsed = JSON.parse(raw);
    const ponytailLevels = ['off', 'lite', 'full', 'ultra'] as const;
    const inputLevels = ['off', 'lossless', 'standard'] as const;
    return {
      caveman: parsed.caveman === true,
      ponytail: ponytailLevels.includes(parsed.ponytail) ? parsed.ponytail : 'off',
      input: inputLevels.includes(parsed.input) ? parsed.input : 'off',
    };
  } catch {
    return { ...DEFAULT_SAVERS };
  }
}

function loadCombosFromDb(db: ReturnType<typeof getDb>): XGatewayCombo[] {
  try {
    const rows = db.prepare('SELECT id, name, entries_json, created_by, created_at, updated_at FROM x_gateway_combos ORDER BY name ASC').all() as Array<{
      id: number;
      name: string;
      entries_json: string;
      created_by: number | null;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map(r => {
      let entries: ComboEntry[] = [];
      try {
        const parsed = JSON.parse(r.entries_json);
        if (Array.isArray(parsed)) entries = parsed;
      } catch {
        entries = [];
      }
      return {
        id: r.id,
        name: r.name,
        entries,
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  } catch {
    return [];
  }
}

function parseOutboundProxy(raw: string | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as { encrypted?: string; iv?: string; authTag?: string };
    if (parsed && typeof parsed.encrypted === 'string' && typeof parsed.iv === 'string' && typeof parsed.authTag === 'string') {
      return decrypt(parsed.encrypted, parsed.iv, parsed.authTag).trim();
    }
  } catch {
    // Fallback if stored as plain URL
    return trimmed;
  }
  return '';
}

export function getConfigSnapshot(): XGatewayConfigSnapshot {
  const now = Date.now();
  if (cachedSnapshot && now < cacheExpiry) return cachedSnapshot;

  try {
    const db = getDb();
    const enabledRow = db.prepare("SELECT value FROM x_gateway_config WHERE key = 'enabled'").get() as { value: string } | undefined;
    const saversRow = db.prepare("SELECT value FROM x_gateway_config WHERE key = 'default_savers'").get() as { value: string } | undefined;
    const proxyRow = db.prepare("SELECT value FROM x_gateway_config WHERE key = 'outbound_proxy'").get() as { value: string } | undefined;
    const combos = loadCombosFromDb(db);
    const outboundProxyUrl = parseOutboundProxy(proxyRow?.value);

    cachedSnapshot = {
      enabled: enabledRow?.value === 'true' || enabledRow?.value === '1',
      savers: parseSavers(saversRow?.value),
      combos,
      outboundProxyUrl,
      maskedOutboundProxyUrl: maskProxyUrl(outboundProxyUrl),
    };
  } catch {
    cachedSnapshot = {
      enabled: false,
      savers: { ...DEFAULT_SAVERS },
      combos: [],
      outboundProxyUrl: '',
      maskedOutboundProxyUrl: '',
    };
  }

  cacheExpiry = now + CACHE_TTL_MS;
  return cachedSnapshot;
}

export function setConfigValue(key: string, value: string, updatedBy?: number): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO x_gateway_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(key, value, now, updatedBy ?? null);
  invalidateConfigCache();
}

export function setEnabled(enabled: boolean, updatedBy?: number): void {
  setConfigValue('enabled', enabled ? 'true' : 'false', updatedBy);
}

export function setDefaultSavers(savers: XGatewaySaverDefaults, updatedBy?: number): void {
  setConfigValue('default_savers', JSON.stringify(savers), updatedBy);
}

export function getOutboundProxyUrl(): string {
  return getConfigSnapshot().outboundProxyUrl;
}

export function setOutboundProxyUrl(proxyUrl: string, updatedBy?: number): void {
  const trimmed = proxyUrl.trim();
  if (!trimmed) {
    setConfigValue('outbound_proxy', '', updatedBy);
    return;
  }
  const encrypted = encrypt(trimmed);
  setConfigValue('outbound_proxy', JSON.stringify(encrypted), updatedBy);
}

export function listCombos(): XGatewayCombo[] {
  return getConfigSnapshot().combos;
}

export function getComboByName(name: string): XGatewayCombo | undefined {
  const lower = name.toLowerCase();
  return getConfigSnapshot().combos.find(c => c.name === lower);
}

export function getComboById(id: number): XGatewayCombo | undefined {
  return getConfigSnapshot().combos.find(c => c.id === id);
}

export function createCombo(name: string, entries: ComboEntry[], createdBy?: number): XGatewayCombo {
  const db = getDb();
  const lower = name.toLowerCase();
  const now = new Date().toISOString();
  const result = db.prepare(
    'INSERT INTO x_gateway_combos (name, entries_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(lower, JSON.stringify(entries), createdBy ?? null, now, now);
  invalidateConfigCache();
  return {
    id: Number(result.lastInsertRowid),
    name: lower,
    entries,
    createdBy: createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateCombo(id: number, name: string, entries: ComboEntry[]): XGatewayCombo | null {
  const db = getDb();
  const lower = name.toLowerCase();
  const now = new Date().toISOString();
  const result = db.prepare(
    'UPDATE x_gateway_combos SET name = ?, entries_json = ?, updated_at = ? WHERE id = ?'
  ).run(lower, JSON.stringify(entries), now, id);
  if (result.changes === 0) return null;
  invalidateConfigCache();
  return getComboById(id) ?? null;
}

export function deleteCombo(id: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM x_gateway_combos WHERE id = ?').run(id);
  if (result.changes > 0) {
    invalidateConfigCache();
    return true;
  }
  return false;
}
