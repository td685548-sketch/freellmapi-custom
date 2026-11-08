import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SessionUser } from '../../services/auth.js';
import { KEY_PROXY_URL_MAX } from '../../lib/key-proxy.js';
import { probeProxyUrl } from '../../lib/proxy.js';
import {
  batchImportProxies,
  bulkActionProxies,
  CLOUDFLARE_WORKER_RELAY_CODE,
  createProxyPoolEntry,
  deleteProxyPoolEntry,
  deployServerlessRelay,
  getProxyPoolConfig,
  listProxyPool,
  POOL_NAME_MAX,
  proxyPoolEntryUrl,
  ProxyPoolError,
  updateProxyPoolConfig,
  updateProxyPoolEntry,
  VERCEL_RELAY_CODE,
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

const batchImportSchema = z.object({
  proxies: z.union([z.string(), z.array(z.string())]).optional(),
  lines: z.string().optional(),
  text: z.string().optional(),
}).strict().refine(b => b.proxies !== undefined || b.lines !== undefined || b.text !== undefined, {
  message: 'proxies, lines or text is required',
});

const bulkActionSchema = z.object({
  action: z.enum(['enable', 'disable', 'delete']),
  ids: z.array(z.union([z.number(), z.string()])).min(1),
}).strict();

const configSchema = z.object({
  noProxy: z.union([z.string(), z.array(z.string())]).optional(),
  strictProxy: z.boolean().optional(),
}).strict();

const deployWorkerSchema = z.object({
  provider: z.enum(['cloudflare', 'vercel']),
  apiToken: z.string().trim().min(1),
  accountId: z.string().trim().optional(),
  workerName: z.string().trim().min(1).max(POOL_NAME_MAX),
}).strict();

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

function redactProbeError(error: string | undefined): string {
  if (!error) return 'Proxy unreachable or refused the connection.';
  // Strip any embedded credentials (e.g. user:pass@host) so secrets never leak to the client
  return error.replace(/([\w.%-]+):([^\s@/]+)@/g, '$1:***@');
}

xProxyPoolRouter.get('/', (_req, res) => {
  res.json({ entries: listProxyPool() });
});

xProxyPoolRouter.get('/config', (_req, res) => {
  res.json({ config: getProxyPoolConfig() });
});

xProxyPoolRouter.post('/config', (req, res, next) => {
  try {
    const body = parse(configSchema, req.body);
    const updated = updateProxyPoolConfig(body);
    res.json({ config: updated });
  } catch (err) {
    next(err);
  }
});

xProxyPoolRouter.get('/relay-template', (_req, res) => {
  res.json({
    cloudflare: CLOUDFLARE_WORKER_RELAY_CODE,
    vercel: VERCEL_RELAY_CODE,
  });
});

xProxyPoolRouter.post('/batch-import', (req, res, next) => {
  try {
    const body = parse(batchImportSchema, req.body);
    let rawLines: string[] = [];
    if (typeof body.proxies === 'string') {
      rawLines = body.proxies.split('\n');
    } else if (Array.isArray(body.proxies)) {
      rawLines = body.proxies;
    } else if (typeof body.lines === 'string') {
      rawLines = body.lines.split('\n');
    } else if (typeof body.text === 'string') {
      rawLines = body.text.split('\n');
    }

    const uid = (req as Request & { user?: SessionUser }).user?.userId;
    const result = batchImportProxies(rawLines, uid);
    res.status(201).json({
      ok: true,
      imported: result.imported,
      failed: result.failed,
      total: rawLines.filter(l => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('//')).length,
      importedCount: result.imported.length,
      failedCount: result.failed.length,
    });
  } catch (err) {
    next(err);
  }
});

xProxyPoolRouter.post('/test-all', async (_req, res, next) => {
  try {
    const entries = listProxyPool().filter(e => e.enabled);
    const results = await Promise.all(
      entries.map(async entry => {
        try {
          const url = proxyPoolEntryUrl(entry.id);
          const isRelay = url.startsWith('https://') && (url.includes('.workers.dev') || url.includes('.vercel.app'));
          const result = await probeProxyUrl(url, {
            targetUrl: 'https://www.gstatic.com/generate_204',
            timeoutMs: 12_000,
            mode: isRelay ? 'fetch-relay' : 'forward',
          });
          return {
            id: entry.id,
            name: entry.name,
            ok: result.ok,
            latencyMs: result.latencyMs,
            ...(result.status !== undefined ? { status: result.status } : {}),
            ...(result.ok ? {} : { message: redactProbeError(result.error) }),
          };
        } catch (err: any) {
          return {
            id: entry.id,
            name: entry.name,
            ok: false,
            latencyMs: 0,
            message: redactProbeError(err?.message ?? String(err)),
          };
        }
      })
    );

    const healthy = results.filter(r => r.ok).length;
    const unhealthy = results.length - healthy;
    const sumLatency = results.filter(r => r.ok).reduce((sum, r) => sum + r.latencyMs, 0);
    const latencyMs = healthy > 0 ? Math.round(sumLatency / healthy) : 0;

    res.json({
      ok: true,
      total: results.length,
      healthy,
      unhealthy,
      latencyMs,
      results,
    });
  } catch (err) {
    next(err);
  }
});

xProxyPoolRouter.post('/bulk-action', (req, res, next) => {
  try {
    const body = parse(bulkActionSchema, req.body);
    const parsedIds = body.ids.map(id => {
      const num = Number(id);
      if (!Number.isSafeInteger(num) || num <= 0) {
        throw new ProxyPoolError(400, `Invalid ID in bulk action: ${id}`);
      }
      return num;
    });
    const result = bulkActionProxies(body.action, parsedIds);
    res.json({ ok: true, action: body.action, affected: result.affected, ids: result.ids });
  } catch (err) {
    next(err);
  }
});

xProxyPoolRouter.post('/deploy-worker', async (req, res, next) => {
  try {
    const body = parse(deployWorkerSchema, req.body);
    const uid = (req as Request & { user?: SessionUser }).user?.userId;
    const result = await deployServerlessRelay({
      provider: body.provider,
      apiToken: body.apiToken,
      accountId: body.accountId,
      workerName: body.workerName,
      createdBy: uid,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
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
// tunnel works. Credentials are stripped before returning any probe error message.
xProxyPoolRouter.post('/:id/test', async (req, res) => {
  const url = proxyPoolEntryUrl(entryId(req));
  const isRelay = url.startsWith('https://') && (url.includes('.workers.dev') || url.includes('.vercel.app'));
  const result = await probeProxyUrl(url, {
    targetUrl: 'https://www.gstatic.com/generate_204',
    timeoutMs: 12_000,
    mode: isRelay ? 'fetch-relay' : 'forward',
  });
  res.json({
    ok: result.ok,
    latencyMs: result.latencyMs,
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.ok ? {} : { message: redactProbeError(result.error) }),
  });
});

xProxyPoolRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const known = err instanceof ProxyPoolError;
  res.status(known ? err.status : 500).json({
    error: { type: 'proxy_pool_error', message: known ? err.message : 'Proxy pool request failed.' },
  });
});
