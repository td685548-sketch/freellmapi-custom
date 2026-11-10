/**
 * Credential lifecycle for X Gateway subscription (OAuth) accounts.
 *
 * The stored blob is the single source of truth: every successful refresh is
 * written back to `x_gateway_keys` before the request continues, so a rotated
 * refresh token survives a restart. Refresh is single-flighted per account
 * because Codex rotates (and revokes) its refresh token on use - two concurrent
 * refreshes would log the user out of their ChatGPT session.
 */
import { decrypt } from '../../lib/crypto.js';
import { AccountError } from './http.js';
import {
  needsRefresh,
  parseOAuthCredential,
  serializeOAuthCredential,
  type OAuthCredential,
} from './oauth-credentials.js';
import {
  oauthDescriptor,
  refreshOAuthCredential,
  type OAuthRefreshError,
  type OAuthProviderDescriptor,
} from './oauth-providers.js';
import {
  setAccountStatus,
  updateAccountCredential,
  type AccountRow,
} from './store.js';

/** Do not hammer a token endpoint that just failed for a transient reason. */
const TRANSIENT_RETRY_COOLDOWN_MS = 30_000;
/**
 * A 401 right after a refresh must not trigger a second refresh: the refresh
 * token has already been spent and reusing it can revoke the whole session.
 */
const FORCED_REFRESH_THROTTLE_MS = 10_000;

interface RefreshEntry {
  inFlight: Promise<OAuthCredential> | null;
  /** Newest credential known to this process (may be newer than the cached row). */
  latest: OAuthCredential | null;
  /** Terminal failure: only reconnecting the account can clear it. */
  permanentFailure: AccountError | null;
  transientFailure: AccountError | null;
  retryAfter: number;
}

const entries = new Map<number, RefreshEntry>();

function entryFor(id: number): RefreshEntry {
  let entry = entries.get(id);
  if (!entry) {
    entry = { inFlight: null, latest: null, permanentFailure: null, transientFailure: null, retryAfter: 0 };
    entries.set(id, entry);
  }
  return entry;
}

/** Drop all in-process refresh state (tests, and after an account is deleted). */
export function clearOAuthRefreshState(): void {
  entries.clear();
}

/** Clear one account's cached state, e.g. after reconnect or credential edit. */
export function clearOAuthRefreshStateForAccount(id: number): void {
  entries.delete(id);
}

/**
 * The stored credential for an account, or null for legacy/plain credentials.
 * Prefers the in-process copy so a caller holding a stale cached row still sees
 * the most recent refresh.
 */
export function oauthCredentialForAccount(
  row: Pick<AccountRow, 'id' | 'encrypted_key' | 'iv' | 'auth_tag'>,
): OAuthCredential | null {
  const entry = entries.get(row.id);
  if (entry?.latest) return entry.latest;
  try {
    return parseOAuthCredential(decrypt(row.encrypted_key, row.iv, row.auth_tag));
  } catch {
    return null;
  }
}

function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 200);
  return 'the provider rejected the refresh token';
}

function isPermanent(error: OAuthRefreshError | undefined): boolean {
  if (!error) return false;
  if (error.permanent === true) return true;
  return error.status === 400 || error.status === 401 || error.status === 403;
}

async function performRefresh(
  row: AccountRow,
  current: OAuthCredential,
  descriptor: OAuthProviderDescriptor,
  entry: RefreshEntry,
): Promise<OAuthCredential> {
  try {
    const next = await refreshOAuthCredential(descriptor, current);
    // Persist before returning: a rotated refresh token that only lives in
    // memory is lost on restart and revokes the grant on the next use.
    updateAccountCredential(row.id, next);
    entry.latest = next;
    entry.transientFailure = null;
    entry.retryAfter = 0;
    return next;
  } catch (cause) {
    const error = cause as OAuthRefreshError;
    if (isPermanent(error)) {
      const failure = new AccountError(
        401,
        `${descriptor.name} rejected the saved refresh token (${reasonOf(cause)}). Reconnect this account to continue.`,
      );
      entry.permanentFailure = failure;
      try {
        setAccountStatus(row.id, 'error');
      } catch {
        // Status bookkeeping must never mask the real error.
      }
      throw failure;
    }
    const transient = new AccountError(
      502,
      `${descriptor.name} token refresh failed temporarily (${reasonOf(cause)}). Retrying shortly.`,
    );
    entry.transientFailure = transient;
    entry.retryAfter = Date.now() + TRANSIENT_RETRY_COOLDOWN_MS;
    throw transient;
  }
}

async function refreshCredential(
  row: AccountRow,
  current: OAuthCredential,
  descriptor: OAuthProviderDescriptor,
): Promise<OAuthCredential> {
  const entry = entryFor(row.id);
  if (entry.permanentFailure) throw entry.permanentFailure;
  if (entry.inFlight) return entry.inFlight;
  if (entry.transientFailure && Date.now() < entry.retryAfter) throw entry.transientFailure;

  let task: Promise<OAuthCredential>;
  task = performRefresh(row, current, descriptor, entry).finally(() => {
    if (entry.inFlight === task) entry.inFlight = null;
  });
  entry.inFlight = task;
  return task;
}

/**
 * Resolve the credential string to hand a provider.
 *
 * OAuth accounts return the (refreshed) JSON blob and parse their own fields;
 * every other account returns the decrypted credential untouched, so plain API
 * keys, cookies and Copilot tokens keep working exactly as before.
 */
export async function resolveAccountCredential(
  row: AccountRow,
  options: { forceRefresh?: boolean } = {},
): Promise<string> {
  const current = oauthCredentialForAccount(row);
  if (!current) return decrypt(row.encrypted_key, row.iv, row.auth_tag);

  const descriptor = oauthDescriptor(current.kind);
  if (!descriptor) {
    throw new AccountError(400, `OAuth account kind '${current.kind}' is not supported by this gateway.`);
  }

  const now = Date.now();
  const entry = entries.get(row.id);
  if (entry?.permanentFailure) throw entry.permanentFailure;

  const due = options.forceRefresh === true || needsRefresh(current, descriptor.refreshLeadMs, now);
  if (!due) return serializeOAuthCredential(current);

  // A refresh that just completed already covers this call, forced or not.
  if (current.lastRefreshAt !== undefined && now - current.lastRefreshAt < FORCED_REFRESH_THROTTLE_MS) {
    return serializeOAuthCredential(current);
  }

  return serializeOAuthCredential(await refreshCredential(row, current, descriptor));
}

/** True when the upstream rejected the credential we sent (HTTP 401). */
export function isUnauthorizedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: unknown }).status;
  if (status === 401) return true;
  const message = error instanceof Error ? error.message : '';
  return /\bHTTP 401\b|\b401 Unauthorized\b/.test(message);
}

/**
 * Run a provider call with a refreshed credential. On a 401 the call is retried
 * exactly once with a forced refresh - never in a loop, and never when the
 * credential is not an OAuth blob.
 */
export async function withAccountCredential<T>(
  row: AccountRow,
  run: (credential: string) => Promise<T>,
): Promise<T> {
  const credential = await resolveAccountCredential(row);
  try {
    return await run(credential);
  } catch (error) {
    if (!isUnauthorizedError(error) || parseOAuthCredential(credential) === null) throw error;
    const refreshed = await resolveAccountCredential(row, { forceRefresh: true });
    if (refreshed === credential) throw error;
    return run(refreshed);
  }
}
