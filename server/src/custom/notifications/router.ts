import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SessionUser } from '../../services/auth.js';
import {
  getTelegramBotSettings,
  sendTelegramTestAlert,
  updateTelegramBotSettings,
} from './telegram-bot.js';

export const telegramAlertSettingsRouter = Router();

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    botToken: z.string().max(300).optional(),
    chatId: z
      .string()
      .trim()
      .max(64)
      .refine((v) => v === '' || /^-?\d+$|^@[A-Za-z0-9_]{4,}$/.test(v), {
        message: 'chatId must be a numeric Telegram chat ID (e.g. 123456789 or -100123456789) or @channel',
      })
      .optional(),
    messageThreadId: z.number().int().positive().max(2_147_483_647).nullable().optional(),
    notifyProviderErrors: z.boolean().optional(),
    notifyRegistrationRequests: z.boolean().optional(),
    notifyQuotaAlerts: z.boolean().optional(),
    interactiveApprovalEnabled: z.boolean().optional(),
  })
  .strict();

telegramAlertSettingsRouter.get('/', (_req: Request, res: Response) => {
  res.json(getTelegramBotSettings());
});

telegramAlertSettingsRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.issues.map((i) => i.message).join(', '),
      },
    });
    return;
  }
  res.json(updateTelegramBotSettings(parsed.data));
});

telegramAlertSettingsRouter.post('/test', async (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user;
  const delivery = await sendTelegramTestAlert(user?.userId);
  if (!delivery.sent) {
    res.status(400).json({
      error: {
        message: delivery.error || 'Failed to send test message to Telegram.',
      },
      delivery,
      settings: getTelegramBotSettings(),
    });
    return;
  }
  res.json({
    delivery,
    settings: getTelegramBotSettings(),
  });
});
