import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SessionUser } from '../../services/auth.js';
import { getSetting, setSetting } from '../../db/index.js';
import { isValidKeyProxyUrl, KEY_PROXY_URL_ERROR, KEY_PROXY_URL_MAX, maskProxyUrl } from '../../lib/key-proxy.js';
import { probeProxyUrl } from '../../lib/proxy.js';
import {
  createCombo,
  getConfigSnapshot,
  listCombos,
  setDefaultSavers,
  setEnabled,
  setOutboundProxyUrl,
  updateCombo,
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
import {
  getDefaultPricing,
  getMergedPricing,
  getPricingOverrides,
  resetPricingOverrides,
  updatePricingOverrides,
  validatePricingPatch,
} from './pricing.js';
import { xGatewayManagementRouter } from './management-router.js';
import { xQuotaRouter } from './quota/router.js';
import { xPlaygroundRouter } from './playground-router.js';
import { xProxyPoolRouter } from './proxy-pool-router.js';
import { xGatewayMediaRouter } from './media-router.js';
import { xOperationsRouter as xCliToolsRouter } from './operations-router.js';
import { xTranslatorRouter } from './translator-router.js';
import { xSkillsRouter } from './skills-router.js';
import { xSupportConsoleRouter } from './support-router.js';

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

xGatewayConsoleRouter.get('/pricing', (_req, res) => {
  res.json({
    pricing: getMergedPricing(),
    overrides: getPricingOverrides(),
    defaults: getDefaultPricing(),
  });
});

xGatewayConsoleRouter.patch('/pricing', (req, res) => {
  const validation = validatePricingPatch(req.body);
  if (!validation.ok) {
    throw new ConsoleError(400, validation.error);
  }
  const pricing = updatePricingOverrides(validation.patch);
  res.json({
    ok: true,
    pricing,
    defaults: getDefaultPricing(),
    overrides: getPricingOverrides(),
  });
});

xGatewayConsoleRouter.delete('/pricing', (req, res) => {
  const provider = typeof req.query.provider === 'string' && req.query.provider.trim() ? req.query.provider.trim() : undefined;
  const model = typeof req.query.model === 'string' && req.query.model.trim() ? req.query.model.trim() : undefined;
  const pricing = resetPricingOverrides(provider, model);
  res.json({
    ok: true,
    pricing,
    defaults: getDefaultPricing(),
    overrides: getPricingOverrides(),
  });
});

function parseJsonSetting<T>(key: string, fallback: T): T {
  try {
    const raw = getSetting(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

xGatewayConsoleRouter.get('/config-backup', (_req, res) => {
  let customNodes = parseJsonSetting<unknown[]>('x_gateway_custom_provider_nodes', []);
  if (!Array.isArray(customNodes) || customNodes.length === 0) {
    customNodes = parseJsonSetting<unknown[]>('x_gateway_custom_nodes', []);
  }
  let providerModelConfigs = parseJsonSetting<Record<string, unknown>>('x_gateway_provider_models', {});
  if (!providerModelConfigs || typeof providerModelConfigs !== 'object' || Object.keys(providerModelConfigs).length === 0) {
    providerModelConfigs = parseJsonSetting<Record<string, unknown>>('provider_model_configs', {});
  }
  const modelAliases = parseJsonSetting<Record<string, string>>('x_gateway_model_aliases', {});
  const customModelCaps = parseJsonSetting<Record<string, unknown>>('x_gateway_custom_model_caps', {});

  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    defaults: getConfigSnapshot().savers,
    combos: listCombos(),
    capacityAdapter: getCapacityAdapterSettings(),
    pricingOverrides: getPricingOverrides(),
    customProviderNodes: customNodes,
    providerModelConfigs,
    modelAliases,
    customModelCaps,
  };
  res.json(backup);
});

xGatewayConsoleRouter.post('/config-backup', (req, res) => {
  const uid = userId(req);
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ConsoleError(400, 'Invalid backup payload.');
  }

  // 1. Defaults (savers)
  if (body.defaults && typeof body.defaults === 'object' && !Array.isArray(body.defaults)) {
    try {
      const parsedDefaults = parse(defaultsSchema, body.defaults) as XGatewaySaverDefaults;
      setDefaultSavers(parsedDefaults, uid);
    } catch {
      const current = getConfigSnapshot().savers;
      const mergedDefaults: XGatewaySaverDefaults = {
        caveman: typeof body.defaults.caveman === 'boolean' ? body.defaults.caveman : current.caveman,
        ponytail: ['off', 'lite', 'full', 'ultra'].includes(body.defaults.ponytail) ? body.defaults.ponytail : current.ponytail,
        input: ['off', 'lossless', 'standard'].includes(body.defaults.input) ? body.defaults.input : current.input,
      };
      setDefaultSavers(mergedDefaults, uid);
    }
  }

  // 2. Capacity Adapter
  if (body.capacityAdapter && typeof body.capacityAdapter === 'object') {
    const ca = body.capacityAdapter;
    const current = getCapacityAdapterSettings();
    const next: CapacityAdapterSettings = {
      vision: {
        enabled: ca.vision?.enabled !== undefined ? Boolean(ca.vision.enabled) : current.vision.enabled,
        roundRobin: ca.vision?.roundRobin !== undefined ? Boolean(ca.vision.roundRobin) : current.vision.roundRobin,
        models: Array.isArray(ca.vision?.models)
          ? ca.vision.models.filter((m: unknown): m is string => typeof m === 'string' && Boolean(m.trim()))
          : current.vision.models,
      },
      audioInput: {
        enabled: ca.audioInput?.enabled !== undefined ? Boolean(ca.audioInput.enabled) : current.audioInput.enabled,
        roundRobin: ca.audioInput?.roundRobin !== undefined ? Boolean(ca.audioInput.roundRobin) : current.audioInput.roundRobin,
        models: Array.isArray(ca.audioInput?.models)
          ? ca.audioInput.models.filter((m: unknown): m is string => typeof m === 'string' && Boolean(m.trim()))
          : current.audioInput.models,
      },
    };
    setCapacityAdapterSettings(next, uid);
  }

  // 3. Pricing Overrides
  let pricingProvidersCount = 0;
  if (body.pricingOverrides && typeof body.pricingOverrides === 'object' && !Array.isArray(body.pricingOverrides)) {
    if (Object.keys(body.pricingOverrides).length === 0) {
      resetPricingOverrides();
    } else {
      const validation = validatePricingPatch(body.pricingOverrides);
      if (validation.ok) {
        updatePricingOverrides(validation.patch);
        pricingProvidersCount = Object.keys(validation.patch).length;
      }
    }
  }

  // 4. Combos
  let combosCount = 0;
  if (Array.isArray(body.combos)) {
    const existingCombos = listCombos();
    const existingByName = new Map(existingCombos.map(c => [c.name.toLowerCase(), c]));
    for (const item of body.combos) {
      if (!item || typeof item !== 'object') continue;
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) continue;
      const entries = Array.isArray(item.entries) ? item.entries : [];
      const meta = {
        strategy: item.strategy,
        description: item.description,
        smartPolicy: item.smartPolicy,
        sessionSticky: item.sessionSticky,
        confidenceThreshold: item.confidenceThreshold,
      };
      const match = existingByName.get(name.toLowerCase());
      if (match) {
        updateCombo(match.id, name, entries, meta);
      } else {
        createCombo(name, entries, uid, meta);
      }
      combosCount++;
    }
  }

  // 5. Custom Provider Nodes
  let customNodesCount = 0;
  if (Array.isArray(body.customProviderNodes)) {
    const serialized = JSON.stringify(body.customProviderNodes);
    setSetting('x_gateway_custom_provider_nodes', serialized);
    setSetting('x_gateway_custom_nodes', serialized);
    customNodesCount = body.customProviderNodes.length;
  }

  // 6. Provider Model Configs
  if (body.providerModelConfigs && typeof body.providerModelConfigs === 'object' && !Array.isArray(body.providerModelConfigs)) {
    const serialized = JSON.stringify(body.providerModelConfigs);
    setSetting('x_gateway_provider_models', serialized);
  }

  // 7. Model Aliases & Custom Model Capabilities
  if (body.modelAliases && typeof body.modelAliases === 'object' && !Array.isArray(body.modelAliases)) {
    setSetting('x_gateway_model_aliases', JSON.stringify(body.modelAliases));
  }
  if (body.customModelCaps && typeof body.customModelCaps === 'object' && !Array.isArray(body.customModelCaps)) {
    setSetting('x_gateway_custom_model_caps', JSON.stringify(body.customModelCaps));
  }

  res.json({
    ok: true,
    restored: {
      combosCount,
      pricingProvidersCount,
      customNodesCount,
    },
  });
});

xGatewayConsoleRouter.use(xPlaygroundRouter);
xGatewayConsoleRouter.use(xGatewayManagementRouter);
xGatewayConsoleRouter.use(xGatewayMediaRouter);
xGatewayConsoleRouter.use(xQuotaRouter);
xGatewayConsoleRouter.use('/proxy-pool', xProxyPoolRouter);
xGatewayConsoleRouter.use('/tools', xCliToolsRouter);
xGatewayConsoleRouter.use('/translator', xTranslatorRouter);
xGatewayConsoleRouter.use('/skills', xSkillsRouter);
xGatewayConsoleRouter.use('/support', xSupportConsoleRouter);

xGatewayConsoleRouter.use((_req, res) => {
  res.status(404).json({ error: { type: 'not_found', message: 'Not found' } });
});

xGatewayConsoleRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const known = err instanceof ConsoleError;
  res.status(known ? err.status : 500).json({
    error: { type: 'gateway_console_error', message: known ? err.message : 'Gateway console request failed.' },
  });
});
