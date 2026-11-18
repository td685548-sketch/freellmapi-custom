import crypto from 'node:crypto';
import type {
  ApproveTopUpRequestInput,
  ApproveTopUpRequestResponse,
  CreateQuotaVoucherInput,
  CreateTopUpRequestInput,
  QuotaTopUpRequest,
  QuotaVoucher,
  QuotaVoucherRedemption,
  QuotaVoucherStatus,
  RedeemQuotaVoucherResponse,
  RejectTopUpRequestInput,
  TopUpRequestStatus,
} from '@freellmapi/shared/quota-vouchers.js';
import type { UsageQuota } from '@freellmapi/shared/usage-quota.js';
import { getDb } from '../../db/index.js';
import {
  createUserNotification,
  notifyOperatorsWithPermission,
} from '../../services/in-app-notifications.js';
import {
  getQuotaState,
  MAX_QUOTA_VALUE,
  quotaNow,
  resetQuotaCaches,
  setQuota,
} from '../../services/usage-quotas.js';
import { assertCanManageAccount } from '../../services/users.js';

export class QuotaVoucherError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'QuotaVoucherError';
    this.status = status;
    this.code = code;
  }
}

interface VoucherDbRow {
  id: number;
  code: string;
  label: string | null;
  bonus_requests_daily: number;
  bonus_tokens_daily: number;
  bonus_requests_monthly: number;
  bonus_tokens_monthly: number;
  max_redemptions: number;
  redeemed_count: number;
  expires_at: string | null;
  active: number;
  created_by: number | null;
  creator_email: string | null;
  created_at: string;
}

interface RedemptionDbRow {
  id: number;
  voucher_id: number;
  code: string;
  label: string | null;
  user_id: number;
  bonus_requests_daily: number;
  bonus_tokens_daily: number;
  bonus_requests_monthly: number;
  bonus_tokens_monthly: number;
  redeemed_at: string;
}

interface TopUpRequestDbRow {
  id: number;
  user_id: number;
  user_email: string | null;
  requested_tokens_daily: number;
  requested_requests_daily: number;
  reason: string;
  status: TopUpRequestStatus;
  admin_note: string | null;
  reviewed_by: number | null;
  reviewer_email: string | null;
  reviewed_at: string | null;
  created_at: string;
}

interface RawUsageQuotaRow {
  daily_requests: number | null;
  daily_tokens: number | null;
  monthly_requests: number | null;
  monthly_tokens: number | null;
}

const VOUCHER_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;

export function normalizeVoucherCode(raw: string): string {
  return raw.trim().toUpperCase();
}

function generateRandomVoucherCode(): string {
  const partA = crypto.randomBytes(2).toString('hex').toUpperCase();
  const partB = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `GIFT-${partA}-${partB}`;
}

function isExpired(expiresAt: string | null, nowMs: number): boolean {
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) return false;
  return parsed <= nowMs;
}

function computeVoucherStatus(row: VoucherDbRow, nowMs: number): QuotaVoucherStatus {
  if (!row.active) return 'inactive';
  if (isExpired(row.expires_at, nowMs)) return 'expired';
  if (row.redeemed_count >= row.max_redemptions) return 'exhausted';
  return 'active';
}

function mapVoucherRow(row: VoucherDbRow, nowMs = quotaNow()): QuotaVoucher {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    bonusRequestsDaily: row.bonus_requests_daily,
    bonusTokensDaily: row.bonus_tokens_daily,
    bonusRequestsMonthly: row.bonus_requests_monthly,
    bonusTokensMonthly: row.bonus_tokens_monthly,
    maxRedemptions: row.max_redemptions,
    redeemedCount: row.redeemed_count,
    expiresAt: row.expires_at,
    active: Boolean(row.active),
    status: computeVoucherStatus(row, nowMs),
    createdBy: row.created_by,
    creatorEmail: row.creator_email ?? null,
    createdAt: row.created_at,
  };
}

function mapRedemptionRow(row: RedemptionDbRow): QuotaVoucherRedemption {
  return {
    id: row.id,
    voucherId: row.voucher_id,
    code: row.code,
    label: row.label,
    userId: row.user_id,
    bonusRequestsDaily: row.bonus_requests_daily,
    bonusTokensDaily: row.bonus_tokens_daily,
    bonusRequestsMonthly: row.bonus_requests_monthly,
    bonusTokensMonthly: row.bonus_tokens_monthly,
    redeemedAt: row.redeemed_at,
  };
}

