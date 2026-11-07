import { Router } from 'express';
import type { Request, Response } from 'express';
import { clampAnalyticsDays } from '../services/user-analytics.js';
import { getUsageOverview } from '../services/usage-overview.js';
import { MAX_RANGE_DAYS, dailyUsage, dayOf, toCsv, type DailyKind } from '../services/usage-daily.js';

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

// --- Long-term daily figures (custom_usage_daily) and CSV exports ---------------------------------
// GET /api/usage/daily/{accounts|profiles|end-users}?from=YYYY-MM-DD&to=YYYY-MM-DD&id=
// GET /api/usage/export/{accounts|profiles|end-users}.csv?from=&to=&id=
// Accounts need view_usage_accounts; client keys and their end users view_usage_profiles.

const KINDS: Record<string, DailyKind> = { accounts: 'user', profiles: 'profile', 'end-users': 'end_user' };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function dailyQuery(req: Request, res: Response): { kind: DailyKind; from: string; to: string; id: number | null } | null {
  const kind = KINDS[String(req.params.kind)];
  if (!kind) { res.status(404).json({ error: { message: 'Unknown kind' } }); return null; }
  const today = dayOf(Date.now());
  const q = (name: string) => (typeof req.query[name] === 'string' ? req.query[name] as string : undefined);
  const to = q('to') ?? today;
  const from = q('from') ?? dayOf(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000);
  const valid = (d: string) => DAY_RE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (!valid(from) || !valid(to) || span < 0 || span >= MAX_RANGE_DAYS) {
    res.status(400).json({ error: { message: `from and to are days (YYYY-MM-DD), from <= to, at most ${MAX_RANGE_DAYS} days apart` } });
    return null;
  }
  const rawId = q('id');
  const id = rawId === undefined ? null : Number(rawId);
  if (id !== null && (!Number.isInteger(id) || id <= 0)) { res.status(400).json({ error: { message: 'Invalid id' } }); return null; }
  return { kind, from, to, id };
}

usageRouter.get('/daily/:kind', (req: Request, res: Response) => {
  const q = dailyQuery(req, res);
  if (!q) return;
  res.json({ from: q.from, to: q.to, rows: dailyUsage(q.kind, q.from, q.to, q.id) });
});

usageRouter.get('/export/:file', (req: Request, res: Response) => {
  const m = /^(accounts|profiles|end-users)\.csv$/.exec(String(req.params.file));
  if (!m) { res.status(404).json({ error: { message: 'Unknown export' } }); return; }
  req.params.kind = m[1]!;
  const q = dailyQuery(req, res);
  if (!q) return;
  const csv = toCsv(q.kind, dailyUsage(q.kind, q.from, q.to, q.id));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="usage-${m[1]}-${q.from}-to-${q.to}.csv"`);
  res.send('\uFEFF' + csv); // BOM: Excel then reads Vietnamese names as UTF-8
});
