import { Router } from 'express';
import { buildSaverBlock } from './prompts.js';
import {
  readOutputSaverSettings,
  setOutputSaverLevels,
  outputSaversUpdateSchema,
} from './config.js';

export const outputSaversRouter = Router();

function view() {
  const { levels, sources } = readOutputSaverSettings();
  return {
    caveman: levels.caveman,
    ponytail: levels.ponytail,
    sources,
    injectedChars: buildSaverBlock(levels).length,
  };
}

outputSaversRouter.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store').json(view());
});

const updateSchema = outputSaversUpdateSchema.refine(
  body => body.caveman !== undefined || body.ponytail !== undefined,
);

outputSaversRouter.put('/', (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        message: 'Supply caveman and/or ponytail as one of off|lite|full|ultra.',
      },
    });
    return;
  }
  setOutputSaverLevels(parsed.data);
  res.set('Cache-Control', 'no-store').json(view());
});
