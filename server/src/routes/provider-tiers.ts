import { Router } from 'express';
import type { ProviderTierRange } from '@freellmapi/shared/provider-tiers.js';
import { providerTiers } from '../services/provider-tiers.js';

export const providerTiersRouter = Router();
providerTiersRouter.get('/', (req, res) => {
  const range = req.query.range ?? '7d';
  if (typeof range !== 'string' || !['24h', '7d', '30d', '90d', 'all'].includes(range)) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'Invalid provider tier time range.' } });
    return;
  }
  res.set('Cache-Control', 'no-store').json(providerTiers(range as ProviderTierRange));
});
