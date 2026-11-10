/**
 * OAuth provider descriptors for the X Gateway subscription providers.
 *
 * Everything here is provider configuration plus token-endpoint plumbing; no
 * desktop callback server is involved. The authorization code is pasted back
 * through the existing X Gateway connect dialog, which is the only flow that
 * works on a headless Render/Docker deployment.
 */
import {
  applyTokenResponse,
  decodeJwtPayload,
  extractEmailFromJwt,
  type OAuthCredential,
  type OAuthKind,
} from './oauth-credentials.js';

export interface OAuthProviderDescriptor {
  kind: OAuthKind;
  name: string;
  clientId: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  redirectUri: string;
  usePkce: boolean;
  extraAuthorizeParams: Record<string, string>;
  exchangeEncoding: 'form' | 'json';
  refreshEncoding: 'form' | 'json';
  refreshLeadMs: number;
  authMethod: 'oauth_pkce';
}

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const GEMINI_CLIENT_ID = process.env.GEMINI_CLIENT_ID || '';
const GEMINI_CLIENT_SECRET = process.env.GEMINI_CLIENT_SECRET || '';

export const GEMINI_CLOUDCODE_URL = 'https://cloudcode-pa.googleapis.com/v1internal';
export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo';

export const OAUTH_PROVIDERS: Record<OAuthKind, OAuthProviderDescriptor> = {
  codex: {
    kind: 'codex',
    name: 'OpenAI Codex',
    clientId: CODEX_CLIENT_ID,
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    scope: 'openid profile email offline_access',
    redirectUri: 'http://localhost:1455/auth/callback',
    usePkce: true,
    extraAuthorizeParams: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    },
    exchangeEncoding: 'form',
    refreshEncoding: 'json',
    refreshLeadMs: 10 * 60_000,
    authMethod: 'oauth_pkce',
  },
  claude: {
    kind: 'claude',
    name: 'Claude Code',
    clientId: CLAUDE_CLIENT_ID,
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://api.anthropic.com/v1/oauth/token',
    scope: 'org:create_api_key user:profile user:inference',
    redirectUri: 'https://console.anthropic.com/oauth/code/callback',
    usePkce: true,
    extraAuthorizeParams: { code: 'true' },
    exchangeEncoding: 'json',
    refreshEncoding: 'json',
    refreshLeadMs: 4 * 60 * 60_000,
    authMethod: 'oauth_pkce',
  },
  'gemini-cli': {
    kind: 'gemini-cli',
    name: 'Gemini CLI',
    clientId: GEMINI_CLIENT_ID,
    clientSecret: GEMINI_CLIENT_SECRET,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
    redirectUri: 'http://localhost:8085/oauth2callback',
    usePkce: false,
    extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
    exchangeEncoding: 'form',
    refreshEncoding: 'form',
    refreshLeadMs: 5 * 60_000,
    authMethod: 'oauth_pkce',
  },
};

export function oauthDescriptor(kind: string): OAuthProviderDescriptor | null {
  return Object.prototype.hasOwnProperty.call(OAUTH_PROVIDERS, kind)
    ? OAUTH_PROVIDERS[kind as OAuthKind]
    : null;
}

