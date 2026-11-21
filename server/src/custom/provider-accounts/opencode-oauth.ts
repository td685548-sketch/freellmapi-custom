/**
 * OpenCode Console OAuth device login for the free lane.
 *
 * The free lane used to send the literal `Authorization: Bearer public` with
 * no account binding. The real OpenCode CLI logs in with an OAuth device
 * flow against `https://opencode.ai/console` using `client_id "opencode-cli"`
 * (see `packages/core/src/plugin/provider/opencode.ts` and
 * `packages/core/src/console-access.ts` in the OpenCode source):
 *
 *   1. POST /auth/device/code { client_id, supports_org_scope: true }
 *      -> { device_code, user_code, verification_uri_complete, expires_in, interval }
 *   2. The user enters `user_code` at `verification_uri_complete`.
 *   3. Poll POST /auth/device/token
 *      { grant_type: "device_code", device_code, client_id }
 *      -> { access_token, refresh_token, expires_in, org_id } once authorized,
 *      or { error: "authorization_pending" | "slow_down" | ... } while waiting.
 *   4. Refresh POSTs the same token endpoint with
 *      { grant_type: "refresh_token", refresh_token, client_id } — handled by
 *      the shared OAuth lifecycle (`refreshOAuthCredential` with the
 *      `opencode` descriptor). A 400 `invalid_grant` there means signed out:
 *      the lifecycle surfaces it as a permanent failure, never a retry loop.
 *
 * This module performs exactly that flow with the user's own account. It
 * never fabricates credentials and never logs token values. The completed
 * login is stored as the account's OAuth credential through the same
 * encrypted `x_gateway_keys` column every other OAuth account uses, so the
 * provider (`opencode.ts`) picks the access token up on the next request and
 * the lifecycle refreshes it before it expires.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { proxyFetch } from '../../lib/proxy.js';
import { AccountError, secretSchema } from './http.js';
import { OPENCODE_UA } from './opencode.js';
import {
  oauthIdentity,
  type OAuthCredential,
} from './oauth-credentials.js';
import { clearOAuthRefreshStateForAccount, oauthCredentialForAccount } from './oauth-lifecycle.js';
import { accountRow, clearAccountDeviceLogin, setAccountDeviceLogin } from './store.js';
import type { AccountActor } from './attempts.js';

export const OPENCODE_CONSOLE_BASE_URL = 'https://opencode.ai/console';
export const OPENCODE_CONSOLE_CLIENT_ID = 'opencode-cli';
export const OPENCODE_DEVICE_CODE_URL = `${OPENCODE_CONSOLE_BASE_URL}/auth/device/code`;
export const OPENCODE_DEVICE_TOKEN_URL = `${OPENCODE_CONSOLE_BASE_URL}/auth/device/token`;

const deviceCodeSchema = z.object({
  device_code: secretSchema,
  user_code: z.string().min(1).max(100),
  verification_uri: z.string().url().max(2048),
  verification_uri_complete: z.string().url().max(2048),
  expires_in: z.number().int().positive().max(86400),
  interval: z.number().int().positive().max(300).default(5),
});

const deviceTokenSuccessSchema = z.object({
  access_token: secretSchema,
  refresh_token: secretSchema,
  expires_in: z.number().int().positive().max(86400).optional(),
  org_id: z.string().min(1).max(200).optional(),
  token_type: z.string().max(50).optional(),
});

const deviceTokenErrorSchema = z.object({
  error: z.string().min(1).max(100),
  error_description: z.string().max(1000).optional(),
});

const deviceTokenSchema = z.union([deviceTokenSuccessSchema, deviceTokenErrorSchema]);

export interface OpenCodeDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export type OpenCodeDeviceTokenResult =
  | { accessToken: string; refreshToken: string; expiresIn?: number; orgId?: string }
  | { error: string };

export interface OpenCodeConsoleLoginStart {
  flow: 'device_code';
  attemptId: string;
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  interval: number;
  expiresAt: number;
}

export type OpenCodeConsoleLoginPoll =
  | { status: 'pending'; interval: number }
  | { status: 'connected'; accountId: number }
  | { status: 'expired' };

export interface OpenCodeConsoleLoginStatus {
  connected: boolean;
  identity: string | null;
  expiresAt: number | null;
}

async function postConsoleJson<T>(url: string, body: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await proxyFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': OPENCODE_UA,
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    }, 'opencode', 'unknown');
  } catch {
    throw new AccountError(502, 'OpenCode Console did not answer. Try again shortly.');
  }
  let data: unknown;
  try {
    // The token endpoint answers pending/expired with an `{ error }` body on
    // a 4xx status, so the body is parsed regardless of the status code.
    data = await response.json();
  } catch {
    throw new AccountError(502, 'OpenCode Console returned an unreadable response.');
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new AccountError(502, 'OpenCode Console returned an unexpected response.');
  }
  return parsed.data;
}

/** Step 1 of the device flow: ask the Console for a user code. */
export async function requestOpenCodeDeviceCode(): Promise<OpenCodeDeviceCode> {
  const device = await postConsoleJson(
    OPENCODE_DEVICE_CODE_URL,
    { client_id: OPENCODE_CONSOLE_CLIENT_ID, supports_org_scope: true },
    deviceCodeSchema,
  );
  return {
    deviceCode: device.device_code,
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    verificationUriComplete: device.verification_uri_complete,
    expiresIn: device.expires_in,
    interval: device.interval,
  };
}

