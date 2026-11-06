import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SessionUser } from '../services/auth.js';
import { clampAnalyticsDays, getUserAnalytics } from '../services/user-analytics.js';
import { getDb } from '../db/index.js';

// Per-account analytics. Two mounts, both behind requireAuth in custom/register.ts:
//   /api/admin/users/:id/analytics  - manage_users (view_users), any account
//   /api/user/analytics             - the caller's own numbers, no grant needed

function emailOf(userId: number): string | null {
  const row = getDb().prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined;
  return row?.email ?? null;
}

export const adminUserAnalyticsRouter = Router();

adminUserAnalyticsRouter.get('/:id/analytics', (req: Request, res: Response) => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid user ID', type: 'invalid_user_id' } });
    return;
  }
  const email = emailOf(id);
  if (email === null) {
    res.status(404).json({ error: { message: 'User not found', type: 'user_not_found' } });
    return;
  }
  res.json({ analytics: getUserAnalytics(id, email, clampAnalyticsDays(req.query.days)) });
});

export const selfAnalyticsRouter = Router();

selfAnalyticsRouter.get('/analytics', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  res.json({ analytics: getUserAnalytics(user.userId, user.email, clampAnalyticsDays(req.query.days)) });
});
