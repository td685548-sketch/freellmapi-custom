import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { xGatewayAuth } from './auth.js';
import { runInGatewayScope } from './context.js';
import { proxyRouter } from '../../routes/proxy.js';

export const xGatewayRouter = Router();

// POST /x/v1/chat/completions — dispatch into the existing proxy chat handler
// after auth + scope setup.
xGatewayRouter.post('/chat/completions', xGatewayAuth, (req: Request, res: Response, next: NextFunction) => {
  const scope = {
    gateway: 'x' as const,
    outputSavers: [] as string[],
    inputSaver: 'off',
    inputTokensSaved: 0,
  };

  // Set response headers to mark this as an X gateway response
  res.setHeader('X-Gateway', 'x');
  res.setHeader('X-Output-Saver-Applied', '');
  res.setHeader('X-Input-Tokens-Saved', '0');

  runInGatewayScope(scope, () => {
    // Rewrite the URL so the proxy router matches its own /chat/completions path
    req.url = '/chat/completions';
    (proxyRouter as unknown as (req: Request, res: Response, next: NextFunction) => void)(req, res, next);
  });
});

// GET /x/v1/models — return the same model listing as the main gateway
xGatewayRouter.get('/models', xGatewayAuth, (req: Request, res: Response, next: NextFunction) => {
  req.url = '/models';
  (proxyRouter as unknown as (req: Request, res: Response, next: NextFunction) => void)(req, res, next);
});

// Catch-all: any other path under /x/v1 returns JSON 404
xGatewayRouter.use((_req: Request, res: Response) => {
  res.status(404).json({ error: { message: 'Not found', type: 'not_found' } });
});
