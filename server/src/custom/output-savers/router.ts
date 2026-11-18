import { Router } from 'express';
import { z } from 'zod';
import {
  AGENTIC_COMPACTOR_LIMITS,
  AGENTIC_PROSE_MODES,
} from '@freellmapi/shared/token-savers-agentic.js';
import { buildSaverBlock } from './prompts.js';
import {
  readOutputSaverSettings,
  setOutputSaverLevels,
  outputSaversUpdateSchema,
} from './config.js';
import { isRtkEnabled, setRtkEnabled, getRtkStats, resetRtkStats } from '../x-gateway/rtk.js';
import {
  getAgenticCompactorConfig,
  getAgenticCompactorStats,
  previewAgenticCompaction,
  resetAgenticCompactorStats,
  setAgenticCompactorConfig,
} from '../x-gateway/agentic-compaction.js';
import {
  isPxpipeEnabled,
  getPxpipeMinChars,
  getPxpipeTimeoutMs,
  setPxpipeConfig,
  getPxpipeStats,
  getPxpipeStatus,
  runPxpipeSelfTest,
} from '../x-gateway/pxpipe.js';
import {
  getHeadroomStatus,
  setHeadroomConfig,
  probeHeadroomConnection,
  resetHeadroomStats,
} from '../x-gateway/headroom.js';

export const outputSaversRouter = Router();

function view() {
  const { levels, sources, customPrompt } = readOutputSaverSettings();
  return {
    caveman: levels.caveman,
    ponytail: levels.ponytail,
    customPrompt: customPrompt ?? '',
    sources,
    injectedChars: buildSaverBlock(levels, customPrompt).length,
  };
}

outputSaversRouter.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store').json(view());
});

const updateSchema = outputSaversUpdateSchema.refine(
  body => body.caveman !== undefined || body.ponytail !== undefined || body.customPrompt !== undefined,
);

outputSaversRouter.put('/', (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        message: 'Supply caveman, ponytail as one of off|lite|full|ultra|wenyan, or customPrompt.',
      },
    });
    return;
  }
  setOutputSaverLevels(parsed.data);
  res.set('Cache-Control', 'no-store').json(view());
});

// RTK routes
outputSaversRouter.get('/rtk', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    enabled: isRtkEnabled(),
    stats: getRtkStats(),
  });
});

outputSaversRouter.put('/rtk', (req, res) => {
  if (req.body && typeof req.body.enabled === 'boolean') {
    setRtkEnabled(req.body.enabled);
  }
  res.set('Cache-Control', 'no-store').json({
    enabled: isRtkEnabled(),
    stats: getRtkStats(),
  });
});

outputSaversRouter.post('/rtk/reset', (_req, res) => {
  const stats = resetRtkStats();
  res.set('Cache-Control', 'no-store').json({ ok: true, stats });
});

// pxpipe routes
outputSaversRouter.get('/pxpipe', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    enabled: isPxpipeEnabled(),
    minChars: getPxpipeMinChars(),
    timeoutMs: getPxpipeTimeoutMs(),
    status: getPxpipeStatus(),
  });
});

outputSaversRouter.put('/pxpipe', (req, res) => {
  if (req.body && typeof req.body === 'object') {
    setPxpipeConfig({
      enabled: typeof req.body.enabled === 'boolean' ? req.body.enabled : undefined,
      minChars: typeof req.body.minChars === 'number' ? req.body.minChars : undefined,
      timeoutMs: typeof req.body.timeoutMs === 'number' ? req.body.timeoutMs : undefined,
    });
  }
  res.set('Cache-Control', 'no-store').json({
    enabled: isPxpipeEnabled(),
    minChars: getPxpipeMinChars(),
    timeoutMs: getPxpipeTimeoutMs(),
    status: getPxpipeStatus(),
  });
});

outputSaversRouter.get('/pxpipe/stats', (_req, res) => {
  res.set('Cache-Control', 'no-store').json(getPxpipeStats());
});

