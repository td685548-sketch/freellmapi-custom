import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { createSession, createUser, normalizeEmail, userCount } from '../../services/auth.js';
import { allowAuthRequest, digest, purgeExpiredAuth, randomSecret, safeEqual, seal, unseal } from '../../services/auth-security.js';
import { consumeGoogleHandoff } from '../../services/google-auth.js';
import { claimInviteCode } from '../../services/invites.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { getExternalAuthConfig } from '../../services/external-auth-config.js';
import {
  getSanitizedSsoConfig,
  getSsoConfig,
  isOidcEnabled,
  isSamlEnabled,
  decryptSsoClientSecret,
  resolveSsoPublicOrigin,
  saveSsoConfig,
} from './config.js';
import { buildOidcAuthorizationUrl, createPkcePair, exchangeOidcCodeAndVerify, fetchOidcDiscovery } from './oidc.js';
import { buildSamlAuthorizeRedirectUrl, buildSpMetadataXml, validateSamlPostResponse } from './saml.js';

export const ssoPublicRouter = Router();
export const ssoAdminRouter = Router();

const ATTEMPT_COOKIE = 'flm_sso_attempt';
const RESULT_COOKIE = 'flm_sso_result';

const attemptSchema = z.object({
  kind: z.enum(['oidc', 'saml']),
  state: z.string().min(10).max(128),
  nonce: z.string().max(128).optional(),
  verifier: z.string().max(128).optional(),
  requestId: z.string().max(128).optional(),
  inviteCode: z.string().max(128).optional(),
  origin: z.string().url(),
  expiresAt: z.number(),
});

function readCookie(req: Request, name: string): string {
  const item = req.headers.cookie?.split(';').map(p => p.trim()).find(p => p.startsWith(`${name}=`));
  return item ? item.slice(name.length + 1) : '';
}

function cookieOpts(req: Request, cfg = getSsoConfig()) {
  const origin = resolveSsoPublicOrigin(req, cfg);
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: origin.startsWith('https:'),
    path: '/',
  };
}

function sameOrigin(req: Request): boolean {
  const origin = req.get('Origin');
  const publicUrl = getExternalAuthConfig().publicUrl;
  if (req.get('Sec-Fetch-Site') === 'cross-site') return false;
  if (!origin) return true;
  if (publicUrl && origin === publicUrl) return true;
  const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0]?.trim();
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0]?.trim();
  return origin === `${proto}://${host}`;
}

function finishSsoLogin(email: string, allowAutoProvision: boolean, inviteCode?: string): string {
  const db = getDb();
  purgeExpiredAuth();
  return db.transaction(() => {
    if (userCount() === 0) throw new Error('Complete initial admin setup before SSO sign-in.');
    const normEmail = normalizeEmail(email);
    let user = db.prepare('SELECT id, email, role FROM users WHERE email = ?').get(normEmail) as
      | { id: number; email: string; role: 'admin' | 'member' }
      | undefined;
    let apiKey: string | undefined;
    if (!user) {
      if (inviteCode) {
        if (!claimInviteCode(inviteCode)) throw new Error('Invalid invitation code.');
      } else if (!allowAutoProvision) {
        throw new Error('SSO account is not provisioned and auto-provisioning is disabled.');
      }
      const created = createUser(normEmail, randomSecret(), 'member');
      user = { id: created.userId, email: created.email, role: 'member' };
      apiKey = mintUserApiKey(user.id, 'Default Key').key;
    }
    const payload = {
      token: createSession(user.id),
      email: user.email,
      role: user.role,
      ...(apiKey ? { apiKey } : {}),
    };
    const ticket = randomSecret();
    db.prepare('INSERT INTO auth_google_handoffs (ticket_hash, user_id, payload, expires_at_ms) VALUES (?, ?, ?, ?)')
      .run(digest(ticket), user.id, seal(payload), Date.now() + 2 * 60 * 1000);
    return ticket;
  })();
}

ssoPublicRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

ssoPublicRouter.get('/methods', (_req: Request, res: Response) => {
  const cfg = getSsoConfig();
  res.json({
    authMode: cfg.authMode,
    oidcEnabled: isOidcEnabled(cfg),
    oidcLabel: cfg.oidcLoginLabel,
    samlEnabled: isSamlEnabled(cfg),
    samlLabel: cfg.samlLoginLabel,
  });
});

ssoPublicRouter.post('/oidc/start', async (req: Request, res: Response) => {
  const cfg = getSsoConfig();
  if (!isOidcEnabled(cfg)) {
    res.status(503).json({ error: { message: 'OIDC SSO is not configured.', type: 'not_configured' } });
    return;
  }
  if (!sameOrigin(req)) {
    res.status(403).json({ error: { message: 'Invalid request origin.', type: 'forbidden' } });
    return;
  }
  if (!allowAuthRequest(`sso-oidc:${req.ip}`, 30)) {
    res.status(429).json({ error: { message: 'Try again later.', type: 'rate_limit_error' } });
    return;
  }
  if (userCount() === 0) {
    res.status(400).json({ error: { message: 'Complete account setup before SSO sign-in.', type: 'setup_required' } });
    return;
  }

  const parsed = z.object({ inviteCode: z.string().trim().max(128).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid invite code.', type: 'invalid_request' } });
    return;
  }

  try {
    purgeExpiredAuth();
    const origin = resolveSsoPublicOrigin(req, cfg);
    const redirectUri = `${origin}/api/auth/sso/oidc/callback`;
    const discovery = await fetchOidcDiscovery(cfg.oidcIssuerUrl);
    const state = randomSecret();
    const nonce = randomSecret();
    const { verifier, challenge } = createPkcePair();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    getDb().prepare('INSERT INTO auth_google_attempts (state_hash, expires_at_ms) VALUES (?, ?)')
      .run(digest(`sso:${state}`), expiresAt);
    const url = buildOidcAuthorizationUrl({
      authorizationEndpoint: discovery.authorization_endpoint,
      clientId: cfg.oidcClientId,
      redirectUri,
      scopes: cfg.oidcScopes,
      state,
      nonce,
      codeChallenge: challenge,
    });
    res.cookie(ATTEMPT_COOKIE, seal({
      kind: 'oidc',
      state,
      nonce,
      verifier,
      inviteCode: parsed.data.inviteCode,
      origin,
      expiresAt,
    }), { ...cookieOpts(req, cfg), maxAge: 10 * 60 * 1000 });
    res.json({ url });
  } catch (err) {
    res.status(502).json({ error: { message: err instanceof Error ? err.message : 'OIDC start failed.', type: 'sso_error' } });
  }
});

ssoPublicRouter.get('/oidc/callback', async (req: Request, res: Response) => {
  const cfg = getSsoConfig();
  const origin = resolveSsoPublicOrigin(req, cfg);
  const opts = cookieOpts(req, cfg);
  const rawAttempt = readCookie(req, ATTEMPT_COOKIE);
  res.clearCookie(ATTEMPT_COOKIE, opts);

  try {
    if (!isOidcEnabled(cfg)) throw new Error('oidc_not_configured');
    if (req.query.error) throw new Error(String(req.query.error));
    const state = z.string().min(10).max(128).parse(req.query.state);
    const code = z.string().min(1).max(4096).parse(req.query.code);
    if (!rawAttempt) throw new Error('missing_sso_attempt');
    const attempt = attemptSchema.parse(unseal(rawAttempt));
    if (attempt.kind !== 'oidc' || !safeEqual(attempt.state, state) || attempt.expiresAt <= Date.now()) {
      throw new Error('invalid_sso_state');
    }
    const deleted = getDb().prepare('DELETE FROM auth_google_attempts WHERE state_hash = ? AND expires_at_ms > ?')
      .run(digest(`sso:${state}`), Date.now());
    if (deleted.changes !== 1) throw new Error('replayed_sso_state');

    const discovery = await fetchOidcDiscovery(cfg.oidcIssuerUrl);
    const identity = await exchangeOidcCodeAndVerify({
      issuerUrl: cfg.oidcIssuerUrl,
      discovery,
      clientId: cfg.oidcClientId,
      clientSecret: decryptSsoClientSecret(cfg.oidcClientSecretEnc),
      code,
      redirectUri: `${attempt.origin}/api/auth/sso/oidc/callback`,
      codeVerifier: attempt.verifier || '',
      expectedNonce: attempt.nonce || '',
    });

    const ticket = finishSsoLogin(identity.email, cfg.autoProvisionMembers, attempt.inviteCode);
    res.cookie(RESULT_COOKIE, ticket, { ...opts, maxAge: 2 * 60 * 1000 });
    res.redirect(`${attempt.origin}/?auth=sso`);
  } catch (err) {
    console.error('[sso-oidc] Callback failed:', err instanceof Error ? err.message : err);
    res.clearCookie(RESULT_COOKIE, opts);
    res.redirect(`${origin}/?auth_error=sso_failed`);
  }
});

ssoPublicRouter.get('/saml/metadata', (req: Request, res: Response) => {
  const cfg = getSsoConfig();
  const origin = resolveSsoPublicOrigin(req, cfg);
  const xml = buildSpMetadataXml({
    issuer: cfg.samlIssuer || 'urn:freellmapi:sp',
    acsUrl: `${origin}/api/auth/sso/saml/acs`,
  });
  res.setHeader('Content-Type', 'application/samlmetadata+xml; charset=utf-8');
  res.status(200).send(xml);
});

ssoPublicRouter.post('/saml/start', (req: Request, res: Response) => {
  const cfg = getSsoConfig();
  if (!isSamlEnabled(cfg)) {
    res.status(503).json({ error: { message: 'SAML SSO is not configured.', type: 'not_configured' } });
    return;
  }
  if (!sameOrigin(req)) {
    res.status(403).json({ error: { message: 'Invalid request origin.', type: 'forbidden' } });
    return;
  }
  if (!allowAuthRequest(`sso-saml:${req.ip}`, 30)) {
    res.status(429).json({ error: { message: 'Try again later.', type: 'rate_limit_error' } });
    return;
  }
  if (userCount() === 0) {
    res.status(400).json({ error: { message: 'Complete account setup before SSO sign-in.', type: 'setup_required' } });
    return;
  }

  const parsed = z.object({ inviteCode: z.string().trim().max(128).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid invite code.', type: 'invalid_request' } });
    return;
  }

  purgeExpiredAuth();
  const origin = resolveSsoPublicOrigin(req, cfg);
  const state = randomSecret();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const { authorizeUrl, requestId } = buildSamlAuthorizeRedirectUrl({
    entryPoint: cfg.samlEntryPoint,
    issuer: cfg.samlIssuer || 'urn:freellmapi:sp',
    acsUrl: `${origin}/api/auth/sso/saml/acs`,
    relayState: state,
  });
  getDb().prepare('INSERT INTO auth_google_attempts (state_hash, expires_at_ms) VALUES (?, ?)')
    .run(digest(`sso:${state}`), expiresAt);
  res.cookie(ATTEMPT_COOKIE, seal({
    kind: 'saml',
    state,
    requestId,
    inviteCode: parsed.data.inviteCode,
    origin,
    expiresAt,
  }), { ...cookieOpts(req, cfg), maxAge: 10 * 60 * 1000 });
  res.json({ url: authorizeUrl });
});

ssoPublicRouter.post('/saml/acs', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  const cfg = getSsoConfig();
  const origin = resolveSsoPublicOrigin(req, cfg);
  const opts = cookieOpts(req, cfg);
  const rawAttempt = readCookie(req, ATTEMPT_COOKIE);
  res.clearCookie(ATTEMPT_COOKIE, opts);

  try {
    if (!isSamlEnabled(cfg)) throw new Error('saml_not_configured');
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const samlResponse = typeof body.SAMLResponse === 'string' ? body.SAMLResponse : '';
    const relayState = typeof body.RelayState === 'string' ? body.RelayState : '';
    if (!samlResponse) throw new Error('missing_saml_response');

    let expectedInResponseTo: string | undefined;
    let inviteCode: string | undefined;
    let redirectOrigin = origin;
    if (rawAttempt) {
      const attempt = attemptSchema.parse(unseal(rawAttempt));
      if (attempt.kind !== 'saml' || attempt.expiresAt <= Date.now()) {
        throw new Error('invalid_saml_attempt');
      }
      if (relayState && !safeEqual(attempt.state, relayState)) {
        throw new Error('saml_relay_state_mismatch');
      }
      const deleted = getDb().prepare('DELETE FROM auth_google_attempts WHERE state_hash = ? AND expires_at_ms > ?')
        .run(digest(`sso:${attempt.state}`), Date.now());
      if (deleted.changes !== 1) throw new Error('replayed_saml_state');
      expectedInResponseTo = attempt.requestId;
      inviteCode = attempt.inviteCode;
      redirectOrigin = attempt.origin;
    }

    const identity = validateSamlPostResponse({
      samlResponseB64: samlResponse,
      idpCertPem: cfg.samlCert,
      expectedInResponseTo,
      expectedIssuer: cfg.samlIssuer,
    });
    const ticket = finishSsoLogin(identity.email, cfg.autoProvisionMembers, inviteCode);
    res.cookie(RESULT_COOKIE, ticket, { ...opts, maxAge: 2 * 60 * 1000 });
    res.redirect(`${redirectOrigin}/?auth=sso`);
  } catch (err) {
    console.error('[sso-saml] ACS failed:', err instanceof Error ? err.message : err);
    res.clearCookie(RESULT_COOKIE, opts);
    res.redirect(`${origin}/?auth_error=sso_failed`);
  }
});

ssoPublicRouter.post('/complete', (req: Request, res: Response) => {
  const cfg = getSsoConfig();
  if (!sameOrigin(req)) {
    res.status(403).json({ error: { message: 'Invalid request origin.', type: 'forbidden' } });
    return;
  }
  const opts = cookieOpts(req, cfg);
  const ticket = readCookie(req, RESULT_COOKIE);
  res.clearCookie(RESULT_COOKIE, opts);
  const result = consumeGoogleHandoff(ticket);
  if (!result) {
    res.status(400).json({ error: { message: 'SSO sign-in expired. Please try again.', type: 'invalid_handoff' } });
    return;
  }
  res.json(result);
});

const updateSsoSchema = z.object({
  authMode: z.enum(['local', 'oidc', 'saml', 'both']).optional(),
  oidcIssuerUrl: z.string().trim().max(500).optional(),
  oidcClientId: z.string().trim().max(300).optional(),
  oidcClientSecret: z.string().max(1000).optional(),
  clearOidcClientSecret: z.boolean().optional(),
  oidcScopes: z.string().trim().max(300).optional(),
  oidcLoginLabel: z.string().trim().max(120).optional(),
  samlEntryPoint: z.string().trim().max(500).optional(),
  samlIssuer: z.string().trim().max(300).optional(),
  samlCert: z.string().max(10_000).optional(),
  samlLoginLabel: z.string().trim().max(120).optional(),
  autoProvisionMembers: z.boolean().optional(),
  publicBaseUrl: z.string().trim().max(500).optional(),
}).strict();

ssoAdminRouter.get('/', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(getSanitizedSsoConfig());
});

ssoAdminRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSsoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid SSO configuration.', type: 'invalid_request_error', issues: parsed.error.issues } });
    return;
  }
  const updated = saveSsoConfig(parsed.data);
  res.setHeader('Cache-Control', 'no-store');
  res.json(updated);
});
