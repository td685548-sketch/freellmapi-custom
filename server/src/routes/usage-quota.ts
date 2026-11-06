import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { UsageQuota } from '@freellmapi/shared/usage-quota.js';
import type { SessionUser } from '../services/auth.js';
import { MAX_QUOTA_VALUE, getQuotaState, setQuota, type SubjectKind } from '../services/usage-quotas.js';
import { assertCanManageAccount, isPrimaryAdmin, userExists } from '../services/users.js';
import { getDb } from '../db/index.js';

// Daily / monthly allowances. Three mounts (custom/register.ts):
//   /api/admin/users/:id/usage-quota   view_users to read, edit_user_quotas to change
//   /api/client-profiles/:id/usage-quota   view_client_profiles / edit_client_profiles
//   /api/user/usage-quota              the caller's own, read-only, no grant needed

const limit = z.number().int().min(1).max(MAX_QUOTA_VALUE).nullable();
const bodySchema = z.object({
  dailyRequests: limit.optional(),
  dailyTokens: limit.optional(),
  monthlyRequests: limit.optional(),
  monthlyTokens: limit.optional(),
}).strict();

function parseId(req: Request, res: Response): number | null {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid id', type: 'invalid_id' } });
    return null;
  }
  return id;
}

/** The new limits: what the body names, everything else unchanged. Sends 400 and returns null on bad input. */
function mergedQuota(kind: SubjectKind, id: number, req: Request, res: Response): UsageQuota | null {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { message: `Each limit must be a whole number from 1 to ${MAX_QUOTA_VALUE.toLocaleString('en-US')}, or null for no limit`, type: 'invalid_quota' },
    });
    return null;
  }
  const current = getQuotaState(kind, id).quota;
  return {
    dailyRequests: parsed.data.dailyRequests === undefined ? current.dailyRequests : parsed.data.dailyRequests,
    dailyTokens: parsed.data.dailyTokens === undefined ? current.dailyTokens : parsed.data.dailyTokens,
    monthlyRequests: parsed.data.monthlyRequests === undefined ? current.monthlyRequests : parsed.data.monthlyRequests,
    monthlyTokens: parsed.data.monthlyTokens === undefined ? current.monthlyTokens : parsed.data.monthlyTokens,
  };
}

export const adminUserQuotaRouter = Router();

adminUserQuotaRouter.get('/:id/usage-quota', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  if (!userExists(id)) { res.status(404).json({ error: { message: 'No such account.', type: 'user_not_found' } }); return; }
  res.json(getQuotaState('user', id));
});

adminUserQuotaRouter.put('/:id/usage-quota', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  if (isPrimaryAdmin(id)) {
    res.status(403).json({ error: { message: 'The primary admin account is protected.', type: 'primary_admin_protected' } });
    return;
  }
  if (!userExists(id)) { res.status(404).json({ error: { message: 'No such account.', type: 'user_not_found' } }); return; }
  try {
    assertCanManageAccount(id, (req as Request & { user?: SessionUser }).user!.userId);
  } catch (err: any) {
    res.status(403).json({ error: { message: err.message, type: 'insufficient_privileges' } });
    return;
  }
  const next = mergedQuota('user', id, req, res);
  if (!next) return;
  setQuota('user', id, next);
  res.json(getQuotaState('user', id));
});

export const profileQuotaRouter = Router();

function profileExists(id: number): boolean {
  return Boolean(getDb().prepare('SELECT 1 FROM client_profiles WHERE id = ?').get(id));
}

profileQuotaRouter.get('/:id/usage-quota', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  if (!profileExists(id)) { res.status(404).json({ error: { message: 'Client profile not found' } }); return; }
  res.json(getQuotaState('profile', id));
});

profileQuotaRouter.put('/:id/usage-quota', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  if (!profileExists(id)) { res.status(404).json({ error: { message: 'Client profile not found' } }); return; }
  const next = mergedQuota('profile', id, req, res);
  if (!next) return;
  setQuota('profile', id, next);
  res.json(getQuotaState('profile', id));
});

export const selfQuotaRouter = Router();

selfQuotaRouter.get('/usage-quota', (req: Request, res: Response) => {
  res.json(getQuotaState('user', (req as Request & { user?: SessionUser }).user!.userId));
});
