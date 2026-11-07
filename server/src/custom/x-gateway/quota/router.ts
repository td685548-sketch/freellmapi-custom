import { Router } from 'express';
import { z } from 'zod';
import { accountRow } from '../../provider-accounts/store.js';
import { listAccountQuotas, QUOTA_FRESHNESS_MS, refreshAccountQuota, setQuotaTier } from './store.js';

export const xQuotaRouter = Router();
xQuotaRouter.get('/quota', (_req, res) => res.json({ accounts: listAccountQuotas(), freshnessMs: QUOTA_FRESHNESS_MS }));
const tierSchema = z.object({ tier: z.enum(['subscription', 'cheap', 'free']) }).strict();
xQuotaRouter.use('/quota/:id', (req, res, next) => {
  if (!/^[1-9]\d*$/.test(String(req.params.id)) || !Number.isSafeInteger(Number(req.params.id))) {
    res.status(400).json({ error: { message: 'Invalid account ID.', type: 'invalid_request_error' } }); return;
  }
  try { accountRow(Number(req.params.id)); } catch {
    res.status(404).json({ error: { message: 'Account not found.', type: 'not_found' } }); return;
  }
  next();
});
xQuotaRouter.post('/quota/:id/refresh', async (req, res) => res.json(await refreshAccountQuota(Number(req.params.id))));
xQuotaRouter.put('/quota/:id/tier', (req, res) => {
  const parsed = tierSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: { message: 'Invalid routing tier.', type: 'invalid_request_error' } }); return; }
  setQuotaTier(Number(req.params.id), parsed.data.tier);
  res.json({ ok: true, tier: parsed.data.tier });
});
