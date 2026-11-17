import type { SubscriptionAttempt } from '@freellmapi/shared/x-subscriptions.js';
import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { validateSession } from '../../services/auth.js';
import { hasPermission, requirePermission } from '../../middleware/requirePermission.js';
import { withKeyProxy } from '../../lib/proxy.js';
import { isValidKeyProxyUrl, KEY_PROXY_URL_ERROR } from '../../lib/key-proxy.js';
import { proxyPoolExists } from '../x-gateway/proxy-pool.js';
import { AccountError } from './http.js';
import { accountRow, resolveXGatewayAccountProxy } from './store.js';
import { X_GATEWAY_OAUTH_EXECUTORS, X_GATEWAY_PROVIDERS } from './catalog.js';
import { applyTokenResponse, type OAuthKind } from './oauth-credentials.js';
import { buildAuthorizationUrl, exchangeAuthorizationCode, oauthDescriptor, resolveCredentialMetadata, type OAuthProviderDescriptor } from './oauth-providers.js';
import { pollKiroDevice, startKiroDevice } from './kiro-auth.js';
import { saveSubscription } from './subscription-store.js';
import {
  bulkImportCredentials,
  completeExtendedOAuth,
  extendedOAuthCapability,
  isExtendedOAuthProvider,
  pollExtendedOAuth,
  saveExtendedOAuthAccount,
  startExtendedOAuth,
  type ExtendedOAuthAttempt,
} from './oauth-extended.js';

