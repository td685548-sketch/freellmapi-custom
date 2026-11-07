import type { Platform } from '@freellmapi/shared/types.js';
import type { ProviderAccount, ProviderAccountAuthMethod, ProviderAccountsResponse } from '@freellmapi/shared/x-accounts.js';
import { getDb } from '../../db/index.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { parseModelScope } from '../../lib/model-scope.js';
import { clearCooldownsForKey } from '../../services/ratelimit.js';
import { AccountError, COPILOT_BASE_URL } from './http.js';
import { clearCopilotToken, type CopilotModel } from './copilot.js';
import {
  X_GATEWAY_PROVIDERS,
  getXGatewayProvider,
  normalizeXGatewayProviderId,
  platformForXGatewayProvider,
} from './catalog.js';

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
    proxy_encrypted: null,
    proxy_iv: null,
    proxy_auth_tag: null,
  };
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

  const scope = parseModelScope(row.model_scope_json);
  if (scope) {
    const knownIds = new Set(baseModels.map(m => m.id));
    for (const id of scope) {
      if (!knownIds.has(id)) {
        baseModels.push({ id, name: id });
      }
    }
  }

  return baseModels.filter(m => !scope || scope.has(m.id));
}

export function listAccounts(): ProviderAccountsResponse['providers'] {
  const db = getDb();
  const month = new Date().toISOString().slice(0, 7);
  const rows = db.prepare(`
    SELECT k.*, COALESCE(u.requests, 0) AS requests, COALESCE(u.tokens, 0) AS tokens
    FROM x_gateway_keys k
    LEFT JOIN x_gateway_key_monthly_usage u ON u.key_id = k.id AND u.month = ?
    ORDER BY k.id
  `).all(month) as Array<RawXGatewayKeyRow & { requests: number; tokens: number }>;

  const providers: ProviderAccountsResponse['providers'] = X_GATEWAY_PROVIDERS.map(p => ({
    id: p.id,
    alias: p.alias,
    name: p.name,
    category: p.category,
    baseUrl: p.baseUrl || null,
    authMethods: [...p.authMethods],
    accounts: [],
  }));

  for (const raw of rows) {
    const row = hydrateAccountRow(raw);
    const provider = providers.find(p => p.id === row.provider);
    if (!provider) continue;
    provider.accounts.push({
      id: row.id,
      provider: provider.id,
      label: row.label,
      identity: row.subject,
      authMethod: row.auth_method,
      enabled: row.enabled === 1,
      status: row.status,
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
            base_url, model_scope_json, models_json, status, enabled, created_by
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 1, ?)
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
        base_url, model_scope_json, models_json, status, enabled, created_by
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'unknown', 1, ?)
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
    ).lastInsertRowid,
  );

  invalidateXGatewayKeyCache();
  return id;
}

export function updateAccount(
  id: number,
  patch: { label?: string; enabled?: boolean; monthlyRequestCap?: number; monthlyTokenCap?: number },
): AccountRow {
  const existing = accountRow(id);
  const nextLabel = patch.label !== undefined ? patch.label : existing.label;
  const nextEnabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled;
  const nextReqCap = patch.monthlyRequestCap !== undefined ? patch.monthlyRequestCap : existing.monthly_request_cap;
  const nextTokCap = patch.monthlyTokenCap !== undefined ? patch.monthlyTokenCap : existing.monthly_token_cap;

  getDb().prepare(`
    UPDATE x_gateway_keys
    SET label = ?, enabled = ?, monthly_request_cap = ?, monthly_token_cap = ?
    WHERE id = ?
  `).run(nextLabel, nextEnabled, nextReqCap, nextTokCap, id);

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
