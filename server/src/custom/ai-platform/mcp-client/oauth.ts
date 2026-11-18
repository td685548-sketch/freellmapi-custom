import crypto from 'node:crypto';
import {
  MCP_OAUTH_LIMITS,
  type McpOAuthCallbackInput,
  type McpOAuthConfigInput,
  type McpOAuthConnectionStatus,
  type McpOAuthRevokeResponse,
  type McpOAuthStartInput,
  type McpOAuthStartResponse,
  type McpOAuthStatusView,
} from '@freellmapi/shared/ai-platform-tracing-oauth.js';
import { getDb } from '../../../db/index.js';
import { decrypt, encrypt } from '../../../lib/crypto.js';
import {
  assessProviderUrlWithPin,
  assertSafeHttpBaseUrlSync,
  createPinnedDispatcher,
} from '../../../lib/url-guard.js';
import { sanitizeMcpError, sanitizeMcpText } from './sanitize.js';
import {
  McpNotFoundError,
  McpServiceError,
  McpValidationError,
  getAllowedInternalOrigins,
  hasTable,
  safeJsonParse,
} from './store.js';

export interface McpOAuthNetworkOptions {
  allowedInternalOrigins?: readonly string[];
  dnsResolver?: (hostname: string) => Promise<string[]>;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

interface OAuthCredentialsRow {
  server_id: number;
  issuer_url: string | null;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string | null;
  client_id: string;
  client_secret_ciphertext: string | null;
  client_secret_iv: string | null;
  client_secret_tag: string | null;
  scopes_json: string;
  redirect_uri: string;
  pkce_method: string;
  access_token_ciphertext: string | null;
  access_token_iv: string | null;
  access_token_tag: string | null;
  refresh_token_ciphertext: string | null;
  refresh_token_iv: string | null;
  refresh_token_tag: string | null;
  token_type: string;
  expires_at: string | null;
  last_refreshed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface PkceStateRow {
  state_hash: string;
  server_id: number;
  code_verifier_ciphertext: string;
  code_verifier_iv: string;
  code_verifier_tag: string;
  redirect_uri: string;
  scopes_json: string;
  actor_id: number | null;
  expires_at: string;
  created_at: string;
}

const singleFlightRefreshes = new Map<number, Promise<string>>();

function ensureServerExists(serverId: number): void {
  const row = getDb()
    .prepare('SELECT id FROM custom_ai_mcp_servers WHERE id = ?')
    .get(serverId);
  if (!row) {
    throw new McpNotFoundError(`MCP server ${serverId} not found.`);
  }
}

function hashStateToken(state: string): string {
  return crypto.createHash('sha256').update(state, 'utf8').digest('hex');
}

export function generatePkceS256Pair(): {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
} {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier, 'ascii')
    .digest('base64url');
  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256',
  };
}

function decryptOptionalSecret(
  ciphertext: string | null | undefined,
  iv: string | null | undefined,
  tag: string | null | undefined,
): string | null {
  if (!ciphertext || !iv || !tag) return null;
  return decrypt(ciphertext, iv, tag);
}

function validateOAuthEndpointUrlSync(
  rawUrl: string,
  label: string,
  allowedInternalOrigins?: readonly string[],
): string {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed || trimmed.length > MCP_OAUTH_LIMITS.maxUrlChars) {
    throw new McpValidationError(`Invalid ${label} URL.`, 'unsafe_url', 422);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new McpValidationError(`Invalid ${label} URL format.`, 'unsafe_url', 422);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new McpValidationError(
      `${label} URL must not contain embedded credentials or fragments.`,
      'unsafe_url',
      422,
    );
  }
  const allowed = allowedInternalOrigins ?? getAllowedInternalOrigins();
  const isAllowedOrigin = allowed.includes(parsed.origin);
  try {
    assertSafeHttpBaseUrlSync(trimmed, !isAllowedOrigin);
  } catch (err) {
    throw new McpValidationError(
      err instanceof Error ? err.message : `${label} URL rejected by SSRF policy.`,
      'unsafe_url',
      422,
    );
  }
  if (parsed.protocol === 'https:') {
    return parsed.toString();
  }
  if (parsed.protocol === 'http:') {
    if (!isAllowedOrigin) {
      throw new McpValidationError(
        `HTTP ${label} URL requires an exact origin in allowed-internal-hosts.`,
        'unsafe_url',
        422,
      );
    }
    return parsed.toString();
  }
  throw new McpValidationError(`${label} URL must use https.`, 'unsafe_url', 422);
}

