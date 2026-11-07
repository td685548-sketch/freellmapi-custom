import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { QUICK_ANSWER_LIMITS as L } from '@freellmapi/shared/quick-answers.js';
import {
  addQuickAnswer, countQuickAnswers, deleteQuickAnswer, findQuickAnswer, getQuickAnswerSettings, listQuickAnswers,
  setQuickAnswerSettings, updateQuickAnswer,
} from '../services/quick-answers.js';

// A client key's ready answers. Mounted in custom/register.ts at /api/client-profiles behind the profile
// permissions: reads (list, try a message) need view_client_profiles, changes need edit_client_profiles.

export const quickAnswersRouter = Router();

const questions = z.array(z.string().trim().min(1).max(L.maxQuestionChars)).min(1).max(L.maxQuestions);
const answer = z.string().trim().min(1).max(L.maxAnswerChars);
const createSchema = z.object({ questions, answer, enabled: z.boolean().optional() }).strict();
const updateSchema = z.object({ questions: questions.optional(), answer: answer.optional(), enabled: z.boolean().optional() }).strict();
const settingsSchema = z.object({ enabled: z.boolean().optional(), minSimilarity: z.number().int().min(L.minMinSimilarity).max(L.maxMinSimilarity).optional() }).strict();

const int = (raw: unknown): number | null => { const n = Number(Array.isArray(raw) ? raw[0] : raw); return Number.isInteger(n) && n > 0 ? n : null; };
const bad = (res: Response, message: string) => res.status(400).json({ error: { message } });
function profileOf(req: Request, res: Response) {
  const id = int(req.params.id);
  if (id === null) { bad(res, 'Invalid profile id'); return null; }
  const settings = getQuickAnswerSettings(id);
  if (!settings) { res.status(404).json({ error: { message: 'Client profile not found' } }); return null; }
  return { id, settings };
}
const shapeMessage = `questions: 1-${L.maxQuestions} of up to ${L.maxQuestionChars} characters; answer: up to ${L.maxAnswerChars.toLocaleString('en-US')} characters`;

quickAnswersRouter.get('/:id/quick-answers', (req, res) => {
  const p = profileOf(req, res);
  if (!p) return;
  res.json({ settings: p.settings, answers: listQuickAnswers(p.id), limits: L });
});

quickAnswersRouter.put('/:id/quick-answer-settings', (req, res) => {
  const p = profileOf(req, res);
  if (!p) return;
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) { bad(res, `enabled is true/false; minSimilarity a whole number from ${L.minMinSimilarity} to ${L.maxMinSimilarity}`); return; }
  setQuickAnswerSettings(p.id, { ...p.settings, ...parsed.data });
  res.json({ settings: getQuickAnswerSettings(p.id) });
});

quickAnswersRouter.post('/:id/quick-answers', (req, res) => {
  const p = profileOf(req, res);
  if (!p) return;
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) { bad(res, shapeMessage); return; }
  if (countQuickAnswers(p.id) >= L.maxAnswers) { bad(res, `A key can hold at most ${L.maxAnswers} ready answers`); return; }
  const id = addQuickAnswer(p.id, parsed.data.questions, parsed.data.answer, parsed.data.enabled ?? true);
  res.status(201).json({ answer: listQuickAnswers(p.id).find(a => a.id === id) });
});

/** Which ready answer a message would get, if any (does not count as a hit). */
quickAnswersRouter.get('/:id/quick-answers/match', (req, res) => {
  const p = profileOf(req, res);
  if (!p) return;
  const message = typeof req.query.message === 'string' ? req.query.message.slice(0, 2000) : '';
  const hit = message.trim() ? findQuickAnswer(p.id, message, p.settings.minSimilarity) : null;
  res.json({ match: hit ? { id: hit.id, answer: hit.answer, similarity: Math.round(hit.score * 100) } : null });
});

quickAnswersRouter.put('/:id/quick-answers/:answerId', (req, res) => {
  const p = profileOf(req, res);
  if (!p) return;
  const answerId = int(req.params.answerId);
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (answerId === null || !parsed.success) { bad(res, shapeMessage); return; }
  if (!updateQuickAnswer(p.id, answerId, parsed.data)) { res.status(404).json({ error: { message: 'Ready answer not found' } }); return; }
  res.json({ answer: listQuickAnswers(p.id).find(a => a.id === answerId) });
});

quickAnswersRouter.delete('/:id/quick-answers/:answerId', (req, res) => {
  const p = profileOf(req, res);
  if (!p) return;
  const answerId = int(req.params.answerId);
  if (answerId === null || !deleteQuickAnswer(p.id, answerId)) { res.status(404).json({ error: { message: 'Ready answer not found' } }); return; }
  res.json({ deleted: 1 });
});
