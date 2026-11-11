import { subscriptionRouter } from './subscription-router.js';
import { resolveAccountProvider } from './execution.js';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Permission } from '@freellmapi/shared/user-access.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { hasPermission, requirePermission } from '../../middleware/requirePermission.js';
import { validateSession, type SessionUser } from '../../services/auth.js';
import { decrypt } from '../../lib/crypto.js';
import { KEY_PROXY_URL_MAX } from '../../lib/key-proxy.js';
import { withKeyProxy } from '../../lib/proxy.js';
import { AccountError } from './http.js';
import { getXGatewayProvider, normalizeXGatewayProviderId } from './catalog.js';
import {
  accountModels,
  accountRow,
  createApiKeyAccount,
  deleteAccount,
  deleteCustomProviderNode,
  getProviderModelConfig,
  getUsableXGatewayKeys,
  listAccountRowsForBatchTest,
  listAccounts,
  listCustomProviderNodes,
  resolveXGatewayAccountProxy,
  saveCustomProviderNode,
  setAccountStatus,
  setProviderModelConfig,
  toggleProviderAccounts,
  updateAccount,
  type CustomProviderNode,
  type OAuthProvider,
} from './store.js';
import {
  attemptAction, cancelAccountAuth, completeAccountAuth, pollAccountAuth, startAccountAuth, type AccountActor,
} from './attempts.js';

export const providerAccountsRouter = Router();
providerAccountsRouter.use(requireAuth, requirePermission('use_x_gateway'));
providerAccountsRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
providerAccountsRouter.use('/subscriptions', subscriptionRouter);

type SessionRequest = Request & { user?: SessionUser; sessionToken?: string };
const labelSchema = z.string().trim().max(200).refine(s => [...s].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127));
const createSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  key: z.string().trim().min(1).max(65536),
  label: labelSchema.optional(),
  baseUrl: z.string().trim().max(2048).optional(),
  proxyUrl: z.string().trim().max(KEY_PROXY_URL_MAX).optional(),
  proxyPoolId: z.number().int().positive().safe().nullable().optional(),
  authMethod: z.enum(['api_key', 'oauth_pkce', 'device_code', 'cookie']).optional(),
  models: z.array(z.object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200).optional().default(''),
  })).max(200).optional(),
}).strict();
const startSchema = z.object({ label: labelSchema, callbackUrl: z.string().max(2048).optional(), reconnectId: z.number().int().positive().safe().optional() }).strict();
const completeSchema = z.object({ code: z.string().trim().min(1).max(4096) }).strict();
const updateSchema = z.object({
  label: labelSchema.optional(),
  enabled: z.boolean().optional(),
  proxyUrl: z.string().trim().max(KEY_PROXY_URL_MAX).optional(),
  proxyPoolId: z.number().int().positive().safe().nullable().optional(),
  monthlyRequestCap: z.number().int().min(0).safe().optional(),
  monthlyTokenCap: z.number().int().min(0).safe().optional(),
}).strict().refine(b => Object.keys(b).length > 0);
const testSchema = z.object({ model: z.string().trim().min(1).max(200).optional(), message: z.string().trim().min(1).max(4000).optional() }).strict();
const batchTestSchema = z.object({
  providerId: z.string().trim().min(1).max(100).optional(),
  accountIds: z.array(z.number().int().positive().safe()).max(200).optional(),
}).strict();
const bulkCreateSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  entries: z.array(z.object({
    key: z.string().trim().min(1).max(65536),
    label: labelSchema.optional(),
  })).min(1).max(100),
  baseUrl: z.string().trim().max(2048).optional(),
  proxyUrl: z.string().trim().max(KEY_PROXY_URL_MAX).optional(),
  proxyPoolId: z.number().int().positive().safe().nullable().optional(),
  authMethod: z.enum(['api_key', 'oauth_pkce', 'device_code', 'cookie']).optional(),
}).strict();
const providerToggleSchema = z.object({
  enabled: z.boolean(),
}).strict();
const providerModelsSchema = z.object({
  disabledModels: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
  customModels: z.array(z.object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().max(200).optional(),
  })).max(200).optional(),
  modelAliases: z.record(z.string().trim().min(1).max(200), z.string().trim().min(1).max(200)).optional(),
}).strict();
const customNodeSchema = z.object({
  id: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(200),
  prefix: z.string().trim().min(1).max(100),
  type: z.enum(['openai-compatible', 'anthropic-compatible', 'custom-embedding']).default('openai-compatible'),
  apiType: z.enum(['chat', 'responses']).optional(),
  baseUrl: z.string().trim().min(1).max(2048),
  models: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
}).strict();
const validateNodeSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2048),
  apiKey: z.string().trim().max(65536).optional(),
  type: z.enum(['openai-compatible', 'anthropic-compatible', 'custom-embedding']).optional().default('openai-compatible'),
  modelId: z.string().trim().max(200).optional(),
}).strict();
const pingModelSchema = z.object({
  model: z.string().trim().min(1).max(200),
}).strict();
const emptySchema = z.object({}).strict();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AccountError(400, 'Invalid request.');
  return result.data;
}
function id(req: Request): number {
  const value = String(req.params.id);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AccountError(400, 'Invalid account ID.');
  return Number(value);
}
function actor(req: SessionRequest): AccountActor {
  if (!req.user || !req.sessionToken) throw new AccountError(401, 'Authentication required.');
  return { userId: req.user.userId, sessionToken: req.sessionToken };
}
function authCheck(req: SessionRequest, provider: OAuthProvider, reconnectId?: number): () => void {
  const original = actor(req);
  return () => {
    const user = validateSession(original.sessionToken);
    if (!user || user.userId !== original.userId) throw new AccountError(401, 'Authentication required.');
    const permissions: Permission[] = ['use_x_gateway', reconnectId === undefined ? 'add_keys' : 'edit_keys'];
    if (provider === 'github-copilot') permissions.push('manage_key_models');
    if (permissions.some(p => !hasPermission(user, p))) throw new AccountError(403, 'Permission denied.');
  };
}
function existingAttempt(req: SessionRequest) {
  const attemptId = String(req.params.attemptId);
  const owner = actor(req);
  const action = attemptAction(attemptId, owner);
  const authorize = authCheck(req, action.provider, action.reconnectId);
  authorize();
  return { attemptId, owner, authorize };
}

