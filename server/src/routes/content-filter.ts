import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CONTENT_FILTER_LIMITS as L } from '@freellmapi/shared/content-filter.js';
import { getContentFilter, listEvents, normalizeKeywords, setContentFilter } from '../services/content-filter.js';

// A client key's content rules. Mounted in custom/register.ts at /api/client-profiles: the settings need
// view_client_profiles to read and edit_client_profiles to change; the flagged messages (they hold what
// end users wrote) need edit_client_profiles (custom/permission-actions.ts).

export const contentFilterRouter = Router();

const schema = z.object({
  mode: z.enum(['off', 'log', 'block']).optional(),
  maxInputChars: z.number().int().min(L.minInputChars).max(L.maxInputChars).nullable().optional(),
  blockInjection: z.boolean().optional(),
  repeatLimit: z.number().int().min(L.minRepeatLimit).max(L.maxRepeatLimit).nullable().optional(),
  keywords: z.array(z.string().max(L.maxKeywordLength)).max(L.maxKeywords).optional(),
}).strict();

function profileId(req: Request, res: Response): number | null {
  const n = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!Number.isInteger(n) || n <= 0) { res.status(400).json({ error: { message: 'Invalid profile id' } }); return null; }
  if (!getContentFilter(n)) { res.status(404).json({ error: { message: 'Client profile not found' } }); return null; }
  return n;
}

contentFilterRouter.get('/:id/content-filter', (req, res) => {
  const id = profileId(req, res);
  if (id === null) return;
  res.json({ settings: getContentFilter(id), limits: L });
});

contentFilterRouter.put('/:id/content-filter', (req, res) => {
  const id = profileId(req, res);
  if (id === null) return;
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: `mode is off, log or block; maxInputChars ${L.minInputChars}-${L.maxInputChars.toLocaleString('en-US')} or null; repeatLimit ${L.minRepeatLimit}-${L.maxRepeatLimit} or null; up to ${L.maxKeywords} keywords of up to ${L.maxKeywordLength} characters` } });
    return;
  }
  const current = getContentFilter(id)!;
  const next = { ...current, ...parsed.data };
  setContentFilter(id, { ...next, keywords: normalizeKeywords(next.keywords) });
  res.json({ settings: getContentFilter(id) });
});

contentFilterRouter.get('/:id/content-filter/events', (req, res) => {
  const id = profileId(req, res);
  if (id === null) return;
  res.json({ events: listEvents(id) });
});
