import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/requireAuth.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import type { SessionUser } from '../../services/auth.js';
import { isGuestRequest } from '../../services/guest-access.js';
import { MAX_QUOTA_VALUE } from '../../services/usage-quotas.js';
import { requireActionPermission } from '../permission-actions.js';
import {
  approveTopUpRequest,
  createQuotaVoucher,
  listAdminTopUpRequests,
  listQuotaVouchers,
  listUserTopUpRequests,
  listUserVoucherRedemptions,
  QuotaVoucherError,
  redeemQuotaVoucher,
  rejectTopUpRequest,
  revokeQuotaVoucher,
  setQuotaVoucherActive,
  submitTopUpRequest,
} from './service.js';

export const quotaVouchersRouter = Router();

function requireSignedInAccount(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    const user = (req as Request & { user?: SessionUser }).user;
    if (isGuestRequest(req) || !user || !user.userId) {
      res.status(401).json({
        error: { message: 'Authentication required', type: 'authentication_error' },
      });
      return;
    }
    next();
  });
}

type AdminActionScope = 'read' | 'create_voucher' | 'toggle_voucher' | 'review_topup';

/**
 * Enforces `manage_invites` OR `manage_users` (plus matching leaf capabilities)
 * directly inside this custom router so `PERMISSION_GATES` in `register.ts`
 * remains completely untouched.
 */
function requireQuotaVoucherAdmin(scope: AdminActionScope) {
  const fallbackGate =
    scope === 'review_topup'
      ? requireActionPermission('manage_users')
      : requireActionPermission('manage_invites');

  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: SessionUser }).user;
    if (isGuestRequest(req) || !user || !user.userId) {
      res.status(401).json({
        error: { message: 'Authentication required', type: 'authentication_error' },
      });
      return;
    }

    const hasParent =
      hasPermission(user, 'manage_invites') || hasPermission(user, 'manage_users');
    const hasScopedLeaf =
      (scope === 'read' &&
        (hasPermission(user, 'view_invites') ||
          hasPermission(user, 'view_users') ||
          hasPermission(user, 'edit_user_quotas'))) ||
      (scope === 'create_voucher' &&
        (hasPermission(user, 'create_invites') ||
          hasPermission(user, 'edit_user_quotas'))) ||
      (scope === 'toggle_voucher' &&
        (hasPermission(user, 'revoke_invites') ||
          hasPermission(user, 'edit_user_quotas'))) ||
      (scope === 'review_topup' && hasPermission(user, 'edit_user_quotas'));

    if (hasParent || hasScopedLeaf) {
      next();
      return;
    }

    fallbackGate(req, res, next);
  };
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof QuotaVoucherError) {
    res.status(err.status).json({
      error: {
        message: err.message,
        type: err.code,
        code: err.code,
      },
    });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unexpected server error';
  res.status(500).json({ error: { message, type: 'internal_error' } });
}

function parsePositiveId(req: Request, res: Response): number | null {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid ID', type: 'invalid_id' } });
    return null;
  }
  return id;
}

const bonusField = z.number().int().min(0).max(MAX_QUOTA_VALUE).optional();

const createVoucherSchema = z
  .object({
    code: z.string().trim().max(40).optional(),
    label: z.string().trim().max(160).nullable().optional(),
    bonusRequestsDaily: bonusField,
    bonusTokensDaily: bonusField,
    bonusRequestsMonthly: bonusField,
    bonusTokensMonthly: bonusField,
    maxRedemptions: z.number().int().min(1).max(100_000).optional(),
    expiresAt: z.string().trim().nullable().optional(),
    expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  })
  .strict();

const toggleVoucherSchema = z
  .object({
    active: z.boolean(),
  })
  .strict();

const redeemSchema = z
  .object({
    code: z.string().trim().min(1, 'Voucher code is required').max(64),
  })
  .strict();

