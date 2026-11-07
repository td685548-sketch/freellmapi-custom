import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { buildWeeklyReport, reportSettings, reportText, sendWeeklyReport, setReportEnabled } from '../services/usage-report.js';

// The weekly usage report. Mounted in custom/register.ts at /api/settings/usage-report, behind the
// /api/settings gate: reading and the preview need view_settings; switching it and sending need edit_settings.

export const usageReportSettingsRouter = Router();

usageReportSettingsRouter.get('/', (_req: Request, res: Response) => {
  res.json(reportSettings());
});

usageReportSettingsRouter.put('/', (req: Request, res: Response) => {
  const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: { message: 'enabled must be true or false' } }); return; }
  setReportEnabled(parsed.data.enabled);
  res.json(reportSettings());
});

/** The last full week's report, without sending it. */
usageReportSettingsRouter.get('/preview', (_req: Request, res: Response) => {
  const report = buildWeeklyReport();
  res.json({ report, text: reportText(report) });
});

/** Send the last full week's report now (does not change when the scheduled one goes out). */
usageReportSettingsRouter.post('/send', async (_req: Request, res: Response) => {
  res.json(await sendWeeklyReport());
});
