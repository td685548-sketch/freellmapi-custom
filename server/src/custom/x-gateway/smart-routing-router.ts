import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  AGENT_SCENARIO_LANES,
  INTENT_CATEGORIES,
  SMART_ROUTING_DECISION_MODES,
  type AgentScenarioLane,
  type IntentCategory,
} from '@freellmapi/shared/smart-routing-v2.js';
import {
  getScenarioRoutingPolicy,
  previewIntentClassification,
  setScenarioRoutingPolicy,
} from './intent-router.js';
import {
  clearLearnedModelCaps,
  listLearnedModelCaps,
} from './learned-caps.js';
import {
  getModelsDevSyncStatus,
  getSyncedModelSpec,
  resolveEffectiveModelCapabilities,
  setModelsDevSyncEnabled,
  syncModelsDevCatalog,
} from './models-dev-sync.js';

export const xSmartRoutingRouter = Router();

const lanesSchema = z.object(
  Object.fromEntries(
    AGENT_SCENARIO_LANES.map(lane => [lane, z.string().max(120).optional()]),
  ) as Record<AgentScenarioLane, z.ZodOptional<z.ZodString>>,
).strict();

const intentTargetsSchema = z.object(
  Object.fromEntries(
    INTENT_CATEGORIES.map(intent => [intent, z.string().max(120).optional()]),
  ) as Record<IntentCategory, z.ZodOptional<z.ZodString>>,
).strict();

const updatePolicySchema = z.object({
  enabled: z.boolean().optional(),
  decisionMode: z.enum(SMART_ROUTING_DECISION_MODES as [string, ...string[]]).optional(),
  longContextThresholdTokens: z.number().int().min(1_000).max(2_000_000).optional(),
  simpleMaxWords: z.number().int().min(5).max(500).optional(),
  lanes: lanesSchema.optional(),
  intentTargets: intentTargetsSchema.optional(),
}).strict();

const classifyPreviewSchema = z.object({
  prompt: z.string().max(200_000),
  systemPrompt: z.string().max(50_000).optional(),
  hasVision: z.boolean().optional(),
  hasWebSearchTool: z.boolean().optional(),
  thinkingEnabled: z.boolean().optional(),
  reasoningEffort: z.string().max(32).optional(),
  estimatedTokens: z.number().int().min(0).max(10_000_000).optional(),
}).strict();

const syncModelsDevSchema = z.object({
  dryRun: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).strict();

const updateModelsDevEnabledSchema = z.object({
  enabled: z.boolean(),
}).strict();

xSmartRoutingRouter.get('/policy', (_req: Request, res: Response) => {
  res.json(getScenarioRoutingPolicy());
});

xSmartRoutingRouter.put('/policy', (req: Request, res: Response) => {
  const parsed = updatePolicySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: { type: 'gateway_console_error', message: 'Invalid smart routing policy payload.' },
    });
    return;
  }
  const data = parsed.data;
  const current = getScenarioRoutingPolicy();
  const next = setScenarioRoutingPolicy({
    ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
    ...(data.decisionMode !== undefined
      ? { decisionMode: data.decisionMode as typeof current.decisionMode }
      : {}),
    ...(data.longContextThresholdTokens !== undefined
      ? { longContextThresholdTokens: data.longContextThresholdTokens }
      : {}),
    ...(data.simpleMaxWords !== undefined ? { simpleMaxWords: data.simpleMaxWords } : {}),
    ...(data.lanes !== undefined ? { lanes: { ...current.lanes, ...data.lanes } } : {}),
    ...(data.intentTargets !== undefined ? { intentTargets: data.intentTargets } : {}),
  });
  res.json(next);
});

xSmartRoutingRouter.post('/classify-preview', (req: Request, res: Response) => {
  const parsed = classifyPreviewSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: { type: 'gateway_console_error', message: 'Invalid classification preview request.' },
    });
    return;
  }
  res.json(previewIntentClassification(parsed.data));
});

xSmartRoutingRouter.get('/learned-caps', (_req: Request, res: Response) => {
  res.json({ caps: listLearnedModelCaps() });
});

xSmartRoutingRouter.delete('/learned-caps', (req: Request, res: Response) => {
  const provider = typeof req.query.provider === 'string' && req.query.provider.trim()
    ? req.query.provider.trim()
    : undefined;
  const modelId = typeof req.query.modelId === 'string' && req.query.modelId.trim()
    ? req.query.modelId.trim()
    : undefined;
  const endpointScope = typeof req.query.endpointScope === 'string'
    ? req.query.endpointScope
    : undefined;

  const cleared = clearLearnedModelCaps(
    provider || modelId || endpointScope !== undefined
      ? { provider, modelId, endpointScope }
      : undefined,
  );
  res.json({ ok: true, cleared, caps: listLearnedModelCaps() });
});

xSmartRoutingRouter.get('/models-dev/status', (req: Request, res: Response) => {
  const status = getModelsDevSyncStatus();
  const provider = typeof req.query.provider === 'string' ? req.query.provider.trim() : '';
  const modelId = typeof req.query.modelId === 'string' ? req.query.modelId.trim() : '';
  if (provider || modelId) {
    res.json({
      ...status,
      spec: getSyncedModelSpec(provider, modelId),
      effective: resolveEffectiveModelCapabilities(provider, modelId),
    });
    return;
  }
  res.json(status);
});

xSmartRoutingRouter.put('/models-dev/status', (req: Request, res: Response) => {
  const parsed = updateModelsDevEnabledSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: { type: 'gateway_console_error', message: 'Invalid models.dev settings payload.' },
    });
    return;
  }
  setModelsDevSyncEnabled(parsed.data.enabled);
  res.json(getModelsDevSyncStatus());
});

xSmartRoutingRouter.post('/models-dev/sync', async (req: Request, res: Response, next) => {
  try {
    const parsed = syncModelsDevSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: { type: 'gateway_console_error', message: 'Invalid models.dev sync payload.' },
      });
      return;
    }
    if (parsed.data.enabled !== undefined) {
      setModelsDevSyncEnabled(parsed.data.enabled);
    }
    const result = await syncModelsDevCatalog({ dryRun: parsed.data.dryRun });
    res.json({
      ...result,
      status: getModelsDevSyncStatus(),
    });
  } catch (err) {
    next(err);
  }
});