outputSaversRouter.post('/pxpipe/test', (_req, res) => {
  try {
    const result = runPxpipeSelfTest();
    res.set('Cache-Control', 'no-store').json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Headroom routes
outputSaversRouter.get('/headroom', async (req, res) => {
  const probeLive = req.query.probe === '1' || req.query.probe === 'true';
  const status = await getHeadroomStatus(probeLive);
  res.set('Cache-Control', 'no-store').json(status);
});

outputSaversRouter.put('/headroom', async (req, res) => {
  if (req.body && typeof req.body === 'object') {
    setHeadroomConfig({
      enabled: typeof req.body.enabled === 'boolean' ? req.body.enabled : undefined,
      url: typeof req.body.url === 'string' ? req.body.url : undefined,
      timeoutMs: typeof req.body.timeoutMs === 'number' ? req.body.timeoutMs : undefined,
      compressUserMessages: typeof req.body.compressUserMessages === 'boolean' ? req.body.compressUserMessages : undefined,
    });
  }
  const status = await getHeadroomStatus(false);
  res.set('Cache-Control', 'no-store').json(status);
});

outputSaversRouter.post('/headroom/test', async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url : undefined;
  const timeoutMs = typeof req.body?.timeoutMs === 'number' ? req.body.timeoutMs : undefined;
  const result = await probeHeadroomConnection({ url, timeoutMs });
  res.set('Cache-Control', 'no-store').json(result);
});

outputSaversRouter.post('/headroom/reset', (_req, res) => {
  const stats = resetHeadroomStats();
  res.set('Cache-Control', 'no-store').json({ ok: true, stats });
});

// Agentic & Code-Safe Input Compactor routes (Spec 029)
const agenticConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    toolCompaction: z.boolean().optional(),
    toolResultMaxChars: z
      .number()
      .int()
      .min(AGENTIC_COMPACTOR_LIMITS.minToolResultMaxChars)
      .max(AGENTIC_COMPACTOR_LIMITS.maxToolResultMaxChars)
      .optional(),
    jsonMinChars: z
      .number()
      .int()
      .min(AGENTIC_COMPACTOR_LIMITS.minJsonMinChars)
      .max(AGENTIC_COMPACTOR_LIMITS.maxJsonMinChars)
      .optional(),
    proseMode: z.enum(AGENTIC_PROSE_MODES).optional(),
    prefixFreezeEnabled: z.boolean().optional(),
    prefixFreezeThreshold: z
      .number()
      .int()
      .min(AGENTIC_COMPACTOR_LIMITS.minPrefixFreezeThreshold)
      .max(AGENTIC_COMPACTOR_LIMITS.maxPrefixFreezeThreshold)
      .optional(),
    dedupTools: z.boolean().optional(),
  })
  .strict();

const agenticConfigUpdateSchema = agenticConfigPatchSchema.refine(
  data => Object.keys(data).length > 0,
  { message: 'Provide at least one agentic compactor field to update.' },
);

const agenticPreviewSchema = z
  .object({
    text: z.string().max(AGENTIC_COMPACTOR_LIMITS.previewTextMaxChars).optional(),
    role: z.enum(['tool', 'user', 'assistant', 'system']).optional(),
    messages: z
      .array(
        z.object({
          role: z.string().min(1),
          content: z.unknown(),
          tool_call_id: z.string().optional(),
        }).passthrough(),
      )
      .max(AGENTIC_COMPACTOR_LIMITS.previewMaxMessages)
      .optional(),
    tools: z.array(z.unknown()).max(200).optional(),
    configOverride: agenticConfigPatchSchema.optional(),
  })
  .refine(
    data =>
      (typeof data.text === 'string' && data.text.length > 0) ||
      (Array.isArray(data.messages) && data.messages.length > 0),
    { message: 'Provide non-empty text or messages for compression preview.' },
  );

outputSaversRouter.get('/agentic', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    config: getAgenticCompactorConfig(),
    stats: getAgenticCompactorStats(),
  });
});

outputSaversRouter.put('/agentic', (req, res) => {
  const parsed = agenticConfigUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        message: parsed.error.issues[0]?.message ?? 'Invalid agentic compactor configuration.',
      },
    });
    return;
  }
  const config = setAgenticCompactorConfig(parsed.data);
  res.set('Cache-Control', 'no-store').json({
    config,
    stats: getAgenticCompactorStats(),
  });
});

outputSaversRouter.post('/agentic/reset', (_req, res) => {
  const stats = resetAgenticCompactorStats();
  res.set('Cache-Control', 'no-store').json({ ok: true, stats });
});

outputSaversRouter.post('/agentic/preview', (req, res) => {
  const parsed = agenticPreviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        message: parsed.error.issues[0]?.message ?? 'Invalid compression preview request.',
      },
    });
    return;
  }
  const result = previewAgenticCompaction(parsed.data);
  res.set('Cache-Control', 'no-store').json(result);
});

// Unified Saver Stats
outputSaversRouter.get('/stats', async (_req, res) => {
  const headroomStatus = await getHeadroomStatus(false);
  res.set('Cache-Control', 'no-store').json({
    outputSavers: view(),
    rtk: {
      enabled: isRtkEnabled(),
      stats: getRtkStats(),
    },
    agentic: {
      config: getAgenticCompactorConfig(),
      stats: getAgenticCompactorStats(),
    },
    headroom: headroomStatus,
    pxpipe: {
      ...getPxpipeStatus(),
      stats: getPxpipeStats(),
    },
  });
});
