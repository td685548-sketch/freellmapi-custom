import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SessionUser } from '../../services/auth.js';
import { isValidKeyProxyUrl, KEY_PROXY_URL_ERROR, KEY_PROXY_URL_MAX, maskProxyUrl } from '../../lib/key-proxy.js';
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
} from './client-keys.js';

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
    outboundProxyUrl: snapshot.maskedOutboundProxyUrl,
    hasOutboundProxy: Boolean(snapshot.outboundProxyUrl),
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

xGatewayConsoleRouter.use((_req, res) => {
  res.status(404).json({ error: { type: 'not_found', message: 'Not found' } });
});

xGatewayConsoleRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const known = err instanceof ConsoleError;
  res.status(known ? err.status : 500).json({
    error: { type: 'gateway_console_error', message: known ? err.message : 'Gateway console request failed.' },
  });
});
