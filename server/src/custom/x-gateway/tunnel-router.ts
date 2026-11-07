import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { tunnelService } from './tunnel-service.js';

export const xTunnelRouter = Router();

const startSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
}).strict();

xTunnelRouter.get('/status', (_req: Request, res: Response) => {
  res.json(tunnelService.getStatus());
});

xTunnelRouter.post('/start', async (req: Request, res: Response) => {
  const parseResult = startSchema.safeParse(req.body ?? {});
  if (!parseResult.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        message: 'Invalid tunnel start configuration.',
        issues: parseResult.error.issues,
      },
    });
    return;
  }

  const status = await tunnelService.start(parseResult.data.port);
  res.json(status);
});

xTunnelRouter.post('/stop', (_req: Request, res: Response) => {
  const status = tunnelService.stop();
  res.json(status);
});

xTunnelRouter.get('/logs', (_req: Request, res: Response) => {
  res.json({ logs: tunnelService.getLogs() });
});
