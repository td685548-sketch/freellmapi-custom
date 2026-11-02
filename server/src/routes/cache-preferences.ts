import { Router } from 'express';
import { z } from 'zod';
import { getDb, setSetting } from '../db/index.js';
import { hasPermission, requirePermission } from '../middleware/requirePermission.js';
import type { SessionUser } from '../services/auth.js';
import { isCacheEnabled, cachePersistencePreference, cacheTtlMs, cacheMaxEntries, getCacheStats } from '../services/cache.js';

export const cachePreferencesRouter = Router();
function preferences() {
  return { enabled: isCacheEnabled(), persist: cachePersistencePreference(), ttlSeconds: cacheTtlMs() / 1000, maxEntries: cacheMaxEntries(), ...getCacheStats() };
}
cachePreferencesRouter.get('/', (req, res) => {
  const user = (req as typeof req & { user?: SessionUser }).user;
  if (!(['view_cache', 'edit_cache', 'clear_cache'] as const).some(p => hasPermission(user, p))) {
    res.status(403).json({ error: { type: 'forbidden', message: 'Response cache access required.' } });
    return;
  }
  res.set('Cache-Control', 'no-store').json(preferences());
});
const schema = z.object({ enabled: z.boolean().optional(), persist: z.boolean().optional() }).strict()
  .refine(body => body.enabled !== undefined || body.persist !== undefined);
cachePreferencesRouter.put('/', requirePermission('edit_cache'), (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'Supply enabled and/or persist as booleans.' } });
    return;
  }
  getDb().transaction(() => {
    if (parsed.data.enabled !== undefined) setSetting('response_cache_enabled', parsed.data.enabled ? '1' : '0');
    if (parsed.data.persist !== undefined) setSetting('response_cache_persist', parsed.data.persist ? '1' : '0');
  })();
  res.set('Cache-Control', 'no-store').json(preferences());
});