export function buildAuthorizationUrl(
  descriptor: OAuthProviderDescriptor,
  state: string,
  codeChallenge: string | null,
): string {
  const url = new URL(descriptor.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', descriptor.clientId);
  url.searchParams.set('redirect_uri', descriptor.redirectUri);
  url.searchParams.set('scope', descriptor.scope);
  url.searchParams.set('state', state);
  if (codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [key, value] of Object.entries(descriptor.extraAuthorizeParams)) {
    url.searchParams.set(key, value);
  }
  // Codex builds the URL manually upstream so spaces encode as %20.
  return url.toString().replace(/\+/g, '%20');
}

export interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/** Anthropic returns `code#state` when the user copies the console code. */
export function splitAuthorizationCode(code: string): { code: string; state: string | null } {
  const [head, ...rest] = code.trim().split('#');
  const state = rest.join('#').trim();
  return { code: (head ?? '').trim(), state: state || null };
}

const tokenHosts = new Set([
  new URL(OAUTH_PROVIDERS.codex.tokenUrl).host,
  new URL(OAUTH_PROVIDERS.claude.tokenUrl).host,
  new URL(OAUTH_PROVIDERS['gemini-cli'].tokenUrl).host,
]);

async function tokenRequest(url: string, init: RequestInit): Promise<RawTokenResponse> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !tokenHosts.has(target.host)) {
    throw new Error('Unsupported OAuth token endpoint.');
  }
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: {
      Accept: 'application/json',
      'User-Agent': 'FreeLLMAPI/0.2.1 (provider-accounts)',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const body = await response.json().catch(() => ({})) as RawTokenResponse;
  if (!response.ok || typeof body.access_token !== 'string') {
    const error = new Error(
      typeof body.error_description === 'string' ? body.error_description
        : typeof body.error === 'string' ? body.error
          : `OAuth token endpoint returned HTTP ${response.status}.`,
    ) as OAuthRefreshError;
    error.status = response.status;
    error.code = typeof body.error === 'string' ? body.error : undefined;
    error.permanent = isPermanentOAuthError(error.code, error.message);
    throw error;
  }
  return body;
}

export interface OAuthRefreshError extends Error {
  status?: number;
  code?: string;
  permanent?: boolean;
}

export function isPermanentOAuthError(code: string | undefined, message: string): boolean {
  const key = `${code ?? ''} ${message}`.toLowerCase();
  return ['invalid_grant', 'invalid_request', 'refresh_token_reused', 'unauthorized_client', 'access_denied']
    .some(pattern => key.includes(pattern));
}

export async function exchangeAuthorizationCode(
  descriptor: OAuthProviderDescriptor,
  rawCode: string,
  verifier: string,
): Promise<RawTokenResponse> {
  const { code, state } = splitAuthorizationCode(rawCode);
  if (!code) throw new Error('Authorization code is required.');
  if (descriptor.exchangeEncoding === 'form') {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: descriptor.clientId,
      code,
      redirect_uri: descriptor.redirectUri,
    });
    if (descriptor.clientSecret) body.set('client_secret', descriptor.clientSecret);
    if (descriptor.usePkce) body.set('code_verifier', verifier);
    return tokenRequest(descriptor.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  }
  const payload: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: descriptor.clientId,
    code,
    redirect_uri: descriptor.redirectUri,
  };
  if (descriptor.usePkce) {
    payload.code_verifier = verifier;
    payload.state = state ?? verifier;
  }
  return tokenRequest(descriptor.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function refreshOAuthCredential(
  descriptor: OAuthProviderDescriptor,
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  const payload: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: credential.refreshToken,
    client_id: descriptor.clientId,
  };
  if (descriptor.clientSecret) payload.client_secret = descriptor.clientSecret;
  const tokens = descriptor.refreshEncoding === 'json'
    ? await tokenRequest(descriptor.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    : await tokenRequest(descriptor.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(payload),
    });
  return applyTokenResponse(credential, tokens);
}

