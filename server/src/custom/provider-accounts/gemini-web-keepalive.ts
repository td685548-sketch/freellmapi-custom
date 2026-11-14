import { decrypt } from '../../lib/crypto.js';
import { withKeyProxy } from '../../lib/proxy.js';
import type { Scheduler } from '../../lib/scheduler.js';
import { normalizeGeminiWebCookie, rotateGeminiCookies } from './gemini-web-chat.js';
import {
  listAccountRowsForBatchTest,
  resolveXGatewayAccountProxy,
  updateAccountCredential,
} from './store.js';

/**
 * Google's Gemini web client rotates `__Secure-1PSIDTS` roughly every 9 minutes
 * via `accounts.google.com/RotateCookies`. Running the same cadence in the
 * background keeps idle sessions alive between user requests.
 */
export const GEMINI_WEB_KEEPALIVE_INTERVAL_MS = 9 * 60_000;

let sweepInFlight: Promise<number> | null = null;

/** Rotate cookies once for all enabled `gemini-web` accounts and persist updates. */
export async function rotateGeminiWebAccountsOnce(): Promise<number> {
  if (sweepInFlight) return sweepInFlight;

  sweepInFlight = (async () => {
    let rotatedCount = 0;
    let accounts;
    try {
      accounts = listAccountRowsForBatchTest({ providerId: 'gemini-web' });
    } catch {
      return 0;
    }

    for (const row of accounts) {
      if (row.enabled !== 1) continue;
      try {
        const rawCredential = decrypt(row.encrypted_key, row.iv, row.auth_tag);
        const cookieHeader = normalizeGeminiWebCookie(rawCredential);
        const proxyUrl = resolveXGatewayAccountProxy(row);
        const result = await withKeyProxy(proxyUrl, () =>
          rotateGeminiCookies(cookieHeader, 'custom', undefined, { force: true }),
        );
        if (result.rotated) {
          updateAccountCredential(row.id, result.cookieHeader, row.encrypted_key);
          rotatedCount++;
        }
      } catch {
        // One failing or expired account must not stop rotation for other accounts.
      }
    }

    return rotatedCount;
  })().finally(() => {
    sweepInFlight = null;
  });

  return sweepInFlight;
}

/** Start the background `gemini-web` cookie rotation timer. */
export function startGeminiWebKeepAlive(scheduler: Scheduler): () => void {
  return scheduler.every(
    GEMINI_WEB_KEEPALIVE_INTERVAL_MS,
    async () => { await rotateGeminiWebAccountsOnce(); },
    { name: 'gemini-web-keepalive' },
  );
}
