import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getActiveProfileId } from '../services/profile-models.js';
import { invalidateModelListPages, ModelListPageExpired, readModelListPage, readModelListBudget, readModelListLive } from '../services/model-list-page.js';

export const modelListPageRouter = Router();
export const modelListCacheInvalidation: RequestHandler = (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) && /^\/(?:models|keys|profiles|fallback|settings)(?:\/|$)/.test(req.path)) {
    res.once('finish', () => { if (res.statusCode < 400) invalidateModelListPages(); });
  }
  next();
};
const pageQuery = z.object({
  profile: z.union([z.literal('global'), z.coerce.number().int().positive()]).optional(),
  search: z.string().max(200).default(''),
  vision: z.enum(['0', '1']).default('0'), tools: z.enum(['0', '1']).default('0'),
  context: z.coerce.number().int().min(0).max(100_000_000).default(0),
  sort: z.enum(['rank', 'model', 'reliability', 'speed', 'intelligence', 'guardrails', 'score', 'on']).optional(),
  direction: z.enum(['asc', 'desc']).default('asc'),
  offset: z.coerce.number().int().nonnegative().max(1_000_000).default(0),
  snapshot: z.string().uuid().optional(),
});

function profileExists(id: number | null): boolean {
  return id === null || !!getDb().prepare('SELECT 1 FROM profiles WHERE id = ?').get(id);
}

modelListPageRouter.get('/budget', (req, res) => {
  const parsed = pageQuery.pick({ profile: true }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: { message: 'Invalid profile.' } }); return; }
  const value = parsed.data.profile;
  const profileId = value === 'global' ? null : value ?? getActiveProfileId(getDb());
  if (!profileExists(profileId)) { res.status(404).json({ error: { message: 'No such profile.' } }); return; }
  res.json(readModelListBudget(profileId));
});

modelListPageRouter.get('/live', (req, res) => {
  const parsed = pageQuery.extend({ snapshot: z.string().uuid(), count: z.coerce.number().int().min(1).max(100_000) }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: { message: 'Invalid live model selection.' } }); return; }
  const q = parsed.data;
  const profileId = q.profile === 'global' ? null : q.profile ?? getActiveProfileId(getDb());
  if (!profileExists(profileId)) { res.status(404).json({ error: { message: 'No such profile.' } }); return; }
  try {
    res.json(readModelListLive({ ...q, profileId, vision: q.vision === '1', tools: q.tools === '1' }, q.count));
  } catch (error) {
    if (!(error instanceof ModelListPageExpired)) throw error;
    res.status(410).json({ error: { message: error.message } });
  }
});

modelListPageRouter.get('/', (req, res) => {
  const parsed = pageQuery.safeParse(req.query);
  if (!parsed.success || (parsed.data.offset > 0 && !parsed.data.snapshot)) {
    res.status(400).json({ error: { message: 'Invalid model page parameters.' } }); return;
  }
  const q = parsed.data;
  const profileId = q.profile === 'global' ? null : q.profile ?? getActiveProfileId(getDb());
  if (!profileExists(profileId)) { res.status(404).json({ error: { message: 'No such profile.' } }); return; }
  try {
    res.json(readModelListPage({ ...q, profileId, vision: q.vision === '1', tools: q.tools === '1' }));
  } catch (error) {
    if (!(error instanceof ModelListPageExpired)) throw error;
    res.status(410).json({ error: { message: error.message } });
  }
});

const edits = z.object({
  profileId: z.number().int().positive().nullable(),
  entries: z.array(z.object({
    modelDbId: z.number().int().positive(), priority: z.number().int().positive(), enabled: z.boolean(),
  }).strict()).max(10_000),
}).strict();

// Unlike the legacy write, this request names the chain it edits. A concurrent
// activation cannot redirect staged changes into another chain.
modelListPageRouter.put('/', (req, res) => {
  const parsed = edits.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: { message: 'Invalid model edits.' } }); return; }
  const { profileId, entries } = parsed.data;
  if (!profileExists(profileId)) { res.status(404).json({ error: { message: 'No such profile.' } }); return; }
  const db = getDb();
  const ids = entries.map(e => e.modelDbId);
  if (new Set(ids).size !== ids.length) { res.status(400).json({ error: { message: 'Duplicate model edits.' } }); return; }
  // Validate in bounded chunks to stay inside SQLite's bind parameter budget.
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const found = db.prepare(`SELECT id FROM models WHERE id IN (${part.map(() => '?').join(',')})`).all(...part);
    if (found.length !== part.length) { res.status(400).json({ error: { message: 'No such model.' } }); return; }
  }
  const write = profileId == null
    ? db.prepare('UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?')
    : db.prepare(`INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)
        ON CONFLICT(profile_id, model_db_id) DO UPDATE SET priority = excluded.priority, enabled = excluded.enabled`);
  db.transaction(() => {
    for (const entry of entries) {
      if (profileId == null) write.run(entry.priority, Number(entry.enabled), entry.modelDbId);
      else write.run(profileId, entry.modelDbId, entry.priority, Number(entry.enabled));
    }
  })();
  invalidateModelListPages();
  res.json({ success: true });
});