providerAccountsRouter.get('/', requirePermission('view_keys'), (req: SessionRequest, res) => {
  res.json({ providers: listAccounts(), permissions: {
    add: hasPermission(req.user, 'add_keys'), edit: hasPermission(req.user, 'edit_keys'),
    delete: hasPermission(req.user, 'delete_keys'), test: hasPermission(req.user, 'test_keys'),
    manageModels: hasPermission(req.user, 'manage_key_models'),
  } });
});

providerAccountsRouter.post('/', requirePermission('add_keys'), (req: SessionRequest, res) => {
  const body = parse(createSchema, req.body);
  if ((body.provider === 'custom' || body.baseUrl || (body.models && body.models.length > 0)) && !hasPermission(req.user, 'manage_key_models')) {
    throw new AccountError(403, 'Permission denied.');
  }
  const accountId = createApiKeyAccount({
    provider: body.provider,
    key: body.key,
    label: body.label,
    baseUrl: body.baseUrl,
    proxyUrl: body.proxyUrl,
    proxyPoolId: body.proxyPoolId,
    authMethod: body.authMethod,
    models: body.models?.map(m => ({ id: m.id, name: m.name || m.id })),
    userId: req.user?.userId ?? null,
  });
  res.status(201).json({ id: accountId });
});

providerAccountsRouter.post('/bulk', requirePermission('add_keys'), (req: SessionRequest, res) => {
  const body = parse(bulkCreateSchema, req.body);
  if ((body.provider === 'custom' || body.baseUrl) && !hasPermission(req.user, 'manage_key_models')) {
    throw new AccountError(403, 'Permission denied.');
  }
  const ids: number[] = [];
  for (let i = 0; i < body.entries.length; i++) {
    const entry = body.entries[i]!;
    const createdId = createApiKeyAccount({
      provider: body.provider,
      key: entry.key,
      label: entry.label || `${body.provider} #${i + 1}`,
      baseUrl: body.baseUrl,
      proxyUrl: body.proxyUrl,
      proxyPoolId: body.proxyPoolId,
      authMethod: body.authMethod,
      userId: req.user?.userId ?? null,
    });
    ids.push(createdId);
  }
  res.status(201).json({ ids, count: ids.length });
});

