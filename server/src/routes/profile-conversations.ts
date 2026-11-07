import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CONVERSATION_LIMITS as L, type StoredMessage } from '@freellmapi/shared/conversations.js';
import {
  deleteConversation, deleteEndUserConversations, getConversation, getConversationSettings, listConversations,
  normalizeConversationId, setConversationSettings,
} from '../services/profile-conversations.js';
import { normalizeEndUser } from '../services/end-user-quotas.js';
import { profileForGate } from '../services/profile-usage.js';
import { CLIENT_PROFILE_KEY_PREFIX } from '../lib/system-prompt.js';
import { extractInferenceToken } from '../middleware/user-rate-limit.js';

// Stored conversations of a client key.
//  - profileConversationsRouter: the dashboard, mounted at /api/client-profiles behind the profile
//    permissions (listing needs view_client_profiles; reading messages and every change need
//    edit_client_profiles, see custom/permission-actions.ts).
//  - storedConversationsRouter: the web app's backend, at /v1/stored-conversations with its own client
//    key, so it can show or erase what is kept for its users.

export const profileConversationsRouter = Router();

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  ttlHours: z.number().int().min(L.minTtlHours).max(L.maxTtlHours).optional(),
  maxMessages: z.number().int().min(L.minMaxMessages).max(L.maxMaxMessages).optional(),
  maxChars: z.number().int().min(L.minMaxChars).max(L.maxMaxChars).optional(),
}).strict();

const first = (raw: unknown): unknown => (Array.isArray(raw) ? raw[0] : raw);
const int = (raw: unknown): number | null => { const n = Number(first(raw)); return Number.isInteger(n) && n > 0 ? n : null; };
const bad = (res: Response, message: string) => res.status(400).json({ error: { message } });

function profileOf(req: Request, res: Response) {
  const id = int(req.params.id);
  if (id === null) { bad(res, 'Invalid profile id'); return null; }
  const settings = getConversationSettings(id);
  if (!settings) { res.status(404).json({ error: { message: 'Client profile not found' } }); return null; }
  return { id, settings };
}

profileConversationsRouter.get('/:id/conversations', (req, res) => {
  const p = profileOf(req, res);
  if (!p) return;
  const endUser = first(req.query.endUser) === undefined ? null : normalizeEndUser(first(req.query.endUser));
  res.json({ settings: p.settings, conversations: listConversations(p.id, p.settings, { endUser }), limits: L });
});

profileConversationsRouter.put('/:id/conversation-settings', (req, res) => {
  const p = profileOf(req, res);
  if (!p) return;
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    bad(res, `enabled is true/false; ttlHours ${L.minTtlHours}-${L.maxTtlHours}; maxMessages ${L.minMaxMessages}-${L.maxMaxMessages}; maxChars ${L.minMaxChars}-${L.maxMaxChars} (whole numbers)`);
    return;
  }
  setConversationSettings(p.id, { ...p.settings, ...parsed.data });
  res.json({ settings: getConversationSettings(p.id) });
});

profileConversationsRouter.get('/:id/conversations/:conversationId', (req, res) => {
  const p = profileOf(req, res);
  if (!p) return;
  const key = normalizeConversationId(req.params.conversationId);
  const found = key ? getConversation(p.id, key, p.settings) : null;
  if (!found) { res.status(404).json({ error: { message: 'Conversation not found' } }); return; }
  res.json(found);
});

profileConversationsRouter.delete('/:id/conversations/:conversationId', (req, res) => {
  const p = profileOf(req, res);
  if (!p) return;
  const key = normalizeConversationId(req.params.conversationId);
  if (!key || !deleteConversation(p.id, key)) { res.status(404).json({ error: { message: 'Conversation not found' } }); return; }
  res.json({ deleted: 1 });
});

/** DELETE ?endUser=… erases every conversation of that end user. */
profileConversationsRouter.delete('/:id/conversations', (req, res) => {
  const p = profileOf(req, res);
  if (!p) return;
  const endUser = normalizeEndUser(first(req.query.endUser));
  if (!endUser) { bad(res, 'endUser is required'); return; }
  res.json({ deleted: deleteEndUserConversations(p.id, endUser) });
});

// --- The web app's own access, with its client key -------------------------------------------------

export const storedConversationsRouter = Router();

function oaiError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { message, type: status === 401 ? 'authentication_error' : 'invalid_request_error', code } });
}

storedConversationsRouter.use((req, res, next) => {
  const token = extractInferenceToken(req);
  const profile = token?.startsWith(CLIENT_PROFILE_KEY_PREFIX) ? profileForGate(token) : null;
  if (!profile) { oaiError(res, 401, 'invalid_api_key', 'A client key (sk-cp-…) is required.'); return; }
  res.locals.conversationProfile = profile;
  next();
});

type GateProfileLocal = { id: number; conversations: Parameters<typeof listConversations>[1] };
const local = (res: Response) => res.locals.conversationProfile as GateProfileLocal;
const wireMessage = (m: StoredMessage) => ({ role: m.role, content: m.content, created_at: m.createdAt });

storedConversationsRouter.get('/:conversationId', (req, res) => {
  const p = local(res);
  const key = normalizeConversationId(req.params.conversationId);
  const found = key ? getConversation(p.id, key, p.conversations) : null;
  if (!found) { oaiError(res, 404, 'conversation_not_found', 'No stored conversation with this id.'); return; }
  const c = found.conversation;
  res.json({ id: c.id, end_user: c.endUser, updated_at: c.updatedAt, expires_at: c.expiresAt, messages: found.messages.map(wireMessage) });
});

storedConversationsRouter.delete('/:conversationId', (req, res) => {
  const key = normalizeConversationId(req.params.conversationId);
  res.json({ deleted: key && deleteConversation(local(res).id, key) ? 1 : 0 });
});

/** DELETE /v1/stored-conversations?end_user=… erases everything kept for that end user. */
storedConversationsRouter.delete('/', (req, res) => {
  const endUser = normalizeEndUser(first(req.query.end_user));
  if (!endUser) { oaiError(res, 400, 'end_user_required', 'Pass ?end_user=… to erase one end user\'s conversations.'); return; }
  res.json({ deleted: deleteEndUserConversations(local(res).id, endUser) });
});

storedConversationsRouter.use((_req, res) => { oaiError(res, 404, 'not_found', 'Use GET or DELETE /v1/stored-conversations/{id}, or DELETE /v1/stored-conversations?end_user=…'); });
