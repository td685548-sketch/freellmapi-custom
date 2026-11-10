import { getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { serializeOAuthCredential, type OAuthCredential } from './oauth-credentials.js';
import { invalidateXGatewayKeyCache } from './store.js';

/** Keep lifecycle persistence available independently of pending account UI work. */
export function updateAccountCredential(id: number, credential: OAuthCredential): void {
  const { encrypted, iv, authTag } = encrypt(serializeOAuthCredential(credential));
  getDb().prepare('UPDATE x_gateway_keys SET encrypted_key = ?, iv = ?, auth_tag = ? WHERE id = ?')
    .run(encrypted, iv, authTag, id);
  invalidateXGatewayKeyCache();
}
