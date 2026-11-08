import type { Platform } from '@freellmapi/shared/types.js';
import type { ProviderAccount, ProviderAccountAuthMethod, ProviderAccountsResponse } from '@freellmapi/shared/x-accounts.js';
import { getDb } from '../../db/index.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { decryptProxyUrl, encryptProxyUrl, isValidKeyProxyUrl, KEY_PROXY_URL_ERROR, maskProxyUrl } from '../../lib/key-proxy.js';
import { parseModelScope } from '../../lib/model-scope.js';
import { clearCooldownsForKey } from '../../services/ratelimit.js';
import { getOutboundProxyUrl } from '../x-gateway/config.js';
import { pickAutoProxyPoolId, proxyPoolExists, resolvePoolProxyUrl } from '../x-gateway/proxy-pool.js';
import { AccountError, COPILOT_BASE_URL } from './http.js';
import { clearCopilotToken, type CopilotModel } from './copilot.js';
import {
  X_GATEWAY_PROVIDERS,
  getXGatewayProvider,
  normalizeXGatewayProviderId,
  platformForXGatewayProvider,
  registerCustomNodesGetter,
  type CustomProviderNode,
} from './catalog.js';

export type { CustomProviderNode };
export const CUSTOM_NODES_SETTINGS_KEY = 'x_gateway_custom_nodes';

export function listCustomProviderNodes(): CustomProviderNode[] {
  try {
    const db = getDb();
    let raw: string | undefined;
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(CUSTOM_NODES_SETTINGS_KEY) as { value: string } | undefined;
      raw = row?.value;
    } catch {
      const row = db.prepare('SELECT value FROM x_gateway_config WHERE key = ?').get(CUSTOM_NODES_SETTINGS_KEY) as { value: string } | undefined;
      raw = row?.value;
    }
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CustomProviderNode[]) : [];
  } catch {
    return [];
  }
}

