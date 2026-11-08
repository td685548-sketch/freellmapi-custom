import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SessionUser } from '../../services/auth.js';
import { isValidKeyProxyUrl, KEY_PROXY_URL_ERROR, KEY_PROXY_URL_MAX, maskProxyUrl } from '../../lib/key-proxy.js';
import { probeProxyUrl } from '../../lib/proxy.js';
import {
  getConfigSnapshot,
  setDefaultSavers,
  setEnabled,
  setOutboundProxyUrl,
  type XGatewaySaverDefaults,
} from './config.js';
import {
  listXGatewayClientKeys,
  mintXGatewayClientKey,
  revokeXGatewayClientKey,
  updateXGatewayClientKeyAccess,
} from './client-keys.js';
import {
  getCapacityAdapterSettings,
  setCapacityAdapterSettings,
  type CapacityAdapterSettings,
} from './capacity-adapter.js';
import { xGatewayManagementRouter } from './management-router.js';
import { xQuotaRouter } from './quota/router.js';
import { xPlaygroundRouter } from './playground-router.js';
import { xProxyPoolRouter } from './proxy-pool-router.js';
import { xGatewayMediaRouter } from './media-router.js';
import { xCliToolsRouter } from './cli-tools-router.js';
import { xTranslatorRouter } from './translator-router.js';
import { xSkillsRouter } from './skills-router.js';

/** Console API for the gateway switch, outbound proxy, dedicated API keys, and default savers.
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
const proxySchema = z.object({
  proxyUrl: z.string().trim().max(KEY_PROXY_URL_MAX),
}).strict();
const createKeySchema = z.object({
  name: z.string().trim().max(100).optional(),
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

function requireUserId(req: Request): number {
  const uid = userId(req);
  if (!uid) throw new ConsoleError(401, 'Authentication required.');
  return uid;
}

function status() {
  const snapshot = getConfigSnapshot();
  return {
    enabled: snapshot.enabled,
    defaults: snapshot.savers,
    combosCount: snapshot.combos.length,
  };
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

xGatewayConsoleRouter.get('/proxy', (_req, res) => {
  const snapshot = getConfigSnapshot();
  res.json({
    proxyUrl: snapshot.maskedOutboundProxyUrl,
    configured: Boolean(snapshot.outboundProxyUrl),
  });
});

xGatewayConsoleRouter.put('/proxy', (req, res) => {
  const body = parse(proxySchema, req.body);
  if (!isValidKeyProxyUrl(body.proxyUrl)) {
    throw new ConsoleError(400, KEY_PROXY_URL_ERROR);
  }
  setOutboundProxyUrl(body.proxyUrl, userId(req));
  res.json({
    proxyUrl: maskProxyUrl(body.proxyUrl),
    configured: Boolean(body.proxyUrl.trim()),
  });
});

xGatewayConsoleRouter.post('/proxy/test', async (req, res, next) => {
  try {
    const rawInput = typeof req.body?.proxyUrl === 'string' ? req.body.proxyUrl.trim() : '';
    const candidate = rawInput || getConfigSnapshot().outboundProxyUrl;
    if (candidate && !isValidKeyProxyUrl(candidate)) {
      throw new ConsoleError(400, KEY_PROXY_URL_ERROR);
    }
    const result = await probeProxyUrl(candidate || undefined);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

xGatewayConsoleRouter.get('/keys', (req, res) => {
  const uid = requireUserId(req);
  res.json({ keys: listXGatewayClientKeys(uid) });
});

xGatewayConsoleRouter.post('/keys', (req, res) => {
  const uid = requireUserId(req);
  const body = parse(createKeySchema, req.body ?? {});
  const created = mintXGatewayClientKey(uid, body.name || 'X Gateway Key');
  res.status(201).json(created);
});

xGatewayConsoleRouter.delete('/keys/:id', (req, res) => {
  const uid = requireUserId(req);
  const rawId = String(req.params.id ?? '');
  if (!/^[1-9]\d*$/.test(rawId)) throw new ConsoleError(400, 'Invalid key ID.');
  const revoked = revokeXGatewayClientKey(uid, Number(rawId));
  if (!revoked) throw new ConsoleError(404, 'Key not found or already revoked.');
  res.json({ ok: true, id: Number(rawId) });
});

xGatewayConsoleRouter.patch('/keys/:id/access', (req, res) => {
  const uid = requireUserId(req);
  const rawId = String(req.params.id ?? '');
  if (!/^[1-9]\d*$/.test(rawId)) throw new ConsoleError(400, 'Invalid key ID.');
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const restricted = Boolean(body.restricted);
  const allow = Array.isArray(body.allow)
    ? (body.allow as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const updated = updateXGatewayClientKeyAccess(uid, Number(rawId), { restricted, allow });
  if (!updated) throw new ConsoleError(404, 'Key not found or revoked.');
  res.json({ ok: true, id: Number(rawId), access: { restricted, allow } });
});

xGatewayConsoleRouter.get('/capacity-adapter', (_req, res) => {
  res.json(getCapacityAdapterSettings());
});

xGatewayConsoleRouter.put('/capacity-adapter', (req, res) => {
  const uid = requireUserId(req);
  const body = req.body && typeof req.body === 'object' ? req.body as Partial<CapacityAdapterSettings> : {};
  const current = getCapacityAdapterSettings();
  const next: CapacityAdapterSettings = {
    vision: {
      enabled: body.vision?.enabled !== undefined ? Boolean(body.vision.enabled) : current.vision.enabled,
      roundRobin: body.vision?.roundRobin !== undefined ? Boolean(body.vision.roundRobin) : current.vision.roundRobin,
      models: Array.isArray(body.vision?.models)
        ? body.vision.models.filter((m): m is string => typeof m === 'string' && Boolean(m.trim()))
        : current.vision.models,
    },
    audioInput: {
      enabled: body.audioInput?.enabled !== undefined ? Boolean(body.audioInput.enabled) : current.audioInput.enabled,
      roundRobin: body.audioInput?.roundRobin !== undefined ? Boolean(body.audioInput.roundRobin) : current.audioInput.roundRobin,
      models: Array.isArray(body.audioInput?.models)
        ? body.audioInput.models.filter((m): m is string => typeof m === 'string' && Boolean(m.trim()))
        : current.audioInput.models,
    },
  };
  setCapacityAdapterSettings(next, uid);
  res.json(next);
});

xGatewayConsoleRouter.use(xPlaygroundRouter);
xGatewayConsoleRouter.use(xGatewayManagementRouter);
xGatewayConsoleRouter.use(xGatewayMediaRouter);
xGatewayConsoleRouter.use(xQuotaRouter);
xGatewayConsoleRouter.use('/proxy-pool', xProxyPoolRouter);
xGatewayConsoleRouter.use('/tools', xCliToolsRouter);
xGatewayConsoleRouter.use('/translator', xTranslatorRouter);
xGatewayConsoleRouter.use('/skills', xSkillsRouter);

xGatewayConsoleRouter.use((_req, res) => {
  res.status(404).json({ error: { type: 'not_found', message: 'Not found' } });
});

xGatewayConsoleRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const known = err instanceof ConsoleError;
  res.status(known ? err.status : 500).json({
    error: { type: 'gateway_console_error', message: known ? err.message : 'Gateway console request failed.' },
  });
});
