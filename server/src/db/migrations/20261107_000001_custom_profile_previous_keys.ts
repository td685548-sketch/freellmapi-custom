// Migration: keys a client profile rotated away from, kept working for a grace period
// Created: 2026-11-07
//
// DOWN: reversible
//
// Rotating a client profile's key used to kill the old key at once, so the web app using it broke until
// its environment variable was changed. A rotation with a grace period moves the old key here: it keeps
// authenticating as the same profile until `expires_at_ms`, then stops. Only the SHA-256 of the key is
// stored (as for the current key) plus a masked hint for the dashboard.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_profile_previous_keys (
      token_hash TEXT PRIMARY KEY,
      profile_id INTEGER NOT NULL,
      key_hint TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_custom_profile_previous_keys_profile ON custom_profile_previous_keys(profile_id);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS custom_profile_previous_keys;');
}