export function saveCustomProviderNode(node: CustomProviderNode): CustomProviderNode {
  const db = getDb();
  const current = listCustomProviderNodes();
  const existingIdx = current.findIndex(n => n.id === node.id);
  let updated: CustomProviderNode[];
  if (existingIdx >= 0) {
    updated = [...current];
    updated[existingIdx] = node;
  } else {
    updated = [...current, node];
  }
  const serialized = JSON.stringify(updated);
  try {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(CUSTOM_NODES_SETTINGS_KEY, serialized);
  } catch {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO x_gateway_config (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(CUSTOM_NODES_SETTINGS_KEY, serialized, now);
  }
  invalidateXGatewayKeyCache();
  return node;
}

export function deleteCustomProviderNode(nodeId: string): void {
  const db = getDb();
  const current = listCustomProviderNodes();
  const filtered = current.filter(n => n.id !== nodeId);
  const serialized = JSON.stringify(filtered);
  try {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(CUSTOM_NODES_SETTINGS_KEY, serialized);
  } catch {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO x_gateway_config (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(CUSTOM_NODES_SETTINGS_KEY, serialized, now);
  }
  invalidateXGatewayKeyCache();
}

registerCustomNodesGetter(listCustomProviderNodes);

export type OAuthProvider = 'openrouter' | 'github-copilot';

export interface AccountRow {
  id: number;
  provider: string;
  platform: Platform;
  label: string;
  enabled: number;
  status: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  base_url: string | null;
  model_scope_json: string | null;
  models_json: string | null;
  monthly_request_cap: number;
  monthly_token_cap: number;
  subject: string | null;
  auth_method: ProviderAccountAuthMethod;
  created_by: number | null;
  proxy_encrypted: string | null;
  proxy_iv: string | null;
  proxy_auth_tag: string | null;
  proxy_pool_id: number | null;
}

interface RawXGatewayKeyRow {
  id: number;
  provider: string;
  label: string;
  subject: string | null;
  auth_method: ProviderAccountAuthMethod;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  base_url: string | null;
  model_scope_json: string | null;
  models_json: string | null;
  status: string;
  enabled: number;
  monthly_request_cap: number;
  monthly_token_cap: number;
  created_by: number | null;
  proxy_encrypted?: string | null;
  proxy_iv?: string | null;
  proxy_auth_tag?: string | null;
  proxy_pool_id?: number | null;
  proxy_pool_name?: string | null;
}

function hydrateAccountRow(raw: RawXGatewayKeyRow): AccountRow {
  const normalizedProvider = normalizeXGatewayProviderId(raw.provider) ?? raw.provider;
  return {
    id: Number(raw.id),
    provider: normalizedProvider,
    platform: platformForXGatewayProvider(normalizedProvider),
    label: raw.label ?? '',
    enabled: Number(raw.enabled),
    status: raw.status ?? 'unknown',
    encrypted_key: raw.encrypted_key,
    iv: raw.iv,
    auth_tag: raw.auth_tag,
    base_url: raw.base_url ?? null,
    model_scope_json: raw.model_scope_json ?? null,
    models_json: raw.models_json ?? null,
    monthly_request_cap: Number(raw.monthly_request_cap ?? 0),
    monthly_token_cap: Number(raw.monthly_token_cap ?? 0),
    subject: raw.subject ?? null,
    auth_method: raw.auth_method ?? 'api_key',
    created_by: raw.created_by == null ? null : Number(raw.created_by),
    proxy_encrypted: raw.proxy_encrypted ?? null,
    proxy_iv: raw.proxy_iv ?? null,
    proxy_auth_tag: raw.proxy_auth_tag ?? null,
    proxy_pool_id: raw.proxy_pool_id == null ? null : Number(raw.proxy_pool_id),
  };
}

export function resolveXGatewayAccountProxy(
  row?: Pick<AccountRow, 'proxy_encrypted' | 'proxy_iv' | 'proxy_auth_tag' | 'proxy_pool_id'> | null,
): string | undefined {
  const perAccount = decryptProxyUrl(row);
  if (perAccount) return perAccount;
  const pooled = resolvePoolProxyUrl(row?.proxy_pool_id);
  if (pooled) return pooled;
  const gatewayWide = getOutboundProxyUrl();
  return gatewayWide || undefined;
}

let cachedDb: unknown = null;
let cachedMonth = '';
let cachedUsableKeys: Array<AccountRow & { requests: number; tokens: number }> | null = null;

export function invalidateXGatewayKeyCache(): void {
  cachedUsableKeys = null;
}

export function accountRow(id: number): AccountRow {
  const raw = getDb()
    .prepare('SELECT * FROM x_gateway_keys WHERE id = ?')
    .get(id) as RawXGatewayKeyRow | undefined;
  if (!raw) throw new AccountError(404, 'Account not found.');
  return hydrateAccountRow(raw);
}

export function reconnectAccount(id: number, provider: OAuthProvider): AccountRow {
  const row = accountRow(id);
  const matches = provider === 'openrouter'
    ? row.provider === 'openrouter'
    : row.provider === 'github-copilot' && row.base_url === COPILOT_BASE_URL && row.subject !== null;
  if (!matches) throw new AccountError(409, 'Account provider does not match.');
  return row;
}

export interface ProviderModelConfig {
  disabledModels: string[];
  customModels: Array<{ id: string; name: string }>;
  modelAliases: Record<string, string>;
}

const PROVIDER_MODELS_CONFIG_KEY = 'provider_model_configs';

function loadAllProviderModelConfigs(): Record<string, ProviderModelConfig> {
  try {
    const row = getDb()
      .prepare('SELECT value FROM x_gateway_config WHERE key = ?')
      .get(PROVIDER_MODELS_CONFIG_KEY) as { value: string } | undefined;
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, ProviderModelConfig>) : {};
  } catch {
    return {};
  }
}

function saveAllProviderModelConfigs(configs: Record<string, ProviderModelConfig>): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO x_gateway_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(PROVIDER_MODELS_CONFIG_KEY, JSON.stringify(configs), now);
}

