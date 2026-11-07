import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { GUEST_TRIAL_LIMITS as L } from '@freellmapi/shared/guest-access.js';
import { getGuestPermissions } from '../services/guest-access.js';
import { admitTrial, askTrial, getTrialSettings } from '../services/guest-trial.js';

// POST /api/guest/chat — the chat a signed-out visitor may try, when an administrator allows it
// (guest permission try_playground). Public by design; bounded by services/guest-trial.ts.

export const guestTrialRouter = Router();

const turn = z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1) }).strict();
const bodySchema = z.object({ messages: z.array(turn).min(1).max(L.maxTurns), model: z.string().max(200).optional() }).strict();

function refuse(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: { message, type: code, code, ...extra } }); // the dashboard reads `type`
}

guestTrialRouter.post('/chat', async (req: Request, res: Response) => {
  if (!getGuestPermissions().includes('try_playground')) { refuse(res, 404, 'guest_trial_off', 'The guest chat is not available.'); return; }
  const s = getTrialSettings();
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) { refuse(res, 400, 'invalid_request', `Send up to ${L.maxTurns} user/assistant messages.`); return; }
  const turns = parsed.data.messages;
  if (turns[turns.length - 1]!.role !== 'user') { refuse(res, 400, 'invalid_request', 'The last message must be the visitor\'s.'); return; }
  if (turns.some(t => t.content.length > s.maxInputChars)) { refuse(res, 400, 'message_too_long', `A message can be at most ${s.maxInputChars} characters.`, { max: s.maxInputChars }); return; }
  const model = parsed.data.model && parsed.data.model !== 'auto' ? parsed.data.model : (s.models[0] ?? 'auto');
  if (s.models.length > 0 ? !s.models.includes(model) : model !== 'auto') { refuse(res, 400, 'model_not_offered', 'This model is not offered to guests.', { models: s.models }); return; }

  const ip = (req.ip ?? req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
  const admission = admitTrial(ip, s);
  if (!admission.ok) {
    res.setHeader('Retry-After', String(admission.retryAfterSec));
    refuse(res, 429, admission.reason === 'ip_hourly' ? 'guest_trial_hourly_limit' : 'guest_trial_daily_cap',
      admission.reason === 'ip_hourly' ? `You have used the ${s.perIpPerHour} guest messages of this hour.` : 'The guest chat has reached today\'s limit.',
      { retry_after: admission.retryAfterSec });
    return;
  }
  const answer = await askTrial(req, turns, model, s);
  if (answer.ok) admission.commit(); else admission.release();
  res.status(answer.ok ? 200 : 502).json({
    reply: answer.reply,
    model: answer.model,
    error: answer.error,
    remaining: { hour: answer.ok ? admission.remainingHour : admission.remainingHour + 1, perHour: s.perIpPerHour },
  });
});