function mapTopUpRow(row: TopUpRequestDbRow): QuotaTopUpRequest {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.user_email ? { userEmail: row.user_email } : {}),
    requestedTokensDaily: row.requested_tokens_daily,
    requestedRequestsDaily: row.requested_requests_daily,
    reason: row.reason,
    status: row.status,
    adminNote: row.admin_note,
    reviewedBy: row.reviewed_by,
    reviewerEmail: row.reviewer_email ?? null,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

function sanitizeBonusAmount(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) {
    throw new QuotaVoucherError(400, 'invalid_bonus_amount', 'Bonus amounts must be non-negative integers.');
  }
  const n = Math.floor(value);
  if (n > MAX_QUOTA_VALUE) {
    throw new QuotaVoucherError(
      400,
      'invalid_bonus_amount',
      `Bonus amounts cannot exceed ${MAX_QUOTA_VALUE.toLocaleString('en-US')}.`,
    );
  }
  return n;
}

/**
 * Stack positive bonus allowances onto a user's `custom_usage_quotas` row.
 * - If the user already has a tracked quota row (e.g. Starter Quota or custom limits),
 *   finite limits are incremented (clamped to `MAX_QUOTA_VALUE`) while explicitly
 *   unlimited (`null`) windows remain unlimited (`null`).
 * - If the user has no tracked quota row yet, a clean row is created with the
 *   positive bonus dimensions.
 */
