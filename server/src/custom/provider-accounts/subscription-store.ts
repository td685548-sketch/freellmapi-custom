import { AccountError } from './http.js';
import { getDb } from '../../db/index.js';
import { accountRow, createApiKeyAccount, invalidateXGatewayKeyCache, updateAccountCredential } from './store.js';
import { normalizeImportedCredential } from './oauth-providers.js';
import { oauthIdentity, parseOAuthCredential, type OAuthCredential } from './oauth-credentials.js';
import { clearOAuthRefreshStateForAccount } from './oauth-lifecycle.js';

export function saveSubscription(input: { provider: string; credential: string | OAuthCredential; label: string; userId: number; reconnectId?: number }): number {
  const raw = typeof input.credential === 'string' ? input.credential : JSON.stringify(input.credential);
  const normalized = normalizeImportedCredential(input.provider, raw);
  const credential = normalized && parseOAuthCredential(normalized);
  if (!credential) throw new AccountError(400, 'Invalid credential JSON for the selected provider. Include access token, refresh token and expiry.');
  return getDb().transaction(() => {
    let id: number;
    if (input.reconnectId !== undefined) {
      const old = accountRow(input.reconnectId);
      if (old.provider !== input.provider) throw new AccountError(400, 'Reconnect provider does not match this account.');
      id = old.id;
      updateAccountCredential(id, credential);
      getDb().prepare("UPDATE x_gateway_keys SET label = ?, status = 'unknown', last_checked_at = NULL WHERE id = ?").run(input.label, id);
    } else {
      id = createApiKeyAccount({ provider: input.provider, key: normalized!, label: input.label, userId: input.userId, authMethod: input.provider === 'kiro' ? 'device_code' : 'oauth_pkce' });
    }
    getDb().prepare('UPDATE x_gateway_keys SET subject = ? WHERE id = ?').run(oauthIdentity(credential) ?? null, id);
    clearOAuthRefreshStateForAccount(id);
    invalidateXGatewayKeyCache();
    return id;
  })();
}
