import { getDb } from '../../db/index.js';
import { isTursoDatabase, tursoWriteVersion } from '../../db/turso.js';
import type { Db } from '../../db/types.js';
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
let emptyState: { db: Db; writeVersion: number; untilMs: number } | null = null;

/** Rotate cookies once for all enabled `gemini-web` accounts and persist updates. */
export async function rotateGeminiWebAccountsOnce(): Promise<number> {
  if (sweepInFlight) return sweepInFlight;

  let db: Db | null = null;
  try {
    db = getDb();
  } catch {
    db = null;
  }

  const now = Date.now();
  if (
    db &&
    emptyState &&
    emptyState.db === db &&
    emptyState.writeVersion === tursoWriteVersion(db) &&
    now < emptyState.untilMs
  ) {
    return 0;
  }

  sweepInFlight = (async () => {
    let rotatedCount = 0;
    let accounts;
    try {
      accounts = listAccountRowsForBatchTest({ providerId: 'gemini-web' });
    } catch {
      return 0;
    }

    if (accounts.every((row) => row.enabled !== 1)) {
      if (db) {
        emptyState = {
          db,
          writeVersion: tursoWriteVersion(db),
          untilMs: now + (isTursoDatabase(db) ? 60 * 60_000 : 9 * 60_000),
        };
      }
      return 0;
    }
    emptyState = null;

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

/** Start the background `gemini-web` cookie rotation timer (plus one initial boot pass). */
export function startGeminiWebKeepAlive(scheduler: Scheduler): () => void {
  const stopBoot = scheduler.after(5_000, async () => {
    await rotateGeminiWebAccountsOnce();
  });
  const stopInterval = scheduler.every(
    GEMINI_WEB_KEEPALIVE_INTERVAL_MS,
    async () => { await rotateGeminiWebAccountsOnce(); },
    { name: 'gemini-web-keepalive' },
  );
  return () => {
    stopBoot();
    stopInterval();
  };
}
