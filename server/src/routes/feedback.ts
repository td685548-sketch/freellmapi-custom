import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { FEEDBACK_LIMITS as L } from '@freellmapi/shared/feedback.js';
import { feedbackComments, feedbackSummary, recordFeedback } from '../services/feedback.js';
import { normalizeEndUser } from '../services/end-user-quotas.js';
import { normalizeConversationId } from '../services/profile-conversations.js';
import { clampAnalyticsDays } from '../services/user-analytics.js';
import { profileForGate } from '../services/profile-usage.js';
import { CLIENT_PROFILE_KEY_PREFIX } from '../lib/system-prompt.js';
import { extractInferenceToken } from '../middleware/user-rate-limit.js';

// Visitor feedback on replies.
//  - feedbackIngestRouter: POST /v1/feedback with the web app's client key (mounted before the profile
//    gate, so a vote uses no allowance).
//  - profileFeedbackRouter: the dashboard, at /api/client-profiles/:id/feedback (view_client_profiles) and
//    /feedback/comments (edit_client_profiles: comments are what visitors wrote).

export const feedbackIngestRouter = Router();

const voteSchema = z.object({
  rating: z.enum(['up', 'down']),
  comment: z.string().trim().max(L.maxComment).optional(),
  model: z.string().trim().max(L.maxModel).optional(),
  end_user: z.string().optional(),
  conversation_id: z.string().optional(),
  reference: z.string().trim().min(1).max(L.maxReference).optional(),
}).strict();

feedbackIngestRouter.post('/', (req: Request, res: Response) => {
  const token = extractInferenceToken(req);
  const profile = token?.startsWith(CLIENT_PROFILE_KEY_PREFIX) ? profileForGate(token) : null;
  if (!profile) { res.status(401).json({ error: { message: 'A client key (sk-cp-…) is required.', type: 'authentication_error', code: 'invalid_api_key' } }); return; }
  const parsed = voteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: `rating is "up" or "down"; comment up to ${L.maxComment} characters; model and reference up to ${L.maxModel}`, type: 'invalid_request_error', code: 'invalid_feedback' } });
    return;
  }
  const v = parsed.data;
  const header = req.headers['x-end-user'];
  const endUser = normalizeEndUser(v.end_user ?? (Array.isArray(header) ? header[0] : header));
  const id = recordFeedback(profile.id, {
    rating: v.rating === 'up' ? 1 : -1,
    comment: v.comment || null,
    model: v.model || null,
    endUser,
    conversationId: v.conversation_id ? normalizeConversationId(v.conversation_id) : null,
    reference: v.reference ?? null,
  });
  res.status(201).json({ id, rating: v.rating });
});

export const profileFeedbackRouter = Router();

const profileId = (req: Request, res: Response): number | null => {
  const n = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!Number.isInteger(n) || n <= 0) { res.status(400).json({ error: { message: 'Invalid profile id' } }); return null; }
  return n;
};

profileFeedbackRouter.get('/:id/feedback', (req, res) => {
  const id = profileId(req, res);
  if (id === null) return;
  res.json({ summary: feedbackSummary(id, clampAnalyticsDays(req.query.days)) });
});

profileFeedbackRouter.get('/:id/feedback/comments', (req, res) => {
  const id = profileId(req, res);
  if (id === null) return;
  const rating = req.query.rating === 'up' || req.query.rating === 'down' ? req.query.rating : null;
  res.json({ comments: feedbackComments(id, rating) });
});