export function getProviderModelConfig(providerId: string): ProviderModelConfig {
  const normalized = normalizeXGatewayProviderId(providerId) ?? providerId;
  const all = loadAllProviderModelConfigs();
  const entry = all[normalized];
  return {
    disabledModels: Array.isArray(entry?.disabledModels) ? entry.disabledModels : [],
    customModels: Array.isArray(entry?.customModels) ? entry.customModels : [],
    modelAliases: entry?.modelAliases && typeof entry.modelAliases === 'object' ? entry.modelAliases : {},
  };
}

export function setProviderModelConfig(
  providerId: string,
  patch: Partial<ProviderModelConfig>,
): ProviderModelConfig {
  const normalized = normalizeXGatewayProviderId(providerId) ?? providerId;
  const all = loadAllProviderModelConfigs();
  const current = getProviderModelConfig(normalized);
  const next: ProviderModelConfig = {
    disabledModels:
      patch.disabledModels !== undefined
        ? Array.from(new Set(patch.disabledModels.map(m => m.trim()).filter(Boolean)))
        : current.disabledModels,
    customModels:
      patch.customModels !== undefined
        ? patch.customModels
            .map(m => ({ id: m.id.trim(), name: (m.name || m.id).trim() }))
            .filter(m => Boolean(m.id))
        : current.customModels,
    modelAliases:
      patch.modelAliases !== undefined
        ? Object.fromEntries(
            Object.entries(patch.modelAliases)
              .map(([k, v]) => [k.trim(), v.trim()] as const)
              .filter(([k, v]) => Boolean(k && v)),
          )
        : current.modelAliases,
  };
  all[normalized] = next;
  saveAllProviderModelConfigs(all);
  invalidateXGatewayKeyCache();
  return next;
}

export function resolveProviderModelAlias(providerId: string, modelId: string): string {
  const cfg = getProviderModelConfig(providerId);
  return cfg.modelAliases[modelId] || modelId;
}

export function accountModels(
  row: Pick<AccountRow, 'id' | 'provider' | 'platform' | 'base_url' | 'model_scope_json' | 'models_json'>,
): ProviderAccount['models'] {
  const providerId = normalizeXGatewayProviderId(row.provider ?? row.platform) ?? row.provider ?? row.platform;
  const catalogModels = getXGatewayProvider(providerId)?.models ?? [];
  let baseModels: { id: string; name: string }[] = [...catalogModels];

  if (row.models_json) {
    try {
      const parsed = JSON.parse(row.models_json);
      if (Array.isArray(parsed) && parsed.length > 0) {
        baseModels = parsed
          .filter((m): m is { id: string; name?: string } => Boolean(m && typeof m.id === 'string'))
          .map(m => ({ id: m.id, name: typeof m.name === 'string' && m.name ? m.name : m.id }));
      }
    } catch {
      // Ignore malformed models_json and fall back to catalog models
    }
  }

  const providerCfg = getProviderModelConfig(providerId);
  if (providerCfg.customModels.length > 0) {
    const known = new Set(baseModels.map(m => m.id));
    for (const cm of providerCfg.customModels) {
      if (!known.has(cm.id)) {
        baseModels.push({ id: cm.id, name: cm.name || cm.id });
        known.add(cm.id);
      }
    }
  }

  const scope = parseModelScope(row.model_scope_json);
  if (scope) {
    const knownIds = new Set(baseModels.map(m => m.id));
    for (const id of scope) {
      if (!knownIds.has(id)) {
        baseModels.push({ id, name: id });
      }
    }
  }

  const disabledSet = new Set(providerCfg.disabledModels);
  return baseModels.filter(m => (!scope || scope.has(m.id)) && !disabledSet.has(m.id));
}

const MAIN_DB_PLATFORM_ALIASES: Record<string, string[]> = {
  google: ['google', 'gemini'],
  cloudflare: ['cloudflare-ai'],
  zhipu: ['glm', 'glm-cn'],
  kilo: ['kilo-gateway', 'kilocode'],
  opencode: ['opencode', 'opencode-zen', 'opencode-go'],
  airforce: ['api-airforce'],
  brave: ['brave-search'],
  serpsearch: ['serper', 'searchapi'],
  qianfan: ['baidu'],
  volcengine: ['volcengine-ark'],
  modelscope: ['alims-intl'],
};

