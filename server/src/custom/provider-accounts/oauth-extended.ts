import { createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, constants as cryptoConstants, privateDecrypt, randomBytes, randomUUID } from 'node:crypto';
import type { ProviderAccountAuthMethod } from '@freellmapi/shared/x-accounts.js';
import { getDb } from '../../db/index.js';
import { encryptProxyUrl, isValidKeyProxyUrl, KEY_PROXY_URL_ERROR } from '../../lib/key-proxy.js';
import { getXGatewayProvider, normalizeXGatewayProviderId } from './catalog.js';
import { AccountError } from './http.js';
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from './antigravity.js';
import { normalizeImportedCredential } from './oauth-providers.js';
import { clearOAuthRefreshStateForAccount } from './oauth-lifecycle.js';
import { accountRow, createApiKeyAccount, invalidateXGatewayKeyCache, updateAccountCredential } from './store.js';
import { saveSubscription } from './subscription-store.js';
import { proxyPoolExists } from '../x-gateway/proxy-pool.js';

export type ExtendedFlowType = 'device_code' | 'oauth_pkce';

export interface ExtendedOAuthAttempt {
  provider: string;
  flow: ExtendedFlowType;
  mode: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  extraMeta?: Record<string, string>;
  deviceCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  interval: number;
  expiresAt: number;
}

export interface ExtendedPollResult {
  pending: boolean;
  slow?: boolean;
  credentialJson?: string;
  subject?: string;
}

const DEVICE_CODE_PROVIDERS = new Set([
  'grok-cli',
  'qoder',
  'qoder-cn',
  'kimi',
  'glm',
  'codebuddy-cn',
  'codebuddy-intl',
  'kilocode',
  'muse',
  'nous',
  'minimax-code',
  'minimax-code-global',
]);

const BROWSER_PKCE_PROVIDERS = new Set([
  'antigravity',
  'cline',
  'clinepass',
  'xai',
  'zed',
  'xiaomi-mimo',
  'iflow',
  'gitlab',
  'kimchi',
  'trae',
  'windsurf',
  'cursor',
  'qwen',
]);

export function isExtendedOAuthProvider(providerId: string): boolean {
  return DEVICE_CODE_PROVIDERS.has(providerId) || BROWSER_PKCE_PROVIDERS.has(providerId);
}

export function extendedOAuthCapability(providerId: string): {
  flow: ExtendedFlowType | null;
  login: boolean;
  refresh: boolean;
  refreshConfigured: boolean;
} {
  if (DEVICE_CODE_PROVIDERS.has(providerId)) {
    const refreshable = ['grok-cli', 'qoder', 'qoder-cn', 'kimi', 'codebuddy-cn', 'codebuddy-intl', 'minimax-code', 'minimax-code-global', 'nous'].includes(providerId);
    return { flow: 'device_code', login: true, refresh: refreshable, refreshConfigured: refreshable };
  }
  if (BROWSER_PKCE_PROVIDERS.has(providerId)) {
    const refreshable = ['antigravity', 'cline', 'clinepass', 'xai', 'iflow', 'gitlab', 'trae', 'windsurf'].includes(providerId);
    return { flow: 'oauth_pkce', login: true, refresh: refreshable, refreshConfigured: refreshable };
  }
  return { flow: null, login: false, refresh: false, refreshConfigured: false };
}

function makePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function publicRedirectUri(fallback: string, pathSuffix = '/oauth/callback'): string {
  const base = process.env.PUBLIC_APP_URL?.trim();
  if (base) return `${base.replace(/\/+$/, '')}${pathSuffix}`;
  return fallback;
}

// ---------------------------------------------------------------------------
// Zed & Xiaomi MiMo Real Cryptographic Handshakes
// ---------------------------------------------------------------------------

export function createZedHandshake(nativeAppPort = 58443): {
  authUrl: string;
  privateKeyPem: string;
  systemId: string;
  publicKeyB64Url: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'der' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const systemId = randomUUID();
  const publicKeyB64Url = Buffer.from(publicKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const url = new URL('https://zed.dev/native_app_signin');
  url.searchParams.set('native_app_port', String(nativeAppPort));
  url.searchParams.set('native_app_public_key', publicKeyB64Url);
  url.searchParams.set('system_id', systemId);
  return { authUrl: url.toString(), privateKeyPem: privateKey, systemId, publicKeyB64Url };
}

export function decryptZedAccessToken(encryptedAccessToken: string, privateKeyPem: string): string {
  const encrypted = Buffer.from(String(encryptedAccessToken).trim(), 'base64url');
  try {
    return privateDecrypt(
      { key: privateKeyPem, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      encrypted,
    ).toString('utf8');
  } catch (oaepErr) {
    try {
      const text = privateDecrypt(
        { key: privateKeyPem, padding: cryptoConstants.RSA_PKCS1_PADDING },
        encrypted,
      ).toString('utf8');
      if (text.includes('\uFFFD')) throw oaepErr;
      return text;
    } catch {
      throw new Error(`Failed to decrypt Zed access token: ${oaepErr instanceof Error ? oaepErr.message : String(oaepErr)}`);
    }
  }
}

export function createXiaomiHandshake(redirectUri: string): {
  authUrl: string;
  privateKeyDerB64: string;
  publicKeyB64: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const publicKeyB64 = Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).toString('base64');
  const privateKeyDerB64 = Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).toString('base64');
  const url = new URL('https://platform.xiaomimimo.com/authorize');
  url.searchParams.set('pk', publicKeyB64);
  url.searchParams.set('kn', 'mimocode');
  url.searchParams.set('redirect_uri', redirectUri);
  return { authUrl: url.toString(), privateKeyDerB64, publicKeyB64 };
}