providerAccountsRouter.get('/nodes', requirePermission('view_keys'), (_req, res) => {
  res.json({ ok: true, nodes: listCustomProviderNodes() });
});

providerAccountsRouter.post('/nodes', requirePermission('add_keys'), (req: SessionRequest, res) => {
  const body = parse(customNodeSchema, req.body);
  const id = body.id || `custom-${body.prefix.toLowerCase().replace(/[^a-z0-9_-]/g, '')}-${Date.now().toString(36)}`;
  const node: CustomProviderNode = {
    id,
    name: body.name,
    prefix: body.prefix.toLowerCase().trim(),
    type: body.type || 'openai-compatible',
    ...(body.apiType ? { apiType: body.apiType } : {}),
    baseUrl: body.baseUrl.trim().replace(/\/+$/, ''),
    ...(body.models ? { models: body.models } : {}),
  };
  const saved = saveCustomProviderNode(node);
  res.status(201).json({ ok: true, node: saved });
});

providerAccountsRouter.delete('/nodes/:nodeId', requirePermission('delete_keys'), (req: SessionRequest, res) => {
  const nodeId = String(req.params.nodeId ?? '').trim();
  if (!nodeId) throw new AccountError(400, 'Node ID is required.');
  deleteCustomProviderNode(nodeId);
  res.json({ ok: true, nodeId });
});

