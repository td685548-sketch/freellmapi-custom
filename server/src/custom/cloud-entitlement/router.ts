import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { hasPermission } from '../../middleware/requirePermission.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import type { SessionUser } from '../../services/auth.js';
import { isGuestRequest } from '../../services/guest-access.js';
import {
  activateWithToken,
  checkActivationRequestApproval,
  clearSavedActivationToken,
  CloudEntitlementError,
  getCloudEntitlementStatus,
  submitActivationRequest,
} from './service.js';

export const aiEntitlementRouter = Router();

function canUserManageEntitlement(req: Request): boolean {
  if (isGuestRequest(req)) return false;
  const user = (req as Request & { user?: SessionUser }).user;
  if (!user) return false;
  return user.role === 'admin' || hasPermission(user, 'manage_settings');
}

function requireEntitlementAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!canUserManageEntitlement(req)) {
    res.status(403).json({
      error: {
        code: 'missing_permission',
        type: 'forbidden',
        message: 'Administrator access is required to manage AI module activation.',
      },
    });
    return;
  }
  next();
}

function resolveRequestOrigin(req: Request): string {
  const originHeader = req.headers.origin;
  if (typeof originHeader === 'string' && originHeader.trim()) {
    return originHeader.trim().slice(0, 200);
  }
  const host = req.headers.host;
  if (typeof host === 'string' && host.trim()) {
    const proto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    return `${proto}://${host.trim()}`.slice(0, 200);
  }
  return '';
}

function sendEntitlementError(res: Response, err: unknown): void {
  if (err instanceof CloudEntitlementError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        type: 'entitlement_error',
        state: err.state,
        message: err.message,
      },
    });
    return;
  }
  res.status(500).json({
    error: {
      code: 'internal_error',
      type: 'internal_error',
      message: err instanceof Error ? err.message : 'Unexpected server error.',
    },
  });
}

// Accessible to signed-in sessions AND guest sessions (returns minimal safe boolean for guests)
aiEntitlementRouter.get('/status', async (req: Request, res: Response) => {
  try {
    if (!isGuestRequest(req) && !(req as Request & { user?: SessionUser }).user) {
      // Run standard requireAuth when not already populated by guestAccessMiddleware
      await new Promise<void>((resolve, reject) => {
        requireAuth(req, res, (err?: unknown) => {
          if (err) reject(err);
          else resolve();
        });
      });
      if (res.headersSent) return;
    }
    const canManage = canUserManageEntitlement(req);
    const status = await getCloudEntitlementStatus({ canManage });
    res.json(status);
  } catch (err) {
    sendEntitlementError(res, err);
  }
});

const activateBodySchema = z
  .object({
    token: z.string().trim().min(12).max(256),
  })
  .strict();

aiEntitlementRouter.post(
  '/activate',
  requireAuth,
  requireEntitlementAdmin,
  async (req: Request, res: Response) => {
    const parsed = activateBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'invalid_request',
          type: 'invalid_request',
          message: 'Please enter a valid activation token.',
        },
      });
      return;
    }

    try {
      await activateWithToken(parsed.data.token, resolveRequestOrigin(req));
      const status = await getCloudEntitlementStatus({ canManage: true });
      res.json({ ok: true, status });
    } catch (err) {
      sendEntitlementError(res, err);
    }
  },
);

aiEntitlementRouter.delete(
  '/activate',
  requireAuth,
  requireEntitlementAdmin,
  async (_req: Request, res: Response) => {
    try {
      clearSavedActivationToken();
      const status = await getCloudEntitlementStatus({ canManage: true });
      res.json({ ok: true, status });
    } catch (err) {
      sendEntitlementError(res, err);
    }
  },
);

const requestBodySchema = z
  .object({
    orgName: z.string().trim().min(2).max(120),
    contactInfo: z.string().trim().min(3).max(160),
    serverOrigin: z.string().trim().max(200).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

aiEntitlementRouter.post(
  '/request',
  requireAuth,
  requireEntitlementAdmin,
  async (req: Request, res: Response) => {
    const parsed = requestBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'invalid_request',
          type: 'invalid_request',
          message: 'Organization/project name and contact details are required.',
        },
      });
      return;
    }

    try {
      const pendingRequest = await submitActivationRequest({
        orgName: parsed.data.orgName,
        contactInfo: parsed.data.contactInfo,
        serverOrigin: parsed.data.serverOrigin || resolveRequestOrigin(req),
        note: parsed.data.note,
      });
      const status = await getCloudEntitlementStatus({ canManage: true });
      res.status(201).json({ ok: true, pendingRequest, status });
    } catch (err) {
      sendEntitlementError(res, err);
    }
  },
);

aiEntitlementRouter.post(
  '/request/check',
  requireAuth,
  requireEntitlementAdmin,
  async (req: Request, res: Response) => {
    try {
      const result = await checkActivationRequestApproval(resolveRequestOrigin(req));
      const status = await getCloudEntitlementStatus({ canManage: true });
      res.json({
        ok: true,
        activated: result.activated,
        request: result.request,
        status,
      });
    } catch (err) {
      sendEntitlementError(res, err);
    }
  },
);
