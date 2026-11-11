import type { SubscriptionAttempt } from '@freellmapi/shared/x-subscriptions.js';
import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { validateSession } from '../../services/auth.js';
import { hasPermission, requirePermission } from '../../middleware/requirePermission.js';
import { withKeyProxy } from '../../lib/proxy.js';
import { AccountError } from './http.js';
import { accountRow, resolveXGatewayAccountProxy } from './store.js';
import { X_GATEWAY_OAUTH_EXECUTORS, X_GATEWAY_PROVIDERS } from './catalog.js';
import { applyTokenResponse, type OAuthKind } from './oauth-credentials.js';
import { buildAuthorizationUrl, exchangeAuthorizationCode, oauthDescriptor, resolveCredentialMetadata, type OAuthProviderDescriptor } from './oauth-providers.js';
import { pollKiroDevice, startKiroDevice } from './kiro-auth.js';
import { saveSubscription } from './subscription-store.js';

const kinds = z.enum(['codex', 'claude', 'gemini-cli', 'kiro']);
const input = z.object({ provider: kinds, label: z.string().trim().min(1).max(200), reconnectId: z.number().int().positive().optional() });
const attempts = new Map<string, Attempt>();
type Device = Awaited<ReturnType<typeof startKiroDevice>>;
interface Attempt { id: string; provider: OAuthKind; label: string; reconnectId?: number; session: string; userId: number; expiresAt: number; verifier: string; descriptor: OAuthProviderDescriptor; device?: Device; nextPollAt: number; busy: boolean }
type SessionRequest = Request & { sessionToken?: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
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
      descriptor.redirectUri = new URL('x/accounts/callback', base.toString().replace(/\/?$/, '/')).toString();
    } catch { throw new AccountError(409, 'Configure an HTTPS PUBLIC_APP_URL for the registered Google OAuth callback.'); }
  }
  return descriptor;
}
export const subscriptionRouter = Router();
subscriptionRouter.get('/capabilities', requirePermission('view_keys'), (_req, res) => {
  res.json({ providers: X_GATEWAY_PROVIDERS.map(provider => {
    const native = ['codex', 'claude', 'gemini-cli', 'kiro'].includes(provider.id);
    const login = provider.id === 'gemini-cli' ? Boolean(process.env.GEMINI_CLIENT_ID && process.env.GEMINI_CLIENT_SECRET && process.env.PUBLIC_APP_URL) : native || ['openrouter', 'github-copilot'].includes(provider.id);
    return { provider: provider.id, catalog: true, credentialImport: native, login, refresh: native || provider.id === 'github-copilot', refreshConfigured: provider.id === 'gemini-cli' ? Boolean(process.env.GEMINI_CLIENT_ID && process.env.GEMINI_CLIENT_SECRET) : native || provider.id === 'github-copilot',
      executor: native ? 'native' : provider.category === 'oauth' && !X_GATEWAY_OAUTH_EXECUTORS.has(provider.id) ? 'unavailable' : 'existing-adapter',
      quota: ['codex', 'claude', 'gemini-cli', 'kiro', 'openrouter', 'github-copilot', 'groq', 'deepseek'].includes(provider.id) ? 'provider-api' : 'unknown', liveVerified: false };
  }) });
});
subscriptionRouter.post('/import', (req: SessionRequest, res) => {
  const parsed = input.extend({ credential: z.string().min(1).max(65536) }).strict().safeParse(req.body);
  if (!parsed.success) throw new AccountError(400, 'Invalid credential import.');
  const user = authorize(req, parsed.data.reconnectId);
  const id = saveSubscription({ ...parsed.data, userId: user.userId });
  res.json({ id, status: 'unknown', message: 'Credential saved encrypted; upstream inference has not been verified.' });
});
subscriptionRouter.post('/start', async (req: SessionRequest, res) => {
  const parsed = input.strict().safeParse(req.body);
  if (!parsed.success) throw new AccountError(400, 'Invalid connection request.');
  const user = authorize(req, parsed.data.reconnectId);
  if (parsed.data.reconnectId !== undefined && accountRow(parsed.data.reconnectId).provider !== parsed.data.provider) throw new AccountError(400, 'Reconnect provider mismatch.');
  for (const [id, a] of attempts) if (a.expiresAt <= Date.now()) attempts.delete(id);
  if (attempts.size >= 256 || [...attempts.values()].filter(a => a.userId === user.userId).length >= 5) throw new AccountError(429, 'Too many pending connections.');
  const a: Attempt = { ...parsed.data, id: 'sub_' + randomBytes(32).toString('hex'), session: hash(req.sessionToken!), userId: user.userId, expiresAt: Date.now() + 600_000,
    verifier: randomBytes(32).toString('base64url'), descriptor: descriptorFor(parsed.data.provider), nextPollAt: 0, busy: true };
  attempts.set(a.id, a);
  try {
    if (a.provider === 'kiro') {
      a.device = await withKeyProxy(resolveXGatewayAccountProxy(null), () => startKiroDevice());
      active(a, req); a.expiresAt = Date.now() + a.device.expiresIn * 1000; a.nextPollAt = Date.now() + a.device.interval * 1000; a.busy = false;
      res.json({ attemptId: a.id, flow: 'device_code', verificationUri: a.device.verificationUri, userCode: a.device.userCode, interval: a.device.interval, expiresAt: a.expiresAt } satisfies SubscriptionAttempt);
    } else {
      a.busy = false;
      res.json({ attemptId: a.id, flow: 'oauth_pkce', authorizationUrl: buildAuthorizationUrl(a.descriptor, a.id, a.descriptor.usePkce ? createHash('sha256').update(a.verifier).digest('base64url') : null), expiresAt: a.expiresAt,
        instruction: a.provider === 'codex' ? 'After login, copy the entire localhost callback URL here; no local server is required.' : a.provider === 'claude' ? 'Paste the complete code#state from the Anthropic callback.' : 'Use the registered public callback or paste its full URL.' } satisfies SubscriptionAttempt);
    }
  } catch (error) { attempts.delete(a.id); throw error; }
});
subscriptionRouter.post('/:attemptId/complete', async (req: SessionRequest, res) => {
  const a = lookup(req);
  const value = z.object({ code: z.string().trim().min(1).max(4096) }).strict().safeParse(req.body);
  if (!value.success || a.device) throw new AccountError(400, 'Invalid authorization response.');
  if (a.busy) throw new AccountError(409, 'Connection attempt is busy.');
  let code = value.data.code; let state: string | null = null;
  if (code.startsWith('http')) {
    try { const url = new URL(code); const expected = new URL(a.descriptor.redirectUri);
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.has('error')) throw new Error();
      state = url.searchParams.get('state'); code = url.searchParams.get('code') ?? '';
    } catch { throw new AccountError(400, 'Invalid OAuth callback URL.'); }
  } else { const split = code.split('#'); code = split[0]; state = split[1] ?? null; }
  if (!code || state !== a.id) throw new AccountError(400, 'OAuth state does not match this session.');
  a.busy = true;
  try {
    const credential = await withKeyProxy(resolveXGatewayAccountProxy(null), async () => {
      const tokens = await exchangeAuthorizationCode(a.descriptor, `${code}#${state}`, a.verifier);
      const metadata = await resolveCredentialMetadata(a.descriptor, tokens);
      return applyTokenResponse({ v: 1, kind: a.provider, accessToken: '', refreshToken: '', expiresAt: 1, ...metadata }, tokens);
    });
    active(a, req);
    const id = saveSubscription({ ...a, credential, userId: a.userId }); attempts.delete(a.id);
    res.json({ id, status: 'saved', verified: false });
  } catch (error) { attempts.delete(a.id); throw error; }
});
subscriptionRouter.post('/:attemptId/poll', async (req: SessionRequest, res) => {
  const a = lookup(req);
  if (!a.device) throw new AccountError(400, 'Not a device flow.');
  if (a.busy || Date.now() < a.nextPollAt) { res.json({ status: 'pending', interval: a.device.interval }); return; }
  a.busy = true; a.nextPollAt = Date.now() + a.device.interval * 1000;
  try {
    const result = await withKeyProxy(resolveXGatewayAccountProxy(null), () => pollKiroDevice(a.device!)); active(a, req);
    if (result.pending) { if (result.slow) a.device.interval = Math.min(30, a.device.interval + 5); res.json({ status: 'pending', interval: a.device.interval }); }
    else { const id = saveSubscription({ ...a, credential: result.credential }); attempts.delete(a.id); res.json({ id, status: 'saved', verified: false }); }
  } finally { a.busy = false; }
});
subscriptionRouter.delete('/:attemptId', (req: SessionRequest, res) => { const a = lookup(req); attempts.delete(a.id); res.status(204).end(); });
