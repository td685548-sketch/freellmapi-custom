// Migration: URL-token expiry (Wave 2 P1)
//
// URL tokens minted before this migration have no expiry (expires_at NULL)
// and keep working until revoked — revoking them on upgrade would silently
// break every headerless client already deployed with one. Tokens minted
// after it always carry expires_at (default 90 days, URL_TOKEN_TTL_DAYS),
// enforced by validateUrlToken() in server/src/services/url-tokens.ts.
//
// DOWN: reversible (drops the column + index; previously minted tokens keep
// working, they just lose their recorded expiry).

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(entry => entry.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'url_tokens', 'expires_at')) {
    db.prepare('ALTER TABLE url_tokens ADD COLUMN expires_at TEXT').run();
  }
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_url_tokens_expires_at ON url_tokens(expires_at)',
  ).run();
}

export function down(db: Db): void {
  db.prepare('DROP INDEX IF EXISTS idx_url_tokens_expires_at').run();
  if (hasColumn(db, 'url_tokens', 'expires_at')) {
    db.prepare('ALTER TABLE url_tokens DROP COLUMN expires_at').run();
  }
}