function validateRedirectUri(rawUri: string): string {
  const trimmed = String(rawUri ?? '').trim();
  if (!trimmed || trimmed.length > MCP_OAUTH_LIMITS.maxUrlChars) {
    throw new McpValidationError('redirectUri must be a valid URL.', 'invalid_oauth_config', 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new McpValidationError('redirectUri must be a valid URL.', 'invalid_oauth_config', 400);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new McpValidationError('redirectUri must use https or http.', 'invalid_oauth_config', 400);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new McpValidationError(
      'redirectUri must not contain credentials or URL fragments.',
      'invalid_oauth_config',
      400,
    );
  }
  return parsed.toString();
}

function validateScopes(scopes: readonly string[] | undefined): string[] {
  if (!scopes) return [];
  if (!Array.isArray(scopes) || scopes.length > MCP_OAUTH_LIMITS.maxScopes) {
    throw new McpValidationError(
      `At most ${MCP_OAUTH_LIMITS.maxScopes} OAuth scopes may be configured.`,
      'invalid_oauth_config',
      400,
    );
  }
  const normalized: string[] = [];
  for (const raw of scopes) {
    const clean = String(raw ?? '').trim();
    if (!clean) continue;
    if (clean.length > MCP_OAUTH_LIMITS.maxScopeChars || /\s/.test(clean)) {
      throw new McpValidationError(
        `Invalid OAuth scope '${clean.slice(0, 32)}'.`,
        'invalid_oauth_config',
        400,
      );
    }
    if (!normalized.includes(clean)) {
      normalized.push(clean);
    }
  }
  return normalized;
}

async function assertOAuthUrlSafeForRequest(
  rawUrl: string,
  label: string,
  opts?: McpOAuthNetworkOptions,
): Promise<{ url: string; dispatcher?: Awaited<ReturnType<typeof createPinnedDispatcher>> }> {
  const allowed = opts?.allowedInternalOrigins ?? getAllowedInternalOrigins();
  const validated = validateOAuthEndpointUrlSync(rawUrl, label, allowed);
  const isAllowedOrigin = allowed.includes(new URL(validated).origin);
  const verdict = await assessProviderUrlWithPin(validated, {
    resolve: opts?.dnsResolver,
    blockPrivate: !isAllowedOrigin,
  });
  if (!verdict.allowed) {
    throw new McpValidationError(
      `${label} URL blocked by SSRF guard: ${verdict.reason ?? 'disallowed address'}`,
      'unsafe_url',
      422,
    );
  }
  const dispatcher =
    !opts?.fetchFn && verdict.hostname && verdict.addresses && verdict.addresses.length > 0
      ? await createPinnedDispatcher(verdict.hostname, verdict.addresses)
      : undefined;
  return { url: validated, dispatcher };
}

async function dispatchGuardedOAuthFetch(
  targetUrl: string,
  label: string,
  init: RequestInit,
  opts?: McpOAuthNetworkOptions,
): Promise<Response> {
  const { url, dispatcher } = await assertOAuthUrlSafeForRequest(targetUrl, label, opts);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`${label} request timed out`));
  }, MCP_OAUTH_LIMITS.httpTimeoutMs);

  const onCallerAbort = () => controller.abort(opts?.signal?.reason);
  if (opts?.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timer);
      throw new McpServiceError(499, 'aborted', `${label} request aborted.`);
    }
    opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    const fetchImpl = opts?.fetchFn ?? fetch;
    const reqInit: RequestInit = {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    };
    const res = await fetchImpl(url, reqInit);
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw new McpValidationError(
        `${label} endpoint attempted an HTTP redirect (${res.status}), which is disallowed by SSRF policy.`,
        'unsafe_url',
        422,
      );
    }
    return res;
  } finally {
    clearTimeout(timer);
    if (opts?.signal) {
      opts.signal.removeEventListener('abort', onCallerAbort);
    }
  }
}

export function computeOAuthConnectionStatus(
  row: OAuthCredentialsRow | undefined,
  nowMs: number = Date.now(),
): McpOAuthConnectionStatus {
  if (!row) return 'unconfigured';
  const hasAccessToken = Boolean(
    row.access_token_ciphertext && row.access_token_iv && row.access_token_tag,
  );
  if (!hasAccessToken) return 'unconfigured';
  if (row.expires_at) {
    const expMs = Date.parse(row.expires_at);
    if (Number.isFinite(expMs) && expMs <= nowMs) {
      return 'expired';
    }
  }
  return 'connected';
}

