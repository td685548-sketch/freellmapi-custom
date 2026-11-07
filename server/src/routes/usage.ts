import { Router } from 'express';
import type { Request, Response } from 'express';
import { clampAnalyticsDays } from '../services/user-analytics.js';
import { getUsageOverview } from '../services/usage-overview.js';

// Usage ranking data. Mounted at /api/usage behind the `view_usage` gate in custom/register.ts;
// custom/permission-actions.ts splits it: accounts need view_usage_accounts, profiles view_usage_profiles.

export const usageRouter = Router();

// GET /api/usage/accounts?days=&fresh=1 (fresh skips the 30-second reuse)
usageRouter.get('/accounts', (req: Request, res: Response) => {
  res.json({ overview: getUsageOverview('account', clampAnalyticsDays(req.query.days), Date.now(), req.query.fresh === '1') });
});

// GET /api/usage/profiles?days=
usageRouter.get('/profiles', (req: Request, res: Response) => {
  res.json({ overview: getUsageOverview('profile', clampAnalyticsDays(req.query.days), Date.now(), req.query.fresh === '1') });
});