const nativeKinds = new Set<string>(['codex', 'claude', 'gemini-cli', 'kiro']);
const kinds = z.enum(['codex', 'claude', 'gemini-cli', 'kiro']);
const anySubscriptionProvider = z.string().trim().min(1).max(64).refine(
  (v) => nativeKinds.has(v) || isExtendedOAuthProvider(v),
  'Unsupported subscription provider.',
);
const input = z.object({
  provider: kinds,
  label: z.string().trim().min(1).max(200),
  reconnectId: z.number().int().positive().optional(),
  proxyUrl: z.string().trim().max(2048).optional(),
  proxyPoolId: z.number().int().positive().nullable().optional(),
});
const startInput = z.object({
  provider: anySubscriptionProvider,
  label: z.string().trim().min(1).max(200),
  reconnectId: z.number().int().positive().optional(),
  proxyUrl: z.string().trim().max(2048).optional(),
  proxyPoolId: z.number().int().positive().nullable().optional(),
  baseUrl: z.string().trim().max(500).optional(),
  clientId: z.string().trim().max(200).optional(),
});
const attempts = new Map<string, Attempt>();
type Device = Awaited<ReturnType<typeof startKiroDevice>>;
interface Attempt {
  id: string;
  provider: string;
  label: string;
  reconnectId?: number;
  session: string;
  userId: number;
  expiresAt: number;
  verifier: string;
  descriptor?: OAuthProviderDescriptor;
  device?: Device;
  extended?: ExtendedOAuthAttempt;
  nextPollAt: number;
  busy: boolean;
  proxyUrl?: string;
  proxyPoolId?: number | null;
}
type SessionRequest = Request & { sessionToken?: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function validateProxyInput(data: { proxyUrl?: string; proxyPoolId?: number | null }) {
  if (data.proxyUrl && !isValidKeyProxyUrl(data.proxyUrl)) {
    throw new AccountError(400, KEY_PROXY_URL_ERROR);
  }
  if (data.proxyPoolId != null && !proxyPoolExists(data.proxyPoolId)) {
    throw new AccountError(400, 'Proxy pool entry not found.');
  }
}

function resolveAttemptProxy(a?: { proxyUrl?: string; proxyPoolId?: number | null } | null): string | undefined {
  if (a?.proxyUrl) return a.proxyUrl;
  return resolveXGatewayAccountProxy(
    a?.proxyPoolId !== undefined
      ? { proxy_encrypted: null, proxy_iv: null, proxy_auth_tag: null, proxy_pool_id: a.proxyPoolId }
      : null,
  );
}

function authorize(req: SessionRequest, reconnectId?: number) {
  const user = req.sessionToken && validateSession(req.sessionToken);
  if (!user) throw new AccountError(401, 'Authentication required.');
  if (!hasPermission(user, 'use_x_gateway') || !hasPermission(user, reconnectId === undefined ? 'add_keys' : 'edit_keys')) throw new AccountError(403, 'Permission denied.');
  return user;
}
function lookup(req: SessionRequest): Attempt {
  const a = attempts.get(String(req.params.attemptId));
  if (!a || a.expiresAt <= Date.now() || a.session !== hash(req.sessionToken ?? '')) throw new AccountError(404, 'Connection attempt not found or expired.');
  authorize(req, a.reconnectId); return a;
}
function active(a: Attempt, req: SessionRequest) {
  if (attempts.get(a.id) !== a || a.expiresAt <= Date.now()) throw new AccountError(410, 'Connection attempt cancelled or expired.');
  authorize(req, a.reconnectId);
}
function descriptorFor(provider: OAuthKind): OAuthProviderDescriptor {
  const descriptor = { ...oauthDescriptor(provider)! };
  if (provider === 'gemini-cli') {
    descriptor.clientId = process.env.GEMINI_CLIENT_ID ?? '';
    descriptor.clientSecret = process.env.GEMINI_CLIENT_SECRET;
    if (!descriptor.clientId || !descriptor.clientSecret) throw new AccountError(409, 'Configure GEMINI_CLIENT_ID and GEMINI_CLIENT_SECRET for browser login; credential import is also available.');
    try {
      const base = new URL(process.env.PUBLIC_APP_URL ?? '');
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error();
      descriptor.redirectUri = new URL('thruline/accounts/callback', base.toString().replace(/\/?$/, '/')).toString();
    } catch { throw new AccountError(409, 'Configure an HTTPS PUBLIC_APP_URL for the registered Google OAuth callback.'); }
  }
  return descriptor;
}
export const subscriptionRouter = Router();
subscriptionRouter.get('/capabilities', requirePermission('view_keys'), (_req, res) => {
  res.json({ providers: X_GATEWAY_PROVIDERS.map(provider => {
    const native = ['codex', 'claude', 'gemini-cli', 'kiro'].includes(provider.id);
    const extCap = extendedOAuthCapability(provider.id);
    const login = provider.id === 'gemini-cli'
      ? Boolean(process.env.GEMINI_CLIENT_ID && process.env.GEMINI_CLIENT_SECRET && process.env.PUBLIC_APP_URL)
      : native || extCap.login || ['openrouter', 'github-copilot'].includes(provider.id);
    return {
      provider: provider.id,
      catalog: true,
      credentialImport: native || extCap.login,
      login,
      refresh: native || extCap.refresh || provider.id === 'github-copilot',
      refreshConfigured: provider.id === 'gemini-cli'
        ? Boolean(process.env.GEMINI_CLIENT_ID && process.env.GEMINI_CLIENT_SECRET)
        : native || extCap.refreshConfigured || provider.id === 'github-copilot',
      executor: native
        ? 'native'
        : provider.category === 'oauth' && !X_GATEWAY_OAUTH_EXECUTORS.has(provider.id)
          ? 'unavailable'
          : 'existing-adapter',
      quota: ['codex', 'claude', 'gemini-cli', 'kiro', 'openrouter', 'github-copilot', 'groq', 'deepseek', 'antigravity', 'clinepass', 'synthetic', 'cursor', 'commandcode', 'codebuddy-cn', 'codebuddy-intl', 'grok-cli', 'xiaomi-mimo', 'zed'].includes(provider.id)
        ? 'provider-api'
        : 'unknown',
      liveVerified: false,
    };
  }) });
});
subscriptionRouter.post('/bulk-import', (req: SessionRequest, res) => {
  const bulkSchema = z.object({
    provider: z.string().trim().max(64).optional(),
    labelPrefix: z.string().trim().max(64).optional(),
    credentials: z.union([z.string().min(1).max(1_048_576), z.array(z.unknown()).max(200), z.record(z.string(), z.unknown())]),
  }).strict();
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) throw new AccountError(400, 'Invalid bulk import payload.');
  const user = authorize(req);
  const result = bulkImportCredentials({
    payload: parsed.data.credentials,
    defaultProvider: parsed.data.provider,
    labelPrefix: parsed.data.labelPrefix,
    userId: user.userId,
    allowCustomModels: hasPermission(user, 'manage_key_models'),
  });
  res.json(result);
});
subscriptionRouter.post('/import', (req: SessionRequest, res) => {
  const parsed = input.extend({ credential: z.string().min(1).max(65536) }).strict().safeParse(req.body);
  if (!parsed.success) throw new AccountError(400, 'Invalid credential import.');
  validateProxyInput(parsed.data);
  const user = authorize(req, parsed.data.reconnectId);
  const id = saveSubscription({ ...parsed.data, userId: user.userId });
  res.json({ id, status: 'unknown', message: 'Credential saved encrypted; upstream inference has not been verified.' });
});
subscriptionRouter.post('/start', async (req: SessionRequest, res) => {
  const parsed = startInput.strict().safeParse(req.body);
  if (!parsed.success) throw new AccountError(400, 'Invalid connection request.');
  if ((parsed.data.baseUrl || parsed.data.clientId) && nativeKinds.has(parsed.data.provider)) {
    throw new AccountError(400, 'Invalid connection request.');
  }
  validateProxyInput(parsed.data);
  const user = authorize(req, parsed.data.reconnectId);
  if (parsed.data.reconnectId !== undefined && accountRow(parsed.data.reconnectId).provider !== parsed.data.provider) throw new AccountError(400, 'Reconnect provider mismatch.');
  for (const [id, a] of attempts) if (a.expiresAt <= Date.now()) attempts.delete(id);
  if (attempts.size >= 256 || [...attempts.values()].filter(a => a.userId === user.userId).length >= 5) throw new AccountError(429, 'Too many pending connections.');

  if (isExtendedOAuthProvider(parsed.data.provider)) {
    const a: Attempt = {
      id: 'sub_' + randomBytes(32).toString('hex'),
      provider: parsed.data.provider,
      label: parsed.data.label,
      reconnectId: parsed.data.reconnectId,
      proxyUrl: parsed.data.proxyUrl,
      proxyPoolId: parsed.data.proxyPoolId,
      session: hash(req.sessionToken!),
      userId: user.userId,
      expiresAt: Date.now() + 600_000,
      verifier: '',
      nextPollAt: 0,
      busy: true,
    };
    attempts.set(a.id, a);
    try {
      const { attempt: extAttempt, responsePayload } = await withKeyProxy(
        resolveAttemptProxy(a),
        () => startExtendedOAuth(parsed.data.provider, { baseUrl: parsed.data.baseUrl, clientId: parsed.data.clientId }),
      );
      active(a, req);
      a.extended = extAttempt;
      a.expiresAt = extAttempt.expiresAt;
      a.nextPollAt = Date.now() + extAttempt.interval * 1000;
      a.busy = false;
      res.json({ attemptId: a.id, ...responsePayload });
    } catch (error) {
      attempts.delete(a.id);
      throw error;
    }
    return;
  }

  const nativeProvider = parsed.data.provider as OAuthKind;
  const a: Attempt = {
    provider: nativeProvider,
    label: parsed.data.label,
    reconnectId: parsed.data.reconnectId,
    proxyUrl: parsed.data.proxyUrl,
    proxyPoolId: parsed.data.proxyPoolId,
    id: 'sub_' + randomBytes(32).toString('hex'),
    session: hash(req.sessionToken!),
    userId: user.userId,
    expiresAt: Date.now() + 600_000,
    verifier: randomBytes(32).toString('base64url'),
    descriptor: descriptorFor(nativeProvider),
    nextPollAt: 0,
    busy: true,
  };
  attempts.set(a.id, a);
  try {
    if (a.provider === 'kiro') {
      a.device = await withKeyProxy(resolveAttemptProxy(a), () => startKiroDevice());
      active(a, req); a.expiresAt = Date.now() + a.device.expiresIn * 1000; a.nextPollAt = Date.now() + a.device.interval * 1000; a.busy = false;
      res.json({ attemptId: a.id, flow: 'device_code', verificationUri: a.device.verificationUri, userCode: a.device.userCode, interval: a.device.interval, expiresAt: a.expiresAt } satisfies SubscriptionAttempt);
    } else {
      a.busy = false;
      res.json({ attemptId: a.id, flow: 'oauth_pkce', authorizationUrl: buildAuthorizationUrl(a.descriptor!, a.id, a.descriptor!.usePkce ? createHash('sha256').update(a.verifier).digest('base64url') : null), expiresAt: a.expiresAt,
        instruction: a.provider === 'codex' ? 'After login, copy the entire localhost callback URL here; no local server is required.' : a.provider === 'claude' ? 'Paste the complete code#state from the Anthropic callback.' : 'Use the registered public callback or paste its full URL.' } satisfies SubscriptionAttempt);
    }
  } catch (error) { attempts.delete(a.id); throw error; }
});
subscriptionRouter.post('/:attemptId/complete', async (req: SessionRequest, res) => {
  const a = lookup(req);
  const value = z.object({ code: z.string().trim().min(1).max(8192) }).strict().safeParse(req.body);
  if (!value.success || a.device) throw new AccountError(400, 'Invalid authorization response.');
  if (a.busy) throw new AccountError(409, 'Connection attempt is busy.');

  if (a.extended) {
    if (a.extended.flow !== 'oauth_pkce') throw new AccountError(400, 'Invalid authorization response.');
    a.busy = true;
    try {
      const done = await withKeyProxy(resolveAttemptProxy(a), () => completeExtendedOAuth(a.extended!, value.data.code));
      active(a, req);
      const id = saveExtendedOAuthAccount({
        provider: a.provider,
        credentialJson: done.credentialJson,
        label: a.label,
        userId: a.userId,
        reconnectId: a.reconnectId,
        proxyUrl: a.proxyUrl,
        proxyPoolId: a.proxyPoolId,
        subject: done.subject,
        authMethod: 'oauth_pkce',
      });
      attempts.delete(a.id);
      res.json({ id, status: 'saved', verified: false });
    } catch (error) {
      attempts.delete(a.id);
      throw error;
    }
    return;
  }

  let code = value.data.code; let state: string | null = null;
  if (code.startsWith('http')) {
    try { const url = new URL(code); const expected = new URL(a.descriptor!.redirectUri);
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.has('error')) throw new Error();
      state = url.searchParams.get('state'); code = url.searchParams.get('code') ?? '';
    } catch { throw new AccountError(400, 'Invalid OAuth callback URL.'); }
  } else { const split = code.split('#'); code = split[0]; state = split[1] ?? null; }
  if (!code || state !== a.id) throw new AccountError(400, 'OAuth state does not match this session.');
  a.busy = true;
  try {
    const credential = await withKeyProxy(resolveAttemptProxy(a), async () => {
      const tokens = await exchangeAuthorizationCode(a.descriptor!, `${code}#${state}`, a.verifier);
      const metadata = await resolveCredentialMetadata(a.descriptor!, tokens);
      return applyTokenResponse({ v: 1, kind: a.provider as OAuthKind, accessToken: '', refreshToken: '', expiresAt: 1, ...metadata }, tokens);
    });
    active(a, req);
    const id = saveSubscription({ ...a, credential, userId: a.userId }); attempts.delete(a.id);
    res.json({ id, status: 'saved', verified: false });
  } catch (error) { attempts.delete(a.id); throw error; }
});
subscriptionRouter.post('/:attemptId/poll', async (req: SessionRequest, res) => {
  const a = lookup(req);
  if (a.extended) {
    if (a.extended.flow !== 'device_code') throw new AccountError(400, 'Not a device flow.');
    if (a.busy || Date.now() < a.nextPollAt) { res.json({ status: 'pending', interval: a.extended.interval }); return; }
    a.busy = true;
    a.nextPollAt = Date.now() + a.extended.interval * 1000;
    try {
      const result = await withKeyProxy(resolveAttemptProxy(a), () => pollExtendedOAuth(a.extended!));
      active(a, req);
      if (result.pending) {
        if (result.slow) a.extended.interval = Math.min(30, a.extended.interval + 5);
        res.json({ status: 'pending', interval: a.extended.interval });
      } else {
        const id = saveExtendedOAuthAccount({
          provider: a.provider,
          credentialJson: result.credentialJson!,
          label: a.label,
          userId: a.userId,
          reconnectId: a.reconnectId,
          proxyUrl: a.proxyUrl,
          proxyPoolId: a.proxyPoolId,
          subject: result.subject,
          authMethod: 'device_code',
        });
        attempts.delete(a.id);
        res.json({ id, status: 'saved', verified: false });
      }
    } finally { a.busy = false; }
    return;
  }

  if (!a.device) throw new AccountError(400, 'Not a device flow.');
  if (a.busy || Date.now() < a.nextPollAt) { res.json({ status: 'pending', interval: a.device.interval }); return; }
  a.busy = true; a.nextPollAt = Date.now() + a.device.interval * 1000;
  try {
    const result = await withKeyProxy(resolveAttemptProxy(a), () => pollKiroDevice(a.device!)); active(a, req);
    if (result.pending) { if (result.slow) a.device.interval = Math.min(30, a.device.interval + 5); res.json({ status: 'pending', interval: a.device.interval }); }
    else { const id = saveSubscription({ ...a, credential: result.credential }); attempts.delete(a.id); res.json({ id, status: 'saved', verified: false }); }
  } finally { a.busy = false; }
});
subscriptionRouter.delete('/:attemptId', (req: SessionRequest, res) => { const a = lookup(req); attempts.delete(a.id); res.status(204).end(); });
