import { getDb } from '../../db/index.js';
import { isTursoDatabase, tursoWriteVersion } from '../../db/turso.js';
import type { Db } from '../../db/types.js';
import { decrypt } from '../../lib/crypto.js';
import { withKeyProxy } from '../../lib/proxy.js';
import type { Scheduler } from '../../lib/scheduler.js';
import { clearAccountCooldown } from './auto-ping.js';
import { rotateChatGptWebSession } from './chatgpt-web-image.js';
import {
  accountRow,
  listAccountRowsForBatchTest,
  resolveXGatewayAccountProxy,
  setAccountStatus,
  updateAccountCredential,
} from './store.js';
import { notifyProviderAccountIssue } from '../notifications/telegram-bot.js';

/**
 * Proactive rotation interval for ChatGPT Web session cookies and access
 * tokens, keeping active accounts healthy and automatically reconnecting
 * recovered accounts without manual cookie re-paste.
 */
export const CHATGPT_WEB_KEEPALIVE_INTERVAL_MS = 30 * 60_000;

let sweepInFlight: Promise<number> | null = null;
let emptyState: { db: Db; writeVersion: number; untilMs: number } | null = null;

/** Clear in-memory keep-alive state (used by tests). */
export function resetChatGptWebKeepAliveForTests(): void {
  sweepInFlight = null;
  emptyState = null;
}

/**
 * Rotate session cookies once for all enabled `chatgpt-web` accounts, persist
 * updates, and automatically mark recovered accounts as healthy.
 */
export async function rotateChatGptWebAccountsOnce(): Promise<number> {
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
      accounts = listAccountRowsForBatchTest({ providerId: 'chatgpt-web' });
    } catch {
      return 0;
    }

    if (accounts.every((row) => row.enabled !== 1)) {
      if (db) {
        emptyState = {
          db,
          writeVersion: tursoWriteVersion(db),
          untilMs: now + (isTursoDatabase(db) ? 60 * 60_000 : CHATGPT_WEB_KEEPALIVE_INTERVAL_MS),
        };
      }
      return 0;
    }
    emptyState = null;

    for (const row of accounts) {
      if (row.enabled !== 1) continue;
      try {
        const rawCredential = decrypt(row.encrypted_key, row.iv, row.auth_tag);
        const proxyUrl = resolveXGatewayAccountProxy(row);
        let currentCipher = row.encrypted_key;
        let lastPersistedHeader: string | undefined;
        const result = await withKeyProxy(proxyUrl, () =>
          rotateChatGptWebSession(rawCredential, {
            baseUrl: row.base_url || undefined,
            platform: 'custom',
            onCredentialUpdate: (next) => {
              if (updateAccountCredential(row.id, next, currentCipher)) {
                lastPersistedHeader = next;
                try {
                  currentCipher = accountRow(row.id).encrypted_key;
                } catch {
                  // Ignore if row disappeared concurrently.
                }
              }
            },
          }),
        );
        if (result.rotated) {
          if (lastPersistedHeader !== result.cookieHeader) {
            updateAccountCredential(row.id, result.cookieHeader, currentCipher);
          }
          rotatedCount++;
        }
        if (row.status !== 'healthy') {
          setAccountStatus(row.id, 'healthy');
          clearAccountCooldown(row.id);
        }
      } catch (err) {
        // One failing or expired account must not stop rotation for other accounts.
        notifyProviderAccountIssue({
          accountId: row.id,
          provider: 'chatgpt-web',
          label: row.label,
          reason: err instanceof Error ? err.message : 'ChatGPT Web cookie keep-alive rotation failed.',
        });
      }
    }

    return rotatedCount;
  })().finally(() => {
    sweepInFlight = null;
  });

  return sweepInFlight;
}

/** Start the background `chatgpt-web` session rotation timer (plus one initial boot pass). */
export function startChatGptWebKeepAlive(scheduler: Scheduler): () => void {
  const stopBoot = scheduler.after(8_000, async () => {
    await rotateChatGptWebAccountsOnce();
  });
  const stopInterval = scheduler.every(
    CHATGPT_WEB_KEEPALIVE_INTERVAL_MS,
    async () => { await rotateChatGptWebAccountsOnce(); },
    { name: 'chatgpt-web-keepalive' },
  );
  return () => {
    stopBoot();
    stopInterval();
  };
}
