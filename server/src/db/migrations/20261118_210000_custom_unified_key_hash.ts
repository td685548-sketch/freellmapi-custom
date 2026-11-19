// Migration: store the unified API key as a SHA-256 hash, not plaintext
// Created: 2026-11-18
//
// The unified key used to live in the settings table as recoverable plaintext
// (`unified_api_key`), so anyone who could read the database file owned the
// whole /v1 surface. Like client-profile and user keys, only its SHA-256
// digest is stored now (`unified_api_key_hash`, plus a non-secret display
// prefix in `unified_api_key_prefix`). The plaintext is shown exactly once,
// as the return value of regenerateUnifiedKey().
//
// UP: if a legacy plaintext row exists, hash it in place and delete it. If
// neither a legacy row nor a hash row exists (a database whose baseline never
// seeded a key), mint a fresh key and store only its hash — the value is
// unknowable afterwards, so the operator regenerates one from the Keys page.
// The conversion runs inside the runner's transaction with the migrations-row
// insert, so a failure leaves the plaintext row untouched.
//
// DOWN: irreversible by design — a hash cannot be turned back into the key.
// Rolling back deletes the hash rows, leaving no unified key at all; the
// operator must regenerate one from the Keys page before /v1 works again.
// This is stated here so the rollback is a deliberate act, not a surprise.
// (The roundtrip test normalizes these two settings values when comparing
// snapshots: the re-minted key after down+up is a fresh random secret, so
// its value cannot match the original — only its presence and shape can.)

import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../types.js';

const LEGACY_KEY = 'unified_api_key';
const HASH_KEY = 'unified_api_key_hash';
const PREFIX_KEY = 'unified_api_key_prefix';

function prefixOf(key: string): string {
  return key.length > 15 ? `${key.slice(0, 11)}…${key.slice(-4)}` : `${key.slice(0, 4)}…`;
}

export function up(db: Db): void {
  const get = (key: string): string | undefined => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  };
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const legacy = get(LEGACY_KEY);
  if (legacy) {
    upsert.run(HASH_KEY, createHash('sha256').update(legacy).digest('hex'));
    upsert.run(PREFIX_KEY, prefixOf(legacy));
    db.prepare('DELETE FROM settings WHERE key = ?').run(LEGACY_KEY);
    return;
  }

  if (!get(HASH_KEY)) {
    const key = `freellmapi-${randomBytes(24).toString('hex')}`;
    upsert.run(HASH_KEY, createHash('sha256').update(key).digest('hex'));
    upsert.run(PREFIX_KEY, prefixOf(key));
  }
}

export function down(db: Db): void {
  // The plaintext is unrecoverable from the hash, so a rollback cannot restore
  // the previous key — it only removes the hashed credential. Regenerate a new
  // key from the Keys page (POST /api/settings/api-key/regenerate) afterwards.
  db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(HASH_KEY, PREFIX_KEY);
}
