import { Router, type Request } from 'express';
import { z } from 'zod';
import type { SessionUser } from '../../services/auth.js';
import { getRoutingDefaults, MAX_STICKY_LIMIT, setRoutingDefaults } from './routing-defaults.js';

/** `/api/thruline/routing-defaults`; permissions come from `permissionForAction`. */
export const xRoutingDefaultsRouter = Router();

const limit = z.number().int().min(1).max(MAX_STICKY_LIMIT);
const schema = z.object({
  accountStrategy: z.enum(['fallback', 'round-robin']).optional(),
  accountStickyLimit: limit.optional(),
  comboRoundRobin: z.boolean().optional(),
  comboStickyLimit: limit.optional(),
}).strict();

xRoutingDefaultsRouter.get('/routing-defaults', (_req, res) => {
  res.json(getRoutingDefaults());
});

xRoutingDefaultsRouter.put('/routing-defaults', (req: Request, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { type: 'gateway_console_error', message: 'Invalid request.' } });
    return;
  }
  const uid = (req as Request & { user?: SessionUser }).user?.userId;
  res.json(setRoutingDefaults(parsed.data, uid));
});
