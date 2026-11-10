import { Router } from 'express';
import { buildSaverBlock } from './prompts.js';
import {
  readOutputSaverSettings,
  setOutputSaverLevels,
  outputSaversUpdateSchema,
} from './config.js';
import { isRtkEnabled, setRtkEnabled, getRtkStats, resetRtkStats } from '../x-gateway/rtk.js';
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

// Unified Saver Stats
outputSaversRouter.get('/stats', async (_req, res) => {
  const headroomStatus = await getHeadroomStatus(false);
  res.set('Cache-Control', 'no-store').json({
    outputSavers: view(),
    rtk: {
      enabled: isRtkEnabled(),
      stats: getRtkStats(),
    },
    headroom: headroomStatus,
    pxpipe: {
      ...getPxpipeStatus(),
      stats: getPxpipeStats(),
    },
  });
});