function toOAuthStatusView(serverId: number, row: OAuthCredentialsRow | undefined): McpOAuthStatusView {
  if (!row) {
    return {
      serverId,
      connectionStatus: 'unconfigured',
      issuerUrl: null,
      authorizationEndpoint: null,
      tokenEndpoint: null,
      revocationEndpoint: null,
      clientId: null,
      hasClientSecret: false,
      scopes: [],
      redirectUri: null,
      pkceMethod: 'S256',
      expiresAt: null,
      hasRefreshToken: false,
      lastRefreshedAt: null,
      lastError: null,
      updatedAt: null,
    };
  }

  return {
    serverId,
    connectionStatus: computeOAuthConnectionStatus(row),
    issuerUrl: row.issuer_url,
    authorizationEndpoint: row.authorization_endpoint,
    tokenEndpoint: row.token_endpoint,
    revocationEndpoint: row.revocation_endpoint,
    clientId: row.client_id,
    hasClientSecret: Boolean(
      row.client_secret_ciphertext && row.client_secret_iv && row.client_secret_tag,
    ),
    scopes: safeJsonParse<string[]>(row.scopes_json, []),
    redirectUri: row.redirect_uri,
    pkceMethod: 'S256',
    expiresAt: row.expires_at,
    hasRefreshToken: Boolean(
      row.refresh_token_ciphertext && row.refresh_token_iv && row.refresh_token_tag,
    ),
    lastRefreshedAt: row.last_refreshed_at,
    lastError: row.last_error ? sanitizeMcpText(row.last_error) : null,
    updatedAt: row.updated_at,
  };
}

function getCredentialsRow(serverId: number): OAuthCredentialsRow | undefined {
  const db = getDb();
  if (!hasTable(db, 'custom_ai_mcp_oauth_credentials')) return undefined;
  return db
    .prepare('SELECT * FROM custom_ai_mcp_oauth_credentials WHERE server_id = ?')
    .get(serverId) as OAuthCredentialsRow | undefined;
}

export function getMcpOAuthConnectionBadge(serverId: number): McpOAuthConnectionStatus {
  const row = getCredentialsRow(serverId);
  return computeOAuthConnectionStatus(row);
}

export function getMcpOAuthStatus(serverId: number): McpOAuthStatusView {
  ensureServerExists(serverId);
  return toOAuthStatusView(serverId, getCredentialsRow(serverId));
}

export function pruneExpiredOAuthPkceStates(now: Date = new Date()): number {
  const db = getDb();
  if (!hasTable(db, 'custom_ai_mcp_oauth_pkce_states')) return 0;
  return db
    .prepare('DELETE FROM custom_ai_mcp_oauth_pkce_states WHERE expires_at <= ?')
    .run(now.toISOString()).changes;
}

export function collectMcpOAuthSecrets(serverId?: number | null): string[] {
  const db = getDb();
  if (!hasTable(db, 'custom_ai_mcp_oauth_credentials')) return [];
  const rows = (
    serverId != null
      ? db.prepare('SELECT * FROM custom_ai_mcp_oauth_credentials WHERE server_id = ?').all(serverId)
      : db.prepare('SELECT * FROM custom_ai_mcp_oauth_credentials').all()
  ) as OAuthCredentialsRow[];

  const secrets: string[] = [];
  for (const row of rows) {
    for (const [ct, iv, tag] of [
      [row.client_secret_ciphertext, row.client_secret_iv, row.client_secret_tag],
      [row.access_token_ciphertext, row.access_token_iv, row.access_token_tag],
      [row.refresh_token_ciphertext, row.refresh_token_iv, row.refresh_token_tag],
    ] as const) {
      if (!ct || !iv || !tag) continue;
      try {
        const val = decrypt(ct, iv, tag);
        if (val) secrets.push(val);
      } catch {
        // Ignore undecryptable rows when collecting redaction needles
      }
    }
  }
  return secrets;
}

export async function discoverOAuthEndpoints(
  issuerUrl: string,
  opts?: McpOAuthNetworkOptions,
): Promise<{
  issuerUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
}> {
  const validatedIssuer = validateOAuthEndpointUrlSync(
    issuerUrl,
    'issuerUrl',
    opts?.allowedInternalOrigins,
  ).replace(/\/+$/, '');
  const discoveryUrl = `${validatedIssuer}/.well-known/oauth-authorization-server`;
  const res = await dispatchGuardedOAuthFetch(
    discoveryUrl,
    'OAuth discovery',
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
    },
    opts,
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new McpServiceError(
      502,
      'oauth_discovery_failed',
      `OAuth metadata discovery returned HTTP ${res.status}.`,
    );
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > 256 * 1024) {
    throw new McpServiceError(502, 'oauth_discovery_failed', 'OAuth metadata response too large.');
  }
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new McpServiceError(502, 'oauth_discovery_failed', 'Invalid JSON in OAuth metadata.');
  }

  const authEp = typeof meta.authorization_endpoint === 'string' ? meta.authorization_endpoint : '';
  const tokenEp = typeof meta.token_endpoint === 'string' ? meta.token_endpoint : '';
  const revEp = typeof meta.revocation_endpoint === 'string' ? meta.revocation_endpoint : null;

  if (!authEp || !tokenEp) {
    throw new McpValidationError(
      'OAuth discovery document is missing authorization_endpoint or token_endpoint.',
      'invalid_oauth_config',
      422,
    );
  }

  return {
    issuerUrl: validatedIssuer,
    authorizationEndpoint: validateOAuthEndpointUrlSync(
      authEp,
      'authorizationEndpoint',
      opts?.allowedInternalOrigins,
    ),
    tokenEndpoint: validateOAuthEndpointUrlSync(
      tokenEp,
      'tokenEndpoint',
      opts?.allowedInternalOrigins,
    ),
    revocationEndpoint: revEp
      ? validateOAuthEndpointUrlSync(revEp, 'revocationEndpoint', opts?.allowedInternalOrigins)
      : null,
  };
}