function getMainDbProviderIds(db: ReturnType<typeof getDb>): Set<string> {
  const result = new Set<string>();
  try {
    const mainRows = db
      .prepare('SELECT DISTINCT platform, base_url FROM api_keys')
      .all() as Array<{ platform: string; base_url: string | null }>;
    for (const row of mainRows) {
      const platform = (row.platform ?? '').trim().toLowerCase();
      if (!platform) continue;
      const normalized = normalizeXGatewayProviderId(platform);
      if (normalized) result.add(normalized);
      const aliased = MAIN_DB_PLATFORM_ALIASES[platform];
      if (aliased) {
        for (const id of aliased) result.add(id);
      }
      if (row.base_url) {
        const trimmedUrl = row.base_url.trim().replace(/\/+$/, '').toLowerCase();
        if (trimmedUrl === COPILOT_BASE_URL.toLowerCase()) {
          result.add('github-copilot');
        }
        for (const cat of X_GATEWAY_PROVIDERS) {
          if (cat.baseUrl && cat.baseUrl.trim().replace(/\/+$/, '').toLowerCase() === trimmedUrl) {
            result.add(cat.id);
          }
        }
      }
    }
  } catch {
    // Ignore if api_keys table is unavailable
  }
  return result;
}

export function listAccounts(): ProviderAccountsResponse['providers'] {
  const db = getDb();
  const month = new Date().toISOString().slice(0, 7);
  const rows = db.prepare(`
    SELECT k.*, COALESCE(u.requests, 0) AS requests, COALESCE(u.tokens, 0) AS tokens,
           pp.name AS proxy_pool_name
    FROM x_gateway_keys k
    LEFT JOIN x_gateway_key_monthly_usage u ON u.key_id = k.id AND u.month = ?
    LEFT JOIN x_gateway_proxy_pool pp ON pp.id = k.proxy_pool_id
    ORDER BY k.id
  `).all(month) as Array<RawXGatewayKeyRow & { requests: number; tokens: number }>;

  const mainDbProviderIds = getMainDbProviderIds(db);

  const providers: ProviderAccountsResponse['providers'] = X_GATEWAY_PROVIDERS.map(p => ({
    id: p.id,
    alias: p.alias,
    name: p.name,
    category: p.category,
    baseUrl: p.baseUrl || null,
    ...(mainDbProviderIds.has(p.id) ? { hasMainDbKey: true } : {}),
    authMethods: [...p.authMethods],
    accounts: [],
  }));

  const customNodes = listCustomProviderNodes();
  for (const node of customNodes) {
    if (!providers.some(p => p.id === node.id)) {
      providers.push({
        id: node.id,
        alias: node.prefix,
        name: node.name,
        category: 'apikey',
        baseUrl: node.baseUrl || null,
        authMethods: ['api_key'],
        accounts: [],
        isCustomNode: true,
        customNodeType: node.type,
      } as any);
    }
  }

  for (const raw of rows) {
    const row = hydrateAccountRow(raw);
    const provider = providers.find(p => p.id === row.provider || p.alias === row.provider);
    if (!provider) continue;
    const maskedProxy = maskProxyUrl(decryptProxyUrl(row));
    provider.accounts.push({
      id: row.id,
      provider: provider.id,
      label: row.label,
      identity: row.subject,
      authMethod: row.auth_method,
      enabled: row.enabled === 1,
      status: row.status,
      ...(maskedProxy ? { proxyUrl: maskedProxy } : {}),
      ...(row.proxy_pool_id != null ? { proxyPoolId: row.proxy_pool_id, proxyPoolName: raw.proxy_pool_name ?? `#${row.proxy_pool_id}` } : {}),
      monthlyUsage: { requests: Number(raw.requests), tokens: Number(raw.tokens) },
      monthlyRequestCap: row.monthly_request_cap,
      monthlyTokenCap: row.monthly_token_cap,
      models: accountModels(row),
    });
  }

  return providers;
}