export function decryptXiaomiCallback(privateKeyDerB64: string, encryptedUParam: string): {
  uid: string;
  sk: string;
  url: string;
} {
  const raw = Buffer.from(String(encryptedUParam).trim(), 'base64');
  if (raw.length < 12 + 32 + 16 + 1) {
    throw new Error(`Xiaomi callback payload too short (${raw.length} bytes)`);
  }
  const nonce = raw.subarray(0, 12);
  const ephemeralPubRaw = raw.subarray(12, 44);
  const ctAndTag = raw.subarray(44);
  const tag = ctAndTag.subarray(ctAndTag.length - 16);
  const ciphertext = ctAndTag.subarray(0, ctAndTag.length - 16);

  const ephemeralPub = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), ephemeralPubRaw]),
    format: 'der',
    type: 'spki',
  });
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyDerB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });

  const shared = diffieHellman({ privateKey, publicKey: ephemeralPub });
  const aesKey = createHash('sha256').update(shared).digest();
  const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(decrypted) as { uid?: string; sk?: string; url?: string };
  if (!parsed?.sk) throw new Error('Xiaomi MiMo callback missing sk credential');
  return {
    uid: String(parsed.uid ?? ''),
    sk: String(parsed.sk),
    url: String(parsed.url || 'https://api.xiaomimimo.com/v1'),
  };
}

export function parseCallbackParams(rawInput: string): {
  params: URLSearchParams;
  json: Record<string, any> | null;
  raw: string;
} {
  const trimmed = rawInput.trim();
  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed) as Record<string, any>;
      return { params: new URLSearchParams(), json, raw: trimmed };
    } catch { /* fall through */ }
  }
  try {
    const u = new URL(trimmed);
    const params = new URLSearchParams(u.search);
    if (u.hash.includes('=')) {
      const hashQuery = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash;
      for (const [k, v] of new URLSearchParams(hashQuery.includes('?') ? hashQuery.split('?')[1] : hashQuery)) {
        if (!params.has(k)) params.set(k, v);
      }
    }
    return { params, json: null, raw: trimmed };
  } catch {
    if (trimmed.includes('=')) {
      const query = trimmed.includes('?') ? trimmed.slice(trimmed.indexOf('?') + 1) : trimmed.replace(/^\?/, '');
      return { params: new URLSearchParams(query), json: null, raw: trimmed };
    }
    return { params: new URLSearchParams(), json: null, raw: trimmed };
  }
}

async function fetchJsonSafe(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; data: Record<string, any> }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text().catch(() => '');
  let data: Record<string, any> = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
// Start Extended OAuth Flow (Device Code OR Browser Paste-Callback)
// ---------------------------------------------------------------------------