export async function upsertMcpOAuthConfig(
  serverId: number,
  input: McpOAuthConfigInput,
  opts?: McpOAuthNetworkOptions,
): Promise<McpOAuthStatusView> {
  ensureServerExists(serverId);
  const clientId = String(input.clientId ?? '').trim();
  if (!clientId || clientId.length > MCP_OAUTH_LIMITS.maxClientIdChars) {
    throw new McpValidationError(
      `clientId must be between 1 and ${MCP_OAUTH_LIMITS.maxClientIdChars} characters.`,
      'invalid_oauth_config',
      400,
    );
  }
  const redirectUri = validateRedirectUri(input.redirectUri);
  const scopes = validateScopes(input.scopes);

  let issuerUrl = input.issuerUrl
    ? validateOAuthEndpointUrlSync(input.issuerUrl, 'issuerUrl', opts?.allowedInternalOrigins)
    : null;
  let authorizationEndpoint = input.authorizationEndpoint
    ? validateOAuthEndpointUrlSync(
        input.authorizationEndpoint,
        'authorizationEndpoint',
        opts?.allowedInternalOrigins,
      )
    : '';
  let tokenEndpoint = input.tokenEndpoint
    ? validateOAuthEndpointUrlSync(
        input.tokenEndpoint,
        'tokenEndpoint',
        opts?.allowedInternalOrigins,
      )
    : '';
  let revocationEndpoint = input.revocationEndpoint
    ? validateOAuthEndpointUrlSync(
        input.revocationEndpoint,
        'revocationEndpoint',
        opts?.allowedInternalOrigins,
      )
    : null;

  if ((!authorizationEndpoint || !tokenEndpoint) && issuerUrl) {
    const discovered = await discoverOAuthEndpoints(issuerUrl, opts);
    issuerUrl = discovered.issuerUrl;
    if (!authorizationEndpoint) authorizationEndpoint = discovered.authorizationEndpoint;
    if (!tokenEndpoint) tokenEndpoint = discovered.tokenEndpoint;
    if (!revocationEndpoint && discovered.revocationEndpoint) {
      revocationEndpoint = discovered.revocationEndpoint;
    }
  }

  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new McpValidationError(
      'authorizationEndpoint and tokenEndpoint (or a discoverable issuerUrl) are required.',
      'invalid_oauth_config',
      400,
    );
  }

  // Request-time DNS SSRF verification on configured OAuth endpoints
  await assertOAuthUrlSafeForRequest(authorizationEndpoint, 'authorizationEndpoint', opts);
  await assertOAuthUrlSafeForRequest(tokenEndpoint, 'tokenEndpoint', opts);
  if (revocationEndpoint) {
    await assertOAuthUrlSafeForRequest(revocationEndpoint, 'revocationEndpoint', opts);
  }

  const existing = getCredentialsRow(serverId);
  let secretCt = existing?.client_secret_ciphertext ?? null;
  let secretIv = existing?.client_secret_iv ?? null;
  let secretTag = existing?.client_secret_tag ?? null;

  if (input.clearClientSecret || input.clientSecret === null) {
    secretCt = null;
    secretIv = null;
    secretTag = null;
  } else if (typeof input.clientSecret === 'string' && input.clientSecret.length > 0) {
    if (input.clientSecret.length > MCP_OAUTH_LIMITS.maxClientSecretChars) {
      throw new McpValidationError('clientSecret exceeds maximum length.', 'invalid_oauth_config', 400);
    }
    const enc = encrypt(input.clientSecret);
    secretCt = enc.encrypted;
    secretIv = enc.iv;
    secretTag = enc.authTag;
  }

  const endpointsChanged =
    existing !== undefined &&
    (existing.token_endpoint !== tokenEndpoint ||
      existing.authorization_endpoint !== authorizationEndpoint ||
      existing.client_id !== clientId);

  const now = new Date().toISOString();
  const db = getDb();

  db.transaction(() => {
    if (!existing) {
      db.prepare(
        `INSERT INTO custom_ai_mcp_oauth_credentials (
          server_id, issuer_url, authorization_endpoint, token_endpoint, revocation_endpoint,
          client_id, client_secret_ciphertext, client_secret_iv, client_secret_tag,
          scopes_json, redirect_uri, pkce_method, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'S256', ?, ?)`,
      ).run(
        serverId,
        issuerUrl,
        authorizationEndpoint,
        tokenEndpoint,
        revocationEndpoint,
        clientId,
        secretCt,
        secretIv,
        secretTag,
        JSON.stringify(scopes),
        redirectUri,
        now,
        now,
      );
    } else {
      db.prepare(
        `UPDATE custom_ai_mcp_oauth_credentials
            SET issuer_url = ?,
                authorization_endpoint = ?,
                token_endpoint = ?,
                revocation_endpoint = ?,
                client_id = ?,
                client_secret_ciphertext = ?,
                client_secret_iv = ?,
                client_secret_tag = ?,
                scopes_json = ?,
                redirect_uri = ?,
                access_token_ciphertext = CASE WHEN ? = 1 THEN NULL ELSE access_token_ciphertext END,
                access_token_iv = CASE WHEN ? = 1 THEN NULL ELSE access_token_iv END,
                access_token_tag = CASE WHEN ? = 1 THEN NULL ELSE access_token_tag END,
                refresh_token_ciphertext = CASE WHEN ? = 1 THEN NULL ELSE refresh_token_ciphertext END,
                refresh_token_iv = CASE WHEN ? = 1 THEN NULL ELSE refresh_token_iv END,
                refresh_token_tag = CASE WHEN ? = 1 THEN NULL ELSE refresh_token_tag END,
                expires_at = CASE WHEN ? = 1 THEN NULL ELSE expires_at END,
                updated_at = ?
          WHERE server_id = ?`,
      ).run(
        issuerUrl,
        authorizationEndpoint,
        tokenEndpoint,
        revocationEndpoint,
        clientId,
        secretCt,
        secretIv,
        secretTag,
        JSON.stringify(scopes),
        redirectUri,
        endpointsChanged ? 1 : 0,
        endpointsChanged ? 1 : 0,
        endpointsChanged ? 1 : 0,
        endpointsChanged ? 1 : 0,
        endpointsChanged ? 1 : 0,
        endpointsChanged ? 1 : 0,
        endpointsChanged ? 1 : 0,
        now,
        serverId,
      );
    }

    db.prepare(
      `UPDATE custom_ai_mcp_servers
          SET auth_kind = 'oauth2',
              credential_generation = CASE WHEN ? = 1 THEN credential_generation + 1 ELSE credential_generation END,
              updated_at = ?
        WHERE id = ?`,
    ).run(endpointsChanged ? 1 : 0, now, serverId);
  })();

  return getMcpOAuthStatus(serverId);
}

