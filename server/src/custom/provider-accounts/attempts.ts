import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ProviderAccountAuthStartResponse, ProviderAccountAuthResult, ProviderAccountPollResponse } from '@freellmapi/shared/x-accounts.js';
import { CopilotProvider } from './copilot.js';
import {
  AccountError, COPILOT_PREFIX, DEVICE_URL, GITHUB_CLIENT_ID, GITHUB_TOKEN_URL,
  GITHUB_USER_URL, OPENROUTER_KEY_URL, githubHeaders, jsonPost, providerJson, secretSchema,
} from './http.js';
import { reconnectAccount, saveAccount, type OAuthProvider } from './store.js';

export interface AccountActor { userId: number; sessionToken: string }
interface Attempt {
  id: string; provider: OAuthProvider; userId: number; sessionHash: string; label: string;
  expiresAt: number; verifier: string; deviceCode?: string; interval: number; nextPollAt: number;
  reconnectId?: number; expectedSubject?: string | null; busy: boolean;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const attempts = new Map<string, Attempt>();
const TTL = 10 * 60_000;
function cleanup(): void {
  for (const [id, attempt] of attempts) if (attempt.expiresAt <= Date.now()) attempts.delete(id);
}
const cleanupTimer = setInterval(cleanup, 60_000);
cleanupTimer.unref?.();

function lookup(id: string, actor: AccountActor): Attempt {
  cleanup();
  const a = attempts.get(id);
  if (!a || a.userId !== actor.userId || a.sessionHash !== hash(actor.sessionToken)) {
    throw new AccountError(404, 'Connection attempt not found or expired.');
  }
  return a;
}

function assertActive(a: Attempt, authorize: () => void): void {
  if (attempts.get(a.id) !== a || a.expiresAt <= Date.now()) throw new AccountError(410, 'Connection attempt cancelled or expired.');
  authorize();
}

export function attemptAction(id: string, actor: AccountActor): { provider: OAuthProvider; reconnectId?: number } {
  const a = lookup(id, actor);
  return { provider: a.provider, reconnectId: a.reconnectId };
}

export function validateCallback(callbackUrl: string | undefined, requestOrigin: string): URL {
  try {
    const url = new URL(callbackUrl ?? '');
    const origin = new URL(requestOrigin);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== requestOrigin) throw new Error();
    if (url.origin !== origin.origin || url.username || url.password || url.hash || (callbackUrl ?? '').includes('#')) throw new Error();
    if (!url.pathname.endsWith('/x/accounts/callback')) throw new Error();
    return url;
  } catch {
    throw new AccountError(400, 'callbackUrl must be a same-origin /x/accounts/callback URL without credentials or fragments.');
  }
}

const deviceSchema = z.object({
  device_code: secretSchema, user_code: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/),
  verification_uri: z.literal('https://github.com/login/device'),
  expires_in: z.number().int().positive().max(86400), interval: z.number().int().positive().max(300).default(5),
});
const pollSchema = z.union([
  z.object({ error: z.enum(['authorization_pending', 'slow_down', 'access_denied', 'expired_token']) }),
  z.object({ access_token: secretSchema, token_type: z.string().refine(s => s.toLowerCase() === 'bearer') }),
]);

