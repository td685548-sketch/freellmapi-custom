import type { Db } from '../types.js';

/**
 * Migration: request_attempts.ttfb_ms — per-attempt time-to-first-byte.
 *
 * The fallback loop already records one trace row per dispatched attempt
 * (start_offset_ms / duration_ms), but duration covers the whole attempt —
 * for a successful stream that includes minutes of streaming, so it says
 * nothing about how long the attempt took to produce its FIRST byte. The
 * per-attempt TTFB is what the adaptive fallback budget (lib/ttfb-budget.ts)
 * actually reasons about, and until now it only existed on the terminal
 * `requests` row, not per hop.
 *
 * The loop stamps it from the first disarmHedge() call — the moment the
 * dispatch proved the attempt alive (first byte / headers flushed). NULL
 * when the attempt died before any first byte, or for non-streaming
 * attempts, which never disarm the hedge (their TTFB lives on the
 * `requests` row instead).
 */
export function up(db: Db): void {
  const columns = db.prepare(`PRAGMA table_info(request_attempts)`).all() as { name: string }[];
  if (!columns.some((c) => c.name === 'ttfb_ms')) {
    db.prepare('ALTER TABLE request_attempts ADD COLUMN ttfb_ms INTEGER').run();
  }
}

export function down(db: Db): void {
  const columns = db.prepare(`PRAGMA table_info(request_attempts)`).all() as { name: string }[];
  if (columns.some((c) => c.name === 'ttfb_ms')) {
    db.prepare('ALTER TABLE request_attempts DROP COLUMN ttfb_ms').run();
  }
}
