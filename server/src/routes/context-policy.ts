import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  CONTEXT_POLICY_LIMITS,
  CONTEXT_PRESETS,
  type ContextPolicyInput,
} from '@freellmapi/shared/context-budget.js';
import { getDb } from '../db/index.js';
import {
  ContextPolicyError,
  deleteContextPolicy,
  getContextPolicyDefault,
  resolveContextPolicy,
  saveContextPolicy,
  setContextPolicyDefault,
  suggestedFromConversationSettings,
} from '../custom/context-budget/policy.js';
import {
  ContextPreviewError,
  previewConversationContext,
} from '../custom/context-budget/preview.js';
import { getReportForRequest } from '../custom/context-budget/report.js';
import { getContextStats } from '../custom/context-budget/stats.js';
import { normalizeEndUser } from '../services/end-user-quotas.js';
import {
  normalizeConversationId,
  SETTINGS_COLUMNS,
  settingsFromRow,
} from '../services/profile-conversations.js';

export const contextPolicyRouter = Router();
export const contextPolicySettingsRouter = Router();

const daysQuerySchema = z.preprocess(
  (val) => {
    if (val === undefined) return 7;
    if (typeof val !== 'string' || !/^-?\d+$/.test(val.trim())) return Number.NaN;
    return Number.parseInt(val.trim(), 10);
  },
  z.number().int().min(1).max(90),
);

function firstParam(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return undefined;
}

function parsePositiveInt(raw: unknown): number | null {
  const s = firstParam(raw);
  if (!s || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

interface ProfileConvRow {
  id: number;
  convEnabled: number;
  ttl: number | null;
  maxMessages: number | null;
  maxChars: number | null;
  convSummarize: number | null;
}

function loadProfileOrRespond(req: Request, res: Response): ProfileConvRow | null {
  const id = parsePositiveInt(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'Invalid profile id', code: 'context_policy_invalid' });
    return null;
  }
  const row = getDb()
    .prepare(`SELECT id, ${SETTINGS_COLUMNS} FROM client_profiles WHERE id = ?`)
    .get(id) as ProfileConvRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'Client profile not found', code: 'profile_not_found' });
    return null;
  }
  return row;
}

function buildPolicyResponse(profile: ProfileConvRow) {
  const policy = resolveContextPolicy(profile.id);
  const conv = settingsFromRow(profile);
  const suggested =
    policy.inherited && conv.enabled
      ? suggestedFromConversationSettings({ maxChars: conv.maxChars, summarize: conv.summarize })
      : null;
  return {
    policy,
    suggested,
    presets: CONTEXT_PRESETS,
    limits: CONTEXT_POLICY_LIMITS,
  };
}

contextPolicyRouter.get('/:id/context-policy', (req: Request, res: Response) => {
  const profile = loadProfileOrRespond(req, res);
  if (!profile) return;
  res.json(buildPolicyResponse(profile));
});

contextPolicyRouter.put('/:id/context-policy', (req: Request, res: Response) => {
  const profile = loadProfileOrRespond(req, res);
  if (!profile) return;
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object', code: 'context_policy_invalid' });
    return;
  }
  try {
    const policy = saveContextPolicy(profile.id, req.body as ContextPolicyInput);
    res.json({
      policy,
      suggested: null,
      presets: CONTEXT_PRESETS,
      limits: CONTEXT_POLICY_LIMITS,
    });
  } catch (err) {
    if (err instanceof ContextPolicyError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
});

contextPolicyRouter.delete('/:id/context-policy', (req: Request, res: Response) => {
  const profile = loadProfileOrRespond(req, res);
  if (!profile) return;
  deleteContextPolicy(profile.id);
  res.status(204).end();
});

contextPolicyRouter.get('/:id/context-stats', (req: Request, res: Response) => {
  const profile = loadProfileOrRespond(req, res);
  if (!profile) return;

  const rawDays = firstParam(req.query.days);
  const parsedDays = daysQuerySchema.safeParse(rawDays);
  if (!parsedDays.success) {
    res.status(400).json({ error: 'days must be an integer between 1 and 90', code: 'context_policy_invalid' });
    return;
  }

  res.json(getContextStats(profile.id, parsedDays.data));
});

contextPolicyRouter.get('/:id/conversations/:conversationId/context-preview', async (req: Request, res: Response) => {
  const profile = loadProfileOrRespond(req, res);
  if (!profile) return;

  const convKey = normalizeConversationId(firstParam(req.params.conversationId));
  if (!convKey) {
    res.status(404).json({ error: 'Conversation not found', code: 'conversation_not_found' });
    return;
  }

  const modelKey = firstParam(req.query.model);
  const query = firstParam(req.query.query);
  const rawEndUser = firstParam(req.query.endUser);
  const endUser = rawEndUser !== undefined ? normalizeEndUser(rawEndUser) : undefined;
  if (rawEndUser !== undefined && endUser === null) {
    res.status(404).json({ error: 'Conversation not found', code: 'conversation_not_found' });
    return;
  }

  try {
    const preview = await previewConversationContext(profile.id, convKey, {
      ...(modelKey ? { modelKey } : {}),
      ...(query ? { query } : {}),
      ...(endUser !== undefined ? { endUser } : {}),
    });
    res.json(preview);
  } catch (err) {
    if (err instanceof ContextPreviewError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
});

contextPolicyRouter.get('/:id/requests/:requestId/context', (req: Request, res: Response) => {
  const profile = loadProfileOrRespond(req, res);
  if (!profile) return;

  const requestId = parsePositiveInt(req.params.requestId);
  if (requestId === null) {
    res.status(400).json({ error: 'Invalid request id', code: 'context_policy_invalid' });
    return;
  }

  const report = getReportForRequest(profile.id, requestId);
  if (!report) {
    res.status(404).json({ error: 'Context report not found', code: 'context_report_not_found' });
    return;
  }
  res.json(report);
});

contextPolicySettingsRouter.get('/', (_req: Request, res: Response) => {
  res.json(getContextPolicyDefault());
});

contextPolicySettingsRouter.put('/', (req: Request, res: Response) => {
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object', code: 'context_policy_invalid' });
    return;
  }
  try {
    res.json(setContextPolicyDefault(req.body));
  } catch (err) {
    if (err instanceof ContextPolicyError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
});