export async function startExtendedOAuth(
  providerId: string,
  opts: { baseUrl?: string; clientId?: string } = {},
): Promise<{ attempt: ExtendedOAuthAttempt; responsePayload: Record<string, unknown> }> {
  const state = randomBytes(16).toString('hex');
  const pkce = makePkce();
  const now = Date.now();

  if (DEVICE_CODE_PROVIDERS.has(providerId)) {
    if (providerId === 'grok-cli') {
      const { ok, status, data } = await fetchJsonSafe('https://auth.x.ai/oauth2/device/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
          scope: 'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write',
        }).toString(),
      });
      if (!ok || !data.device_code) throw new AccountError(502, `Grok CLI device auth start failed (${status})`);
      const interval = Math.max(2, Number(data.interval ?? 5));
      const expiresIn = Math.max(60, Number(data.expires_in ?? 600));
      const attempt: ExtendedOAuthAttempt = {
        provider: providerId, flow: 'device_code', mode: 'oauth2_device', state, codeVerifier: pkce.verifier, redirectUri: '',
        deviceCode: String(data.device_code),
        verificationUri: String(data.verification_uri || 'https://auth.x.ai/device'),
        verificationUriComplete: typeof data.verification_uri_complete === 'string' ? data.verification_uri_complete : undefined,
        userCode: String(data.user_code || ''),
        interval, expiresAt: now + expiresIn * 1000,
      };
      return {
        attempt,
        responsePayload: {
          flow: 'device_code',
          verificationUri: attempt.verificationUri,
          ...(attempt.verificationUriComplete ? { verificationUriComplete: attempt.verificationUriComplete } : {}),
          userCode: attempt.userCode,
          interval,
          expiresAt: attempt.expiresAt,
        },
      };
    }

    if (providerId === 'qoder' || providerId === 'qoder-cn') {
      const isCn = providerId === 'qoder-cn';
      const nonce = randomBytes(16).toString('hex');
      const loginBase = isCn ? 'https://qoder.com.cn/device/selectAccounts' : 'https://qoder.com/device/selectAccounts';
      const verificationUri = `${loginBase}?nonce=${nonce}&challenge=${pkce.challenge}&challenge_method=S256`;
      const attempt: ExtendedOAuthAttempt = {
        provider: providerId, flow: 'device_code', mode: 'qoder_device', state, codeVerifier: pkce.verifier, redirectUri: '',
        deviceCode: nonce, verificationUri, userCode: nonce.slice(0, 8).toUpperCase(), interval: 3, expiresAt: now + 600_000,
      };
      return {
        attempt,
        responsePayload: {
          flow: 'device_code',
          verificationUri,
          verificationUriComplete: verificationUri,
          userCode: attempt.userCode,
          interval: attempt.interval,
          expiresAt: attempt.expiresAt,
        },
      };
    }

    if (providerId === 'kimi') {
      const deviceId = createHash('sha256').update(randomBytes(16)).digest('hex').slice(0, 32);
      const { ok, status, data } = await fetchJsonSafe('https://auth.kimi.com/api/oauth/device_authorization', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'X-Msh-Platform': '9router',
          'X-Msh-Version': '1.0',
          'X-Msh-Device-Id': deviceId,
          'X-Msh-Device-Name': 'Render Gateway',
          'X-Msh-Device-Model': 'Linux-x64',
        },
        body: new URLSearchParams({ client_id: '17e5f671-d194-4dfb-9706-5516cb48c098' }).toString(),
      });
      if (!ok || !data.device_code) throw new AccountError(502, `Kimi device auth start failed (${status})`);
      const interval = Math.max(2, Number(data.interval ?? 5));
      const expiresIn = Math.max(60, Number(data.expires_in ?? 600));
      const attempt: ExtendedOAuthAttempt = {
        provider: providerId, flow: 'device_code', mode: 'kimi_device', state, codeVerifier: pkce.verifier, redirectUri: '',
        extraMeta: { deviceId },
        deviceCode: String(data.device_code),
        verificationUri: String(data.verification_uri || 'https://www.kimi.com/code/authorize_device'),
        verificationUriComplete: typeof data.verification_uri_complete === 'string' ? data.verification_uri_complete : undefined,
        userCode: String(data.user_code || ''),
        interval, expiresAt: now + expiresIn * 1000,
      };
      return {
        attempt,
        responsePayload: {
          flow: 'device_code',
          verificationUri: attempt.verificationUri,
          ...(attempt.verificationUriComplete ? { verificationUriComplete: attempt.verificationUriComplete } : {}),
          userCode: attempt.userCode,
          interval,
          expiresAt: attempt.expiresAt,
        },
      };
    }

    if (providerId === 'glm') {
      const { ok, status, data } = await fetchJsonSafe('https://zcode.z.ai/api/v1/oauth/cli/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({}),
      });
      const payload = data.data && typeof data.data === 'object' ? data.data : data;
      const code = payload.deviceCode || payload.sessionId || payload.code || payload.state;
      const url = payload.verificationUri || payload.verification_uri || payload.authUrl || payload.url;
      if (!ok || !code || !url) throw new AccountError(502, `GLM device auth start failed (${status})`);
      const attempt: ExtendedOAuthAttempt = {
        provider: providerId, flow: 'device_code', mode: 'glm_device', state, codeVerifier: pkce.verifier, redirectUri: '',
        deviceCode: String(code), verificationUri: String(url), userCode: String(payload.userCode || payload.user_code || code),
        interval: 3, expiresAt: now + 600_000,
      };
      return {
        attempt,
        responsePayload: {
          flow: 'device_code', verificationUri: attempt.verificationUri,
          verificationUriComplete: attempt.verificationUri, userCode: attempt.userCode,
          interval: attempt.interval, expiresAt: attempt.expiresAt,
        },
      };
    }

    if (providerId === 'codebuddy-cn' || providerId === 'codebuddy-intl') {
      const isCn = providerId === 'codebuddy-cn';
      const base = isCn ? 'https://copilot.tencent.com' : 'https://www.codebuddy.ai';
      const ua = isCn ? 'CLI/2.63.2 CodeBuddy/2.63.2' : 'IDE/2.63.2 CodeBuddy/2.63.2';
      const { ok, status, data } = await fetchJsonSafe(`${base}/v2/plugin/auth/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
        body: JSON.stringify({ platform: isCn ? 'CLI' : 'ide' }),
      });
      if (!ok || data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
        throw new AccountError(502, `CodeBuddy auth start failed (${status}): ${data.msg || 'missing authUrl'}`);
      }
      const attempt: ExtendedOAuthAttempt = {
        provider: providerId, flow: 'device_code', mode: 'codebuddy_poll', state, codeVerifier: pkce.verifier, redirectUri: '',
        deviceCode: String(data.data.state), verificationUri: String(data.data.authUrl),
        userCode: String(data.data.state).slice(0, 12), interval: 5, expiresAt: now + 600_000,
      };
      return {
        attempt,
        responsePayload: {
          flow: 'device_code', verificationUri: attempt.verificationUri,
          verificationUriComplete: attempt.verificationUri, userCode: attempt.userCode,
          interval: attempt.interval, expiresAt: attempt.expiresAt,
        },
      };
    }

    if (providerId === 'kilocode') {
      const { ok, status, data } = await fetchJsonSafe('https://api.kilo.ai/api/device-auth/codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!ok || !data.code || !data.verificationUrl) {
        throw new AccountError(502, `Kilo Code device auth start failed (${status})`);
      }
      const expiresIn = Math.max(60, Number(data.expiresIn ?? 600));
      const attempt: ExtendedOAuthAttempt = {
        provider: providerId, flow: 'device_code', mode: 'kilocode_device', state, codeVerifier: pkce.verifier, redirectUri: '',
        deviceCode: String(data.code), verificationUri: String(data.verificationUrl),
        userCode: String(data.code), interval: 3, expiresAt: now + expiresIn * 1000,
      };
      return {
        attempt,
        responsePayload: {
          flow: 'device_code', verificationUri: attempt.verificationUri,
          verificationUriComplete: attempt.verificationUri, userCode: attempt.userCode,
          interval: attempt.interval, expiresAt: attempt.expiresAt,
        },
      };
    }

    if (providerId === 'muse') {
      const { ok, status, data } = await fetchJsonSafe('https://auth.meta.com/oidc/device/authorization/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: '1031625952748946', scope: 'openid' }).toString(),
      });
      if (!ok || !data.device_code) throw new AccountError(502, `Muse device auth start failed (${status})`);
      const interval = Math.max(2, Number(data.interval ?? 5));
      const attempt: ExtendedOAuthAttempt = {
        provider: providerId, flow: 'device_code', mode: 'muse_device', state, codeVerifier: pkce.verifier, redirectUri: '',
        deviceCode: String(data.device_code),
        verificationUri: String(data.verification_uri || 'https://auth.meta.com/device'),
        verificationUriComplete: typeof data.verification_uri_complete === 'string' ? data.verification_uri_complete : undefined,
        userCode: String(data.user_code || ''), interval, expiresAt: now + Number(data.expires_in ?? 600) * 1000,
      };
      return {
        attempt,
        responsePayload: {
          flow: 'device_code', verificationUri: attempt.verificationUri,
          ...(attempt.verificationUriComplete ? { verificationUriComplete: attempt.verificationUriComplete } : {}),
          userCode: attempt.userCode, interval, expiresAt: attempt.expiresAt,
        },
      };
    }

    if (providerId === 'nous') {
      const { ok, status, data } = await fetchJsonSafe('https://portal.nousresearch.com/api/oauth/device/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: 'hermes-cli', scope: 'inference:invoke inference:mint_agent_key' }).toString(),
      });
      if (!ok || !data.device_code) throw new AccountError(502, `Nous device auth start failed (${status})`);
      const interval = Math.max(2, Number(data.interval ?? 5));
      const attempt: ExtendedOAuthAttempt = {
        provider: providerId, flow: 'device_code', mode: 'nous_device', state, codeVerifier: pkce.verifier, redirectUri: '',
        deviceCode: String(data.device_code),
        verificationUri: String(data.verification_uri || 'https://portal.nousresearch.com/device'),
        verificationUriComplete: typeof data.verification_uri_complete === 'string' ? data.verification_uri_complete : undefined,
        userCode: String(data.user_code || ''), interval, expiresAt: now + Number(data.expires_in ?? 600) * 1000,
      };
      return {
        attempt,
        responsePayload: {
          flow: 'device_code', verificationUri: attempt.verificationUri,
          ...(attempt.verificationUriComplete ? { verificationUriComplete: attempt.verificationUriComplete } : {}),
          userCode: attempt.userCode, interval, expiresAt: attempt.expiresAt,
        },
      };
    }

    // minimax-code & minimax-code-global
    const isCn = providerId === 'minimax-code';
    const base = isCn ? 'https://account.minimax.cn' : 'https://account.minimax.io';
    const { ok, status, data } = await fetchJsonSafe(`${base}/oauth2/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: 'mcode-public',
        scope: 'agent.default',
        audience: 'agent-backend',
      }).toString(),
    });
    if (!ok || !data.device_code) throw new AccountError(502, `MiniMax Code device auth start failed (${status})`);
    const interval = Math.max(2, Number(data.interval ?? 5));
    const attempt: ExtendedOAuthAttempt = {
      provider: providerId, flow: 'device_code', mode: 'minimax_device', state, codeVerifier: pkce.verifier, redirectUri: '',
      deviceCode: String(data.device_code),
      verificationUri: String(data.verification_uri || `${base}/device`),
      verificationUriComplete: typeof data.verification_uri_complete === 'string' ? data.verification_uri_complete : undefined,
      userCode: String(data.user_code || ''), interval, expiresAt: now + Number(data.expires_in ?? 600) * 1000,
    };
    return {
      attempt,
      responsePayload: {
        flow: 'device_code', verificationUri: attempt.verificationUri,
        ...(attempt.verificationUriComplete ? { verificationUriComplete: attempt.verificationUriComplete } : {}),
        userCode: attempt.userCode, interval, expiresAt: attempt.expiresAt,
      },
    };
  }

  // Browser Paste-Callback / Handshake / Token Import
  const expiresAt = now + 15 * 60_000;
  if (providerId === 'antigravity') {
    const redirectUri = publicRedirectUri('http://localhost:51121/oauth-callback');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ].join(' '));
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    const attempt: ExtendedOAuthAttempt = {
      provider: providerId, flow: 'oauth_pkce', mode: 'antigravity_pkce', state, codeVerifier: pkce.verifier, redirectUri,
      interval: 0, expiresAt,
    };
    return { attempt, responsePayload: { flow: 'oauth_pkce', authorizationUrl: url.toString(), expiresAt } };
  }

  if (providerId === 'cline' || providerId === 'clinepass') {
    const redirectUri = publicRedirectUri('http://127.0.0.1:48801/auth');
    const url = new URL('https://api.cline.bot/api/v1/auth/authorize');
    url.searchParams.set('callback_url', redirectUri);
    url.searchParams.set('client_type', 'extension');
    const attempt: ExtendedOAuthAttempt = {
      provider: providerId, flow: 'oauth_pkce', mode: 'cline_callback', state, codeVerifier: pkce.verifier, redirectUri,
      interval: 0, expiresAt,
    };
    return { attempt, responsePayload: { flow: 'oauth_pkce', authorizationUrl: url.toString(), expiresAt } };
  }

  if (providerId === 'zed') {
    const zed = createZedHandshake();
    const attempt: ExtendedOAuthAttempt = {
      provider: providerId, flow: 'oauth_pkce', mode: 'zed_rsa', state, codeVerifier: zed.privateKeyPem, redirectUri: '',
      extraMeta: { systemId: zed.systemId }, interval: 0, expiresAt,
    };
    return { attempt, responsePayload: { flow: 'oauth_pkce', authorizationUrl: zed.authUrl, expiresAt } };
  }

  if (providerId === 'xiaomi-mimo') {
    const redirectUri = publicRedirectUri('http://127.0.0.1:54321/callback');
    const mimo = createXiaomiHandshake(redirectUri);
    const attempt: ExtendedOAuthAttempt = {
      provider: providerId, flow: 'oauth_pkce', mode: 'xiaomi_ecdh', state, codeVerifier: mimo.privateKeyDerB64, redirectUri,
      interval: 0, expiresAt,
    };
    return { attempt, responsePayload: { flow: 'oauth_pkce', authorizationUrl: mimo.authUrl, expiresAt } };
  }

  if (providerId === 'xai') {
    const redirectUri = publicRedirectUri('http://localhost:53411/callback');
    const url = new URL('https://accounts.x.ai/oauth/authorize');
    url.searchParams.set('client_id', 'b1a00492-073a-47ea-816f-4c329264a828');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid profile email offline_access api:access');
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    const attempt: ExtendedOAuthAttempt = {
      provider: providerId, flow: 'oauth_pkce', mode: 'xai_pkce', state, codeVerifier: pkce.verifier, redirectUri,
      interval: 0, expiresAt,
    };
    return { attempt, responsePayload: { flow: 'oauth_pkce', authorizationUrl: url.toString(), expiresAt } };
  }

  if (providerId === 'iflow') {
    const redirectUri = publicRedirectUri('http://localhost:11451/oauth2callback');
    const url = new URL('https://iflow.cn/oauth');
    url.searchParams.set('loginMethod', 'phone');
    url.searchParams.set('type', 'phone');
    url.searchParams.set('redirect', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('clientId', '10009311001');
    const attempt: ExtendedOAuthAttempt = {
      provider: providerId, flow: 'oauth_pkce', mode: 'iflow_oauth', state, codeVerifier: pkce.verifier, redirectUri,
      interval: 0, expiresAt,
    };
    return { attempt, responsePayload: { flow: 'oauth_pkce', authorizationUrl: url.toString(), expiresAt } };
  }

  if (providerId === 'gitlab') {
    const baseUrl = (opts.baseUrl || 'https://gitlab.com').replace(/\/+$/, '');
    const clientId = opts.clientId?.trim() || 'gitlab-duo';
    const redirectUri = publicRedirectUri('http://127.0.0.1:49152/callback');
    const url = new URL(`${baseUrl}/oauth/authorize`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'api read_user');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    const attempt: ExtendedOAuthAttempt = {
      provider: providerId, flow: 'oauth_pkce', mode: 'gitlab_pkce', state, codeVerifier: pkce.verifier, redirectUri,
      extraMeta: { baseUrl, clientId }, interval: 0, expiresAt,
    };
    return { attempt, responsePayload: { flow: 'oauth_pkce', authorizationUrl: url.toString(), expiresAt } };
  }

  // Web token / session import portals (kimchi, trae, windsurf, cursor, qwen)
  const portalUrls: Record<string, string> = {
    kimchi: 'https://app.kimchi.dev',
    trae: 'https://www.trae.ai',
    windsurf: 'https://windsurf.com/account',
    cursor: 'https://cursor.com/settings',
    qwen: 'https://chat.qwen.ai',
  };
  const attempt: ExtendedOAuthAttempt = {
    provider: providerId, flow: 'oauth_pkce', mode: 'token_paste', state, codeVerifier: pkce.verifier, redirectUri: '',
    interval: 0, expiresAt,
  };
  return {
    attempt,
    responsePayload: {
      flow: 'oauth_pkce',
      authorizationUrl: portalUrls[providerId] || 'https://github.com',
      expiresAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Complete Extended Browser Flow (Code / Pasted Callback URL / Handshake)
// ---------------------------------------------------------------------------

export async function completeExtendedOAuth(
  attempt: ExtendedOAuthAttempt,
  rawInput: string,
): Promise<{ credentialJson: string; subject?: string }> {
  const { params, json, raw } = parseCallbackParams(rawInput);

  if (attempt.mode === 'zed_rsa') {
    const userId = json?.userId || json?.user_id || params.get('user_id') || params.get('userId');
    const encryptedToken = json?.encryptedAccessToken || json?.access_token || json?.accessToken || params.get('access_token') || params.get('accessToken') || params.get('token');
    if (!userId || !encryptedToken) {
      throw new AccountError(400, 'Zed callback must include user_id and access_token.');
    }
    const accessToken = decryptZedAccessToken(String(encryptedToken), attempt.codeVerifier);
    const cred = {
      v: 1,
      kind: 'zed',
      userId: String(userId),
      systemId: attempt.extraMeta?.systemId,
      accessToken,
    };
    return { credentialJson: JSON.stringify(cred), subject: `zed:${userId}` };
  }

  if (attempt.mode === 'xiaomi_ecdh') {
    const uParam = params.get('u') || json?.u || (!raw.includes('http') ? raw : '');
    if (!uParam) throw new AccountError(400, 'Xiaomi MiMo callback missing encrypted "u" parameter.');
    const decrypted = decryptXiaomiCallback(attempt.codeVerifier, uParam);
    const cred = {
      v: 1,
      kind: 'xiaomi-mimo',
      userId: decrypted.uid,
      accessToken: decrypted.sk,
      apiKey: decrypted.sk,
      baseUrl: decrypted.url,
    };
    return { credentialJson: JSON.stringify(cred), subject: decrypted.uid ? `xiaomi:${decrypted.uid}` : undefined };
  }

  if (attempt.mode === 'token_paste') {
    if (json && (json.accessToken || json.access_token || json.token || json.apiKey)) {
      const accessToken = String(json.accessToken || json.access_token || json.token || json.apiKey);
      return {
        credentialJson: JSON.stringify({ ...json, kind: attempt.provider, accessToken }),
        subject: json.email ? String(json.email) : undefined,
      };
    }
    if (!raw) throw new AccountError(400, `Paste the ${attempt.provider} token or credential JSON.`);
    return { credentialJson: JSON.stringify({ kind: attempt.provider, accessToken: raw }) };
  }

  const code = params.get('code') || json?.code || (!raw.startsWith('http') ? raw.split('#')[0].trim() : '');
  if (!code) {
    // Allow pasting direct token JSON when provider callback already contains access_token
    const directTok = json?.accessToken || json?.access_token || params.get('access_token');
    if (directTok) {
      return {
        credentialJson: JSON.stringify({
          kind: attempt.provider,
          accessToken: String(directTok),
          refreshToken: json?.refreshToken || json?.refresh_token || params.get('refresh_token') || undefined,
        }),
      };
    }
    throw new AccountError(400, 'Missing authorization code or callback URL.');
  }
  const returnedState = params.get('state') || json?.state;
  if (returnedState && returnedState !== attempt.state) {
    throw new AccountError(400, 'OAuth state mismatch. Please restart the login flow.');
  }

  if (attempt.mode === 'antigravity_pkce') {
    const { ok, status, data } = await fetchJsonSafe('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: attempt.redirectUri,
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        code_verifier: attempt.codeVerifier,
      }).toString(),
    });
    if (!ok || !data.access_token) {
      throw new AccountError(502, `Antigravity token exchange failed (${status}): ${data.error_description || data.error || ''}`);
    }
    const expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return {
      credentialJson: JSON.stringify({
        v: 1,
        kind: 'antigravity',
        accessToken: String(data.access_token),
        refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : '',
        expiresAt,
      }),
    };
  }

  if (attempt.mode === 'cline_callback') {
    const { ok, status, data } = await fetchJsonSafe('https://api.cline.bot/api/v1/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        grantType: 'authorization_code',
        clientType: 'extension',
        redirectUri: attempt.redirectUri,
      }),
    });
    const tokData = data.data && typeof data.data === 'object' ? data.data : data;
    if (!ok || !tokData.accessToken) {
      throw new AccountError(502, `Cline token exchange failed (${status})`);
    }
    return {
      credentialJson: JSON.stringify({
        v: 1,
        kind: attempt.provider,
        accessToken: String(tokData.accessToken),
        refreshToken: tokData.refreshToken ? String(tokData.refreshToken) : undefined,
        expiresAt: tokData.expiresAt ? Date.parse(String(tokData.expiresAt)) : Date.now() + 3600_000,
      }),
    };
  }

  if (attempt.mode === 'xai_pkce') {
    const { ok, status, data } = await fetchJsonSafe('https://auth.x.ai/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: attempt.redirectUri,
        client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
        code_verifier: attempt.codeVerifier,
      }).toString(),
    });
    if (!ok || !data.access_token) throw new AccountError(502, `xAI token exchange failed (${status})`);
    return {
      credentialJson: JSON.stringify({
        v: 1,
        kind: 'xai',
        accessToken: String(data.access_token),
        refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
        expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      }),
    };
  }

  if (attempt.mode === 'iflow_oauth') {
    const basic = Buffer.from('10009311001:4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW').toString('base64');
    const { ok, status, data } = await fetchJsonSafe('https://iflow.cn/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: attempt.redirectUri,
      }).toString(),
    });
    if (!ok || !data.access_token) throw new AccountError(502, `iFlow token exchange failed (${status})`);
    return {
      credentialJson: JSON.stringify({
        v: 1,
        kind: 'iflow',
        accessToken: String(data.access_token),
        refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
        expiresAt: Date.now() + (Number(data.expires_in) || 86400) * 1000,
      }),
    };
  }

  // gitlab_pkce
  const baseUrl = attempt.extraMeta?.baseUrl || 'https://gitlab.com';
  const clientId = attempt.extraMeta?.clientId || 'gitlab-duo';
  const { ok, status, data } = await fetchJsonSafe(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: attempt.redirectUri,
      code_verifier: attempt.codeVerifier,
    }).toString(),
  });
  if (!ok || !data.access_token) throw new AccountError(502, `GitLab token exchange failed (${status})`);
  return {
    credentialJson: JSON.stringify({
      v: 1,
      kind: 'gitlab',
      accessToken: String(data.access_token),
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
      expiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000,
      baseUrl: `${baseUrl}/api/v4/chat/completions`,
    }),
  };
}