providerAccountsRouter.post('/nodes/validate', requirePermission('view_keys'), async (req, res) => {
  const body = parse(validateNodeSchema, req.body);
  const start = Date.now();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(body.baseUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ ok: false, valid: false, error: 'Invalid URL format', latencyMs: 0, models: [] });
  }

  const headers: Record<string, string> = {};
  if (body.apiKey) {
    headers['Authorization'] = `Bearer ${body.apiKey}`;
  }

  const timeoutMs = 12000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let valid = false;
  let models: string[] = [];
  let message: string | undefined;

  try {
    if (body.type === 'custom-embedding') {
      let sanitizedBase = body.baseUrl.trim().replace(/\/+$/, '');
      if (sanitizedBase.endsWith('/embeddings')) {
        sanitizedBase = sanitizedBase.slice(0, -'/embeddings'.length);
      }
      try {
        const mRes = await fetch(`${sanitizedBase}/models`, {
          headers,
          signal: controller.signal,
        });
        if (mRes.ok) {
          const data: any = await mRes.json().catch(() => null);
          if (Array.isArray(data?.data)) {
            models = data.data.map((m: any) => m?.id).filter(Boolean);
          } else if (Array.isArray(data)) {
            models = data.map((m: any) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
          }
          valid = true;
        }
      } catch {}

      if (!valid && body.modelId) {
        const eRes = await fetch(`${sanitizedBase}/embeddings`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: body.modelId, input: 'ping' }),
          signal: controller.signal,
        });
        if (eRes.ok) {
          valid = true;
          if (!models.includes(body.modelId)) models.push(body.modelId);
        } else {
          const errText = await eRes.text().catch(() => '');
          message = `Embeddings check failed (${eRes.status}): ${errText.slice(0, 150)}`;
        }
      } else if (!valid) {
        message = 'Could not reach /models. Specify a Model ID to test embeddings.';
      }
    } else if (body.type === 'anthropic-compatible') {
      let sanitizedBase = body.baseUrl.trim().replace(/\/+$/, '');
      if (sanitizedBase.endsWith('/messages')) {
        sanitizedBase = sanitizedBase.slice(0, -'/messages'.length);
      }
      const anthropicHeaders: Record<string, string> = {
        ...headers,
        'anthropic-version': '2023-06-01',
      };
      if (body.apiKey) anthropicHeaders['x-api-key'] = body.apiKey;

      try {
        const mRes = await fetch(`${sanitizedBase}/models`, {
          headers: anthropicHeaders,
          signal: controller.signal,
        });
        if (mRes.ok) {
          const data: any = await mRes.json().catch(() => null);
          if (Array.isArray(data?.data)) {
            models = data.data.map((m: any) => m?.id).filter(Boolean);
          } else if (Array.isArray(data)) {
            models = data.map((m: any) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
          }
          valid = true;
        }
      } catch {}

      if (!valid && body.modelId) {
        const cRes = await fetch(`${sanitizedBase}/messages`, {
          method: 'POST',
          headers: { ...anthropicHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: body.modelId,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
          }),
          signal: controller.signal,
        });
        if (cRes.ok) {
          valid = true;
          if (!models.includes(body.modelId)) models.push(body.modelId);
        } else {
          const errText = await cRes.text().catch(() => '');
          message = `Anthropic check failed (${cRes.status}): ${errText.slice(0, 150)}`;
        }
      } else if (!valid) {
        message = 'Could not reach /models on Anthropic-compatible endpoint.';
      }
    } else {
      // openai-compatible
      const sanitizedBase = body.baseUrl.trim().replace(/\/+$/, '');
      try {
        const mRes = await fetch(`${sanitizedBase}/models`, {
          headers,
          signal: controller.signal,
        });
        if (mRes.ok) {
          const data: any = await mRes.json().catch(() => null);
          if (Array.isArray(data?.data)) {
            models = data.data.map((m: any) => m?.id).filter(Boolean);
          } else if (Array.isArray(data)) {
            models = data.map((m: any) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
          }
          valid = true;
        }
      } catch {}

      if (!valid && body.modelId) {
        const cRes = await fetch(`${sanitizedBase}/chat/completions`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: body.modelId,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
          }),
          signal: controller.signal,
        });
        if (cRes.ok) {
          valid = true;
          if (!models.includes(body.modelId)) models.push(body.modelId);
        } else {
          const errText = await cRes.text().catch(() => '');
          message = `Chat completion check failed (${cRes.status}): ${errText.slice(0, 150)}`;
        }
      } else if (!valid) {
        message = 'Could not reach /models on OpenAI-compatible endpoint.';
      }
    }
  } catch (err: any) {
    message = err.name === 'AbortError' ? 'Request timed out after 12s' : (err.message || 'Connection failed');
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - start;
  return res.json({
    ok: valid,
    valid,
    latencyMs,
    models,
    message: message || (valid ? 'Endpoint connection successful' : 'Validation failed'),
    error: valid ? undefined : (message || 'Validation failed'),
  });
});

providerAccountsRouter.post('/test-batch', requirePermission('test_keys'), async (req, res) => {
  const body = parse(batchTestSchema, req.body ?? {});
  const rows = listAccountRowsForBatchTest({ providerId: body.providerId, accountIds: body.accountIds });
  const results: Array<{ id: number; label: string; provider: string; ok: boolean; message?: string }> = [];

  for (const row of rows) {
    const provider = resolveAccountProvider(row);
    if (!provider || !provider.supportsKeyValidation) {
      results.push({
        id: row.id,
        label: row.label,
        provider: row.provider,
        ok: false,
        message: 'Provider does not support credential health checks.',
      });
      continue;
    }
    try {
      const credential = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      const ok = await withKeyProxy(resolveXGatewayAccountProxy(row), async () => {
        return (await provider.validateKey(credential, { platform: row.platform, keyId: row.id })) === true;
      });
      setAccountStatus(row.id, ok ? 'healthy' : 'error');
      results.push({
        id: row.id,
        label: row.label,
        provider: row.provider,
        ok,
        ...(ok ? {} : { message: 'Account health check failed.' }),
      });
    } catch {
      setAccountStatus(row.id, 'error');
      results.push({
        id: row.id,
        label: row.label,
        provider: row.provider,
        ok: false,
        message: 'Account health check failed.',
      });
    }
  }

  const passed = results.filter(r => r.ok).length;
  res.json({
    results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
    },
  });
});