/** Step 3 of the device flow: one poll against the token endpoint. */
export async function pollOpenCodeDeviceToken(deviceCode: string): Promise<OpenCodeDeviceTokenResult> {
  const result = await postConsoleJson(
    OPENCODE_DEVICE_TOKEN_URL,
    { grant_type: 'device_code', device_code: deviceCode, client_id: OPENCODE_CONSOLE_CLIENT_ID },
    deviceTokenSchema,
  );
  if ('error' in result) return { error: result.error };
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    ...(result.expires_in !== undefined ? { expiresIn: result.expires_in } : {}),
    ...(result.org_id ? { orgId: result.org_id } : {}),
  };
}

/** Build the stored OAuth credential from a completed device-token response. */
export function buildOpenCodeCredential(
  tokens: { accessToken: string; refreshToken: string; expiresIn?: number; orgId?: string },
  now = Date.now(),
): OAuthCredential {
  return {
    v: 1,
    kind: 'opencode',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: now + (tokens.expiresIn ?? 3600) * 1000,
    lastRefreshAt: now,
    ...(tokens.orgId ? { orgId: tokens.orgId, subject: tokens.orgId } : {}),
  };
}

// --- Pending-login attempts (in-memory, same shape as attempts.ts) ---

interface OpenCodeLoginAttempt {
  id: string;
  accountId: number;
  userId: number;
  sessionHash: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: number;
  interval: number;
  nextPollAt: number;
  busy: boolean;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const attempts = new Map<string, OpenCodeLoginAttempt>();
const ATTEMPT_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 256;
const MAX_ATTEMPTS_PER_USER = 5;

function cleanup(): void {
  for (const [id, attempt] of attempts) {
    if (attempt.expiresAt <= Date.now()) attempts.delete(id);
  }
}
const cleanupTimer = setInterval(cleanup, 60_000);
cleanupTimer.unref?.();

/** Drop all in-process login state (tests, and after an account is deleted). */
export function _resetOpenCodeConsoleLoginStateForTests(): void {
  attempts.clear();
}

function lookup(id: string, actor: AccountActor): OpenCodeLoginAttempt {
  cleanup();
  const attempt = attempts.get(id);
  if (!attempt || attempt.userId !== actor.userId || attempt.sessionHash !== hash(actor.sessionToken)) {
    throw new AccountError(404, 'Connection attempt not found or expired.');
  }
  return attempt;
}

function assertOpenCodeAccount(accountId: number): void {
  const row = accountRow(accountId);
  if (row.provider !== 'opencode') {
    throw new AccountError(400, 'Only OpenCode Free accounts support Console login.');
  }
}

/**
 * Start a Console device login for an existing OpenCode Free account.
 * Returns the verification link + user code for the client to display.
 */
export async function startOpenCodeConsoleLogin(
  accountId: number,
  actor: AccountActor,
): Promise<OpenCodeConsoleLoginStart> {
  assertOpenCodeAccount(accountId);
  cleanup();
  if (attempts.size >= MAX_ATTEMPTS || [...attempts.values()].filter((a) => a.userId === actor.userId).length >= MAX_ATTEMPTS_PER_USER) {
    throw new AccountError(429, 'Too many connection attempts. Cancel an attempt or wait for expiry.');
  }
  const device = await requestOpenCodeDeviceCode();
  const attempt: OpenCodeLoginAttempt = {
    id: randomBytes(32).toString('hex'),
    accountId,
    userId: actor.userId,
    sessionHash: hash(actor.sessionToken),
    deviceCode: device.deviceCode,
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    verificationUriComplete: device.verificationUriComplete,
    expiresAt: Math.min(Date.now() + ATTEMPT_TTL_MS, Date.now() + device.expiresIn * 1000),
    interval: device.interval,
    // The client waits `interval` before its first poll; allow an immediate
    // poll so tests and impatient clients are not throttled on the first call.
    nextPollAt: 0,
    busy: false,
  };
  attempts.set(attempt.id, attempt);
  return {
    flow: 'device_code',
    attemptId: attempt.id,
    verificationUri: attempt.verificationUri,
    verificationUriComplete: attempt.verificationUriComplete,
    userCode: attempt.userCode,
    interval: attempt.interval,
    expiresAt: attempt.expiresAt,
  };
}

/**
 * Poll one login attempt. A successful authorization persists the OAuth
 * credential on the account and the attempt is gone; pending stays pending;
 * an expired or denied code ends the attempt.
 */
export async function pollOpenCodeConsoleLogin(
  attemptId: string,
  actor: AccountActor,
): Promise<OpenCodeConsoleLoginPoll> {
  const attempt = lookup(attemptId, actor);
  if (attempt.expiresAt <= Date.now()) {
    attempts.delete(attempt.id);
    return { status: 'expired' };
  }
  if (attempt.busy || Date.now() < attempt.nextPollAt) {
    return {
      status: 'pending',
      interval: Math.max(attempt.interval, Math.ceil((attempt.nextPollAt - Date.now()) / 1000)),
    };
  }
  attempt.busy = true;
  attempt.nextPollAt = Date.now() + attempt.interval * 1000;
  let keep = false;
  try {
    const result = await pollOpenCodeDeviceToken(attempt.deviceCode);
    if ('error' in result) {
      if (result.error === 'authorization_pending' || result.error === 'slow_down') {
        if (result.error === 'slow_down') {
          attempt.interval += 5;
          attempt.nextPollAt = Date.now() + attempt.interval * 1000;
        }
        keep = true;
        return { status: 'pending', interval: attempt.interval };
      }
      if (result.error === 'access_denied') {
        throw new AccountError(400, 'OpenCode Console authorization was denied.');
      }
      // expired_token / invalid_grant / anything else: the code is dead.
      return { status: 'expired' };
    }
    const credential = buildOpenCodeCredential(result);
    setAccountDeviceLogin(attempt.accountId, credential, credential.orgId ?? credential.subject ?? null);
    clearOAuthRefreshStateForAccount(attempt.accountId);
    return { status: 'connected', accountId: attempt.accountId };
  } finally {
    attempt.busy = false;
    if (!keep) attempts.delete(attempt.id);
  }
}

/** Cancel a pending login attempt. */
export function cancelOpenCodeConsoleLogin(attemptId: string, actor: AccountActor): void {
  const attempt = lookup(attemptId, actor);
  attempts.delete(attempt.id);
}

/** Whether an account currently holds a Console OAuth login. */
export function openCodeConsoleLoginStatus(accountId: number): OpenCodeConsoleLoginStatus {
  assertOpenCodeAccount(accountId);
  const row = accountRow(accountId);
  const credential = oauthCredentialForAccount(row);
  if (!credential || credential.kind !== 'opencode') {
    return { connected: false, identity: row.subject, expiresAt: null };
  }
  return {
    connected: true,
    identity: oauthIdentity(credential) ?? row.subject,
    expiresAt: credential.expiresAt,
  };
}

/** Drop the stored Console login and restore the keyless credential. */
export function disconnectOpenCodeConsoleLogin(accountId: number): { connected: boolean } {
  assertOpenCodeAccount(accountId);
  clearAccountDeviceLogin(accountId);
  clearOAuthRefreshStateForAccount(accountId);
  return { connected: false };
}