function stackBonusAllowances(
  userId: number,
  bonus: {
    dailyRequests: number;
    dailyTokens: number;
    monthlyRequests: number;
    monthlyTokens: number;
  },
): void {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT daily_requests, daily_tokens, monthly_requests, monthly_tokens
         FROM custom_usage_quotas
        WHERE subject_kind = 'user' AND subject_id = ?`,
    )
    .get(userId) as RawUsageQuotaRow | undefined;

  const tracked = Boolean(
    row &&
      (row.daily_requests !== null ||
        row.daily_tokens !== null ||
        row.monthly_requests !== null ||
        row.monthly_tokens !== null),
  );

  const clampAdd = (base: number, delta: number): number =>
    Math.min(MAX_QUOTA_VALUE, Math.max(1, base + Math.max(0, Math.floor(delta))));

  const nextQuota: UsageQuota = tracked
    ? {
        dailyRequests:
          row!.daily_requests === null
            ? null
            : bonus.dailyRequests > 0
              ? clampAdd(row!.daily_requests, bonus.dailyRequests)
              : row!.daily_requests,
        dailyTokens:
          row!.daily_tokens === null
            ? null
            : bonus.dailyTokens > 0
              ? clampAdd(row!.daily_tokens, bonus.dailyTokens)
              : row!.daily_tokens,
        monthlyRequests:
          row!.monthly_requests === null
            ? null
            : bonus.monthlyRequests > 0
              ? clampAdd(row!.monthly_requests, bonus.monthlyRequests)
              : row!.monthly_requests,
        monthlyTokens:
          row!.monthly_tokens === null
            ? null
            : bonus.monthlyTokens > 0
              ? clampAdd(row!.monthly_tokens, bonus.monthlyTokens)
              : row!.monthly_tokens,
      }
    : {
        dailyRequests: bonus.dailyRequests > 0 ? clampAdd(0, bonus.dailyRequests) : null,
        dailyTokens: bonus.dailyTokens > 0 ? clampAdd(0, bonus.dailyTokens) : null,
        monthlyRequests: bonus.monthlyRequests > 0 ? clampAdd(0, bonus.monthlyRequests) : null,
        monthlyTokens: bonus.monthlyTokens > 0 ? clampAdd(0, bonus.monthlyTokens) : null,
      };

  setQuota('user', userId, nextQuota);
}

function getVoucherRowById(id: number): VoucherDbRow | undefined {
  return getDb()
    .prepare(
      `SELECT v.*, u.email AS creator_email
         FROM custom_quota_vouchers v
         LEFT JOIN users u ON u.id = v.created_by
        WHERE v.id = ?`,
    )
    .get(id) as VoucherDbRow | undefined;
}

export function listQuotaVouchers(): QuotaVoucher[] {
  const db = getDb();
  const nowMs = quotaNow();
  const rows = db
    .prepare(
      `SELECT v.*, u.email AS creator_email
         FROM custom_quota_vouchers v
         LEFT JOIN users u ON u.id = v.created_by
        ORDER BY v.id DESC`,
    )
    .all() as VoucherDbRow[];

  return rows.map((row) => mapVoucherRow(row, nowMs));
}

export function createQuotaVoucher(
  adminUserId: number,
  input: CreateQuotaVoucherInput,
): QuotaVoucher {
  const db = getDb();
  const nowMs = quotaNow();

  const bonusRequestsDaily = sanitizeBonusAmount(input.bonusRequestsDaily);
  const bonusTokensDaily = sanitizeBonusAmount(input.bonusTokensDaily);
  const bonusRequestsMonthly = sanitizeBonusAmount(input.bonusRequestsMonthly);
  const bonusTokensMonthly = sanitizeBonusAmount(input.bonusTokensMonthly);

  if (
    bonusRequestsDaily === 0 &&
    bonusTokensDaily === 0 &&
    bonusRequestsMonthly === 0 &&
    bonusTokensMonthly === 0
  ) {
    throw new QuotaVoucherError(
      400,
      'invalid_voucher_bonus',
      'At least one bonus quota allowance must be greater than zero.',
    );
  }

  const maxRedemptions =
    input.maxRedemptions === undefined ? 1 : Math.floor(input.maxRedemptions);
  if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1 || maxRedemptions > 100_000) {
    throw new QuotaVoucherError(
      400,
      'invalid_max_redemptions',
      'Max redemptions must be an integer between 1 and 100,000.',
    );
  }

  let expiresAtIso: string | null = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt.trim() !== '') {
    const parsedMs = Date.parse(input.expiresAt);
    if (Number.isNaN(parsedMs)) {
      throw new QuotaVoucherError(400, 'invalid_expiry', 'Invalid expiration timestamp.');
    }
    if (parsedMs <= nowMs) {
      throw new QuotaVoucherError(400, 'invalid_expiry', 'Expiration timestamp must be in the future.');
    }
    expiresAtIso = new Date(parsedMs).toISOString();
  } else if (input.expiresInDays !== undefined && input.expiresInDays !== null) {
    const days = Number(input.expiresInDays);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      throw new QuotaVoucherError(400, 'invalid_expiry', 'expiresInDays must be between 1 and 3650.');
    }
    expiresAtIso = new Date(nowMs + days * 86_400_000).toISOString();
  }

  let code: string;
  if (input.code && input.code.trim() !== '') {
    code = normalizeVoucherCode(input.code);
    if (!VOUCHER_CODE_PATTERN.test(code)) {
      throw new QuotaVoucherError(
        400,
        'invalid_voucher_code',
        'Voucher code must be 3–40 uppercase letters, digits, hyphens, or underscores.',
      );
    }
  } else {
    code = generateRandomVoucherCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      const collision = db
        .prepare('SELECT 1 FROM custom_quota_vouchers WHERE code = ?')
        .get(code);
      if (!collision) break;
      code = generateRandomVoucherCode();
    }
  }

  const existing = db
    .prepare('SELECT id FROM custom_quota_vouchers WHERE code = ?')
    .get(code) as { id: number } | undefined;
  if (existing) {
    throw new QuotaVoucherError(
      409,
      'voucher_code_exists',
      `A voucher with code '${code}' already exists.`,
    );
  }

  const label = input.label?.trim() ? input.label.trim().slice(0, 160) : null;
  const createdAt = new Date(nowMs).toISOString();

  const res = db
    .prepare(
      `INSERT INTO custom_quota_vouchers (
         code, label,
         bonus_requests_daily, bonus_tokens_daily,
         bonus_requests_monthly, bonus_tokens_monthly,
         max_redemptions, redeemed_count,
         expires_at, active, created_by, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?)`,
    )
    .run(
      code,
      label,
      bonusRequestsDaily,
      bonusTokensDaily,
      bonusRequestsMonthly,
      bonusTokensMonthly,
      maxRedemptions,
      expiresAtIso,
      adminUserId,
      createdAt,
    );

  const created = getVoucherRowById(Number(res.lastInsertRowid));
  if (!created) {
    throw new QuotaVoucherError(500, 'voucher_create_failed', 'Failed to load created voucher.');
  }
  return mapVoucherRow(created, nowMs);
}

export function setQuotaVoucherActive(id: number, active: boolean): QuotaVoucher {
  const db = getDb();
  const res = db
    .prepare('UPDATE custom_quota_vouchers SET active = ? WHERE id = ?')
    .run(active ? 1 : 0, id);
  if (res.changes === 0) {
    throw new QuotaVoucherError(404, 'voucher_not_found', 'Voucher not found.');
  }
  const updated = getVoucherRowById(id)!;
  return mapVoucherRow(updated);
}

export function revokeQuotaVoucher(id: number): QuotaVoucher {
  return setQuotaVoucherActive(id, false);
}

export function listUserVoucherRedemptions(userId: number, limit = 30): QuotaVoucherRedemption[] {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT
         r.id,
         r.voucher_id,
         v.code,
         v.label,
         r.user_id,
         v.bonus_requests_daily,
         v.bonus_tokens_daily,
         v.bonus_requests_monthly,
         v.bonus_tokens_monthly,
         r.redeemed_at
        FROM custom_quota_voucher_redemptions r
        JOIN custom_quota_vouchers v ON v.id = r.voucher_id
       WHERE r.user_id = ?
       ORDER BY r.id DESC
       LIMIT ?`,
    )
    .all(userId, safeLimit) as RedemptionDbRow[];

  return rows.map(mapRedemptionRow);
}

