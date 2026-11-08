import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
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
  strategy: z.enum(['fallback', 'round-robin', 'smart', 'fusion']).optional(),
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
    description: parsed.data.description,
  });
  if (!check.valid) return fail(res, 400, check.error);
  try {
    res.status(201).json(createCombo(
      parsed.data.name,
      parsed.data.entries as ComboEntry[],
      userId(req),
      { strategy: parsed.data.strategy, description: parsed.data.description },
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
    description: parsed.data.description,
  });
  if (!check.valid) return fail(res, 400, check.error);
  try {
    const updated = updateCombo(
      id,
      parsed.data.name,
      parsed.data.entries as ComboEntry[],
      { strategy: parsed.data.strategy, description: parsed.data.description },
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
