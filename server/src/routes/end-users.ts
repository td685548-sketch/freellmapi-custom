import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { clampAnalyticsDays } from '../services/user-analytics.js';
import { getEndUserOverview } from '../services/end-users.js';
import { getEndUserQuota, setEndUserQuota } from '../services/end-user-quotas.js';
import { MAX_QUOTA_VALUE } from '../services/usage-quotas.js';

// The web app's end users behind one client key. Mounted in custom/register.ts at /api/client-profiles
// behind the profile permissions (view_client_profiles to read, edit_client_profiles to change).

export const endUsersRouter = Router();

function parseId(req: Request, res: Response): number | null {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: { message: 'Invalid profile id' } }); return null; }
  return id;
}
const notFound = (res: Response) => res.status(404).json({ error: { message: 'Client profile not found' } });

// GET /api/client-profiles/:id/end-users?days=
endUsersRouter.get('/:id/end-users', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const overview = getEndUserOverview(id, clampAnalyticsDays(req.query.days));
  if (!overview) { notFound(res); return; }
  res.json({ overview });
});

const limit = z.number().int().min(1).max(MAX_QUOTA_VALUE).nullable();
const quotaSchema = z.object({ dailyRequests: limit.optional(), dailyTokens: limit.optional(), monthlyRequests: limit.optional(), monthlyTokens: limit.optional() }).strict();

endUsersRouter.get('/:id/end-user-quota', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const quota = getEndUserQuota(id);
  if (!quota) { notFound(res); return; }
  res.json({ quota });
});

// PUT /api/client-profiles/:id/end-user-quota  (fields it names change, the others stay)
endUsersRouter.put('/:id/end-user-quota', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = quotaSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Each limit must be a whole number from 1 upwards, or null for no limit' } });
    return;
  }
  const current = getEndUserQuota(id);
  if (!current) { notFound(res); return; }
  const next = {
    dailyRequests: parsed.data.dailyRequests === undefined ? current.dailyRequests : parsed.data.dailyRequests,
    dailyTokens: parsed.data.dailyTokens === undefined ? current.dailyTokens : parsed.data.dailyTokens,
    monthlyRequests: parsed.data.monthlyRequests === undefined ? current.monthlyRequests : parsed.data.monthlyRequests,
    monthlyTokens: parsed.data.monthlyTokens === undefined ? current.monthlyTokens : parsed.data.monthlyTokens,
  };
  setEndUserQuota(id, next);
  res.json({ quota: getEndUserQuota(id) });
});