export function getUsableXGatewayKeys(): Array<AccountRow & { requests: number; tokens: number }> {
  const db = getDb();
  const month = new Date().toISOString().slice(0, 7);
  if (cachedUsableKeys !== null && cachedDb === db && cachedMonth === month) {
    return cachedUsableKeys;
  }
  const rows = db.prepare(`
    SELECT k.*, COALESCE(u.requests, 0) AS requests, COALESCE(u.tokens, 0) AS tokens
    FROM x_gateway_keys k
    LEFT JOIN x_gateway_key_monthly_usage u ON u.key_id = k.id AND u.month = ?
    WHERE k.enabled = 1 AND k.status NOT IN ('invalid', 'disabled')
    ORDER BY k.id
  `).all(month) as Array<RawXGatewayKeyRow & { requests: number; tokens: number }>;

  cachedDb = db;
  cachedMonth = month;
  cachedUsableKeys = rows.map(raw => ({
    ...hydrateAccountRow(raw),
    requests: Number(raw.requests),
    tokens: Number(raw.tokens),
  }));
  return cachedUsableKeys;
}

export function recordXGatewayKeyUsage(keyId: number, tokens: number): void {
  const month = new Date().toISOString().slice(0, 7);
  if (cachedUsableKeys && cachedMonth === month) {
    const entry = cachedUsableKeys.find(k => k.id === keyId);
    if (entry) {
      entry.requests += 1;
      entry.tokens += Math.max(0, tokens);
    }
  }
  try {
    getDb().prepare(`
      INSERT INTO x_gateway_key_monthly_usage (key_id, month, requests, tokens)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(key_id, month) DO UPDATE SET
        requests = requests + 1,
        tokens = tokens + excluded.tokens
    `).run(keyId, month, Math.max(0, tokens));
  } catch {
    // Ignore usage write errors if key was deleted concurrently
  }
}

export function saveAccount(input: {
  provider: OAuthProvider;
  label: string;
  credential: string;
  subject: string | null;
  reconnectId?: number;
  expectedSubject?: string | null;
  models?: CopilotModel[];
  userId?: number;
}): number {
  const db = getDb();
  const id = db.transaction(() => {
    const copilot = input.provider === 'github-copilot';
    if (copilot && (!input.subject || !input.models?.length)) {
      throw new AccountError(502, 'Copilot account is not eligible.');
    }
    if (input.reconnectId !== undefined) {
      const existing = reconnectAccount(input.reconnectId, input.provider);
      if (copilot && (existing.subject !== input.subject || existing.subject !== input.expectedSubject)) {
        throw new AccountError(409, 'Reconnect must use the original GitHub account.');
      }
      if (copilot) clearCopilotToken(decrypt(existing.encrypted_key, existing.iv, existing.auth_tag));
    }
    if (input.subject !== null) {
      const duplicate = db
        .prepare('SELECT id FROM x_gateway_keys WHERE provider = ? AND subject = ?')
        .get(input.provider, input.subject) as { id: number } | undefined;
      if (duplicate && duplicate.id !== input.reconnectId) {
        throw new AccountError(409, 'Account is already connected. Use reconnect to replace its grant.');
      }
    }
    const { encrypted, iv, authTag } = encrypt(input.credential);
    const authMethod: ProviderAccountAuthMethod = copilot ? 'device_code' : 'oauth_pkce';
    const modelScopeJson = copilot && input.models ? JSON.stringify(input.models.map(m => m.id)) : null;
    const modelsJson = copilot && input.models
      ? JSON.stringify(input.models.map(m => ({ id: m.id, name: m.name })))
      : null;

    let keyId = input.reconnectId;
    if (keyId !== undefined) {
      db.prepare(`
        UPDATE x_gateway_keys
        SET label = ?, subject = ?, auth_method = ?, encrypted_key = ?, iv = ?, auth_tag = ?,
            status = 'unknown', last_checked_at = NULL,
            model_scope_json = COALESCE(?, model_scope_json),
            models_json = COALESCE(?, models_json)
        WHERE id = ?
      `).run(
        input.label,
        input.subject,
        authMethod,
        encrypted,
        iv,
        authTag,
        modelScopeJson,
        modelsJson,
        keyId,
      );
    } else {
      keyId = Number(
        db.prepare(`
          INSERT INTO x_gateway_keys (
            provider, label, subject, auth_method, encrypted_key, iv, auth_tag,
            base_url, model_scope_json, models_json, status, enabled, created_by, proxy_pool_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 1, ?, ?)
        `).run(
          input.provider,
          input.label,
          input.subject,
          authMethod,
          encrypted,
          iv,
          authTag,
          copilot ? COPILOT_BASE_URL : null,
          modelScopeJson,
          modelsJson,
          input.userId ?? null,
          pickAutoProxyPoolId(),
        ).lastInsertRowid,
      );
    }
    return keyId;
  })();

  invalidateXGatewayKeyCache();
  if (input.reconnectId !== undefined) clearCooldownsForKey(id);
  return id;
}

