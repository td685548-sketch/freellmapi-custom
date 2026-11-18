import { Router } from 'express';
import type { Request, Response } from 'express';
import { getPublicServiceStatus } from '../services/public-status.js';

export const publicStatusRouter = Router();

// Cache public status for 10 seconds to protect against scraper spikes
let cachedStatus: ReturnType<typeof getPublicServiceStatus> | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 10_000;

export function resetPublicStatusCacheForTests(): void {
  cachedStatus = null;
  cachedAt = 0;
}

// GET /api/public/status — unauthenticated public operational summary
publicStatusRouter.get('/status', (_req: Request, res: Response) => {
  const now = Date.now();
  if (cachedStatus && now - cachedAt < CACHE_TTL_MS) {
    res.setHeader('Cache-Control', 'public, max-age=10');
    res.json(cachedStatus);
    return;
  }

  const status = getPublicServiceStatus();
  cachedStatus = status;
  cachedAt = now;

  res.setHeader('Cache-Control', 'public, max-age=10');
  res.json(status);
});