export function redeemQuotaVoucher(
  userId: number,
  rawCode: string,
): RedeemQuotaVoucherResponse {
  const code = normalizeVoucherCode(rawCode);
  if (!code) {
    throw new QuotaVoucherError(400, 'invalid_voucher_code', 'Please enter a voucher code.');
  }

  const db = getDb();
  const nowMs = quotaNow();
  const nowIso = new Date(nowMs).toISOString();

  let redemptionRowId = 0;
  let voucherId = 0;

  try {
    db.transaction(() => {
      const voucher = db
        .prepare(
          `SELECT v.*, u.email AS creator_email
             FROM custom_quota_vouchers v
             LEFT JOIN users u ON u.id = v.created_by
            WHERE v.code = ?`,
        )
        .get(code) as VoucherDbRow | undefined;

      if (!voucher) {
        throw new QuotaVoucherError(404, 'voucher_not_found', 'Invalid or unknown voucher code.');
      }

      if (!voucher.active) {
        throw new QuotaVoucherError(
          400,
          'voucher_inactive',
          'This voucher is inactive or has been revoked.',
        );
      }

      if (isExpired(voucher.expires_at, nowMs)) {
        throw new QuotaVoucherError(400, 'voucher_expired', 'This voucher has expired.');
      }

      const alreadyRedeemed = db
        .prepare(
          `SELECT id
             FROM custom_quota_voucher_redemptions
            WHERE voucher_id = ? AND user_id = ?`,
        )
        .get(voucher.id, userId) as { id: number } | undefined;

      if (alreadyRedeemed) {
        throw new QuotaVoucherError(
          409,
          'voucher_already_redeemed',
          'You have already redeemed this voucher.',
        );
      }

      if (voucher.redeemed_count >= voucher.max_redemptions) {
        throw new QuotaVoucherError(
          409,
          'voucher_exhausted',
          'This voucher has reached its maximum number of redemptions.',
        );
      }

      const updateRes = db
        .prepare(
          `UPDATE custom_quota_vouchers
              SET redeemed_count = redeemed_count + 1
            WHERE id = ?
              AND active = 1
              AND redeemed_count < max_redemptions`,
        )
        .run(voucher.id);

      if (updateRes.changes !== 1) {
        throw new QuotaVoucherError(
          409,
          'voucher_exhausted',
          'This voucher is no longer available for redemption.',
        );
      }

      const insertRes = db
        .prepare(
          `INSERT INTO custom_quota_voucher_redemptions (voucher_id, user_id, redeemed_at)
           VALUES (?, ?, ?)`,
        )
        .run(voucher.id, userId, nowIso);

      redemptionRowId = Number(insertRes.lastInsertRowid);
      voucherId = voucher.id;

      stackBonusAllowances(userId, {
        dailyRequests: voucher.bonus_requests_daily,
        dailyTokens: voucher.bonus_tokens_daily,
        monthlyRequests: voucher.bonus_requests_monthly,
        monthlyTokens: voucher.bonus_tokens_monthly,
      });
    })();
  } catch (err) {
    if (!(err instanceof QuotaVoucherError)) {
      resetQuotaCaches();
    }
    throw err;
  }

  const updatedVoucher = getVoucherRowById(voucherId)!;
  const redemptionRow = db
    .prepare(
      `SELECT
         r.id,
         r.voucher_id,
         v.code,
         v.label,
         r.user_id,
         v.bonus_requests_daily,
         v.bonus_tokens_daily,
         v.bonus_requests_monthly,
         v.bonus_tokens_monthly,
         r.redeemed_at
        FROM custom_quota_voucher_redemptions r
        JOIN custom_quota_vouchers v ON v.id = r.voucher_id
       WHERE r.id = ?`,
    )
    .get(redemptionRowId) as RedemptionDbRow;

  return {
    redemption: mapRedemptionRow(redemptionRow),
    voucher: mapVoucherRow(updatedVoucher, nowMs),
    quotaState: getQuotaState('user', userId),
  };
}

