import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Permission } from '@freellmapi/shared/user-access.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { hasPermission, requirePermission } from '../../middleware/requirePermission.js';
import { validateSession, type SessionUser } from '../../services/auth.js';
import { decrypt } from '../../lib/crypto.js';
import { decryptProxyUrl } from '../../lib/key-proxy.js';
import { withKeyProxy } from '../../lib/proxy.js';
import { AccountError } from './http.js';
import { resolveXGatewayProvider } from './catalog.js';
import {
  accountModels,
  accountRow,
  createApiKeyAccount,
  deleteAccount,
  listAccounts,
  updateAccount,
  type OAuthProvider,
} from './store.js';
import {
  attemptAction, cancelAccountAuth, completeAccountAuth, pollAccountAuth, startAccountAuth, type AccountActor,
} from './attempts.js';

export const providerAccountsRouter = Router();
providerAccountsRouter.use(requireAuth, requirePermission('use_x_gateway'));
providerAccountsRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

type SessionRequest = Request & { user?: SessionUser; sessionToken?: string };
const labelSchema = z.string().trim().max(200).refine(s => [...s].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127));
const createSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  key: z.string().trim().min(1).max(8192),
  label: labelSchema.optional(),
  baseUrl: z.string().trim().max(2048).optional(),
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
  monthlyRequestCap: z.number().int().min(0).safe().optional(),
  monthlyTokenCap: z.number().int().min(0).safe().optional(),
}).strict().refine(b => Object.keys(b).length > 0);
const testSchema = z.object({ model: z.string().trim().min(1).max(200).optional(), message: z.string().trim().min(1).max(4000).optional() }).strict();
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
    authMethod: body.authMethod,
    models: body.models?.map(m => ({ id: m.id, name: m.name || m.id })),
    userId: req.user?.userId ?? null,
  });
  res.status(201).json({ id: accountId });
});

providerAccountsRouter.post('/auth/:provider/start', async (req: SessionRequest, res) => {
  const provider = parse(z.enum(['openrouter', 'github-copilot']), req.params.provider);
  const body = parse(startSchema, req.body);
  const authorize = authCheck(req, provider, body.reconnectId);
  authorize();
  const origin = req.get('Origin') ?? `${req.protocol}://${req.get('Host') ?? ''}`;
  res.json(await startAccountAuth({ ...body, provider }, actor(req), origin, authorize));
});
providerAccountsRouter.post('/auth/:attemptId/complete', async (req: SessionRequest, res) => {
  const { code } = parse(completeSchema, req.body);
  const { attemptId, owner, authorize } = existingAttempt(req);
  res.json(await completeAccountAuth(attemptId, owner, code, authorize));
});
providerAccountsRouter.post('/auth/:attemptId/poll', async (req: SessionRequest, res) => {
  parse(emptySchema, req.body ?? {});
  const { attemptId, owner, authorize } = existingAttempt(req);
  res.json(await pollAccountAuth(attemptId, owner, authorize));
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
  const provider = resolveXGatewayProvider(row.provider, row.base_url);
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
    const ok = await withKeyProxy(decryptProxyUrl(row), async () => {
      if (!body.message) return await provider.validateKey(credential, { platform: row.platform, keyId: row.id }) === true;
      const result = await provider.chatCompletion(credential, [{ role: 'user', content: body.message }], model!, {
        max_tokens: 128, timeoutMs: 30_000,
      }, { platform: row.platform, keyId: row.id, modelId: model });
      return Array.isArray(result.choices) && result.choices.length > 0;
    });
    res.json({ ok, ...(ok ? {} : { message: 'Account health check failed.' }) });
  } catch {
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
