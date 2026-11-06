import type { Platform } from '@freellmapi/shared/types.js';
import type { ProviderAccount, ProviderAccountAuthMethod, ProviderAccountsResponse } from '@freellmapi/shared/x-accounts.js';
import { getDb } from '../../db/index.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { endpointScopeForBaseUrl } from '../../lib/endpoint-scope.js';
import { parseModelScope } from '../../lib/model-scope.js';
import { isSearchPlatform } from '../../lib/search-platforms.js';
import { getAllProviders } from '../../providers/index.js';
import { registerCustomChatModels } from '../../services/custom-model-register.js';
import { invalidateKeyCache } from '../../services/key-cache.js';
import { clearCooldownsForKey } from '../../services/ratelimit.js';
import { AccountError, COPILOT_BASE_URL } from './http.js';
import { clearCopilotToken, type CopilotModel } from './copilot.js';

export type OAuthProvider = 'openrouter' | 'github-copilot';
export interface AccountRow {
  id: number; platform: Platform; label: string; enabled: number; status: string;
  encrypted_key: string; iv: string; auth_tag: string; base_url: string | null;
  model_scope_json: string | null; monthly_request_cap: number; monthly_token_cap: number;
  provider: OAuthProvider | null; subject: string | null; auth_method: ProviderAccountAuthMethod | null;
  proxy_encrypted: string | null; proxy_iv: string | null; proxy_auth_tag: string | null;
}

export function accountRow(id: number): AccountRow {
  const row = getDb().prepare(`SELECT k.*, a.provider, a.subject, a.auth_method FROM api_keys k
    LEFT JOIN x_provider_accounts a ON a.api_key_id = k.id WHERE k.id = ?`).get(id) as AccountRow | undefined;
  if (!row) throw new AccountError(404, 'Account not found.');
  return row;
}

export function reconnectAccount(id: number, provider: OAuthProvider): AccountRow {
  const row = accountRow(id);
  const matches = provider === 'openrouter'
    ? row.platform === 'openrouter' && (!row.provider || row.provider === provider)
    : row.platform === 'custom' && row.base_url === COPILOT_BASE_URL && row.provider === provider && row.subject !== null;
  if (!matches) throw new AccountError(409, 'Account provider does not match.');
  return row;
}

export function accountModels(row: Pick<AccountRow, 'id' | 'platform' | 'base_url' | 'model_scope_json'>): ProviderAccount['models'] {
  const db = getDb();
  const models = (row.platform === 'custom'
    ? db.prepare(`SELECT m.model_id, m.display_name FROM models m JOIN api_keys k ON k.id = m.key_id
        WHERE m.platform = 'custom' AND k.base_url = ? AND m.enabled = 1`).all(row.base_url)
    : db.prepare('SELECT model_id, display_name FROM models WHERE platform = ? AND enabled = 1 AND (key_id IS NULL OR key_id = ?)').all(row.platform, row.id)
  ) as Array<{ model_id: string; display_name: string }>;
  const scope = parseModelScope(row.model_scope_json);
  return models.filter(m => !scope || scope.has(m.model_id)).map(m => ({ id: m.model_id, name: m.display_name }));
}

export function listAccounts(): ProviderAccountsResponse['providers'] {
  const db = getDb();
  const rows = db.prepare(`SELECT k.*, a.provider, a.subject, a.auth_method,
      COALESCE(u.requests, 0) AS requests, COALESCE(u.tokens, 0) AS tokens
    FROM api_keys k LEFT JOIN x_provider_accounts a ON a.api_key_id = k.id
    LEFT JOIN key_monthly_usage u ON u.key_id = k.id AND u.month = ? ORDER BY k.id`).all(
    new Date().toISOString().slice(0, 7),
  ) as Array<AccountRow & { requests: number; tokens: number }>;
  const providers: ProviderAccountsResponse['providers'] = getAllProviders()
    .filter(p => !isSearchPlatform(p.platform) && (!p.keyless || rows.some(r => r.platform === p.platform)))
    .map(p => ({
      id: p.platform, name: p.name,
      authMethods: p.platform === 'openrouter' ? ['api_key', 'oauth_pkce'] : ['api_key'], accounts: [],
    }));
  providers.push({ id: 'github-copilot', name: 'GitHub Copilot', authMethods: ['device_code'], accounts: [] });
  for (const row of rows) {
    const provider = providers.find(p => p.id === (row.provider ?? row.platform));
    if (!provider) continue;
    provider.accounts.push({
      id: Number(row.id), provider: provider.id, label: row.label ?? '', identity: row.subject,
      authMethod: row.auth_method ?? 'api_key', enabled: row.enabled === 1, status: row.status,
      monthlyUsage: { requests: Number(row.requests), tokens: Number(row.tokens) },
      monthlyRequestCap: Number(row.monthly_request_cap), monthlyTokenCap: Number(row.monthly_token_cap),
      models: accountModels(row),
    });
  }
  return providers.sort((a, b) => a.name.localeCompare(b.name));
}