providerAccountsRouter.post('/providers/:providerId/toggle', requirePermission('edit_keys'), (req, res) => {
  const providerId = String(req.params.providerId ?? '').trim();
  const body = parse(providerToggleSchema, req.body);
  const updated = toggleProviderAccounts(providerId, body.enabled);
  res.json({ ok: true, providerId, enabled: body.enabled, updated });
});

providerAccountsRouter.get('/providers/:providerId/models', requirePermission('view_keys'), (req, res) => {
  const rawId = String(req.params.providerId ?? '').trim();
  const normalized = normalizeXGatewayProviderId(rawId);
  if (!normalized) throw new AccountError(404, 'Unknown provider.');
  const catalogModels = getXGatewayProvider(normalized)?.models ?? [];
  const config = getProviderModelConfig(normalized);
  res.json({
    providerId: normalized,
    catalogModels,
    disabledModels: config.disabledModels,
    customModels: config.customModels,
    modelAliases: config.modelAliases,
  });
});

providerAccountsRouter.put('/providers/:providerId/models', requirePermission('edit_keys'), (req, res) => {
  const rawId = String(req.params.providerId ?? '').trim();
  const normalized = normalizeXGatewayProviderId(rawId);
  if (!normalized) throw new AccountError(404, 'Unknown provider.');
  const body = parse(providerModelsSchema, req.body ?? {});
  const updated = setProviderModelConfig(normalized, {
    disabledModels: body.disabledModels,
    customModels: body.customModels?.map(m => ({ id: m.id, name: m.name || m.id })),
    modelAliases: body.modelAliases,
  });
  res.json({
    providerId: normalized,
    disabledModels: updated.disabledModels,
    customModels: updated.customModels,
    modelAliases: updated.modelAliases,
  });
});

providerAccountsRouter.post('/providers/:providerId/models/ping', requirePermission('test_keys'), async (req, res) => {
  const providerId = String(req.params.providerId ?? '').trim();
  const body = parse(pingModelSchema, req.body);
  const normalized = normalizeXGatewayProviderId(providerId) ?? providerId;

  const usableKeys = getUsableXGatewayKeys();
  const account = usableKeys.find(
    k => k.provider.toLowerCase() === normalized.toLowerCase() || k.provider.toLowerCase() === providerId.toLowerCase()
  );

  if (!account) {
    res.json({
      ok: false,
      latencyMs: 0,
      model: body.model,
      message: `No enabled account found for provider "${providerId}".`,
    });
    return;
  }

  const providerInstance = resolveAccountProvider(account);
  if (!providerInstance) {
    res.json({
      ok: false,
      latencyMs: 0,
      model: body.model,
      message: `Provider "${providerId}" implementation is unavailable.`,
    });
    return;
  }

  const startMs = Date.now();
  try {
    const credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
    const proxyUrl = resolveXGatewayAccountProxy(account);

    await withKeyProxy(proxyUrl, async () => {
      await providerInstance.chatCompletion(
        credential,
        [{ role: 'user', content: 'hi' }],
        body.model,
        { max_tokens: 1, timeoutMs: 15_000 },
        { platform: account.platform, keyId: account.id, modelId: body.model }
      );
    });

    const latencyMs = Date.now() - startMs;
    res.json({
      ok: true,
      latencyMs,
      model: body.model,
      message: 'Pong',
    });
  } catch (err: any) {
    const latencyMs = Date.now() - startMs;
    res.json({
      ok: false,
      latencyMs,
      model: body.model,
      message: err?.message || 'Ping request failed.',
    });
  }
});

