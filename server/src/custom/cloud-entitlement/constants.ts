/**
 * Cryptographic public constants and setting keys for Cloud AI & Support Entitlement.
 * Only the Ed25519 public verification key is stored here; signing happens exclusively
 * on the owner's Cloudflare Worker edge service.
 */

export const CLOUD_ENTITLEMENT_DEFAULT_URL =
  'https://freellmapi-ai-gate.freellm-cloud.workers.dev';

export const CLOUD_ENTITLEMENT_ED25519_PUBLIC_KEY_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEALv7NqIKvuQ0YuMVKyr4Zz0aLGvxFu3BqofPWoMiqEHw=',
  '-----END PUBLIC KEY-----',
  '',
].join('\n');

export const ENV_AI_ACTIVATION_TOKEN = 'FREEAPI_AI_ACTIVATION_TOKEN';
export const ENV_AI_ENTITLEMENT_URL = 'FREEAPI_AI_ENTITLEMENT_URL';
export const ENV_AI_BACKGROUND_POLL = 'CLOUD_ENTITLEMENT_BACKGROUND_POLL';

export const SETTING_AI_ACTIVATION_TOKEN_ENC = 'ai_entitlement_token_enc_v1';
export const SETTING_AI_INSTANCE_ID = 'ai_entitlement_instance_id_v1';
export const SETTING_AI_PENDING_REQUEST_ENC = 'ai_entitlement_pending_req_enc_v1';

export const LEASE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
export const LEASE_HARD_GRACE_MS = 45 * 60 * 1000;
export const ENTITLEMENT_HTTP_TIMEOUT_MS = 8_000;
