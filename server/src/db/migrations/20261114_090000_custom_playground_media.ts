// Migration: cached provider images for the Playground
// Created: 2026-11-14
//
// DOWN: reversible
//
// Gemini Web only ever puts a placeholder link in the reply text; the actual
// picture sits on Google's CDN behind the account's cookies and the console's
// CSP (`img-src 'self' data:`) refuses cross-origin images anyway. The stream
// handler therefore downloads each image once, with the same cookie it already
// uses for the conversation, and hands the chat a same-origin URL.
//
// The bytes live here rather than on disk so a single-file backup or a
// container with a read-only filesystem keeps working, and so the row can be
// expired with the rest of the data. `id` is an unguessable random token: the
// route that serves it cannot require the dashboard session, because an <img>
// tag sends no Authorization header, so the id itself is the capability.
// expires_at_ms keeps a generated picture reachable for a week, long enough to
// reload an old conversation, short enough that the table cannot grow forever.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS playground_media (
      id TEXT PRIMARY KEY,
      content_type TEXT NOT NULL,
      bytes BLOB NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );

    -- Sweeping expired rows scans by expiry; the id is already the key.
    CREATE INDEX IF NOT EXISTS idx_playground_media_expires
      ON playground_media(expires_at_ms);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_playground_media_expires;
    DROP TABLE IF EXISTS playground_media;
  `);
}
