import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { deliverAlert, getAlertSettings, setAlertSettings } from '../services/usage-alerts.js';

// Where usage alerts go. Mounted in custom/register.ts at /api/settings/usage-alerts, behind the
// /api/settings gate: reading needs view_settings, changing or sending a test needs edit_settings.

export const usageAlertSettingsRouter = Router();

const url = z.string().trim().max(500).refine(v => {
  if (v === '') return true;
  try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
});
const email = z.string().trim().max(254).refine(v => v === '' || (z.string().email().safeParse(v).success && !/[\r\n]/.test(v)));
const bodySchema = z.object({ webhookUrl: url.optional(), email: email.optional() }).strict();

usageAlertSettingsRouter.get('/', (_req: Request, res: Response) => {
  res.json(getAlertSettings());
});

usageAlertSettingsRouter.put('/', (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'webhookUrl must be an http(s) URL (or empty) and email a valid address (or empty)' } });
    return;
  }
  res.json(setAlertSettings(parsed.data));
});

usageAlertSettingsRouter.post('/test', async (_req: Request, res: Response) => {
  const delivery = await deliverAlert({
    alert: 'test', level: 'info', subject: null,
    message: 'Test alert from FreeLLMAPI: usage alerts reach this destination.',
    details: {},
  });
  res.json({ delivery, settings: getAlertSettings() });
});
