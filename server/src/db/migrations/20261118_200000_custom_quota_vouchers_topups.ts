// Migration: Self-Service Quota Redeem Vouchers & 1-Click Top-Up Requests
// Created: 2026-11-18
//
// DOWN: reversible

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_quota_vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      label TEXT,
      bonus_requests_daily INTEGER NOT NULL DEFAULT 0 CHECK (bonus_requests_daily >= 0),
      bonus_tokens_daily INTEGER NOT NULL DEFAULT 0 CHECK (bonus_tokens_daily >= 0),
      bonus_requests_monthly INTEGER NOT NULL DEFAULT 0 CHECK (bonus_requests_monthly >= 0),
      bonus_tokens_monthly INTEGER NOT NULL DEFAULT 0 CHECK (bonus_tokens_monthly >= 0),
      max_redemptions INTEGER NOT NULL DEFAULT 1 CHECK (max_redemptions >= 1),
      redeemed_count INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0),
      expires_at TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS custom_quota_voucher_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL REFERENCES custom_quota_vouchers(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redeemed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (voucher_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_custom_quota_voucher_redemptions_user
      ON custom_quota_voucher_redemptions(user_id, id DESC);

    CREATE TABLE IF NOT EXISTS custom_quota_topup_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requested_tokens_daily INTEGER NOT NULL DEFAULT 0 CHECK (requested_tokens_daily >= 0),
      requested_requests_daily INTEGER NOT NULL DEFAULT 0 CHECK (requested_requests_daily >= 0),
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      admin_note TEXT,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_quota_topup_one_pending_per_user
      ON custom_quota_topup_requests(user_id) WHERE status = 'pending';

    CREATE INDEX IF NOT EXISTS idx_custom_quota_topup_status_created
      ON custom_quota_topup_requests(status, id DESC);

    CREATE INDEX IF NOT EXISTS idx_custom_quota_topup_user_created
      ON custom_quota_topup_requests(user_id, id DESC);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_custom_quota_topup_user_created;
    DROP INDEX IF EXISTS idx_custom_quota_topup_status_created;
    DROP INDEX IF EXISTS idx_custom_quota_topup_one_pending_per_user;
    DROP TABLE IF EXISTS custom_quota_topup_requests;
    DROP INDEX IF EXISTS idx_custom_quota_voucher_redemptions_user;
    DROP TABLE IF EXISTS custom_quota_voucher_redemptions;
    DROP TABLE IF EXISTS custom_quota_vouchers;
  `);
}