export async function startAccountAuth(input: {
  provider: OAuthProvider; label: string; callbackUrl?: string; reconnectId?: number;
}, actor: AccountActor, origin: string, authorize: () => void): Promise<ProviderAccountAuthStartResponse> {
  authorize();
  const callback = input.provider === 'openrouter' ? validateCallback(input.callbackUrl, origin) : null;
  const expectedSubject = input.reconnectId === undefined ? undefined : reconnectAccount(input.reconnectId, input.provider).subject;
  cleanup();
  if (attempts.size >= 256 || [...attempts.values()].filter(a => a.userId === actor.userId).length >= 5) {
    throw new AccountError(429, 'Too many connection attempts. Cancel an attempt or wait for expiry.');
  }
  const a: Attempt = {
    ...input, id: randomBytes(32).toString('hex'), userId: actor.userId, sessionHash: hash(actor.sessionToken),
    expiresAt: Date.now() + TTL, verifier: randomBytes(32).toString('base64url'), interval: 5,
    nextPollAt: 0, expectedSubject, busy: true,
  };
  attempts.set(a.id, a);
  try {
    if (callback) {
      callback.searchParams.set('attemptId', a.id);
      const url = new URL('https://openrouter.ai/auth');
      url.searchParams.set('callback_url', callback.toString());
      url.searchParams.set('code_challenge', createHash('sha256').update(a.verifier).digest('base64url'));
      url.searchParams.set('code_challenge_method', 'S256');
      a.busy = false;
      return { flow: 'oauth_pkce', attemptId: a.id, authorizationUrl: url.toString(), expiresAt: a.expiresAt };
    }
    const device = await providerJson(DEVICE_URL, deviceSchema, jsonPost({ client_id: GITHUB_CLIENT_ID, scope: 'read:user' }));
    assertActive(a, authorize);
    a.deviceCode = device.device_code;
    a.interval = device.interval;
    a.expiresAt = Math.min(a.expiresAt, Date.now() + device.expires_in * 1000);
    a.nextPollAt = Date.now() + a.interval * 1000;
    a.busy = false;
    return {
      flow: 'device_code', attemptId: a.id, verificationUri: device.verification_uri,
      userCode: device.user_code, interval: a.interval, expiresAt: a.expiresAt,
    };
  } catch (err) {
    attempts.delete(a.id);
    throw err;
  }
}

export async function completeAccountAuth(id: string, actor: AccountActor, code: string, authorize: () => void): Promise<ProviderAccountAuthResult> {
  const a = lookup(id, actor);
  authorize();
  if (a.provider !== 'openrouter') throw new AccountError(400, 'This connection requires device polling.');
  if (a.busy) throw new AccountError(409, 'Connection attempt is already in progress.');
  a.busy = true;
  try {
    const result = await providerJson(OPENROUTER_KEY_URL, z.object({ key: secretSchema }), jsonPost({ code, code_verifier: a.verifier }));
    assertActive(a, authorize);
    const accountId = saveAccount({ ...a, credential: result.key, subject: null });
    return { status: 'connected', accountId };
  } finally {
    attempts.delete(a.id);
  }
}

export async function pollAccountAuth(id: string, actor: AccountActor, authorize: () => void): Promise<ProviderAccountPollResponse> {
  const a = lookup(id, actor);
  authorize();
  if (a.provider !== 'github-copilot' || !a.deviceCode) throw new AccountError(400, 'This connection requires a PKCE code.');
  if (a.busy || Date.now() < a.nextPollAt) {
    return { status: 'pending', interval: Math.max(a.interval, Math.ceil((a.nextPollAt - Date.now()) / 1000)) };
  }
  a.busy = true;
  a.nextPollAt = Date.now() + a.interval * 1000;
  let keep = false;
  try {
    const result = await providerJson(GITHUB_TOKEN_URL, pollSchema, jsonPost({
      client_id: GITHUB_CLIENT_ID, device_code: a.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }));
    assertActive(a, authorize);
    if ('error' in result) {
      if (result.error === 'authorization_pending' || result.error === 'slow_down') {
        if (result.error === 'slow_down') a.interval += 5;
        a.nextPollAt = Date.now() + a.interval * 1000;
        keep = true;
        return { status: 'pending', interval: a.interval };
      }
      throw new AccountError(400, result.error === 'access_denied' ? 'Provider authorization was denied.' : 'Provider authorization has expired.');
    }
    const user = await providerJson(GITHUB_USER_URL, z.object({ id: z.number().int().positive().safe() }), {
      headers: githubHeaders(result.access_token),
    });
    const subject = String(user.id);
    if (a.reconnectId !== undefined && subject !== a.expectedSubject) throw new AccountError(409, 'Reconnect must use the original GitHub account.');
    const credential = COPILOT_PREFIX + result.access_token;
    const models = await new CopilotProvider().discoverModels(credential);
    assertActive(a, authorize);
    const accountId = saveAccount({ ...a, credential, subject, models });
    return { status: 'connected', accountId };
  } finally {
    a.busy = false;
    if (!keep) attempts.delete(a.id);
  }
}

export function cancelAccountAuth(id: string, actor: AccountActor): void {
  const a = lookup(id, actor);
  attempts.delete(a.id);
}