export function createApiKeyAccount(input: {
  provider: string;
  key: string;
  label?: string;
  baseUrl?: string | null;
  proxyUrl?: string | null;
  proxyPoolId?: number | null;
  authMethod?: ProviderAccountAuthMethod;
  models?: { id: string; name: string }[];
  userId?: number | null;
}): number {
  const normalizedProvider = normalizeXGatewayProviderId(input.provider);
  if (!normalizedProvider) {
    throw new AccountError(400, 'Unknown provider.');
  }
  const catalogEntry = getXGatewayProvider(normalizedProvider)!;
  const trimmedKey = input.key.trim();
  if (!trimmedKey) {
    throw new AccountError(400, 'API key or credential is required.');
  }
  let baseUrl: string | null = input.baseUrl?.trim() || null;
  if (!baseUrl && catalogEntry.baseUrl) {
    baseUrl = catalogEntry.baseUrl;
  }
  if (normalizedProvider === 'custom') {
    if (!baseUrl) {
      throw new AccountError(400, 'Base URL is required for custom endpoints.');
    }
    try {
      const parsed = new URL(baseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
      baseUrl = baseUrl.replace(/\/+$/, '');
    } catch {
      throw new AccountError(400, 'Base URL must be a valid http(s) URL.');
    }
  } else if (baseUrl) {
    baseUrl = baseUrl.replace(/\/+$/, '');
  }

  const rawProxyUrl = input.proxyUrl?.trim() ?? '';
  if (rawProxyUrl && !isValidKeyProxyUrl(rawProxyUrl)) {
    throw new AccountError(400, KEY_PROXY_URL_ERROR);
  }
  const proxyEncrypted = encryptProxyUrl(rawProxyUrl);

  let proxyPoolId: number | null = null;
  if (input.proxyPoolId != null) {
    if (!proxyPoolExists(input.proxyPoolId)) {
      throw new AccountError(400, 'Proxy pool entry not found.');
    }
    proxyPoolId = input.proxyPoolId;
  } else if (input.proxyPoolId === undefined && !rawProxyUrl) {
    proxyPoolId = pickAutoProxyPoolId();
  }

  const authMethod: ProviderAccountAuthMethod = input.authMethod
    ?? (catalogEntry.category === 'webCookie' ? 'cookie' : 'api_key');

  const modelsJson = input.models && input.models.length > 0
    ? JSON.stringify(input.models.map(m => ({ id: m.id, name: m.name || m.id })))
    : null;
  const modelScopeJson = input.models && input.models.length > 0
    ? JSON.stringify(input.models.map(m => m.id))
    : null;

  const { encrypted, iv, authTag } = encrypt(trimmedKey);
  const id = Number(
    getDb().prepare(`
      INSERT INTO x_gateway_keys (
        provider, label, subject, auth_method, encrypted_key, iv, auth_tag,
        base_url, model_scope_json, models_json, status, enabled, created_by,
        proxy_encrypted, proxy_iv, proxy_auth_tag, proxy_pool_id
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'unknown', 1, ?, ?, ?, ?, ?)
    `).run(
      normalizedProvider,
      input.label?.trim() ?? '',
      authMethod,
      encrypted,
      iv,
      authTag,
      baseUrl,
      modelScopeJson,
      modelsJson,
      input.userId ?? null,
      proxyEncrypted.encrypted,
      proxyEncrypted.iv,
      proxyEncrypted.authTag,
      proxyPoolId,
    ).lastInsertRowid,
  );

  invalidateXGatewayKeyCache();
  return id;
}

export function updateAccount(
  id: number,
  patch: {
    label?: string;
    enabled?: boolean;
    proxyUrl?: string;
    proxyPoolId?: number | null;
    monthlyRequestCap?: number;
    monthlyTokenCap?: number;
  },
): AccountRow {
  const existing = accountRow(id);
  const nextLabel = patch.label !== undefined ? patch.label : existing.label;
  const nextEnabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled;
  const nextReqCap = patch.monthlyRequestCap !== undefined ? patch.monthlyRequestCap : existing.monthly_request_cap;
  const nextTokCap = patch.monthlyTokenCap !== undefined ? patch.monthlyTokenCap : existing.monthly_token_cap;

  let nextProxyEnc = existing.proxy_encrypted;
  let nextProxyIv = existing.proxy_iv;
  let nextProxyTag = existing.proxy_auth_tag;
  if (patch.proxyUrl !== undefined) {
    if (!isValidKeyProxyUrl(patch.proxyUrl)) {
      throw new AccountError(400, KEY_PROXY_URL_ERROR);
    }
    const enc = encryptProxyUrl(patch.proxyUrl);
    nextProxyEnc = enc.encrypted;
    nextProxyIv = enc.iv;
    nextProxyTag = enc.authTag;
  }

  let nextPoolId = existing.proxy_pool_id;
  if (patch.proxyPoolId !== undefined) {
    if (patch.proxyPoolId !== null && !proxyPoolExists(patch.proxyPoolId)) {
      throw new AccountError(400, 'Proxy pool entry not found.');
    }
    nextPoolId = patch.proxyPoolId;
  }

  getDb().prepare(`
    UPDATE x_gateway_keys
    SET label = ?, enabled = ?, monthly_request_cap = ?, monthly_token_cap = ?,
        proxy_encrypted = ?, proxy_iv = ?, proxy_auth_tag = ?, proxy_pool_id = ?
    WHERE id = ?
  `).run(nextLabel, nextEnabled, nextReqCap, nextTokCap, nextProxyEnc, nextProxyIv, nextProxyTag, nextPoolId, id);

  invalidateXGatewayKeyCache();
  return accountRow(id);
}

export function deleteAccount(id: number): void {
  const row = accountRow(id);
  if (row.provider === 'github-copilot') {
    clearCopilotToken(decrypt(row.encrypted_key, row.iv, row.auth_tag));
  }
  getDb().prepare('DELETE FROM x_gateway_keys WHERE id = ?').run(id);
  invalidateXGatewayKeyCache();
  clearCooldownsForKey(id);
}

export function setAccountStatus(id: number, status: 'healthy' | 'error' | 'unknown'): void {
  getDb()
    .prepare('UPDATE x_gateway_keys SET status = ?, last_checked_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(status, id);
  invalidateXGatewayKeyCache();
}

export function toggleProviderAccounts(providerId: string, enabled: boolean): number {
  const normalized = normalizeXGatewayProviderId(providerId) ?? providerId.trim().toLowerCase();
  const result = getDb()
    .prepare('UPDATE x_gateway_keys SET enabled = ? WHERE provider = ? OR provider = ?')
    .run(enabled ? 1 : 0, normalized, providerId.trim());
  invalidateXGatewayKeyCache();
  return Number(result.changes ?? 0);
}

export function listAccountRowsForBatchTest(filter: {
  providerId?: string;
  accountIds?: number[];
}): AccountRow[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM x_gateway_keys ORDER BY id').all() as RawXGatewayKeyRow[];
  const hydrated = rows.map(hydrateAccountRow);
  const normalizedProvider = filter.providerId
    ? (normalizeXGatewayProviderId(filter.providerId) ?? filter.providerId)
    : undefined;
  const idSet = filter.accountIds && filter.accountIds.length > 0 ? new Set(filter.accountIds) : null;
  return hydrated.filter(row => {
    if (normalizedProvider && row.provider !== normalizedProvider) return false;
    if (idSet && !idSet.has(row.id)) return false;
    return true;
  });
}