function getTopUpRowById(id: number): TopUpRequestDbRow | undefined {
  return getDb()
    .prepare(
      `SELECT
         r.*,
         u.email AS user_email,
         rv.email AS reviewer_email
        FROM custom_quota_topup_requests r
        JOIN users u ON u.id = r.user_id
        LEFT JOIN users rv ON rv.id = r.reviewed_by
       WHERE r.id = ?`,
    )
    .get(id) as TopUpRequestDbRow | undefined;
}

export function listUserTopUpRequests(
  userId: number,
  limit = 20,
): { requests: QuotaTopUpRequest[]; pendingRequest: QuotaTopUpRequest | null } {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT
         r.*,
         NULL AS user_email,
         rv.email AS reviewer_email
        FROM custom_quota_topup_requests r
        LEFT JOIN users rv ON rv.id = r.reviewed_by
       WHERE r.user_id = ?
       ORDER BY r.id DESC
       LIMIT ?`,
    )
    .all(userId, safeLimit) as TopUpRequestDbRow[];

  const mapped = rows.map(mapTopUpRow);
  const pendingRow = db
    .prepare(
      `SELECT
         r.*,
         NULL AS user_email,
         rv.email AS reviewer_email
        FROM custom_quota_topup_requests r
        LEFT JOIN users rv ON rv.id = r.reviewed_by
       WHERE r.user_id = ? AND r.status = 'pending'
       ORDER BY r.id DESC
       LIMIT 1`,
    )
    .get(userId) as TopUpRequestDbRow | undefined;

  return {
    requests: mapped,
    pendingRequest: pendingRow ? mapTopUpRow(pendingRow) : null,
  };
}

export function submitTopUpRequest(
  userId: number,
  userEmail: string,
  input: CreateTopUpRequestInput,
): QuotaTopUpRequest {
  const requestedTokensDaily = sanitizeBonusAmount(input.requestedTokensDaily);
  const requestedRequestsDaily = sanitizeBonusAmount(input.requestedRequestsDaily);
  const reason = (input.reason ?? '').trim().slice(0, 500);

  if (requestedTokensDaily === 0 && requestedRequestsDaily === 0) {
    throw new QuotaVoucherError(
      400,
      'invalid_topup_amount',
      'Request at least one positive daily request or daily token boost.',
    );
  }

  const db = getDb();
  const createdAt = new Date(quotaNow()).toISOString();
  let insertedId = 0;

  db.transaction(() => {
    const existingPending = db
      .prepare(
        `SELECT id
           FROM custom_quota_topup_requests
          WHERE user_id = ? AND status = 'pending'
          LIMIT 1`,
      )
      .get(userId) as { id: number } | undefined;

    if (existingPending) {
      throw new QuotaVoucherError(
        409,
        'pending_topup_exists',
        'You already have a pending quota top-up request awaiting review.',
      );
    }

    try {
      const res = db
        .prepare(
          `INSERT INTO custom_quota_topup_requests (
             user_id, requested_tokens_daily, requested_requests_daily, reason, status, created_at
           )
           VALUES (?, ?, ?, ?, 'pending', ?)`,
        )
        .run(userId, requestedTokensDaily, requestedRequestsDaily, reason, createdAt);
      insertedId = Number(res.lastInsertRowid);
    } catch (err: any) {
      if (String(err?.message ?? '').includes('UNIQUE')) {
        throw new QuotaVoucherError(
          409,
          'pending_topup_exists',
          'You already have a pending quota top-up request awaiting review.',
        );
      }
      throw err;
    }
  })();

  const parts: string[] = [];
  if (requestedRequestsDaily > 0) parts.push(`+${requestedRequestsDaily.toLocaleString('en-US')} req/day`);
  if (requestedTokensDaily > 0) parts.push(`+${requestedTokensDaily.toLocaleString('en-US')} tok/day`);

  notifyOperatorsWithPermission('edit_user_quotas', {
    category: 'quota',
    severity: 'info',
    title: `Quota top-up request from ${userEmail}`,
    body: `${userEmail} requested ${parts.join(' & ')}${reason ? ` — "${reason}"` : '.'}`,
    actionUrl: '/invites',
    dedupeKey: `quota-topup-submitted:${insertedId}`,
  });

  const created = getTopUpRowById(insertedId)!;
  return mapTopUpRow(created);
}

export function listAdminTopUpRequests(options?: {
  status?: TopUpRequestStatus | 'all';
  limit?: number;
}): { requests: QuotaTopUpRequest[]; pendingCount: number } {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(100, Math.floor(options?.limit ?? 50)));
  const filterStatus = options?.status && options.status !== 'all' ? options.status : null;

  const rows = filterStatus
    ? (db
        .prepare(
          `SELECT
             r.*,
             u.email AS user_email,
             rv.email AS reviewer_email
            FROM custom_quota_topup_requests r
            JOIN users u ON u.id = r.user_id
            LEFT JOIN users rv ON rv.id = r.reviewed_by
           WHERE r.status = ?
           ORDER BY r.id DESC
           LIMIT ?`,
        )
        .all(filterStatus, safeLimit) as TopUpRequestDbRow[])
    : (db
        .prepare(
          `SELECT
             r.*,
             u.email AS user_email,
             rv.email AS reviewer_email
            FROM custom_quota_topup_requests r
            JOIN users u ON u.id = r.user_id
            LEFT JOIN users rv ON rv.id = r.reviewed_by
           ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END ASC, r.id DESC
           LIMIT ?`,
        )
        .all(safeLimit) as TopUpRequestDbRow[]);

  const pendingRow = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM custom_quota_topup_requests
        WHERE status = 'pending'`,
    )
    .get() as { count: number } | undefined;

  return {
    requests: rows.map(mapTopUpRow),
    pendingCount: pendingRow?.count ?? 0,
  };
}

