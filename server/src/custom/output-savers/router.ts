import { Router } from 'express';
import { buildSaverBlock } from './prompts.js';
import {
  readOutputSaverSettings,
  setOutputSaverLevels,
  outputSaversUpdateSchema,
} from './config.js';
import { isRtkEnabled, setRtkEnabled, getRtkStats } from '../x-gateway/rtk.js';
import {
  isPxpipeEnabled,
  setPxpipeEnabled,
  getPxpipeMinChars,
  setPxpipeMinChars,
  getPxpipeStats,
} from '../x-gateway/pxpipe.js';

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
  });
});

// pxpipe routes
outputSaversRouter.get('/pxpipe', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    enabled: isPxpipeEnabled(),
    minChars: getPxpipeMinChars(),
  });
});

outputSaversRouter.put('/pxpipe', (req, res) => {
  if (req.body && typeof req.body.enabled === 'boolean') {
    setPxpipeEnabled(req.body.enabled);
  }
  if (req.body && typeof req.body.minChars === 'number') {
    setPxpipeMinChars(req.body.minChars);
  }
  res.set('Cache-Control', 'no-store').json({
    enabled: isPxpipeEnabled(),
    minChars: getPxpipeMinChars(),
  });
});

outputSaversRouter.get('/pxpipe/stats', (_req, res) => {
  res.set('Cache-Control', 'no-store').json(getPxpipeStats());
});
