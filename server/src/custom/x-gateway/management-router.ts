import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import type { SessionUser } from '../../services/auth.js';
import { getXGatewayProvider } from '../provider-accounts/catalog.js';
import { accountModels, getUsableXGatewayKeys } from '../provider-accounts/store.js';
import {
  buildComboPresets,
  COMBO_PRESET_NAMES,
  MAX_COMBO_DESCRIPTION,
  MAX_COMBOS,
  validateCombo,
  type ComboEntry,
  type ComboPresetCandidate,
} from './combos.js';
import { createCombo, deleteCombo, getComboById, listCombos, updateCombo } from './config.js';
import { getActiveCooldownsForKeys } from '../../services/ratelimit.js';
import { calculateRequestCost } from './pricing.js';

/** Combos CRUD, request log, hourly usage and an in-console playground.
 *
 * Mounted under the console router, so every handler already runs behind the
 * `/api/thruline` permission gate (`permissionForAction` maps combos, usage and
 * test paths to their dedicated leaves).
 */
export const xGatewayManagementRouter = Router();

const comboSchema = z.object({
  name: z.string().trim().min(1).max(48),
  entries: z.array(z.object({ platform: z.string(), modelId: z.string() })).min(1).max(20),
  strategy: z.enum(['fallback', 'round-robin', 'smart', 'fusion']).optional(),
  smartPolicy: z.enum(['smart', 'strict', 'per-turn', 'custom']).optional(),
  sessionSticky: z.boolean().optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  description: z.string().trim().max(MAX_COMBO_DESCRIPTION).optional(),
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

/** Every (provider, model) pair a preset may route to, from accounts usable now. */
function collectPresetCandidates(): ComboPresetCandidate[] {
  const candidates: ComboPresetCandidate[] = [];
  for (const account of getUsableXGatewayKeys()) {
    const provider = getXGatewayProvider(account.provider);
    const free = provider?.category === 'free' || provider?.category === 'freeTier';
    for (const model of accountModels(account)) {
      candidates.push({ platform: account.provider, modelId: model.id, free });
    }
  }
  return candidates;
}

xGatewayManagementRouter.get('/combos', (_req, res) => {
  res.json({ combos: listCombos() });
});

xGatewayManagementRouter.post('/combos', (req, res) => {
  const parsed = comboSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid request.');
  const check = validateCombo(parsed.data.name, parsed.data.entries, {
    totalCombos: listCombos().length,
    strategy: parsed.data.strategy,
    smartPolicy: parsed.data.smartPolicy,
    sessionSticky: parsed.data.sessionSticky,
    confidenceThreshold: parsed.data.confidenceThreshold,
    description: parsed.data.description,
  });
  if (!check.valid) return fail(res, 400, check.error);
  try {
    res.status(201).json(createCombo(
      parsed.data.name,
      parsed.data.entries as ComboEntry[],
      userId(req),
      {
        strategy: parsed.data.strategy,
        description: parsed.data.description,
        smartPolicy: parsed.data.smartPolicy,
        sessionSticky: parsed.data.sessionSticky,
        confidenceThreshold: parsed.data.confidenceThreshold,
      },
    ));
  } catch (err) {
    if (isUniqueViolation(err)) return fail(res, 409, 'A combo with this name already exists.');
    throw err;
  }
});

xGatewayManagementRouter.post('/combos/presets', (req, res) => {
  const existing = listCombos();
  const taken = new Set(existing.map(combo => combo.name.toLowerCase()));
  const built = buildComboPresets(collectPresetCandidates());
  const builtNames = new Set(built.map(preset => preset.name));
  const created: ReturnType<typeof createCombo>[] = [];
  const skipped: Array<{ name: string; reason: 'exists' | 'no_models' | 'limit' }> = [];
  let total = existing.length;

  for (const preset of built) {
    if (taken.has(preset.name)) {
      skipped.push({ name: preset.name, reason: 'exists' });
      continue;
    }
    if (total >= MAX_COMBOS) {
      skipped.push({ name: preset.name, reason: 'limit' });
      continue;
    }
    try {
      created.push(createCombo(preset.name, preset.entries, userId(req), {
        strategy: preset.strategy,
        description: preset.description,
      }));
      taken.add(preset.name);
      total += 1;
    } catch (err) {
      if (isUniqueViolation(err)) {
        skipped.push({ name: preset.name, reason: 'exists' });
        continue;
      }
      throw err;
    }
  }

  // Presets with no matching model were not built; report them so the console
  // can explain why only some of the starter combos appeared.
  for (const name of COMBO_PRESET_NAMES) {
    if (!builtNames.has(name) && !taken.has(name)) {
      skipped.push({ name, reason: 'no_models' });
    }
  }

  res.json({ created, skipped, createdCount: created.length, skippedCount: skipped.length });
});

xGatewayManagementRouter.put('/combos/:id', (req, res) => {
  const id = parseId(req);
  if (!id) return fail(res, 400, 'Invalid combo ID.');
  const parsed = comboSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid request.');
  if (!getComboById(id)) return fail(res, 404, 'Combo not found.');
  const check = validateCombo(parsed.data.name, parsed.data.entries, {
    strategy: parsed.data.strategy,
    smartPolicy: parsed.data.smartPolicy,
    sessionSticky: parsed.data.sessionSticky,
    confidenceThreshold: parsed.data.confidenceThreshold,
    description: parsed.data.description,
  });
  if (!check.valid) return fail(res, 400, check.error);
  try {
    const updated = updateCombo(
      id,
      parsed.data.name,
      parsed.data.entries as ComboEntry[],
      {
        strategy: parsed.data.strategy,
        description: parsed.data.description,
        smartPolicy: parsed.data.smartPolicy,
        sessionSticky: parsed.data.sessionSticky,
        confidenceThreshold: parsed.data.confidenceThreshold,
      },
    );
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

xGatewayManagementRouter.delete('/usage/logs', (req, res) => {
  const user = (req as Request & { user?: SessionUser }).user;
  if (!user?.isPrimary) {
    return fail(res, 403, 'Primary Admin access required.');
  }
  const info = getDb().prepare("DELETE FROM requests WHERE caller = 'x-gateway'").run();
  res.json({ ok: true, deleted: info.changes });
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

/* ----------------------------------------------------------------------------
 * Usage breakdown: provider topology + per model / account / client key / endpoint.
 * Source of truth is the shared `requests` log (rows tagged `caller = 'x-gateway'`)
 * plus `x_gateway_key_monthly_usage` for per-account counters.
 * -------------------------------------------------------------------------- */

const BREAKDOWN_RANGES = ['24h', '7d', '30d', 'all'] as const;
type BreakdownRange = (typeof BREAKDOWN_RANGES)[number];

const BREAKDOWN_ENDPOINTS = [
  'chat/completions', 'messages', 'responses', 'embeddings', 'images', 'audio', 'search', 'fetch',
] as const;

/** `requests.request_type` (plus a few aliases) -> public gateway endpoint. */
function endpointForRequestType(type: string | null): string {
  switch ((type ?? 'chat').toLowerCase()) {
    case 'embedding': case 'embeddings': return 'embeddings';
    case 'image': case 'images': case 'video': return 'images';
    case 'audio': case 'transcription': case 'speech': case 'tts': case 'stt': return 'audio';
    case 'search': return 'search';
    case 'fetch': return 'fetch';
    case 'messages': return 'messages';
    case 'responses': return 'responses';
    default: return 'chat/completions';
  }
}

function breakdownSince(range: BreakdownRange): string | null {
  const hours = range === '24h' ? 24 : range === '7d' ? 168 : range === '30d' ? 720 : 0;
  if (!hours) return null;
  return new Date(Date.now() - hours * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

interface BreakdownAgg {
  requests: number; successCount: number; errorCount: number;
  promptTokens: number; completionTokens: number; latencySum: number;
}

function emptyAgg(): BreakdownAgg {
  return { requests: 0, successCount: 0, errorCount: 0, promptTokens: 0, completionTokens: 0, latencySum: 0 };
}

interface AggRow {
  requests: number; success: number; errors: number;
  promptTokens: number; completionTokens: number; latencySum: number;
}

function addAgg(a: BreakdownAgg, row: AggRow): void {
  a.requests += row.requests;
  a.successCount += row.success;
  a.errorCount += row.errors;
  a.promptTokens += row.promptTokens;
  a.completionTokens += row.completionTokens;
  a.latencySum += row.latencySum;
}

function aggView(a: BreakdownAgg) {
  return {
    requests: a.requests,
    successCount: a.successCount,
    errorCount: a.errorCount,
    promptTokens: a.promptTokens,
    completionTokens: a.completionTokens,
    totalTokens: a.promptTokens + a.completionTokens,
    successRate: a.requests ? round1((a.successCount / a.requests) * 100) : 100,
    avgLatencyMs: a.requests ? Math.round(a.latencySum / a.requests) : 0,
  };
}

const AGG_COLUMNS = `COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success,
            COALESCE(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END), 0) AS errors,
            COALESCE(SUM(input_tokens), 0) AS promptTokens,
            COALESCE(SUM(output_tokens), 0) AS completionTokens,
            COALESCE(SUM(latency_ms), 0) AS latencySum`;

xGatewayManagementRouter.get('/usage/breakdown', (req, res) => {
  const rawRange = String(req.query.range ?? '7d');
  if (!(BREAKDOWN_RANGES as readonly string[]).includes(rawRange)) {
    fail(res, 400, `range must be one of ${BREAKDOWN_RANGES.join(', ')}`);
    return;
  }
  const range = rawRange as BreakdownRange;
  const since = breakdownSince(range);
  const db = getDb();
  const month = new Date().toISOString().slice(0, 7);
  const where = `caller = 'x-gateway'${since ? ' AND created_at >= ?' : ''}`;
  const params: unknown[] = since ? [since] : [];

  // Providers + accounts (accounts are the topology's source of nodes).
  const accounts = db.prepare(
    `SELECT k.id, k.provider, k.label, k.status, k.enabled, k.monthly_request_cap AS monthlyRequestCap,
            k.monthly_token_cap AS monthlyTokenCap,
            COALESCE(u.requests, 0) AS monthlyRequests, COALESCE(u.tokens, 0) AS monthlyTokens
       FROM x_gateway_keys k
       LEFT JOIN x_gateway_key_monthly_usage u ON u.key_id = k.id AND u.month = ?
      ORDER BY k.provider, k.id`,
  ).all(month) as Array<{
    id: number; provider: string; label: string; status: string; enabled: number;
    monthlyRequestCap: number; monthlyTokenCap: number; monthlyRequests: number; monthlyTokens: number;
  }>;

  let cooldowns = new Map<number, unknown[]>();
  try {
    cooldowns = getActiveCooldownsForKeys(accounts.map(a => a.id)) as Map<number, unknown[]>;
  } catch {
    cooldowns = new Map();
  }

  const providerRows = db.prepare(
    `SELECT platform, ${AGG_COLUMNS} FROM requests WHERE ${where} GROUP BY platform`,
  ).all(...params) as Array<AggRow & { platform: string }>;
  const providerAgg = new Map(providerRows.map(r => [r.platform, r]));

  const providerIds = [...new Set(accounts.map(a => a.provider))];
  const topology = providerIds.map(id => {
    const list = accounts.filter(a => a.provider === id);
    const enabled = list.filter(a => a.enabled === 1);
    const usable = enabled.filter(a => a.status !== 'invalid' && a.status !== 'disabled');
    const cooling = usable.filter(a => (cooldowns.get(a.id)?.length ?? 0) > 0);
    const erroring = usable.filter(a => a.status === 'error');
    const agg = emptyAgg();
    const row = providerAgg.get(id);
    if (row) addAgg(agg, row);
    const view = aggView(agg);

    let status: 'healthy' | 'degraded' | 'cooldown' | 'paused';
    if (enabled.length === 0) status = 'paused';
    else if (usable.length > 0 && cooling.length === usable.length) status = 'cooldown';
    else if (usable.length === 0 || cooling.length > 0 || erroring.length > 0 || (view.requests >= 5 && view.successRate < 80)) {
      status = 'degraded';
    } else status = 'healthy';

    return {
      provider: id,
      name: getXGatewayProvider(id)?.name ?? id,
      status,
      totalAccounts: list.length,
      activeAccounts: usable.length - cooling.length,
      cooldownAccounts: cooling.length,
      monthlyRequests: list.reduce((s, a) => s + a.monthlyRequests, 0),
      monthlyTokens: list.reduce((s, a) => s + a.monthlyTokens, 0),
      ...view,
    };
  });

  // byModel
  const modelRows = db.prepare(
    `SELECT platform, model_id AS modelId, ${AGG_COLUMNS}
       FROM requests WHERE ${where} GROUP BY platform, model_id ORDER BY requests DESC`,
  ).all(...params) as Array<AggRow & { platform: string; modelId: string }>;
  const byModel = modelRows.map(r => {
    const agg = emptyAgg();
    addAgg(agg, r);
    return {
      provider: r.platform,
      model: r.modelId,
      ...aggView(agg),
      estimatedCostUsd: round6(calculateRequestCost(r.platform, r.modelId, r.promptTokens, r.completionTokens)),
    };
  });

  // byAccount: monthly counters are the per-account source of truth (log rows carry
  // no account id), plus any log rows that were attributed through `key_id`.
  const keyed = db.prepare(
    `SELECT key_id AS keyId, ${AGG_COLUMNS} FROM requests
      WHERE ${where} AND key_id IS NOT NULL GROUP BY key_id`,
  ).all(...params) as Array<AggRow & { keyId: number }>;
  const keyedById = new Map(keyed.map(r => [r.keyId, r]));
  const byAccount = accounts.map(a => {
    const agg = emptyAgg();
    const logged = keyedById.get(a.id);
    if (logged) addAgg(agg, logged);
    return {
      id: a.id,
      provider: a.provider,
      providerName: getXGatewayProvider(a.provider)?.name ?? a.provider,
      label: a.label,
      status: a.status,
      enabled: a.enabled === 1,
      coolingDown: (cooldowns.get(a.id)?.length ?? 0) > 0,
      month,
      monthlyRequests: a.monthlyRequests,
      monthlyTokens: a.monthlyTokens,
      monthlyRequestCap: a.monthlyRequestCap,
      monthlyTokenCap: a.monthlyTokenCap,
      loggedRequests: agg.requests,
      loggedTokens: agg.promptTokens + agg.completionTokens,
    };
  });

  // byClientKey: request rows carry the key owner (`user_id`), not the key itself,
  // so keys sharing an owner share that owner's figures (flagged via `sharedOwner`).
  const userRows = db.prepare(
    `SELECT user_id AS userId, ${AGG_COLUMNS} FROM requests
      WHERE ${where} AND user_id IS NOT NULL GROUP BY user_id`,
  ).all(...params) as Array<AggRow & { userId: number }>;
  const userAgg = new Map(userRows.map(r => [r.userId, r]));
  const clientKeys = db.prepare(
    `SELECT id, user_id AS userId, name, key_prefix AS keyPrefix, revoked, rpm_limit AS rpmLimit,
            created_at AS createdAt, last_used_at AS lastUsedAt
       FROM x_gateway_client_keys ORDER BY id`,
  ).all() as Array<{
    id: number; userId: number; name: string; keyPrefix: string; revoked: number; rpmLimit: number;
    createdAt: string; lastUsedAt: string | null;
  }>;
  const keysPerUser = new Map<number, number>();
  for (const k of clientKeys) keysPerUser.set(k.userId, (keysPerUser.get(k.userId) ?? 0) + 1);
  const byClientKey = clientKeys.map(k => {
    const agg = emptyAgg();
    const row = userAgg.get(k.userId);
    if (row) addAgg(agg, row);
    return {
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      userId: k.userId,
      revoked: k.revoked === 1,
      rpmLimit: k.rpmLimit,
      lastUsedAt: k.lastUsedAt,
      sharedOwner: (keysPerUser.get(k.userId) ?? 0) > 1,
      ...aggView(agg),
    };
  });

  // byEndpoint
  const typeRows = db.prepare(
    `SELECT request_type AS requestType, ${AGG_COLUMNS} FROM requests WHERE ${where} GROUP BY request_type`,
  ).all(...params) as Array<AggRow & { requestType: string | null }>;
  const endpointAgg = new Map<string, BreakdownAgg>(BREAKDOWN_ENDPOINTS.map(e => [e, emptyAgg()]));
  for (const r of typeRows) addAgg(endpointAgg.get(endpointForRequestType(r.requestType))!, r);
  const byEndpoint = BREAKDOWN_ENDPOINTS.map(endpoint => ({
    endpoint,
    ...aggView(endpointAgg.get(endpoint)!),
  }));

  res.json({ range, since, month, topology, byModel, byAccount, byClientKey, byEndpoint });
});

/* ----------------------------------------------------------------------------
 * Paginated request details (inspector tab).
 * -------------------------------------------------------------------------- */

/** `YYYY-MM-DD` or ISO timestamp -> the `YYYY-MM-DD HH:MM:SS` UTC form stored in `requests.created_at`. */
function parseDetailDate(raw: unknown, endOfDay: boolean): string | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  const text = String(raw).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const ms = Date.parse(dateOnly ? `${text}T${endOfDay ? '23:59:59' : '00:00:00'}Z` : text);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function parseIntParam(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const text = String(raw).trim();
  return /^-?\d+$/.test(text) ? Number(text) : Number.NaN;
}

xGatewayManagementRouter.get('/usage/request-details', (req, res) => {
  const page = parseIntParam(req.query.page, 1);
  const pageSize = parseIntParam(req.query.pageSize, 20);
  if (!Number.isInteger(page) || page < 1) { fail(res, 400, 'page must be an integer >= 1'); return; }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    fail(res, 400, 'pageSize must be an integer between 1 and 100');
    return;
  }
  const status = req.query.status === undefined || req.query.status === '' ? null : String(req.query.status);
  if (status !== null && status !== 'success' && status !== 'error') {
    fail(res, 400, 'status must be success or error');
    return;
  }
  const startDate = parseDetailDate(req.query.startDate, false);
  const endDate = parseDetailDate(req.query.endDate, true);
  if (startDate === null || endDate === null) { fail(res, 400, 'startDate/endDate must be ISO timestamps or YYYY-MM-DD'); return; }
  let accountId: number | null = null;
  if (req.query.accountId !== undefined && req.query.accountId !== '') {
    const parsed = parseIntParam(req.query.accountId, Number.NaN);
    if (!Number.isInteger(parsed)) { fail(res, 400, 'accountId must be an integer'); return; }
    accountId = parsed;
  }

  const conditions = ["r.caller = 'x-gateway'"];
  const params: unknown[] = [];
  const provider = typeof req.query.provider === 'string' ? req.query.provider.trim() : '';
  if (provider) { conditions.push('r.platform = ?'); params.push(provider); }
  const model = typeof req.query.model === 'string' ? req.query.model.trim() : '';
  if (model) {
    const like = `%${model.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
    conditions.push("(r.model_id LIKE ? ESCAPE '\\' OR r.requested_model LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  if (accountId !== null) { conditions.push('r.key_id = ?'); params.push(accountId); }
  if (status) { conditions.push('r.status = ?'); params.push(status); }
  if (startDate) { conditions.push('r.created_at >= ?'); params.push(startDate); }
  if (endDate) { conditions.push('r.created_at <= ?'); params.push(endDate); }
  const where = conditions.join(' AND ');

  const db = getDb();
  const totalCount = (db.prepare(`SELECT COUNT(*) AS n FROM requests r WHERE ${where}`).get(...params) as { n: number }).n;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  // Account labels come from the X Gateway account table (log rows reference it via key_id).
  const rows = db.prepare(
    `SELECT r.id, r.platform, r.key_id AS accountId, k.label AS accountLabel, r.model_id AS modelId,
            r.requested_model AS requestedModel, r.request_type AS requestType, r.status,
            r.latency_ms AS latencyMs, r.input_tokens AS inputTokens, r.output_tokens AS outputTokens,
            r.error, r.created_at AS createdAt
       FROM requests r
       LEFT JOIN x_gateway_keys k ON k.id = r.key_id
      WHERE ${where}
      ORDER BY r.id DESC LIMIT ? OFFSET ?`,
  ).all(...params, pageSize, (page - 1) * pageSize) as Array<{
    id: number; platform: string; accountId: number | null; accountLabel: string | null; modelId: string;
    requestedModel: string | null; requestType: string | null; status: string; latencyMs: number;
    inputTokens: number; outputTokens: number; error: string | null; createdAt: string;
  }>;

  const details = rows.map(r => ({
    id: r.id,
    provider: r.platform,
    accountId: r.accountId,
    accountLabel: r.accountLabel,
    modelId: r.modelId,
    requestedModel: r.requestedModel,
    requestType: r.requestType ?? 'chat',
    endpoint: endpointForRequestType(r.requestType),
    status: r.status,
    latencyMs: r.latencyMs,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    // The request log does not record cache / reasoning splits.
    cachedTokens: 0,
    reasoningTokens: 0,
    estimatedCost: round6(calculateRequestCost(r.platform, r.modelId, r.inputTokens, r.outputTokens)),
    error: r.error,
    createdAt: r.createdAt,
  }));

  const providers = (db.prepare(
    "SELECT DISTINCT platform FROM requests WHERE caller = 'x-gateway' ORDER BY platform",
  ).all() as Array<{ platform: string }>).map(r => r.platform);
  const models = (db.prepare(
    "SELECT DISTINCT model_id FROM requests WHERE caller = 'x-gateway' ORDER BY model_id LIMIT 500",
  ).all() as Array<{ model_id: string }>).map(r => r.model_id);

  res.json({ page, pageSize, totalCount, totalPages, details, filters: { providers, models } });
});