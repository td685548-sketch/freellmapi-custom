import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { getDb } from '../../db/index.js';
import { decrypt } from '../../lib/crypto.js';
import { withKeyProxy } from '../../lib/proxy.js';
import { logRequest } from '../../lib/request-log.js';
import { resolveXGatewayProvider } from '../provider-accounts/catalog.js';
import { recordXGatewayKeyUsage, resolveXGatewayAccountProxy } from '../provider-accounts/store.js';
import { validateCombo, type ComboEntry } from './combos.js';
import { createCombo, deleteCombo, getComboById, listCombos, updateCombo } from './config.js';
import { applyGatewaySavers, resolveCandidateRoutes } from './router.js';

/** Combos CRUD, request log, hourly usage and an in-console playground.
 *
 * Mounted under the console router, so every handler already runs behind the
 * `/api/x-gateway` permission gate (`permissionForAction` maps combos, usage and
 * test paths to their dedicated leaves).
 */
export const xGatewayManagementRouter = Router();

const comboSchema = z.object({
  name: z.string().trim().min(1).max(48),
  entries: z.array(z.object({ platform: z.string(), modelId: z.string() })).min(1).max(20),
}).strict();

const playgroundSchema = z.object({
  model: z.string().trim().max(200).optional(),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().max(100_000),
  })).min(1).max(100),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(32_768).optional(),
}).strict();

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { type: 'gateway_console_error', message } });
}

function parseId(req: Request): number | null {
  const raw = String(req.params.id ?? '');
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
}

function userId(req: Request): number | undefined {
  return (req as Request & { user?: { userId?: number } }).user?.userId;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE/i.test(err.message);
}

xGatewayManagementRouter.get('/combos', (_req, res) => {
  res.json({ combos: listCombos() });
});

xGatewayManagementRouter.post('/combos', (req, res) => {
  const parsed = comboSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid request.');
  const check = validateCombo(parsed.data.name, parsed.data.entries, { totalCombos: listCombos().length });
  if (!check.valid) return fail(res, 400, check.error);
  try {
    res.status(201).json(createCombo(parsed.data.name, parsed.data.entries as ComboEntry[], userId(req)));
  } catch (err) {
    if (isUniqueViolation(err)) return fail(res, 409, 'A combo with this name already exists.');
    throw err;
  }
});

xGatewayManagementRouter.put('/combos/:id', (req, res) => {
  const id = parseId(req);
  if (!id) return fail(res, 400, 'Invalid combo ID.');
  const parsed = comboSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid request.');
  if (!getComboById(id)) return fail(res, 404, 'Combo not found.');
  const check = validateCombo(parsed.data.name, parsed.data.entries);
  if (!check.valid) return fail(res, 400, check.error);
  try {
    const updated = updateCombo(id, parsed.data.name, parsed.data.entries as ComboEntry[]);
    if (!updated) return fail(res, 404, 'Combo not found.');
    res.json(updated);
  } catch (err) {
    if (isUniqueViolation(err)) return fail(res, 409, 'A combo with this name already exists.');
    throw err;
  }
});

xGatewayManagementRouter.delete('/combos/:id', (req, res) => {
  const id = parseId(req);
  if (!id) return fail(res, 400, 'Invalid combo ID.');
  if (!deleteCombo(id)) return fail(res, 404, 'Combo not found.');
  res.json({ ok: true, id });
});

xGatewayManagementRouter.get('/usage/logs', (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500);
  const status = req.query.status === 'error' || req.query.status === 'success' ? req.query.status : null;
  const rows = getDb().prepare(
    `SELECT id, platform, model_id AS modelId, status, input_tokens AS inputTokens,
            output_tokens AS outputTokens, latency_ms AS latencyMs, error,
            requested_model AS requestedModel, created_at AS createdAt
       FROM requests
      WHERE caller = 'x-gateway' ${status ? 'AND status = ?' : ''}
      ORDER BY id DESC LIMIT ?`,
  ).all(...(status ? [status, limit] : [limit]));
  res.json({ logs: rows });
});

xGatewayManagementRouter.get('/usage/hourly', (req, res) => {
  const hours = Math.min(Math.max(Number.parseInt(String(req.query.hours ?? '24'), 10) || 24, 1), 168);
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const rows = getDb().prepare(
    `SELECT substr(created_at, 1, 13) AS hour,
            COUNT(*) AS requests,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS errors,
            COALESCE(SUM(input_tokens), 0) AS inputTokens,
            COALESCE(SUM(output_tokens), 0) AS outputTokens
       FROM requests
      WHERE caller = 'x-gateway' AND created_at >= ?
      GROUP BY hour ORDER BY hour ASC`,
  ).all(since);
  res.json({ hours, buckets: rows });
});

// POST /api/x-gateway/test — run one non-streaming chat through the same routing as /x/v1.
xGatewayManagementRouter.post('/test', async (req, res) => {
  const parsed = playgroundSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid request.');
  const startMs = Date.now();
  const requestedModel = parsed.data.model || 'auto';
  const { candidates, notFoundError } = resolveCandidateRoutes(requestedModel);
  if (notFoundError) return fail(res, 404, notFoundError);
  if (candidates.length === 0) return fail(res, 503, 'No enabled X Gateway provider accounts available.');
  const { messages } = applyGatewaySavers(req, parsed.data.messages as ChatMessage[]);

  let lastError = 'All X Gateway provider accounts failed.';
  for (const { account, modelId } of candidates) {
    const provider = resolveXGatewayProvider(account.provider, account.base_url);
    if (!provider) continue;
    try {
      const credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
      const completion = await withKeyProxy(resolveXGatewayAccountProxy(account), () =>
        provider.chatCompletion(
          credential,
          messages,
          modelId,
          { temperature: parsed.data.temperature, max_tokens: parsed.data.max_tokens },
          { platform: account.platform, keyId: account.id, modelId },
        ),
      );
      const latencyMs = Date.now() - startMs;
      const promptTokens = completion.usage?.prompt_tokens ?? 0;
      const completionTokens = completion.usage?.completion_tokens ?? 0;
      recordXGatewayKeyUsage(account.id, promptTokens + completionTokens);
      logRequest(
        account.provider, modelId, null, 'success', promptTokens, completionTokens,
        latencyMs, null, latencyMs, requestedModel === 'auto' ? null : requestedModel, null, 'x-gateway',
      );
      res.json({
        content: completion.choices?.[0]?.message?.content ?? '',
        provider: account.provider,
        accountLabel: account.label,
        model: modelId,
        latencyMs,
        usage: completion.usage ?? null,
      });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : lastError;
    }
  }
  logRequest(
    candidates[0].account.provider, candidates[0].modelId, null, 'error', 0, 0,
    Date.now() - startMs, lastError, null, requestedModel === 'auto' ? null : requestedModel, null, 'x-gateway',
  );
  fail(res, 502, lastError);
});