// ---------------------------------------------------------------------------
// Poll Extended Device-Code Flows
// ---------------------------------------------------------------------------

export async function pollExtendedOAuth(attempt: ExtendedOAuthAttempt): Promise<ExtendedPollResult> {
  if (attempt.provider === 'grok-cli' || attempt.provider === 'kimi' || attempt.provider === 'muse' || attempt.provider === 'nous' || attempt.provider === 'minimax-code' || attempt.provider === 'minimax-code-global') {
    const tokenUrl = attempt.provider === 'grok-cli'
      ? 'https://auth.x.ai/oauth2/token'
      : attempt.provider === 'kimi'
        ? 'https://auth.kimi.com/api/oauth/token'
        : attempt.provider === 'muse'
          ? 'https://auth.meta.com/oidc/device/token/'
          : attempt.provider === 'nous'
            ? 'https://portal.nousresearch.com/api/oauth/token'
            : attempt.provider === 'minimax-code'
              ? 'https://account.minimax.cn/oauth2/token'
              : 'https://account.minimax.io/oauth2/token';
    const clientId = attempt.provider === 'grok-cli'
      ? 'b1a00492-073a-47ea-816f-4c329264a828'
      : attempt.provider === 'kimi'
        ? '17e5f671-d194-4dfb-9706-5516cb48c098'
        : attempt.provider === 'muse'
          ? '1031625952748946'
          : attempt.provider === 'nous'
            ? 'hermes-cli'
            : 'mcode-public';

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    if (attempt.provider === 'kimi' && attempt.extraMeta?.deviceId) {
      headers['X-Msh-Platform'] = '9router';
      headers['X-Msh-Version'] = '1.0';
      headers['X-Msh-Device-Id'] = attempt.extraMeta.deviceId;
    }

    const { ok, status, data } = await fetchJsonSafe(tokenUrl, {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: attempt.deviceCode!,
        client_id: clientId,
      }).toString(),
    });

    const err = String(data.error ?? '');
    if (!ok) {
      if (err === 'authorization_pending') return { pending: true };
      if (err === 'slow_down') return { pending: true, slow: true };
      throw new AccountError(502, `${attempt.provider} device poll failed (${status}): ${data.error_description || err || 'rejected'}`);
    }
    if (!data.access_token) return { pending: true };

    return {
      pending: false,
      credentialJson: JSON.stringify({
        v: 1,
        kind: attempt.provider,
        accessToken: String(data.access_token),
        refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
        expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      }),
    };
  }

  if (attempt.provider === 'qoder' || attempt.provider === 'qoder-cn') {
    const pollUrl = attempt.provider === 'qoder-cn'
      ? `https://openapi.qoder.com.cn/api/v1/deviceToken/poll?nonce=${encodeURIComponent(attempt.deviceCode!)}&verifier=${encodeURIComponent(attempt.codeVerifier)}`
      : `https://openapi.qoder.sh/api/v1/deviceToken/poll?nonce=${encodeURIComponent(attempt.deviceCode!)}&verifier=${encodeURIComponent(attempt.codeVerifier)}`;
    const { ok, status, data } = await fetchJsonSafe(pollUrl, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!ok && status !== 202) throw new AccountError(502, `Qoder poll failed (${status})`);
    const tokData = data.data && typeof data.data === 'object' ? data.data : data;
    const accessToken = tokData.accessToken || tokData.access_token || tokData.token;
    if (!accessToken) return { pending: true };
    return {
      pending: false,
      credentialJson: JSON.stringify({
        v: 1,
        kind: attempt.provider,
        accessToken: String(accessToken),
        refreshToken: typeof (tokData.refreshToken || tokData.refresh_token) === 'string'
          ? String(tokData.refreshToken || tokData.refresh_token)
          : undefined,
        userId: typeof tokData.userId === 'string' ? tokData.userId : undefined,
      }),
    };
  }

  if (attempt.provider === 'codebuddy-cn' || attempt.provider === 'codebuddy-intl') {
    const isCn = attempt.provider === 'codebuddy-cn';
    const base = isCn ? 'https://copilot.tencent.com' : 'https://www.codebuddy.ai';
    const ua = isCn ? 'CLI/2.63.2 CodeBuddy/2.63.2' : 'IDE/2.63.2 CodeBuddy/2.63.2';
    const { ok, status, data } = await fetchJsonSafe(
      `${base}/v2/plugin/auth/token?state=${encodeURIComponent(attempt.deviceCode!)}`,
      { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': ua } },
    );
    if (!ok) throw new AccountError(502, `CodeBuddy poll failed (${status})`);
    if (data.code !== 0 || !data.data?.accessToken) return { pending: true };
    return {
      pending: false,
      credentialJson: JSON.stringify({
        v: 1,
        kind: attempt.provider,
        accessToken: String(data.data.accessToken),
        refreshToken: data.data.refreshToken ? String(data.data.refreshToken) : undefined,
        expiresAt: Date.now() + (Number(data.data.expiresIn) || 3600) * 1000,
      }),
    };
  }

  if (attempt.provider === 'kilocode') {
    const { ok, status, data } = await fetchJsonSafe(
      `https://api.kilo.ai/api/device-auth/codes/${encodeURIComponent(attempt.deviceCode!)}`,
      { method: 'GET', headers: { Accept: 'application/json' } },
    );
    if (status === 404 || status === 202 || data.status === 'pending') return { pending: true };
    if (!ok) throw new AccountError(502, `Kilo Code poll failed (${status})`);
    const token = data.token || data.accessToken || data.apiKey;
    if (!token) return { pending: true };
    return {
      pending: false,
      credentialJson: JSON.stringify({ v: 1, kind: 'kilocode', accessToken: String(token) }),
    };
  }

  // glm
  const { ok, status, data } = await fetchJsonSafe(
    `https://zcode.z.ai/api/v1/oauth/cli/poll?code=${encodeURIComponent(attempt.deviceCode!)}`,
    { method: 'GET', headers: { Accept: 'application/json' } },
  );
  if (!ok && status !== 202) throw new AccountError(502, `GLM poll failed (${status})`);
  const tokData = data.data && typeof data.data === 'object' ? data.data : data;
  const token = tokData.accessToken || tokData.token || tokData.apiKey || tokData['zcode-api-key'];
  if (!token) return { pending: true };
  return {
    pending: false,
    credentialJson: JSON.stringify({ v: 1, kind: 'glm', accessToken: String(token) }),
  };
}

