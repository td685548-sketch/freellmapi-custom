import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { MAX_QUOTA_VALUE } from '../services/usage-quotas.js';
import {
  backfillStarterQuotaForUncappedMembers,
  countUncappedMembers,
  getStarterQuotaConfig,
  setStarterQuotaConfig,
} from '../services/starter-quota.js';

export const starterQuotaSettingsRouter = Router();

const limitField = z.number().int().min(1).max(MAX_QUOTA_VALUE).nullable();

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    dailyRequests: limitField.optional(),
    dailyTokens: limitField.optional(),
    monthlyRequests: limitField.optional(),
    monthlyTokens: limitField.optional(),
    rpmLimit: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

starterQuotaSettingsRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    config: getStarterQuotaConfig(),
    uncappedMembers: countUncappedMembers(),
  });
});

starterQuotaSettingsRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid starter quota settings: ${parsed.error.issues.map(i => i.message).join(', ')}`,
      },
    });
    return;
  }
  const config = setStarterQuotaConfig(parsed.data);
  res.json({
    config,
    uncappedMembers: countUncappedMembers(),
  });
});

starterQuotaSettingsRouter.post('/backfill', (_req: Request, res: Response) => {
  const config = getStarterQuotaConfig();
  if (
    !config.enabled ||
    (config.dailyRequests === null &&
      config.dailyTokens === null &&
      config.monthlyRequests === null &&
      config.monthlyTokens === null)
  ) {
    res.status(400).json({
      error: {
        message: 'Enable starter quota and set at least one daily or monthly limit before backfilling.',
      },
    });
    return;
  }
  const { updatedCount } = backfillStarterQuotaForUncappedMembers();
  res.json({
    updatedCount,
    config,
    uncappedMembers: countUncappedMembers(),
  });
});
