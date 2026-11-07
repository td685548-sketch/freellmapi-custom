import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SessionUser } from '../services/auth.js';
import { getDb } from '../db/index.js';
import { clampPage, listRecentRequests, requestAttempts, type RequestOwner } from '../services/recent-requests.js';

// Recent requests of one subject, newest first. Three mounts (custom/register.ts):
//   /api/client-profiles/:id/requests[/:rid/attempts]   view_client_profiles
//   /api/admin/users/:id/requests[/:rid/attempts]       view_users
//   /api/user/requests[/:rid/attempts]                  the caller's own

function positiveInt(raw: unknown): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function page(owner: RequestOwner, ownerId: number, req: Request, res: Response): void {
  const before = req.query.before === undefined ? null : positiveInt(req.query.before);
  if (req.query.before !== undefined && before === null) { res.status(400).json({ error: { message: 'Invalid before' } }); return; }
  const endUser = owner === 'profile_id' && typeof req.query.endUser === 'string' && req.query.endUser.trim() ? req.query.endUser.trim().slice(0, 128) : null;
  res.json(listRecentRequests(owner, ownerId, { onlyErrors: req.query.status === 'error', limit: clampPage(req.query.limit), before, endUser }));
}

function attempts(owner: RequestOwner, ownerId: number, req: Request, res: Response): void {
  const rid = positiveInt(req.params.rid);
  if (rid === null) { res.status(400).json({ error: { message: 'Invalid request id' } }); return; }
  const list = requestAttempts(owner, ownerId, rid);
  if (!list) { res.status(404).json({ error: { message: 'Request not found' } }); return; }
  res.json({ attempts: list });
}

const exists = (table: 'client_profiles' | 'users', id: number) => Boolean(getDb().prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id));

function bySubject(owner: RequestOwner, table: 'client_profiles' | 'users', notFound: string): Router {
  const router = Router();
  const subject = (req: Request, res: Response): number | null => {
    const id = positiveInt(req.params.id);
    if (id === null) { res.status(400).json({ error: { message: 'Invalid id' } }); return null; }
    if (!exists(table, id)) { res.status(404).json({ error: { message: notFound } }); return null; }
    return id;
  };
  router.get('/:id/requests', (req, res) => { const id = subject(req, res); if (id !== null) page(owner, id, req, res); });
  router.get('/:id/requests/:rid/attempts', (req, res) => { const id = subject(req, res); if (id !== null) attempts(owner, id, req, res); });
  return router;
}

export const profileRequestsRouter = bySubject('profile_id', 'client_profiles', 'Client profile not found');
export const adminUserRequestsRouter = bySubject('user_id', 'users', 'No such account.');

export const selfRequestsRouter = Router();
const me = (req: Request) => (req as Request & { user?: SessionUser }).user!.userId;
selfRequestsRouter.get('/requests', (req, res) => page('user_id', me(req), req, res));
selfRequestsRouter.get('/requests/:rid/attempts', (req, res) => attempts('user_id', me(req), req, res));