const submitTopUpSchema = z
  .object({
    requestedTokensDaily: bonusField,
    requestedRequestsDaily: bonusField,
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

const approveTopUpSchema = z
  .object({
    grantedTokensDaily: bonusField,
    grantedRequestsDaily: bonusField,
    grantedTokensMonthly: bonusField,
    grantedRequestsMonthly: bonusField,
    adminNote: z.string().trim().max(500).optional(),
  })
  .strict();

const rejectTopUpSchema = z
  .object({
    adminNote: z.string().trim().max(500).optional(),
  })
  .strict();

quotaVouchersRouter.use(requireSignedInAccount);

// ─── Member Self-Service Voucher Redemption ─────────────────────────────────

quotaVouchersRouter.post('/redeem', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const parsed = redeemSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.issues.map((i) => i.message).join(', '),
        type: 'invalid_request',
      },
    });
    return;
  }

  try {
    const result = redeemQuotaVoucher(user.userId, parsed.data.code);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

quotaVouchersRouter.get('/redemptions/mine', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  try {
    res.json({ redemptions: listUserVoucherRedemptions(user.userId) });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── Member 1-Click Top-Up Requests ─────────────────────────────────────────

quotaVouchersRouter.get('/topup-requests/mine', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  try {
    res.json(listUserTopUpRequests(user.userId));
  } catch (err) {
    sendError(res, err);
  }
});

quotaVouchersRouter.post('/topup-requests', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const parsed = submitTopUpSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.issues.map((i) => i.message).join(', '),
        type: 'invalid_request',
      },
    });
    return;
  }

  try {
    const created = submitTopUpRequest(user.userId, user.email, parsed.data);
    res.status(201).json({ request: created });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── Admin Voucher Management (`manage_invites` or `manage_users`) ──────────

quotaVouchersRouter.get(
  '/vouchers',
  requireQuotaVoucherAdmin('read'),
  (_req: Request, res: Response) => {
    try {
      res.json({ vouchers: listQuotaVouchers() });
    } catch (err) {
      sendError(res, err);
    }
  },
);

quotaVouchersRouter.post(
  '/vouchers',
  requireQuotaVoucherAdmin('create_voucher'),
  (req: Request, res: Response) => {
    const user = (req as Request & { user?: SessionUser }).user!;
    const parsed = createVoucherSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: {
          message: parsed.error.issues.map((i) => i.message).join(', '),
          type: 'invalid_request',
        },
      });
      return;
    }

    try {
      const voucher = createQuotaVoucher(user.userId, parsed.data);
      res.status(201).json({ voucher });
    } catch (err) {
      sendError(res, err);
    }
  },
);

quotaVouchersRouter.patch(
  '/vouchers/:id',
  requireQuotaVoucherAdmin('toggle_voucher'),
  (req: Request, res: Response) => {
    const id = parsePositiveId(req, res);
    if (id === null) return;
    const parsed = toggleVoucherSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: {
          message: parsed.error.issues.map((i) => i.message).join(', '),
          type: 'invalid_request',
        },
      });
      return;
    }

    try {
      const voucher = setQuotaVoucherActive(id, parsed.data.active);
      res.json({ voucher });
    } catch (err) {
      sendError(res, err);
    }
  },
);

quotaVouchersRouter.delete(
  '/vouchers/:id',
  requireQuotaVoucherAdmin('toggle_voucher'),
  (req: Request, res: Response) => {
    const id = parsePositiveId(req, res);
    if (id === null) return;

    try {
      const voucher = revokeQuotaVoucher(id);
      res.json({ success: true, voucher });
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── Admin 1-Click Top-Up Request Review (`manage_users` or `manage_invites`) ─

quotaVouchersRouter.get(
  '/topup-requests',
  requireQuotaVoucherAdmin('read'),
  (req: Request, res: Response) => {
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : 'all';
    const status =
      rawStatus === 'pending' || rawStatus === 'approved' || rawStatus === 'rejected'
        ? rawStatus
        : 'all';
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
    const limit = Number.isFinite(rawLimit) ? rawLimit : 50;

    try {
      res.json(listAdminTopUpRequests({ status, limit }));
    } catch (err) {
      sendError(res, err);
    }
  },
);

quotaVouchersRouter.post(
  '/topup-requests/:id/approve',
  requireQuotaVoucherAdmin('review_topup'),
  (req: Request, res: Response) => {
    const id = parsePositiveId(req, res);
    if (id === null) return;
    const user = (req as Request & { user?: SessionUser }).user!;
    const parsed = approveTopUpSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: {
          message: parsed.error.issues.map((i) => i.message).join(', '),
          type: 'invalid_request',
        },
      });
      return;
    }

    try {
      const result = approveTopUpRequest(id, user.userId, parsed.data);
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  },
);

quotaVouchersRouter.post(
  '/topup-requests/:id/reject',
  requireQuotaVoucherAdmin('review_topup'),
  (req: Request, res: Response) => {
    const id = parsePositiveId(req, res);
    if (id === null) return;
    const user = (req as Request & { user?: SessionUser }).user!;
    const parsed = rejectTopUpSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: {
          message: parsed.error.issues.map((i) => i.message).join(', '),
          type: 'invalid_request',
        },
      });
      return;
    }

    try {
      const request = rejectTopUpRequest(id, user.userId, parsed.data);
      res.json({ request });
    } catch (err) {
      sendError(res, err);
    }
  },
);