// ---------------------------------------------------------------------------
// Persist Extended Account & Bulk Import
// ---------------------------------------------------------------------------

export function saveExtendedOAuthAccount(input: {
  provider: string;
  credentialJson: string;
  label: string;
  userId: number;
  reconnectId?: number;
  proxyUrl?: string | null;
  proxyPoolId?: number | null;
  subject?: string;
  authMethod: ProviderAccountAuthMethod;
}): number {
  return getDb().transaction(() => {
    let id: number;
    if (input.reconnectId !== undefined) {
      const old = accountRow(input.reconnectId);
      if (old.provider !== input.provider) throw new AccountError(400, 'Reconnect provider mismatch.');
      id = old.id;
      updateAccountCredential(id, input.credentialJson);
      let proxyEnc = old.proxy_encrypted;
      let proxyIv = old.proxy_iv;
      let proxyTag = old.proxy_auth_tag;
      let poolId = old.proxy_pool_id;
      if (input.proxyUrl !== undefined) {
        const rawProxy = input.proxyUrl?.trim() ?? '';
        if (rawProxy && !isValidKeyProxyUrl(rawProxy)) throw new AccountError(400, KEY_PROXY_URL_ERROR);
        const enc = encryptProxyUrl(rawProxy);
        proxyEnc = enc.encrypted;
        proxyIv = enc.iv;
        proxyTag = enc.authTag;
      }
      if (input.proxyPoolId !== undefined) {
        if (input.proxyPoolId != null && !proxyPoolExists(input.proxyPoolId)) {
          throw new AccountError(400, 'Proxy pool entry not found.');
        }
        poolId = input.proxyPoolId;
      }
      getDb()
        .prepare("UPDATE x_gateway_keys SET label = ?, status = 'unknown', last_checked_at = NULL, proxy_encrypted = ?, proxy_iv = ?, proxy_auth_tag = ?, proxy_pool_id = ? WHERE id = ?")
        .run(input.label, proxyEnc, proxyIv, proxyTag, poolId, id);
    } else {
      id = createApiKeyAccount({
        provider: input.provider,
        key: input.credentialJson,
        label: input.label,
        userId: input.userId,
        authMethod: input.authMethod,
        proxyUrl: input.proxyUrl,
        proxyPoolId: input.proxyPoolId,
      });
    }
    if (input.subject) {
      getDb().prepare('UPDATE x_gateway_keys SET subject = ? WHERE id = ?').run(input.subject, id);
    }
    clearOAuthRefreshStateForAccount(id);
    invalidateXGatewayKeyCache();
    return id;
  })();
}

