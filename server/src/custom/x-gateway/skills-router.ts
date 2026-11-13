import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SessionUser } from '../../services/auth.js';
import { skillsService, type CustomSkill } from './skills-service.js';

export const xSkillsRouter = Router();
export const xSkillsPublicRouter = Router();

const customSkillCreateSchema = z.object({
  id: z.string().trim().min(2).max(64),
  name: z.string().trim().min(2).max(100),
  category: z.enum(['entry', 'chat', 'media', 'audio', 'data', 'search', 'tools', 'custom']).optional(),
  description: z.string().trim().min(5).max(500),
  endpoint: z.string().trim().max(255).optional().nullable(),
  icon: z.string().trim().max(50).optional(),
  content: z.string().min(10).max(50000),
}).strict();

const customSkillUpdateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  category: z.enum(['entry', 'chat', 'media', 'audio', 'data', 'search', 'tools', 'custom']).optional(),
  description: z.string().trim().min(5).max(500).optional(),
  endpoint: z.string().trim().max(255).optional().nullable(),
  icon: z.string().trim().max(50).optional(),
  content: z.string().min(10).max(50000).optional(),
}).strict();

function extractOrigin(req: Request): string {
  const host = req.get('host') || 'localhost:3001';
  const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
  return `${proto}://${host}`;
}

function getUserId(req: Request): number | undefined {
  return (req as Request & { user?: SessionUser }).user?.userId;
}

// Console API: GET /api/thruline/skills
xSkillsRouter.get('/', (req: Request, res: Response) => {
  const origin = extractOrigin(req);
  const data = skillsService.listSkills({ origin });
  res.json(data);
});

// Console API: GET /api/thruline/skills/:id
xSkillsRouter.get('/:id', (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const origin = extractOrigin(req);
  const skill = skillsService.getSkill(id, { origin });
  if (!skill) {
    res.status(404).json({ error: { type: 'not_found', message: `Skill '${id}' not found.` } });
    return;
  }
  res.json({ skill });
});

// Console API: GET /api/thruline/skills/:id/raw (serves raw text/markdown)
xSkillsRouter.get('/:id/raw', (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const origin = extractOrigin(req);
  const markdown = skillsService.getRawSkillMarkdown(id, { origin });
  if (!markdown) {
    res.status(404).type('text/plain').send(`Skill '${id}' not found.`);
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.type('text/markdown; charset=utf-8').send(markdown);
});

// Console API: POST /api/thruline/skills/custom
xSkillsRouter.post('/custom', (req: Request, res: Response) => {
  const parsed = customSkillCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { type: 'validation_error', message: 'Invalid skill data.', details: parsed.error.issues } });
    return;
  }

  try {
    const created = skillsService.createCustomSkill({
      ...parsed.data,
      category: parsed.data.category as CustomSkill['category'],
      userId: getUserId(req),
    });
    res.status(201).json({ skill: created });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to create skill';
    res.status(400).json({ error: { type: 'create_failed', message: msg } });
  }
});

// Console API: PUT /api/thruline/skills/custom/:id
xSkillsRouter.put('/custom/:id', (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const parsed = customSkillUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { type: 'validation_error', message: 'Invalid skill patch.', details: parsed.error.issues } });
    return;
  }

  try {
    const updated = skillsService.updateCustomSkill(id, {
      ...parsed.data,
      category: parsed.data.category as CustomSkill['category'],
    });
    res.json({ skill: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to update skill';
    res.status(404).json({ error: { type: 'update_failed', message: msg } });
  }
});

// Console API: DELETE /api/thruline/skills/custom/:id
xSkillsRouter.delete('/custom/:id', (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const deleted = skillsService.deleteCustomSkill(id);
  if (!deleted) {
    res.status(404).json({ error: { type: 'not_found', message: `Custom skill '${id}' not found.` } });
    return;
  }
  res.json({ ok: true, id });
});

// Public Router: GET /thruline-skills/:id and GET /thruline-skills/:id/SKILL.md (Open without auth for AI agents)
function handlePublicSkill(req: Request, res: Response) {
  const rawId = String(req.params.id ?? '').replace(/\.md$/i, '').replace(/\/SKILL$/i, '');
  const origin = extractOrigin(req);
  const markdown = skillsService.getRawSkillMarkdown(rawId, { origin });
  if (!markdown) {
    res.status(404).type('text/plain').send(`Skill '${rawId}' not found.`);
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.type('text/markdown; charset=utf-8').send(markdown);
}

xSkillsPublicRouter.get('/:id/SKILL.md', handlePublicSkill);
xSkillsPublicRouter.get('/:id', handlePublicSkill);