export async function startMcpOAuthFlow(
  serverId: number,
  input: McpOAuthStartInput | undefined,
  actorId: number | null,
  opts?: McpOAuthNetworkOptions,
): Promise<McpOAuthStartResponse> {
  ensureServerExists(serverId);
  pruneExpiredOAuthPkceStates();

  if (input?.config) {
    await upsertMcpOAuthConfig(serverId, input.config, opts);
  }

  const creds = getCredentialsRow(serverId);
  if (!creds) {
    throw new McpValidationError(
      'OAuth 2.1 client configuration must be saved before starting PKCE authorization.',
      'oauth_unconfigured',
      400,
    );
  }

  await assertOAuthUrlSafeForRequest(creds.authorization_endpoint, 'authorizationEndpoint', opts);
  await assertOAuthUrlSafeForRequest(creds.token_endpoint, 'tokenEndpoint', opts);

  const redirectUri = input?.redirectUri
    ? validateRedirectUri(input.redirectUri)
    : creds.redirect_uri;
  const scopes = input?.scopes
    ? validateScopes(input.scopes)
    : safeJsonParse<string[]>(creds.scopes_json, []);

  const state = crypto.randomBytes(24).toString('base64url');
  const stateHash = hashStateToken(state);
  const pkce = generatePkceS256Pair();
  const encVerifier = encrypt(pkce.codeVerifier);
  const nowMs = Date.now();
  const expiresAt = new Date(nowMs + MCP_OAUTH_LIMITS.pkceStateTtlMs).toISOString();

  getDb()
    .prepare(
      `INSERT INTO custom_ai_mcp_oauth_pkce_states (
        state_hash, server_id, code_verifier_ciphertext, code_verifier_iv, code_verifier_tag,
        redirect_uri, scopes_json, actor_id, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      stateHash,
      serverId,
      encVerifier.encrypted,
      encVerifier.iv,
      encVerifier.authTag,
      redirectUri,
      JSON.stringify(scopes),
      actorId,
      expiresAt,
      new Date(nowMs).toISOString(),
    );

  const authUrl = new URL(creds.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', creds.client_id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  if (scopes.length > 0) {
    authUrl.searchParams.set('scope', scopes.join(' '));
  }

  return {
    authorizationUrl: authUrl.toString(),
    state,
    codeChallengeMethod: 'S256',
    expiresAt,
    oauth: toOAuthStatusView(serverId, creds),
  };
}

interface TokenEndpointPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

async function parseTokenResponse(
  res: Response,
  redactionSecrets: string[],
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresAt: string | null;
}> {
  const rawBody = await res.text();
  if (Buffer.byteLength(rawBody, 'utf8') > 256 * 1024) {
    throw new McpServiceError(502, 'oauth_token_error', 'OAuth token response exceeded size limit.');
  }
  let parsed: TokenEndpointPayload = {};
  try {
    parsed = JSON.parse(rawBody) as TokenEndpointPayload;
  } catch {
    if (!res.ok) {
      throw new McpServiceError(
        502,
        'oauth_token_error',
        `OAuth token endpoint returned HTTP ${res.status}.`,
      );
    }
    throw new McpServiceError(502, 'oauth_token_error', 'OAuth token endpoint returned invalid JSON.');
  }

  if (!res.ok || typeof parsed.access_token !== 'string' || !parsed.access_token.trim()) {
    const errCode = typeof parsed.error === 'string' ? parsed.error : `http_${res.status}`;
    const errDesc =
      typeof parsed.error_description === 'string'
        ? sanitizeMcpText(parsed.error_description, redactionSecrets).slice(0, 200)
        : `OAuth token request failed (${errCode}).`;
    throw new McpServiceError(502, 'oauth_token_error', errDesc);
  }

  const accessToken = parsed.access_token.trim();
  const refreshToken =
    typeof parsed.refresh_token === 'string' && parsed.refresh_token.trim()
      ? parsed.refresh_token.trim()
      : null;
  const tokenType =
    typeof parsed.token_type === 'string' && parsed.token_type.trim()
      ? parsed.token_type.trim()
      : 'Bearer';

  let expiresAt: string | null = null;
  if (typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in) && parsed.expires_in > 0) {
    expiresAt = new Date(Date.now() + Math.trunc(parsed.expires_in) * 1000).toISOString();
  } else if (typeof parsed.expires_in === 'string' && /^\d+$/.test(parsed.expires_in.trim())) {
    const secs = Number(parsed.expires_in.trim());
    if (secs > 0) {
      expiresAt = new Date(Date.now() + secs * 1000).toISOString();
    }
  }

  return {
    accessToken,
    refreshToken,
    tokenType,
    expiresAt,
  };
}

export async function completeMcpOAuthCallback(
  serverId: number,
  input: McpOAuthCallbackInput,
  opts?: McpOAuthNetworkOptions,
): Promise<McpOAuthStatusView> {
  ensureServerExists(serverId);
  const code = String(input.code ?? '').trim();
  const state = String(input.state ?? '').trim();
  if (!code || !state) {
    throw new McpValidationError('Both code and state are required.', 'invalid_oauth_callback', 400);
  }

  const creds = getCredentialsRow(serverId);
  if (!creds) {
    throw new McpValidationError('OAuth is not configured for this server.', 'oauth_unconfigured', 400);
  }

  const db = getDb();
  const nowIso = new Date().toISOString();
  const stateHash = hashStateToken(state);

  // Atomically claim and delete PKCE state so authorization callbacks are strictly one-time use.
  const claimedPkce = db.transaction((): PkceStateRow => {
    pruneExpiredOAuthPkceStates(new Date(nowIso));
    const row = db
      .prepare(
        `SELECT * FROM custom_ai_mcp_oauth_pkce_states
          WHERE state_hash = ? AND server_id = ?`,
      )
      .get(stateHash, serverId) as PkceStateRow | undefined;
    if (!row) {
      throw new McpValidationError(
        'Invalid, expired, or already-used OAuth PKCE state.',
        'invalid_oauth_state',
        400,
      );
    }
    db.prepare('DELETE FROM custom_ai_mcp_oauth_pkce_states WHERE state_hash = ?').run(stateHash);
    return row;
  })();

  if (input.redirectUri && validateRedirectUri(input.redirectUri) !== claimedPkce.redirect_uri) {
    throw new McpValidationError(
      'redirectUri does not match the PKCE authorization request.',
      'invalid_oauth_callback',
      400,
    );
  }

  const codeVerifier = decrypt(
    claimedPkce.code_verifier_ciphertext,
    claimedPkce.code_verifier_iv,
    claimedPkce.code_verifier_tag,
  );
  const clientSecret = decryptOptionalSecret(
    creds.client_secret_ciphertext,
    creds.client_secret_iv,
    creds.client_secret_tag,
  );
  const redactionNeedles = [code, codeVerifier, ...(clientSecret ? [clientSecret] : [])];

  const form = new URLSearchParams();
  form.set('grant_type', 'authorization_code');
  form.set('code', code);
  form.set('redirect_uri', claimedPkce.redirect_uri);
  form.set('client_id', creds.client_id);
  form.set('code_verifier', codeVerifier);
  if (clientSecret) {
    form.set('client_secret', clientSecret);
  }

  try {
    const res = await dispatchGuardedOAuthFetch(
      creds.token_endpoint,
      'tokenEndpoint',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
      },
      opts,
    );

    const tokens = await parseTokenResponse(res, redactionNeedles);
    const encAccess = encrypt(tokens.accessToken);
    const encRefresh = tokens.refreshToken ? encrypt(tokens.refreshToken) : null;
    const updatedIso = new Date().toISOString();

    db.transaction(() => {
      db.prepare(
        `UPDATE custom_ai_mcp_oauth_credentials
            SET access_token_ciphertext = ?,
                access_token_iv = ?,
                access_token_tag = ?,
                refresh_token_ciphertext = ?,
                refresh_token_iv = ?,
                refresh_token_tag = ?,
                token_type = ?,
                expires_at = ?,
                last_refreshed_at = ?,
                last_error = NULL,
                updated_at = ?
          WHERE server_id = ?`,
      ).run(
        encAccess.encrypted,
        encAccess.iv,
        encAccess.authTag,
        encRefresh?.encrypted ?? null,
        encRefresh?.iv ?? null,
        encRefresh?.authTag ?? null,
        tokens.tokenType,
        tokens.expiresAt,
        updatedIso,
        updatedIso,
        serverId,
      );

      db.prepare(
        `UPDATE custom_ai_mcp_servers
            SET auth_kind = 'oauth2',
                credential_generation = credential_generation + 1,
                updated_at = ?
          WHERE id = ?`,
      ).run(updatedIso, serverId);
    })();

    return getMcpOAuthStatus(serverId);
  } catch (err) {
    const cleanErr = sanitizeMcpError(err, redactionNeedles).slice(0, 400);
    db.prepare(
      `UPDATE custom_ai_mcp_oauth_credentials
          SET last_error = ?, updated_at = ?
        WHERE server_id = ?`,
    ).run(cleanErr, new Date().toISOString(), serverId);
    throw err;
  }
}

async function executeRefreshTokenGrant(
  serverId: number,
  opts?: McpOAuthNetworkOptions,
): Promise<string> {
  const creds = getCredentialsRow(serverId);
  if (!creds) {
    throw new McpServiceError(401, 'oauth_unconfigured', 'MCP server OAuth 2.1 is not configured.');
  }

  const refreshToken = decryptOptionalSecret(
    creds.refresh_token_ciphertext,
    creds.refresh_token_iv,
    creds.refresh_token_tag,
  );
  if (!refreshToken) {
    throw new McpServiceError(
      401,
      'oauth_token_expired',
      'MCP OAuth access token is expired and no refresh token is available.',
    );
  }

  const clientSecret = decryptOptionalSecret(
    creds.client_secret_ciphertext,
    creds.client_secret_iv,
    creds.client_secret_tag,
  );
  const redactionNeedles = [refreshToken, ...(clientSecret ? [clientSecret] : [])];

  const scopes = safeJsonParse<string[]>(creds.scopes_json, []);
  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('refresh_token', refreshToken);
  form.set('client_id', creds.client_id);
  if (clientSecret) {
    form.set('client_secret', clientSecret);
  }
  if (scopes.length > 0) {
    form.set('scope', scopes.join(' '));
  }

  const db = getDb();
  try {
    const res = await dispatchGuardedOAuthFetch(
      creds.token_endpoint,
      'tokenEndpoint',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
      },
      opts,
    );

    const tokens = await parseTokenResponse(res, redactionNeedles);
    const encAccess = encrypt(tokens.accessToken);
    const encRefresh = tokens.refreshToken ? encrypt(tokens.refreshToken) : null;
    const nowIso = new Date().toISOString();

    db.prepare(
      `UPDATE custom_ai_mcp_oauth_credentials
          SET access_token_ciphertext = ?,
              access_token_iv = ?,
              access_token_tag = ?,
              refresh_token_ciphertext = COALESCE(?, refresh_token_ciphertext),
              refresh_token_iv = COALESCE(?, refresh_token_iv),
              refresh_token_tag = COALESCE(?, refresh_token_tag),
              token_type = ?,
              expires_at = ?,
              last_refreshed_at = ?,
              last_error = NULL,
              updated_at = ?
        WHERE server_id = ?`,
    ).run(
      encAccess.encrypted,
      encAccess.iv,
      encAccess.authTag,
      encRefresh?.encrypted ?? null,
      encRefresh?.iv ?? null,
      encRefresh?.authTag ?? null,
      tokens.tokenType,
      tokens.expiresAt,
      nowIso,
      nowIso,
      serverId,
    );

    return tokens.accessToken;
  } catch (err) {
    const cleanErr = sanitizeMcpError(err, redactionNeedles).slice(0, 400);
    db.prepare(
      `UPDATE custom_ai_mcp_oauth_credentials
          SET last_error = ?, updated_at = ?
        WHERE server_id = ?`,
    ).run(cleanErr, new Date().toISOString(), serverId);
    throw err;
  }
}

/**
 * Resolves a valid OAuth 2.1 Bearer access token for `serverId`, performing a
 * single-flight `refresh_token` exchange if expired or expiring within 30s.
 */
export async function resolveMcpOAuthAccessToken(
  serverId: number,
  opts?: McpOAuthNetworkOptions & { forceRefresh?: boolean },
): Promise<string> {
  const creds = getCredentialsRow(serverId);
  if (!creds) {
    throw new McpServiceError(401, 'oauth_unconfigured', 'MCP server OAuth 2.1 is not configured.');
  }

  if (!opts?.forceRefresh) {
    const accessToken = decryptOptionalSecret(
      creds.access_token_ciphertext,
      creds.access_token_iv,
      creds.access_token_tag,
    );
    if (accessToken) {
      const expMs = creds.expires_at ? Date.parse(creds.expires_at) : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(expMs) || expMs - Date.now() > MCP_OAUTH_LIMITS.refreshSkewMs) {
        return accessToken;
      }
    }
  }

  const existingFlight = singleFlightRefreshes.get(serverId);
  if (existingFlight) {
    return await existingFlight;
  }

  const refreshPromise = executeRefreshTokenGrant(serverId, opts).finally(() => {
    singleFlightRefreshes.delete(serverId);
  });
  singleFlightRefreshes.set(serverId, refreshPromise);
  return await refreshPromise;
}

export async function refreshMcpOAuthCredentials(
  serverId: number,
  opts?: McpOAuthNetworkOptions,
): Promise<McpOAuthStatusView> {
  ensureServerExists(serverId);
  await resolveMcpOAuthAccessToken(serverId, { ...opts, forceRefresh: true });
  return getMcpOAuthStatus(serverId);
}

export async function revokeMcpOAuthCredentials(
  serverId: number,
  opts?: McpOAuthNetworkOptions,
): Promise<McpOAuthRevokeResponse> {
  ensureServerExists(serverId);
  const creds = getCredentialsRow(serverId);
  const db = getDb();
  const nowIso = new Date().toISOString();

  if (creds?.revocation_endpoint) {
    const tokenToRevoke =
      decryptOptionalSecret(
        creds.refresh_token_ciphertext,
        creds.refresh_token_iv,
        creds.refresh_token_tag,
      ) ??
      decryptOptionalSecret(
        creds.access_token_ciphertext,
        creds.access_token_iv,
        creds.access_token_tag,
      );
    const clientSecret = decryptOptionalSecret(
      creds.client_secret_ciphertext,
      creds.client_secret_iv,
      creds.client_secret_tag,
    );
    if (tokenToRevoke) {
      const form = new URLSearchParams();
      form.set('token', tokenToRevoke);
      form.set('client_id', creds.client_id);
      if (clientSecret) form.set('client_secret', clientSecret);
      try {
        const res = await dispatchGuardedOAuthFetch(
          creds.revocation_endpoint,
          'revocationEndpoint',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
          },
          opts,
        );
        await res.body?.cancel().catch(() => {});
      } catch {
        // Local token wipe always proceeds even if remote RFC 7009 revocation endpoint fails
      }
    }
  }

  db.transaction(() => {
    if (hasTable(db, 'custom_ai_mcp_oauth_pkce_states')) {
      db.prepare('DELETE FROM custom_ai_mcp_oauth_pkce_states WHERE server_id = ?').run(serverId);
    }
    if (creds) {
      db.prepare(
        `UPDATE custom_ai_mcp_oauth_credentials
            SET access_token_ciphertext = NULL,
                access_token_iv = NULL,
                access_token_tag = NULL,
                refresh_token_ciphertext = NULL,
                refresh_token_iv = NULL,
                refresh_token_tag = NULL,
                expires_at = NULL,
                last_error = NULL,
                updated_at = ?
          WHERE server_id = ?`,
      ).run(nowIso, serverId);
    }
    db.prepare(
      `UPDATE custom_ai_mcp_servers
          SET credential_generation = credential_generation + 1,
              updated_at = ?
        WHERE id = ?`,
    ).run(nowIso, serverId);
  })();

  return {
    ok: true,
    oauth: getMcpOAuthStatus(serverId),
  };
}
