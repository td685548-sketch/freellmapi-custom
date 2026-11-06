import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SessionUser } from '../../services/auth.js';
import { getConfigSnapshot, setDefaultSavers, setEnabled, type XGatewaySaverDefaults } from './config.js';

/** Console API for the gateway switch and its default savers.
 *
 * Authentication and the per-path permission leaves are enforced by the
 * `/api/x-gateway` entry in `PERMISSION_GATES` (plus `permissionForAction`), so
 * every handler here runs for a session that already holds the mapped leaf.
 */
export const xGatewayConsoleRouter = Router();

const enabledSchema = z.object({ enabled: z.boolean() }).strict();
const defaultsSchema = z.object({
  caveman: z.boolean(),
  ponytail: z.enum(['off', 'lite', 'full', 'ultra']),
  input: z.enum(['off', 'lossless', 'standard']),
}).strict();

class ConsoleError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ConsoleError(400, 'Invalid request.');
  return result.data;
}

function userId(req: Request): number | undefined {
  return (req as Request & { user?: SessionUser }).user?.userId;
}

function status() {
  const snapshot = getConfigSnapshot();
  return { enabled: snapshot.enabled, defaults: snapshot.savers, combosCount: snapshot.combos.length };
}

xGatewayConsoleRouter.get('/status', (_req, res) => {
  res.json(status());
});

xGatewayConsoleRouter.put('/enabled', (req, res) => {
  const body = parse(enabledSchema, req.body);
  setEnabled(body.enabled, userId(req));
  res.json({ enabled: body.enabled });
});

xGatewayConsoleRouter.get('/defaults', (_req, res) => {
  res.json(getConfigSnapshot().savers);
});

xGatewayConsoleRouter.put('/defaults', (req, res) => {
  const body = parse(defaultsSchema, req.body) as XGatewaySaverDefaults;
  setDefaultSavers(body, userId(req));
  res.json(body);
});

xGatewayConsoleRouter.use((_req, res) => {
  res.status(404).json({ error: { type: 'not_found', message: 'Not found' } });
});

xGatewayConsoleRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const known = err instanceof ConsoleError;
  res.status(known ? err.status : 500).json({
    error: { type: 'gateway_console_error', message: known ? err.message : 'Gateway console request failed.' },
  });
});
