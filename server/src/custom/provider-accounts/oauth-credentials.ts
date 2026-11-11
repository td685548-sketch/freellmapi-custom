/**
 * Structured OAuth credentials for X Gateway subscription providers.
 *
 * The existing `x_gateway_keys.encrypted_key` column keeps holding a single
 * encrypted string. For OAuth accounts that string is a JSON blob described
 * here, so no schema migration is required and legacy plain-text credentials
 * (raw API keys, `x-copilot:` tokens, cookies) keep working untouched.
 */
export const OAUTH_CREDENTIAL_VERSION = 1 as const;

export type OAuthKind = 'codex' | 'claude' | 'gemini-cli' | 'kiro';

export interface OAuthCredential {
  v: typeof OAUTH_CREDENTIAL_VERSION;
  kind: OAuthKind;
  accessToken: string;
  refreshToken: string;
  /** Access-token expiry in epoch milliseconds. */
  expiresAt: number;
  /** Epoch milliseconds of the last successful refresh (Codex staleness guard). */
  lastRefreshAt?: number;
  email?: string;
  /** Stable identity used for duplicate/reconnect checks. */
  subject?: string;
  /** ChatGPT account id (Codex header). */
  accountId?: string;
  planType?: string;
  /** Google Cloud Code Assist project (Gemini CLI). */
  projectId?: string;
  scope?: string;
  region?: string;
  profileArn?: string;
  authMethod?: 'builder-id' | 'idc' | 'social';
  clientId?: string;
  clientSecret?: string;
}

const KINDS: readonly OAuthKind[] = ['codex', 'claude', 'gemini-cli', 'kiro'];

export function isOAuthKind(value: unknown): value is OAuthKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

function text(value: unknown, max = 16384): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;
}

function milliseconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Tolerate second-based epochs from CLI files.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Parse the decrypted blob. Returns null for legacy/plain credentials. */
export function parseOAuthCredential(raw: string): OAuthCredential | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const data = parsed as Record<string, unknown>;
  if (data.v !== OAUTH_CREDENTIAL_VERSION || !isOAuthKind(data.kind)) return null;
  const accessToken = text(data.accessToken);
  const refreshToken = text(data.refreshToken);
  const expiresAt = milliseconds(data.expiresAt);
  if (!accessToken || !refreshToken || !expiresAt || !/^[\x21-\x7e]+$/.test(accessToken) || !/^[\x21-\x7e]+$/.test(refreshToken)) return null;
  const credential: OAuthCredential = { v: 1, kind: data.kind, accessToken, refreshToken, expiresAt };
  const email = text(data.email, 320);
  if (email) credential.email = email;
  const subject = text(data.subject, 320);
  if (subject) credential.subject = subject;
  const accountId = text(data.accountId, 200);
  if (accountId) credential.accountId = accountId;
  const planType = text(data.planType, 100);
  if (planType) credential.planType = planType;
  const projectId = text(data.projectId, 200);
  if (projectId) credential.projectId = projectId;
  const scope = text(data.scope, 2000);
  if (scope) credential.scope = scope;
  const lastRefreshAt = milliseconds(data.lastRefreshAt);
  if (lastRefreshAt) credential.lastRefreshAt = lastRefreshAt;
  for (const name of ['region', 'profileArn', 'clientId', 'clientSecret'] as const) {
    const value = text(data[name]);
    if (value) credential[name] = value;
  }
  if (data.authMethod === 'builder-id' || data.authMethod === 'idc' || data.authMethod === 'social') credential.authMethod = data.authMethod;
  if (credential.kind === 'kiro' && !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(credential.region ?? 'us-east-1')) return null;
  return credential;
}

export function serializeOAuthCredential(credential: OAuthCredential): string {
  return JSON.stringify(credential);
}

export function oauthIdentity(credential: OAuthCredential): string | null {
  return credential.subject ?? credential.email ?? credential.accountId ?? null;
}

export function credentialExpired(credential: OAuthCredential, now = Date.now()): boolean {
  return credential.expiresAt <= now;
}

/**
 * Refresh before the token is actually rejected. Codex rotates its refresh
 * token on use and reuse revokes the whole ChatGPT session, so the lead stays
 * short (10 minutes) exactly like the Codex CLI / 9router reference.
 */
export function needsRefresh(
  credential: OAuthCredential,
  leadMs: number,
  now = Date.now(),
): boolean {
  if (!credential.refreshToken) return false;
  return credential.expiresAt - now <= leadMs;
}

export interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  id_token?: unknown;
}

/** Merge a token endpoint response into the stored credential. */
export function applyTokenResponse(
  current: OAuthCredential,
  tokens: TokenResponse,
  now = Date.now(),
): OAuthCredential {
  const accessToken = text(tokens.access_token);
  if (!accessToken || !/^[\x21-\x7e]+$/.test(accessToken)) throw new Error('Token endpoint returned an invalid access token.');
  const refreshToken = text(tokens.refresh_token) ?? current.refreshToken;
  if (!refreshToken || !/^[\x21-\x7e]+$/.test(refreshToken)) throw new Error('Token endpoint omitted a valid refresh token.');
  const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : Number(tokens.expires_in);
  const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600_000;
  const scope = text(tokens.scope, 2000);
  return {
    ...current,
    accessToken,
    refreshToken,
    expiresAt: now + lifetimeMs,
    lastRefreshAt: now,
    ...(scope ? { scope } : {}),
  };
}

/** Decode a JWT payload without verifying it (provider-issued, TLS-fetched). */
export function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function extractEmailFromJwt(token: string | undefined): string | undefined {
  const payload = decodeJwtPayload(token);
  return text(payload?.email, 320);
}
