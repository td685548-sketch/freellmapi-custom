import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SessionUser } from '../../services/auth.js';
import { KEY_PROXY_URL_MAX } from '../../lib/key-proxy.js';
import { probeProxyUrl } from '../../lib/proxy.js';
import {
  createProxyPoolEntry,
  deleteProxyPoolEntry,
  listProxyPool,
  POOL_NAME_MAX,
  proxyPoolEntryUrl,
  ProxyPoolError,
  updateProxyPoolEntry,
} from './proxy-pool.js';

/**
 * Proxy pool management, mounted at /api/x-gateway/proxy-pool. The console's
 * PERMISSION_GATES entry maps reads to use_x_gateway and writes to
 * edit_x_settings before any handler here runs.
 */
export const xProxyPoolRouter = Router();

const nameSchema = z.string().trim().min(1).max(POOL_NAME_MAX);
const urlSchema = z.string().trim().min(1).max(KEY_PROXY_URL_MAX);
const createSchema = z.object({ name: nameSchema, proxyUrl: urlSchema }).strict();
const patchSchema = z.object({
  name: nameSchema.optional(),
  proxyUrl: urlSchema.optional(),
  enabled: z.boolean().optional(),
}).strict().refine(b => Object.keys(b).length > 0);

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ProxyPoolError(400, 'Invalid request.');
  return result.data;
}

function entryId(req: Request): number {
  const raw = String(req.params.id ?? '');
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new ProxyPoolError(400, 'Invalid entry ID.');
  }
  return Number(raw);
}

xProxyPoolRouter.get('/', (_req, res) => {
  res.json({ entries: listProxyPool() });
});

xProxyPoolRouter.post('/', (req, res) => {
  const body = parse(createSchema, req.body);
  const uid = (req as Request & { user?: SessionUser }).user?.userId;
  res.status(201).json({ entry: createProxyPoolEntry(body.name, body.proxyUrl, uid) });
});

xProxyPoolRouter.patch('/:id', (req, res) => {
  const body = parse(patchSchema, req.body);
  res.json({ entry: updateProxyPoolEntry(entryId(req), body) });
});

xProxyPoolRouter.delete('/:id', (req, res) => {
  const id = entryId(req);
  if (!deleteProxyPoolEntry(id)) throw new ProxyPoolError(404, 'Proxy pool entry not found.');
  res.json({ ok: true, id });
});

// Probe the proxy with a tiny no-content endpoint; any HTTP answer proves the
// tunnel works. The message stays generic — probe errors can embed the proxy
// URL (with credentials) in err.message.
xProxyPoolRouter.post('/:id/test', async (req, res) => {
  const url = proxyPoolEntryUrl(entryId(req));
  const result = await probeProxyUrl(url, { targetUrl: 'https://www.gstatic.com/generate_204', timeoutMs: 8_000 });
  res.json({
    ok: result.ok,
    latencyMs: result.latencyMs,
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.ok ? {} : { message: 'Proxy unreachable or refused the connection.' }),
  });
});

xProxyPoolRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const known = err instanceof ProxyPoolError;
  res.status(known ? err.status : 500).json({
    error: { type: 'proxy_pool_error', message: known ? err.message : 'Proxy pool request failed.' },
  });
});