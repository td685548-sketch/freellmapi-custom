import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { GUEST_PERMISSIONS } from '@freellmapi/shared/guest-access.js';
import { getGuestPermissions, setGuestPermissions } from '../services/guest-access.js';
import { getTrialSettings, setTrialSettings, trialInfo } from '../services/guest-trial.js';
import { GUEST_TRIAL_LIMITS as TL, type GuestPermission } from '@freellmapi/shared/guest-access.js';
import { hasPermission } from '../middleware/requirePermission.js';
import type { SessionUser } from '../services/auth.js';

// Guest (signed-out visitor) access.
//  - guestInfoRouter, public at /api/auth/guest: which read-only views a visitor gets.
//  - guestAccessAdminRouter at /api/admin/guest-access: reading it needs view_users; changing it needs
//    edit_user_permissions, like assigning permissions to an account. Guests get read permissions only,
//    plus, if allowed, the bounded trial chat (try_playground, routes/guest-trial.ts) with its limits.

export const guestInfoRouter = Router();

guestInfoRouter.get('/', (_req: Request, res: Response) => {
  const trial = trialInfo();
  res.json({ permissions: getGuestPermissions(), ...(trial ? { trial } : {}) });
});

export const guestAccessAdminRouter = Router();

guestAccessAdminRouter.get('/', (_req: Request, res: Response) => {
  res.json({ permissions: getGuestPermissions(), available: GUEST_PERMISSIONS, trial: getTrialSettings() });
});

const keys = GUEST_PERMISSIONS.map(p => p.key) as [string, ...string[]];
const int = ([min, max]: readonly [number, number]) => z.number().int().min(min).max(max).optional();
const trialSchema = z.object({
  perIpPerHour: int(TL.perIpPerHour), dailyCap: int(TL.dailyCap), maxTokens: int(TL.maxTokens), maxInputChars: int(TL.maxInputChars),
  models: z.array(z.string().trim().min(1).max(200)).max(TL.maxModels).optional(),
}).strict();
const bodySchema = z.object({ permissions: z.array(z.enum(keys)).max(keys.length), trial: trialSchema.optional() }).strict();

function actorCanDelegateGuestAccess(
  user: SessionUser | undefined,
  permissions: readonly string[],
  hasTrialChange: boolean,
): boolean {
  if (hasTrialChange && !hasPermission(user, 'edit_settings')) {
    return false;
  }
  for (const perm of permissions as GuestPermission[]) {
    if (perm === 'view_models') {
      const canBudget = hasPermission(user, 'view_token_budget') || hasPermission(user, 'view_analytics');
      if (!canBudget || !hasPermission(user, 'view_keys')) return false;
    } else if (perm === 'view_usage_profiles') {
      if (!hasPermission(user, 'view_usage_profiles')) return false;
    } else if (perm === 'view_usage_accounts') {
      if (!hasPermission(user, 'view_usage_accounts')) return false;
    } else if (perm === 'try_playground') {
      if (!hasPermission(user, 'edit_settings')) return false;
    }
  }
  return true;
}

guestAccessAdminRouter.put('/', (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: `permissions is a list of: ${keys.join(', ')}; trial limits: messages per IP per hour ${TL.perIpPerHour.join('-')}, per day ${TL.dailyCap.join('-')}, max tokens ${TL.maxTokens.join('-')}, message length ${TL.maxInputChars.join('-')}, up to ${TL.maxModels} models.` } });
    return;
  }
  const actor = (req as Request & { user?: SessionUser }).user;
  if (!actorCanDelegateGuestAccess(actor, parsed.data.permissions, parsed.data.trial !== undefined)) {
    res.status(403).json({
      error: {
        type: 'forbidden',
        message: 'Permission denied: cannot expose guest views or trial settings beyond your own granted permissions.',
      },
    });
    return;
  }
  const trial = parsed.data.trial ? setTrialSettings(parsed.data.trial) : getTrialSettings();
  res.json({ permissions: setGuestPermissions(parsed.data.permissions), available: GUEST_PERMISSIONS, trial });
});
