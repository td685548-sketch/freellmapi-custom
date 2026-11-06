import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { clampAnalyticsDays } from '../services/user-analytics.js';
import { MAX_PROFILE_RPM, getProfileAnalytics, setProfileRpmLimit } from '../services/profile-usage.js';

// Usage and request cap of one client profile. Mounted in custom/register.ts at
// /api/client-profiles, behind the same `manage_settings` gate as upstream's profile CRUD;
// paths not handled here fall through to that router.

export const profileAnalyticsRouter = Router();

function parseId(req: Request, res: Response): number | null {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid profile id' } });
    return null;
  }
  return id;
}

// GET /api/client-profiles/:id/analytics?days=
profileAnalyticsRouter.get('/:id/analytics', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const analytics = getProfileAnalytics(id, clampAnalyticsDays(req.query.days));
  if (!analytics) {
    res.status(404).json({ error: { message: 'Client profile not found' } });
    return;
  }
  res.json({ analytics });
});

const quotaSchema = z.object({ rpmLimit: z.number().int().min(1).max(MAX_PROFILE_RPM).nullable() });

// PUT /api/client-profiles/:id/quota  { rpmLimit: 1..1000 | null }
profileAnalyticsRouter.put('/:id/quota', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = quotaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: `rpmLimit must be an integer from 1 to ${MAX_PROFILE_RPM}, or null for no limit` } });
    return;
  }
  if (!setProfileRpmLimit(id, parsed.data.rpmLimit)) {
    res.status(404).json({ error: { message: 'Client profile not found' } });
    return;
  }
  res.json({ success: true, id, rpmLimit: parsed.data.rpmLimit });
});