export interface BulkImportItemResult {
  index: number;
  provider?: string;
  error: string;
}

export function bulkImportCredentials(input: {
  payload: unknown;
  defaultProvider?: string;
  labelPrefix?: string;
  userId: number;
  allowCustomModels: boolean;
}): { imported: number; failed: number; ids: number[]; errors: BulkImportItemResult[] } {
  let items: unknown[] = [];
  if (typeof input.payload === 'string') {
    const trimmed = input.payload.trim();
    if (!trimmed) throw new AccountError(400, 'Import payload is empty.');
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) items = parsed;
      else if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        items = Array.isArray(obj.connections)
          ? obj.connections
          : Array.isArray(obj.accounts)
            ? obj.accounts
            : [obj];
      }
    } catch {
      items = trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return { key: line }; }
        });
    }
  } else if (Array.isArray(input.payload)) {
    items = input.payload;
  } else if (input.payload && typeof input.payload === 'object') {
    const obj = input.payload as Record<string, unknown>;
    items = Array.isArray(obj.connections)
      ? obj.connections
      : Array.isArray(obj.accounts)
        ? obj.accounts
        : [obj];
  }

  if (items.length === 0) throw new AccountError(400, 'No credentials found in bulk import payload.');
  if (items.length > 200) throw new AccountError(400, 'Bulk import is limited to 200 entries per batch.');

  const ids: number[] = [];
  const errors: BulkImportItemResult[] = [];
  const nativeOAuth = new Set(['codex', 'claude', 'gemini-cli', 'kiro']);

  for (let i = 0; i < items.length; i++) {
    const rawItem = items[i];
    try {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        throw new Error('Entry must be a JSON object.');
      }
      const item = rawItem as Record<string, any>;
      const rawProv = String(item.provider ?? item.kind ?? input.defaultProvider ?? '').trim();
      const provider = normalizeXGatewayProviderId(rawProv);
      if (!provider || !getXGatewayProvider(provider)) {
        throw new Error(`Unknown provider: ${rawProv || '(missing)'}`);
      }
      const baseUrl = typeof item.baseUrl === 'string' && item.baseUrl.trim() ? item.baseUrl.trim() : undefined;
      if (baseUrl && !input.allowCustomModels) {
        throw new Error('Custom baseUrl requires manage_key_models permission.');
      }
      const label = String(item.label ?? item.name ?? item.email ?? `${input.labelPrefix || provider} #${i + 1}`).trim().slice(0, 120);

      if (nativeOAuth.has(provider)) {
        const rawJson = JSON.stringify(item.credential && typeof item.credential === 'object' ? item.credential : item);
        if (!normalizeImportedCredential(provider, rawJson)) {
          throw new Error(`Invalid native OAuth credential format for ${provider}.`);
        }
        const id = saveSubscription({
          provider,
          credential: rawJson,
          label,
          userId: input.userId,
          proxyUrl: typeof item.proxyUrl === 'string' ? item.proxyUrl : undefined,
        });
        ids.push(id);
        continue;
      }

      const rawSecret =
        typeof item.credential === 'string'
          ? item.credential
          : item.credential && typeof item.credential === 'object'
            ? JSON.stringify(item.credential)
            : typeof item.key === 'string'
              ? item.key
              : (item.accessToken || item.access_token || item.apiKey || item.api_key || item.private_key)
                ? JSON.stringify(item)
                : '';

      if (!rawSecret.trim()) throw new Error('Missing key or OAuth credential fields.');
      const id = createApiKeyAccount({
        provider,
        key: rawSecret.trim(),
        label,
        baseUrl,
        proxyUrl: typeof item.proxyUrl === 'string' ? item.proxyUrl : undefined,
        authMethod: item.authMethod === 'device_code' || item.authMethod === 'oauth_pkce' ? item.authMethod : 'api_key',
        userId: input.userId,
      });
      ids.push(id);
    } catch (err: any) {
      errors.push({ index: i, error: err?.message ?? 'Import entry failed.' });
    }
  }

  return { imported: ids.length, failed: errors.length, ids, errors };
}
