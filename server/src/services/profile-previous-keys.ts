import { getDb } from '../db/index.js';

// Keys a client profile rotated away from, still accepted until their grace period ends. Looked up by
// the same SHA-256 the current key is stored under, and only when that lookup missed, so a request with
// the current key never pays for this.

export const MAX_PREVIOUS_KEYS = 5;
export const MAX_GRACE_HOURS = 168;

export interface PreviousKey { keyHint: string; expiresAt: string; createdAt: string }

/** The profile a still-valid previous key belongs to, or undefined. */
export function profileIdForPreviousKey(tokenHash: string, now: number = Date.now()): number | undefined {
  const row = getDb()
    .prepare('SELECT profile_id AS id FROM custom_profile_previous_keys WHERE token_hash = ? AND expires_at_ms > ?')
    .get(tokenHash, now) as { id: number } | undefined;
  return row?.id;
}

/** Keep `tokenHash` working for `graceHours`, then forget it; trims the profile to its newest keys. */
export function keepPreviousKey(profileId: number, tokenHash: string, keyHint: string, graceHours: number, now: number = Date.now()): Date {
  const db = getDb();
  const expires = now + graceHours * 3_600_000;
  db.prepare(`
    INSERT INTO custom_profile_previous_keys (token_hash, profile_id, key_hint, expires_at_ms) VALUES (?, ?, ?, ?)
    ON CONFLICT(token_hash) DO UPDATE SET profile_id = excluded.profile_id, key_hint = excluded.key_hint, expires_at_ms = excluded.expires_at_ms
  `).run(tokenHash, profileId, keyHint, expires);
  db.prepare(`
    DELETE FROM custom_profile_previous_keys
    WHERE profile_id = ? AND (expires_at_ms <= ? OR token_hash NOT IN (
      SELECT token_hash FROM custom_profile_previous_keys WHERE profile_id = ? ORDER BY expires_at_ms DESC LIMIT ?
    ))
  `).run(profileId, now, profileId, MAX_PREVIOUS_KEYS);
  return new Date(expires);
}

export function listPreviousKeys(profileId: number, now: number = Date.now()): PreviousKey[] {
  const rows = getDb().prepare(`
    SELECT key_hint AS keyHint, expires_at_ms AS expiresAtMs, created_at AS createdAt
    FROM custom_profile_previous_keys WHERE profile_id = ? AND expires_at_ms > ? ORDER BY expires_at_ms DESC
  `).all(profileId, now) as Array<{ keyHint: string; expiresAtMs: number; createdAt: string }>;
  return rows.map(r => ({ keyHint: r.keyHint, expiresAt: new Date(r.expiresAtMs).toISOString(), createdAt: r.createdAt }));
}

/** End every grace period of a profile now. Returns how many keys stopped working. */
export function revokePreviousKeys(profileId: number, now: number = Date.now()): number {
  const live = listPreviousKeys(profileId, now).length;
  getDb().prepare('DELETE FROM custom_profile_previous_keys WHERE profile_id = ?').run(profileId);
  return live;
}
