import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { MAX_ALLOWED_MODELS, MAX_TOKENS_CAP_LIMIT } from '@freellmapi/shared/profile-restrictions.js';
import { getProfileRestrictions, normalizeModelList, setProfileRestrictions } from '../services/profile-restrictions.js';

// GET|PUT /api/client-profiles/:id/restrictions. Mounted in custom/register.ts behind the same
// view_client_profiles / edit_client_profiles gate as the profile CRUD.

export const profileRestrictionsRouter = Router();

const bodySchema = z.object({
  allowedModels: z.array(z.string().trim().min(1).max(200)).max(MAX_ALLOWED_MODELS).optional(),
  maxTokens: z.number().int().min(1).max(MAX_TOKENS_CAP_LIMIT).nullable().optional(),
}).strict();

function parseId(req: Request, res: Response): number | null {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid profile id' } });
    return null;
  }
  return id;
}

profileRestrictionsRouter.get('/:id/restrictions', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const restrictions = getProfileRestrictions(id);
  if (!restrictions) { res.status(404).json({ error: { message: 'Client profile not found' } }); return; }
  res.json({ restrictions });
});

profileRestrictionsRouter.put('/:id/restrictions', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { message: `allowedModels is a list of up to ${MAX_ALLOWED_MODELS} model ids; maxTokens is a whole number from 1 to ${MAX_TOKENS_CAP_LIMIT.toLocaleString('en-US')} or null` },
    });
    return;
  }
  const current = getProfileRestrictions(id);
  if (!current) { res.status(404).json({ error: { message: 'Client profile not found' } }); return; }
  setProfileRestrictions(id, {
    allowedModels: parsed.data.allowedModels === undefined ? current.allowedModels : normalizeModelList(parsed.data.allowedModels),
    maxTokens: parsed.data.maxTokens === undefined ? current.maxTokens : parsed.data.maxTokens,
  });
  res.json({ restrictions: getProfileRestrictions(id) });
});