function cloudCodeRequest(path: string, accessToken: string): Promise<Response> {
  return fetch(`${GEMINI_CLOUDCODE_URL}:${path}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'google-api-nodejs-client/9.15.1',
      'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    },
    // Matches the Gemini CLI client metadata: ideType 9, Linux x64 (3), plugin 2.
    body: JSON.stringify({ metadata: { ideType: 9, platform: 3, pluginType: 2 }, mode: 1 }),
  });
}

/** Resolve the Cloud Code Assist project id bound to a Google OAuth token. */
export async function fetchGeminiProjectId(accessToken: string): Promise<string | null> {
  try {
    const response = await cloudCodeRequest('loadCodeAssist', accessToken);
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const data = await response.json() as Record<string, unknown>;
    const project = data.cloudaicompanionProject;
    if (typeof project === 'string' && project.trim()) return project.trim();
    if (project && typeof project === 'object') {
      const id = (project as Record<string, unknown>).id;
      if (typeof id === 'string' && id.trim()) return id.trim();
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchGoogleEmail(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(`${GOOGLE_USERINFO_URL}?alt=json`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const data = await response.json() as Record<string, unknown>;
    return typeof data.email === 'string' && data.email.trim() ? data.email.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Metadata that only the token exchange can provide: account identity, the
 * ChatGPT plan, and the Gemini project. Best-effort and never fatal.
 */
export async function resolveCredentialMetadata(
  descriptor: OAuthProviderDescriptor,
  tokens: RawTokenResponse,
): Promise<{ email?: string; subject?: string; accountId?: string; planType?: string; projectId?: string }> {
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : '';
  if (descriptor.kind === 'codex') {
    const payload = decodeJwtPayload(typeof tokens.id_token === 'string' ? tokens.id_token : undefined);
    const auth = payload && typeof payload['https://api.openai.com/auth'] === 'object'
      ? payload['https://api.openai.com/auth'] as Record<string, unknown>
      : null;
    const accountId = typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined;
    const planType = typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined;
    const email = extractEmailFromJwt(typeof tokens.id_token === 'string' ? tokens.id_token : undefined)
      ?? extractEmailFromJwt(accessToken);
    return {
      ...(email ? { email } : {}),
      ...(accountId || email ? { subject: accountId ?? email } : {}),
      ...(accountId ? { accountId } : {}),
      ...(planType ? { planType } : {}),
    };
  }
  if (descriptor.kind === 'gemini-cli' && accessToken) {
    const [email, projectId] = await Promise.all([fetchGoogleEmail(accessToken), fetchGeminiProjectId(accessToken)]);
    return {
      ...(email ? { email } : {}),
      ...(email ? { subject: email } : {}),
      ...(projectId ? { projectId } : {}),
    };
  }
  return {};
}

/**
 * Normalise credentials exported by the CLI tools (`~/.codex/auth.json`,
 * `~/.claude/.credentials.json`, `~/.gemini/oauth_creds.json`) so a pasted
 * file keeps its refresh token instead of degrading to a one-hour token.
 */
export function normalizeImportedCredential(providerId: string, raw: string): string | null {
  const descriptor = oauthDescriptor(providerId);
  if (!descriptor) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const nested = (key: string): Record<string, unknown> | null => {
    const value = parsed[key];
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  };
  const pick = (source: Record<string, unknown> | null, ...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = source?.[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };
  let tokenSource: Record<string, unknown> | null = parsed;
  if (descriptor.kind === 'codex') tokenSource = nested('tokens') ?? nested('auth') ?? parsed;
  if (descriptor.kind === 'claude') tokenSource = nested('claudeAiOauth') ?? parsed;
  if (!tokenSource) return null;

  const accessToken = pick(tokenSource, 'accessToken', 'access_token');
  if (!accessToken || !/^[\x21-\x7e]+$/.test(accessToken)) return null;
  const refreshToken = pick(tokenSource, 'refreshToken', 'refresh_token');
  if (!refreshToken || !/^[\x21-\x7e]+$/.test(refreshToken)) return null;
  const rawExpiry = tokenSource.expiresAt ?? tokenSource.expiry_date ?? parsed.expiresAt ?? parsed.expiry_date;
  const numericExpiry = typeof rawExpiry === 'number'
    ? (rawExpiry < 1e12 ? rawExpiry * 1000 : rawExpiry)
    : typeof rawExpiry === 'string' ? Date.parse(rawExpiry) : NaN;
  const expiresAt = Number.isFinite(numericExpiry) && numericExpiry > 0 ? numericExpiry : Date.now() + 3600_000;
  const email = pick(tokenSource, 'email') ?? pick(parsed, 'email');
  const accountId = pick(tokenSource, 'account_id', 'accountId') ?? pick(parsed, 'account_id', 'accountId');
  const projectId = pick(tokenSource, 'projectId', 'project_id') ?? pick(parsed, 'projectId', 'project_id');
  const scope = pick(tokenSource, 'scope') ?? pick(parsed, 'scope');
  const credential = {
    v: 1 as const,
    kind: descriptor.kind,
    accessToken,
    refreshToken,
    expiresAt,
    lastRefreshAt: Date.now(),
    ...(email ? { email } : {}),
    ...(accountId || email ? { subject: accountId ?? email } : {}),
    ...(accountId ? { accountId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(scope ? { scope } : {}),
  };
  return JSON.stringify(credential);
}
