import { getDb } from '../../db/index.js';

// Individual settings rows avoid losing concurrent updates for different models.
const PREFIX = 'x_opencode_unavailable_';
const CACHE_MS = 5_000;
let cacheDb: unknown;
let cacheUntil = 0;
let cache: Array<{ accountId: number; modelId: string }> = [];
const keyFor = (accountId: number, modelId: string) =>
  `${PREFIX}${accountId}_${Buffer.from(modelId).toString('base64url')}`;

export function rememberUnavailableOpenCodeModel(accountId: number, modelId: string): void {
  getDb().prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(keyFor(accountId, modelId), JSON.stringify({ accountId, modelId }));
  cacheUntil = 0;
}

export function listUnavailableOpenCodeModels(): Array<{ accountId: number; modelId: string }> {
  try {
    const db = getDb();
    if (cacheDb === db && Date.now() < cacheUntil) return [...cache];
    const rows = db.prepare('SELECT value FROM settings WHERE substr(key, 1, ?) = ?').all(PREFIX.length, PREFIX) as Array<{ value: string }>;
    cache = rows.flatMap(row => {
      try {
        const value = JSON.parse(row.value) as { accountId?: unknown; modelId?: unknown };
        return Number.isSafeInteger(value.accountId) && typeof value.modelId === 'string' && value.modelId
          ? [{ accountId: value.accountId as number, modelId: value.modelId }] : [];
      } catch { return []; }
    });
    cacheDb = db;
    cacheUntil = Date.now() + CACHE_MS;
    return [...cache];
  } catch { return []; }
}

export function clearUnavailableOpenCodeModels(accountId: number, modelId?: string, force = false): void {
  try {
    if (!force && !listUnavailableOpenCodeModels().some(entry => entry.accountId === accountId
      && (modelId === undefined || entry.modelId === modelId))) return;
    const db = getDb();
    if (modelId !== undefined) db.prepare('DELETE FROM settings WHERE key = ?').run(keyFor(accountId, modelId));
    else {
      const prefix = `${PREFIX}${accountId}_`;
      db.prepare('DELETE FROM settings WHERE substr(key, 1, ?) = ?').run(prefix.length, prefix);
    }
    cacheUntil = 0;
  } catch { /* The in-memory cooldown remains usable when the database is unavailable. */ }
}