providerAccountsRouter.post('/auth/:provider/start', async (req: SessionRequest, res) => {
  const provider = parse(z.enum(['openrouter', 'github-copilot']), req.params.provider);
  const body = parse(startSchema, req.body);
  const authorize = authCheck(req, provider, body.reconnectId);
  authorize();
  const origin = req.get('Origin') ?? `${req.protocol}://${req.get('Host') ?? ''}`;
  res.json(await withKeyProxy(resolveXGatewayAccountProxy(null), () =>
    startAccountAuth({ ...body, provider }, actor(req), origin, authorize),
  ));
});
providerAccountsRouter.post('/auth/:attemptId/complete', async (req: SessionRequest, res) => {
  const { code } = parse(completeSchema, req.body);
  const { attemptId, owner, authorize } = existingAttempt(req);
  res.json(await withKeyProxy(resolveXGatewayAccountProxy(null), () =>
    completeAccountAuth(attemptId, owner, code, authorize),
  ));
});
providerAccountsRouter.post('/auth/:attemptId/poll', async (req: SessionRequest, res) => {
  parse(emptySchema, req.body ?? {});
  const { attemptId, owner, authorize } = existingAttempt(req);
  res.json(await withKeyProxy(resolveXGatewayAccountProxy(null), () =>
    pollAccountAuth(attemptId, owner, authorize),
  ));
});
providerAccountsRouter.delete('/auth/:attemptId', (req: SessionRequest, res) => {
  parse(emptySchema, req.body ?? {});
  const { attemptId, owner } = existingAttempt(req);
  cancelAccountAuth(attemptId, owner);
  res.status(204).end();
});

providerAccountsRouter.patch('/:id', requirePermission('edit_keys'), (req, res) => {
  const accountId = id(req);
  const patch = parse(updateSchema, req.body);
  const updated = updateAccount(accountId, patch);
  res.json({ id: updated.id, label: updated.label, enabled: updated.enabled === 1 });
});
providerAccountsRouter.delete('/:id', requirePermission('delete_keys'), (req, res) => {
  const accountId = id(req);
  parse(emptySchema, req.body ?? {});
  deleteAccount(accountId);
  res.json({ ok: true, id: accountId });
});
providerAccountsRouter.post('/:id/test', requirePermission('test_keys'), async (req, res) => {
  const row = accountRow(id(req));
  const body = parse(testSchema, req.body ?? {});
  const provider = resolveAccountProvider(row);
  if (!provider) throw new AccountError(400, 'Account provider is unavailable.');
  if (!body.message && !provider.supportsKeyValidation) {
    res.json({ ok: false, message: 'This provider does not support credential health checks.' });
    return;
  }
  const models = body.message ? accountModels(row) : [];
  const model = body.model ?? models[0]?.id;
  if (body.message && (!model || !models.some(m => m.id === model))) throw new AccountError(400, 'Select an eligible account model.');
  try {
    const credential = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    const ok = await withKeyProxy(resolveXGatewayAccountProxy(row), async () => {
      if (!body.message) return await provider.validateKey(credential, { platform: row.platform, keyId: row.id }) === true;
      const result = await provider.chatCompletion(credential, [{ role: 'user', content: body.message }], model!, {
        max_tokens: 128, timeoutMs: 30_000,
      }, { platform: row.platform, keyId: row.id, modelId: model });
      return Array.isArray(result.choices) && result.choices.length > 0;
    });
    setAccountStatus(row.id, ok ? 'healthy' : 'error');
    res.json({ ok, ...(ok ? {} : { message: 'Account health check failed.' }) });
  } catch {
    setAccountStatus(row.id, 'error');
    res.json({ ok: false, message: 'Account health check failed.' });
  }
});

providerAccountsRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const known = err instanceof AccountError;
  res.status(known ? err.status : 500).json({ error: {
    type: known && err.status === 502 ? 'upstream_error' : 'account_error',
    message: known ? err.message : 'Provider account request failed.',
  } });
});
