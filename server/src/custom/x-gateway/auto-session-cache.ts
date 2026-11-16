/**
 * Bounded per-session route cache for Thruline `auto` mode (9Router `comboSessionModelStore` pattern).
 *
 * Once `auto` selects a healthy `(providerId, accountId, modelId)` for a session, subsequent turns
 * reuse it directly with zero re-routing overhead. Entries expire after 1 hour of inactivity and are
 * evicted immediately on error, cooldown, or empty stream.
 */

export const AUTO_SESSION_TTL_MS = 60 * 60_000;
export const MAX_AUTO_SESSIONS = 2_000;

export interface AutoSessionEntry {
  sessionId: string;
  modality: string;
  providerId: string;
  accountId: number;
  modelId: string;
  pinnedAt: number;
  lastUsedAt: number;
  dbRef: unknown;
}

const autoSessionStore = new Map<string, AutoSessionEntry>();

function makeKey(sessionId: string, modality: string): string {
  return `${modality}:${sessionId}`;
}

function pruneExpiredAndOverflow(now: number): void {
  for (const [key, entry] of autoSessionStore) {
    if (now - entry.lastUsedAt > AUTO_SESSION_TTL_MS) {
      autoSessionStore.delete(key);
    }
  }
  if (autoSessionStore.size <= MAX_AUTO_SESSIONS) return;
  const oldest = [...autoSessionStore.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  for (let i = 0; i < oldest.length - MAX_AUTO_SESSIONS; i += 1) {
    autoSessionStore.delete(oldest[i][0]);
  }
}

export function getAutoSessionRoute(
  sessionId: string,
  modality: string,
  dbRef: unknown,
  now = Date.now(),
): AutoSessionEntry | undefined {
  if (!sessionId) return undefined;
  const key = makeKey(sessionId, modality);
  const entry = autoSessionStore.get(key);
  if (!entry) return undefined;
  if (entry.dbRef !== dbRef || now - entry.lastUsedAt > AUTO_SESSION_TTL_MS) {
    autoSessionStore.delete(key);
    return undefined;
  }
  entry.lastUsedAt = now;
  return entry;
}

export function setAutoSessionRoute(
  sessionId: string,
  modality: string,
  route: { providerId: string; accountId: number; modelId: string },
  dbRef: unknown,
  now = Date.now(),
): void {
  if (!sessionId) return;
  pruneExpiredAndOverflow(now);
  const key = makeKey(sessionId, modality);
  const existing = autoSessionStore.get(key);
  autoSessionStore.set(key, {
    sessionId,
    modality,
    providerId: route.providerId,
    accountId: route.accountId,
    modelId: route.modelId,
    pinnedAt: existing && existing.dbRef === dbRef ? existing.pinnedAt : now,
    lastUsedAt: now,
    dbRef,
  });
}

export function clearAutoSessionRoute(sessionId: string, modality?: string): void {
  if (!sessionId) return;
  if (modality !== undefined) {
    autoSessionStore.delete(makeKey(sessionId, modality));
    return;
  }
  for (const [key, entry] of autoSessionStore) {
    if (entry.sessionId === sessionId) {
      autoSessionStore.delete(key);
    }
  }
}

export function resetAutoSessionCache(): void {
  autoSessionStore.clear();
}
