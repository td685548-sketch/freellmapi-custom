import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface OidcDiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(jwksUri: string) {
  let set = jwksCache.get(jwksUri);
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, set);
  }
  return set;
}

export async function fetchOidcDiscovery(issuerUrl: string): Promise<OidcDiscoveryDoc> {
  const cleanIssuer = issuerUrl.trim().replace(/\/+$/, '');
  const discoveryUrl = `${cleanIssuer}/.well-known/openid-configuration`;
  const res = await fetch(discoveryUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch OIDC discovery (${res.status}) from ${discoveryUrl}`);
  }
  const doc = (await res.json()) as Partial<OidcDiscoveryDoc>;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error('OIDC discovery document missing required endpoints.');
  }
  return {
    issuer: doc.issuer || cleanIssuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    jwks_uri: doc.jwks_uri,
    userinfo_endpoint: doc.userinfo_endpoint,
  };
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildOidcAuthorizationUrl(params: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const url = new URL(params.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scopes || 'openid profile email');
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeOidcCodeAndVerify(params: {
  issuerUrl: string;
  discovery: OidcDiscoveryDoc;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  expectedNonce: string;
}): Promise<{ subject: string; email: string; emailVerified: boolean }> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });

  const tokenRes = await fetch(params.discovery.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new Error(`OIDC token exchange failed (${tokenRes.status}): ${text.slice(0, 160)}`);
  }
  const tokens = (await tokenRes.json()) as { id_token?: string; access_token?: string };
  if (!tokens.id_token) {
    throw new Error('OIDC token response omitted id_token.');
  }

  const jwks = getJwks(params.discovery.jwks_uri);
  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer: params.discovery.issuer || params.issuerUrl,
    audience: params.clientId,
  });

  if (typeof payload.nonce !== 'string' || payload.nonce !== params.expectedNonce) {
    throw new Error('OIDC id_token nonce mismatch.');
  }

  let email = typeof payload.email === 'string' ? payload.email : '';
  let emailVerified = payload.email_verified === true;
  if (!email && tokens.access_token && params.discovery.userinfo_endpoint) {
    const infoRes = await fetch(params.discovery.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (infoRes.ok) {
      const info = (await infoRes.json()) as Record<string, unknown>;
      if (typeof info.email === 'string') email = info.email;
      if (info.email_verified === true) emailVerified = true;
    }
  }

  const subject = typeof payload.sub === 'string' ? payload.sub : '';
  if (!subject || !email) {
    throw new Error('OIDC identity missing required sub or email claim.');
  }
  return { subject, email, emailVerified };
}