export function saveAccount(input: {
  provider: OAuthProvider; label: string; credential: string; subject: string | null;
  reconnectId?: number; expectedSubject?: string | null; models?: CopilotModel[];
}): number {
  const db = getDb();
  const id = db.transaction(() => {
    const copilot = input.provider === 'github-copilot';
    if (copilot && (!input.subject || !input.models?.length)) throw new AccountError(502, 'Copilot account is not eligible.');
    if (input.reconnectId !== undefined) {
      const existing = reconnectAccount(input.reconnectId, input.provider);
      if (copilot && (existing.subject !== input.subject || existing.subject !== input.expectedSubject)) {
        throw new AccountError(409, 'Reconnect must use the original GitHub account.');
      }
      if (copilot) clearCopilotToken(decrypt(existing.encrypted_key, existing.iv, existing.auth_tag));
    }
    if (input.subject !== null) {
      const duplicate = db.prepare('SELECT api_key_id FROM x_provider_accounts WHERE provider = ? AND subject = ?')
        .get(input.provider, input.subject) as { api_key_id: number } | undefined;
      if (duplicate && duplicate.api_key_id !== input.reconnectId) throw new AccountError(409, 'Account is already connected. Use reconnect to replace its grant.');
    }
    const { encrypted, iv, authTag } = encrypt(input.credential);
    let keyId = input.reconnectId;
    if (keyId !== undefined) {
      db.prepare(`UPDATE api_keys SET label = ?, encrypted_key = ?, iv = ?, auth_tag = ?, status = 'unknown',
        last_checked_at = NULL, last_healthy_at = NULL, last_health_error = NULL WHERE id = ?`)
        .run(input.label, encrypted, iv, authTag, keyId);
    } else {
      keyId = Number(db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, base_url, group_label, enabled, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'unknown')`).run(
        copilot ? 'custom' : 'openrouter', input.label, encrypted, iv, authTag,
        copilot ? COPILOT_BASE_URL : null, copilot ? 'GitHub Copilot' : null,
      ).lastInsertRowid);
    }
    db.prepare(`INSERT INTO x_provider_accounts (api_key_id, provider, subject, auth_method) VALUES (?, ?, ?, ?)
      ON CONFLICT(api_key_id) DO UPDATE SET provider = excluded.provider, subject = excluded.subject, auth_method = excluded.auth_method`)
      .run(keyId, input.provider, input.subject, copilot ? 'device_code' : 'oauth_pkce');
    if (copilot) {
      const models = input.models!;
      db.prepare('UPDATE api_keys SET model_scope_json = ? WHERE id = ?').run(JSON.stringify(models.map(m => m.id)), keyId);
      const scope = endpointScopeForBaseUrl(COPILOT_BASE_URL);
      const existing = new Set((db.prepare("SELECT model_id FROM models WHERE platform = 'custom' AND endpoint_scope = ?")
        .all(scope) as { model_id: string }[]).map(m => m.model_id));
      registerCustomChatModels(db, COPILOT_BASE_URL, keyId, models.filter(m => !existing.has(m.id)).map(m => ({
        modelId: m.id, displayName: m.name, supportsTools: m.supportsTools, supportsVision: m.supportsVision,
      })));
    }
    return keyId;
  })();
  invalidateKeyCache();
  if (input.reconnectId !== undefined) clearCooldownsForKey(id);
  return id;
}
