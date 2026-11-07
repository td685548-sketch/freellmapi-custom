import { Router } from 'express';
import type { Request, Response } from 'express';
import { listAudit } from '../services/audit-log.js';

// GET /api/audit?actor=&area=&q=&before=&limit= — the dashboard's change history, newest first.
// Mounted in custom/register.ts behind requireAuth + view_logs, narrowed to view_audit_log.

export const auditLogRouter = Router();

const first = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined);
const positive = (v: unknown): number | undefined => { const n = Number(first(v)); return Number.isInteger(n) && n > 0 ? n : undefined; };

auditLogRouter.get('/', (req: Request, res: Response) => {
  const area = first(req.query.area)?.slice(0, 60) || undefined;
  const q = first(req.query.q)?.trim().slice(0, 100) || undefined;
  res.json(listAudit({ actorId: positive(req.query.actor), area, q, before: positive(req.query.before), limit: positive(req.query.limit) }));
});
