import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { GUEST_PERMISSIONS } from '@freellmapi/shared/guest-access.js';
import { getGuestPermissions, setGuestPermissions } from '../services/guest-access.js';

// Guest (signed-out visitor) access.
//  - guestInfoRouter, public at /api/auth/guest: which read-only views a visitor gets.
//  - guestAccessAdminRouter at /api/admin/guest-access: reading it needs view_users; changing it needs
//    edit_user_permissions, like assigning permissions to an account. Only read permissions exist.

export const guestInfoRouter = Router();

guestInfoRouter.get('/', (_req: Request, res: Response) => {
  res.json({ permissions: getGuestPermissions() });
});

export const guestAccessAdminRouter = Router();

guestAccessAdminRouter.get('/', (_req: Request, res: Response) => {
  res.json({ permissions: getGuestPermissions(), available: GUEST_PERMISSIONS });
});

const keys = GUEST_PERMISSIONS.map(p => p.key) as [string, ...string[]];
const bodySchema = z.object({ permissions: z.array(z.enum(keys)).max(keys.length) }).strict();

guestAccessAdminRouter.put('/', (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: `permissions is a list of: ${keys.join(', ')}. Guests can only be given read access.` } });
    return;
  }
  res.json({ permissions: setGuestPermissions(parsed.data.permissions), available: GUEST_PERMISSIONS });
});
