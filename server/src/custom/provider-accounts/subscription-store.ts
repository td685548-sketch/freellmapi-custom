import { AccountError } from './http.js';
import { getDb } from '../../db/index.js';
import { accountRow, createApiKeyAccount, invalidateXGatewayKeyCache, updateAccountCredential } from './store.js';
import { encryptProxyUrl, isValidKeyProxyUrl, KEY_PROXY_URL_ERROR } from '../../lib/key-proxy.js';
import { proxyPoolExists } from '../x-gateway/proxy-pool.js';
import { normalizeImportedCredential } from './oauth-providers.js';
import { oauthIdentity, parseOAuthCredential, type OAuthCredential } from './oauth-credentials.js';
import { clearOAuthRefreshStateForAccount } from './oauth-lifecycle.js';

export function saveSubscription(input: {
  provider: string;
  credential: string | OAuthCredential;
  label: string;
  userId: number;
  reconnectId?: number;
  proxyUrl?: string | null;
  proxyPoolId?: number | null;
}): number {
  const raw = typeof input.credential === 'string' ? input.credential : JSON.stringify(input.credential);
  const normalized = normalizeImportedCredential(input.provider, raw);
  const credential = normalized && parseOAuthCredential(normalized);
  if (!credential) throw new AccountError(400, 'Invalid credential JSON for the selected provider. Include access token, refresh token and expiry.');
  return getDb().transaction(() => {
    let id: number;
    if (input.reconnectId !== undefined) {
      const old = accountRow(input.reconnectId);
      if (old.provider !== input.provider) throw new AccountError(400, 'Reconnect provider mismatch.');
      id = old.id;
      updateAccountCredential(id, credential);
      let proxyEnc = old.proxy_encrypted;
      let proxyIv = old.proxy_iv;
      let proxyTag = old.proxy_auth_tag;
      let poolId = old.proxy_pool_id;
      if (input.proxyUrl !== undefined) {
        const rawProxy = input.proxyUrl?.trim() ?? '';
        if (rawProxy && !isValidKeyProxyUrl(rawProxy)) throw new AccountError(400, KEY_PROXY_URL_ERROR);
        const enc = encryptProxyUrl(rawProxy);
        proxyEnc = enc.encrypted; proxyIv = enc.iv; proxyTag = enc.authTag;
      }
      if (input.proxyPoolId !== undefined) {
        if (input.proxyPoolId != null && !proxyPoolExists(input.proxyPoolId)) throw new AccountError(400, 'Proxy pool entry not found.');
        poolId = input.proxyPoolId;
      }
      getDb().prepare("UPDATE x_gateway_keys SET label = ?, status = 'unknown', last_checked_at = NULL, proxy_encrypted = ?, proxy_iv = ?, proxy_auth_tag = ?, proxy_pool_id = ? WHERE id = ?").run(input.label, proxyEnc, proxyIv, proxyTag, poolId, id);
    } else {
      id = createApiKeyAccount({
        provider: input.provider,
        key: normalized!,
        label: input.label,
        userId: input.userId,
        authMethod: input.provider === 'kiro' ? 'device_code' : 'oauth_pkce',
        proxyUrl: input.proxyUrl,
        proxyPoolId: input.proxyPoolId,
      });
    }
    getDb().prepare('UPDATE x_gateway_keys SET subject = ? WHERE id = ?').run(oauthIdentity(credential) ?? null, id);
    clearOAuthRefreshStateForAccount(id);
    invalidateXGatewayKeyCache();
    return id;
  })();
}