export function approveTopUpRequest(
  requestId: number,
  reviewerUserId: number,
  input: ApproveTopUpRequestInput = {},
): ApproveTopUpRequestResponse {
  const db = getDb();
  const existing = getTopUpRowById(requestId);
  if (!existing) {
    throw new QuotaVoucherError(404, 'topup_not_found', 'Top-up request not found.');
  }

  try {
    assertCanManageAccount(existing.user_id, reviewerUserId);
  } catch (err: any) {
    throw new QuotaVoucherError(
      403,
      'insufficient_privileges',
      err?.message || 'Insufficient privileges to modify this account.',
    );
  }

  const grantedTokensDaily =
    input.grantedTokensDaily === undefined
      ? existing.requested_tokens_daily
      : sanitizeBonusAmount(input.grantedTokensDaily);
  const grantedRequestsDaily =
    input.grantedRequestsDaily === undefined
      ? existing.requested_requests_daily
      : sanitizeBonusAmount(input.grantedRequestsDaily);
  const grantedTokensMonthly = sanitizeBonusAmount(input.grantedTokensMonthly);
  const grantedRequestsMonthly = sanitizeBonusAmount(input.grantedRequestsMonthly);

  if (
    grantedTokensDaily === 0 &&
    grantedRequestsDaily === 0 &&
    grantedTokensMonthly === 0 &&
    grantedRequestsMonthly === 0
  ) {
    throw new QuotaVoucherError(
      400,
      'invalid_grant_amount',
      'At least one granted allowance must be greater than zero.',
    );
  }

  const adminNote = input.adminNote?.trim() ? input.adminNote.trim().slice(0, 500) : null;
  const reviewedAt = new Date(quotaNow()).toISOString();

  const summaryParts: string[] = [];
  if (grantedRequestsDaily > 0) summaryParts.push(`+${grantedRequestsDaily.toLocaleString('en-US')} daily requests`);
  if (grantedTokensDaily > 0) summaryParts.push(`+${grantedTokensDaily.toLocaleString('en-US')} daily tokens`);
  if (grantedRequestsMonthly > 0) summaryParts.push(`+${grantedRequestsMonthly.toLocaleString('en-US')} monthly requests`);
  if (grantedTokensMonthly > 0) summaryParts.push(`+${grantedTokensMonthly.toLocaleString('en-US')} monthly tokens`);

  try {
    db.transaction(() => {
      const updateRes = db
        .prepare(
          `UPDATE custom_quota_topup_requests
              SET status = 'approved',
                  admin_note = ?,
                  reviewed_by = ?,
                  reviewed_at = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(adminNote, reviewerUserId, reviewedAt, requestId);

      if (updateRes.changes !== 1) {
        throw new QuotaVoucherError(
          409,
          'topup_already_reviewed',
          'This top-up request has already been reviewed.',
        );
      }

      stackBonusAllowances(existing.user_id, {
        dailyRequests: grantedRequestsDaily,
        dailyTokens: grantedTokensDaily,
        monthlyRequests: grantedRequestsMonthly,
        monthlyTokens: grantedTokensMonthly,
      });

      createUserNotification({
        userId: existing.user_id,
        category: 'quota',
        severity: 'info',
        title: 'Quota top-up approved',
        body: `Your quota top-up request was approved (${summaryParts.join(', ')}).${adminNote ? ` Note: ${adminNote}` : ''}`,
        actionUrl: '/keys',
        dedupeKey: `quota-topup-approved:${requestId}`,
      });
    })();
  } catch (err) {
    if (!(err instanceof QuotaVoucherError)) {
      resetQuotaCaches();
    }
    throw err;
  }

  const updated = getTopUpRowById(requestId)!;
  return {
    request: mapTopUpRow(updated),
    granted: {
      dailyRequests: grantedRequestsDaily,
      dailyTokens: grantedTokensDaily,
      monthlyRequests: grantedRequestsMonthly,
      monthlyTokens: grantedTokensMonthly,
    },
    quotaState: getQuotaState('user', existing.user_id),
  };
}

export function rejectTopUpRequest(
  requestId: number,
  reviewerUserId: number,
  input: RejectTopUpRequestInput = {},
): QuotaTopUpRequest {
  const db = getDb();
  const existing = getTopUpRowById(requestId);
  if (!existing) {
    throw new QuotaVoucherError(404, 'topup_not_found', 'Top-up request not found.');
  }

  try {
    assertCanManageAccount(existing.user_id, reviewerUserId);
  } catch (err: any) {
    throw new QuotaVoucherError(
      403,
      'insufficient_privileges',
      err?.message || 'Insufficient privileges to review this account.',
    );
  }

  const adminNote = input.adminNote?.trim() ? input.adminNote.trim().slice(0, 500) : null;
  const reviewedAt = new Date(quotaNow()).toISOString();

  db.transaction(() => {
    const updateRes = db
      .prepare(
        `UPDATE custom_quota_topup_requests
            SET status = 'rejected',
                admin_note = ?,
                reviewed_by = ?,
                reviewed_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(adminNote, reviewerUserId, reviewedAt, requestId);

    if (updateRes.changes !== 1) {
      throw new QuotaVoucherError(
        409,
        'topup_already_reviewed',
        'This top-up request has already been reviewed.',
      );
    }

    createUserNotification({
      userId: existing.user_id,
      category: 'quota',
      severity: 'warning',
      title: 'Quota top-up request declined',
      body: adminNote
        ? `Your quota top-up request was declined: ${adminNote}`
        : 'Your quota top-up request was declined by an administrator.',
      actionUrl: '/keys',
      dedupeKey: `quota-topup-rejected:${requestId}`,
    });
  })();

  const updated = getTopUpRowById(requestId)!;
  return mapTopUpRow(updated);
}
