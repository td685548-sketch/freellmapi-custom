import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SessionUser } from '../../services/auth.js';
import { appendSupportAuditLog } from '../x-gateway/support-enterprise-router.js';
import {
  TENANT_PERMISSIONS,
  type TenantRolePresetId,
} from '@freellmapi/shared/tenant-rbac.js';
import {
  canPlatformManageTenantUsers,
  listUserTenantMembershipsForAdmin,
  removeTenantMember,
  TenantRbacError,
  upsertTenantMembershipByPlatformAdmin,
} from './store.js';

export const adminTenantMembershipsRouter = Router();

const PRESET_VALUES = [
  'tenant_owner',
  'ai_configurator',
  'support_operator',
  'viewer',
  'custom',
] as const;

const upsertMembershipSchema = z.object({
  rolePreset: z.enum(PRESET_VALUES).optional(),
  permissions: z.array(z.enum([...TENANT_PERMISSIONS, '*'])).optional(),
});

function actor(req: Request): SessionUser {
  return (req as Request & { user?: SessionUser }).user!;
}

function parsePositiveInt(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const num = Number(value);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

function sendError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof TenantRbacError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        type: err.code,
        message: err.message,
      },
    });
    return;
  }
  res.status(500).json({ error: { code: 'internal_error', message: fallback } });
}

// GET /api/admin/tenant-memberships/users/:userId
adminTenantMembershipsRouter.get('/users/:userId', (req: Request, res: Response) => {
  const user = actor(req);
  if (!canPlatformManageTenantUsers(user, 'read')) {
    res.status(403).json({
      error: {
        type: 'forbidden',
        code: 'forbidden',
        message: "Permission denied: 'view_users' or Support Tenant operator access required.",
      },
    });
    return;
  }

  const userId = parsePositiveInt(req.params.userId);
  if (!userId) {
    res.status(400).json({ error: { code: 'invalid_user_id', message: 'Invalid user ID.' } });
    return;
  }

  try {
    res.json(listUserTenantMembershipsForAdmin(userId));
  } catch (err) {
    sendError(res, err, 'Failed to load tenant memberships.');
  }
});

// PUT /api/admin/tenant-memberships/tenants/:tenantId/users/:userId
adminTenantMembershipsRouter.put(
  '/tenants/:tenantId/users/:userId',
  (req: Request, res: Response) => {
    const user = actor(req);
    if (!canPlatformManageTenantUsers(user, 'write')) {
      res.status(403).json({
        error: {
          type: 'forbidden',
          code: 'forbidden',
          message:
            "Permission denied: 'edit_user_permissions' or Support Tenant operator access required.",
        },
      });
      return;
    }

    const tenantId = parsePositiveInt(req.params.tenantId);
    const userId = parsePositiveInt(req.params.userId);
    if (!tenantId || !userId) {
      res.status(400).json({ error: { code: 'invalid_input', message: 'Invalid tenant or user ID.' } });
      return;
    }

    const parsed = upsertMembershipSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'invalid_permissions',
          message: parsed.error.issues.map((i) => i.message).join(', '),
        },
      });
      return;
    }

    try {
      const member = upsertTenantMembershipByPlatformAdmin({
        tenantId,
        targetUserId: userId,
        rolePreset: parsed.data.rolePreset as TenantRolePresetId | undefined,
        permissions: parsed.data.permissions,
        actor: user,
      });

      appendSupportAuditLog({
        tenantId: String(tenantId),
        action: 'tenant_membership.upsert',
        userId: String(user.userId),
        role: user.role,
        details: {
          targetUserId: userId,
          targetEmail: member.email,
          rolePreset: member.rolePreset,
          permissions: member.permissions,
          via: 'platform_admin',
        },
      });

      res.json({ ok: true, member });
    } catch (err) {
      sendError(res, err, 'Failed to update tenant membership.');
    }
  },
);

// DELETE /api/admin/tenant-memberships/tenants/:tenantId/users/:userId
adminTenantMembershipsRouter.delete(
  '/tenants/:tenantId/users/:userId',
  (req: Request, res: Response) => {
    const user = actor(req);
    if (!canPlatformManageTenantUsers(user, 'write')) {
      res.status(403).json({
        error: {
          type: 'forbidden',
          code: 'forbidden',
          message:
            "Permission denied: 'edit_user_permissions' or Support Tenant operator access required.",
        },
      });
      return;
    }

    const tenantId = parsePositiveInt(req.params.tenantId);
    const userId = parsePositiveInt(req.params.userId);
    if (!tenantId || !userId) {
      res.status(400).json({ error: { code: 'invalid_input', message: 'Invalid tenant or user ID.' } });
      return;
    }

    try {
      removeTenantMember({
        tenantId,
        targetUserId: userId,
        actor: user,
        viaPlatformAdmin: true,
      });

      appendSupportAuditLog({
        tenantId: String(tenantId),
        action: 'tenant_membership.remove',
        userId: String(user.userId),
        role: user.role,
        details: {
          targetUserId: userId,
          via: 'platform_admin',
        },
      });

      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, 'Failed to remove tenant membership.');
    }
  },
);
