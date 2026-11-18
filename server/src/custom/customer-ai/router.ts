import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  ASSISTANT_AUDIENCES,
  ASSISTANT_CATEGORIES,
  KEY_ROUTING_MODES,
  MAX_USER_ASSISTANT_SYSTEM_PROMPT_CHARS,
} from '@freellmapi/shared/customer-ai.js';
import type { Permission } from '@freellmapi/shared/permissions.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import type { SessionUser } from '../../services/auth.js';
import { isGuestRequest } from '../../services/guest-access.js';
import { buildAdminAnomalyRadar, buildCustomerQuotaCoach } from './coach.js';
import { chatWithAssistant, streamChatWithAssistant } from './runtime.js';
import {
  applyEcoModeToUserKeys,
  createAssistant,
  CustomerAiError,
  deleteAssistant,
  getUserAiPreferences,
  listAssistantsForAdmin,
  listAssistantsForCustomer,
  setUserAiPreferences,
  updateAssistant,
  updateUserKeyAiConfig,
} from './store.js';
import {
  branchAssistantThread,
  createAssistantThread,
  createUserCustomAssistant,
  deleteAssistantThread,
  deleteUserCustomAssistant,
  getAssistantThread,
  getUserCustomAssistant,
  listAssistantThreads,
  listUserCustomAssistants,
  listUserKeyCustomBindings,
  updateAssistantThread,
  updateUserCustomAssistant,
} from './workspace-store.js';

function handleAiError(res: Response, err: unknown): void {
  if (err instanceof CustomerAiError) {
    res.status(err.status).json({ error: { message: err.message, code: err.code, type: err.code } });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unexpected server error';
  res.status(500).json({ error: { message, type: 'internal_error' } });
}

function requireSignedInCustomer(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: SessionUser }).user;
  if (isGuestRequest(req) || !user || !user.userId) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  next();
}

function requirePerm(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: SessionUser }).user;
    if (hasPermission(user, permission)) {
      next();
      return;
    }
    res.status(403).json({
      error: {
        type: 'forbidden',
        code: 'missing_permission',
        permission,
        message: `Permission denied: '${permission}' access required.`,
      },
    });
  };
}

function parsePositiveId(raw: unknown): number | null {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ─── Customer & Guest Router (/api/user/ai-hub) ──────────────────────────────

export const customerAiUserRouter = Router();

customerAiUserRouter.get('/catalog', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user;
  const isGuest = isGuestRequest(req);
  const isAdmin = !isGuest && user?.role === 'admin';
  const assistants = listAssistantsForCustomer({ isGuest, isAdmin });
  res.json({ assistants });
});

customerAiUserRouter.use(requireSignedInCustomer);

customerAiUserRouter.get('/preferences', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  res.json({ preferences: getUserAiPreferences(user.userId) });
});

const preferencesSchema = z.object({
  customInstructions: z.string().max(2000),
  applyCustomInstructionsToKeys: z.boolean(),
}).strict();

customerAiUserRouter.put('/preferences', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const parsed = preferencesSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => i.message).join(', '), type: 'invalid_request' } });
    return;
  }
  res.json({ preferences: setUserAiPreferences(user.userId, parsed.data) });
});

customerAiUserRouter.get('/coach', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const rawDays = typeof req.query.days === 'string' ? Number.parseInt(req.query.days, 10) : 14;
  const days = Number.isFinite(rawDays) ? rawDays : 14;
  res.json({ report: buildCustomerQuotaCoach(user.userId, days) });
});

customerAiUserRouter.get('/key-bindings', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  res.json({ bindings: listUserKeyCustomBindings(user.userId) });
});

const keyPatchSchema = z.object({
  routingMode: z.enum(KEY_ROUTING_MODES).optional(),
  assistantId: z.union([z.number().int().positive(), z.string().max(120)]).nullable().optional(),
  userAssistantId: z.number().int().positive().nullable().optional(),
  assistantRef: z.string().max(120).nullable().optional(),
}).strict();

customerAiUserRouter.patch('/keys/:id', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const keyId = parsePositiveId(req.params.id);
  if (!keyId) {
    res.status(400).json({ error: { message: 'Invalid key ID', type: 'invalid_request' } });
    return;
  }
  const parsed = keyPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => i.message).join(', '), type: 'invalid_request' } });
    return;
  }
  try {
    const updated = updateUserKeyAiConfig(user.userId, user.role, keyId, parsed.data);
    res.json({ key: updated });
  } catch (err) {
    handleAiError(res, err);
  }
});

const applyEcoSchema = z.object({
  keyId: z.number().int().positive().optional(),
}).strict();

customerAiUserRouter.post('/keys/apply-eco', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const parsed = applyEcoSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => i.message).join(', '), type: 'invalid_request' } });
    return;
  }
  res.json(applyEcoModeToUserKeys(user.userId, parsed.data.keyId));
});

// ─── User-Created Custom Assistants (/api/user/ai-hub/custom-assistants) ─────

const userAssistantCreateSchema = z.object({
  slug: z.string().trim().max(63).optional(),
  name: z.string().trim().min(2).max(100),
  category: z.enum(ASSISTANT_CATEGORIES).optional(),
  description: z.string().trim().max(500).optional(),
  systemPrompt: z.string().trim().min(4).max(MAX_USER_ASSISTANT_SYSTEM_PROMPT_CHARS),
  // Byte-level 32KB cap is strictly enforced inside createUserCustomAssistant / updateUserCustomAssistant
  knowledgeMarkdown: z.string().max(131_072).optional(),
  recommendedRoutingMode: z.enum(KEY_ROUTING_MODES).optional(),
}).strict();

const userAssistantUpdateSchema = userAssistantCreateSchema.partial();

customerAiUserRouter.get('/custom-assistants', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  res.json({ assistants: listUserCustomAssistants(user.userId) });
});

customerAiUserRouter.post('/custom-assistants', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const parsed = userAssistantCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => i.message).join(', '), type: 'invalid_request' } });
    return;
  }
  try {
    const assistant = createUserCustomAssistant(user.userId, parsed.data);
    res.status(201).json({ assistant });
  } catch (err) {
    handleAiError(res, err);
  }
});

customerAiUserRouter.get('/custom-assistants/:id', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const id = parsePositiveId(req.params.id);
  if (!id) {
    res.status(400).json({ error: { message: 'Invalid assistant ID', type: 'invalid_request' } });
    return;
  }
  try {
    res.json({ assistant: getUserCustomAssistant(user.userId, id) });
  } catch (err) {
    handleAiError(res, err);
  }
});

function handleUpdateCustomAssistant(req: Request, res: Response): void {
  const user = (req as Request & { user?: SessionUser }).user!;
  const id = parsePositiveId(req.params.id);
  if (!id) {
    res.status(400).json({ error: { message: 'Invalid assistant ID', type: 'invalid_request' } });
    return;
  }
  const parsed = userAssistantUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => i.message).join(', '), type: 'invalid_request' } });
    return;
  }
  try {
    const assistant = updateUserCustomAssistant(user.userId, id, parsed.data);
    res.json({ assistant });
  } catch (err) {
    handleAiError(res, err);
  }
}

customerAiUserRouter.patch('/custom-assistants/:id', handleUpdateCustomAssistant);
customerAiUserRouter.put('/custom-assistants/:id', handleUpdateCustomAssistant);

customerAiUserRouter.delete('/custom-assistants/:id', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const id = parsePositiveId(req.params.id);
  if (!id) {
    res.status(400).json({ error: { message: 'Invalid assistant ID', type: 'invalid_request' } });
    return;
  }
  const deleted = deleteUserCustomAssistant(user.userId, id);
  if (!deleted) {
    res.status(404).json({ error: { message: 'Custom assistant not found.', code: 'assistant_not_found', type: 'assistant_not_found' } });
    return;
  }
  res.json({ success: true });
});

// ─── Persistent Threads & Branching (/api/user/ai-hub/threads) ───────────────

const createThreadSchema = z.object({
  assistantRef: z.string().trim().min(1).max(120),
  title: z.string().trim().max(140).optional(),
  routingMode: z.enum(KEY_ROUTING_MODES).optional(),
}).strict();

const updateThreadSchema = z.object({
  title: z.string().trim().min(1).max(140).optional(),
  routingMode: z.enum(KEY_ROUTING_MODES).optional(),
}).strict();

const branchThreadSchema = z.object({
  fromMessageIndex: z.number().int().min(0).optional(),
  fromMessageId: z.number().int().positive().optional(),
  title: z.string().trim().max(140).optional(),
}).strict();

customerAiUserRouter.get('/threads', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const assistantRef = typeof req.query.assistantRef === 'string' ? req.query.assistantRef : undefined;
  const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50;
  const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
  res.json({ threads: listAssistantThreads(user.userId, { assistantRef, limit }) });
});

customerAiUserRouter.post('/threads', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const parsed = createThreadSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => i.message).join(', '), type: 'invalid_request' } });
    return;
  }
  try {
    const thread = createAssistantThread(user, parsed.data);
    res.status(201).json({ thread });
  } catch (err) {
    handleAiError(res, err);
  }
});

customerAiUserRouter.get('/threads/:id', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const id = parsePositiveId(req.params.id);
  if (!id) {
    res.status(400).json({ error: { message: 'Invalid thread ID', type: 'invalid_request' } });
    return;
  }
  try {
    res.json({ thread: getAssistantThread(user.userId, id) });
  } catch (err) {
    handleAiError(res, err);
  }
});

customerAiUserRouter.patch('/threads/:id', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const id = parsePositiveId(req.params.id);
  if (!id) {
    res.status(400).json({ error: { message: 'Invalid thread ID', type: 'invalid_request' } });
    return;
  }
  const parsed = updateThreadSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => i.message).join(', '), type: 'invalid_request' } });
    return;
  }
  try {
    res.json({ thread: updateAssistantThread(user.userId, id, parsed.data) });
  } catch (err) {
    handleAiError(res, err);
  }
});

customerAiUserRouter.delete('/threads/:id', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const id = parsePositiveId(req.params.id);
  if (!id) {
    res.status(400).json({ error: { message: 'Invalid thread ID', type: 'invalid_request' } });
    return;
  }
  const deleted = deleteAssistantThread(user.userId, id);
  if (!deleted) {
    res.status(404).json({ error: { message: 'Conversation thread not found.', code: 'thread_not_found', type: 'thread_not_found' } });
    return;
  }
  res.json({ success: true });
});

customerAiUserRouter.post('/threads/:id/branch', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const id = parsePositiveId(req.params.id);
  if (!id) {
    res.status(400).json({ error: { message: 'Invalid thread ID', type: 'invalid_request' } });
    return;
  }
  const parsed = branchThreadSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => i.message).join(', '), type: 'invalid_request' } });
    return;
  }
  try {
    const thread = branchAssistantThread(user.userId, id, parsed.data);
    res.status(201).json({ thread });
  } catch (err) {
    handleAiError(res, err);
  }
});

// ─── Assistant Chat & SSE Streaming ──────────────────────────────────────────

const chatTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(8000),
}).strict();

const chatBodySchema = z.object({
  messages: z.array(chatTurnSchema).min(1).max(30),
  routingMode: z.enum(KEY_ROUTING_MODES).optional(),
  maxTokens: z.number().int().min(64).max(4096).optional(),
  threadId: z.number().int().positive().optional(),
}).strict();

customerAiUserRouter.post('/assistants/:slug/chat', async (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const slug = String(Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug ?? '').trim();
  const parsed = chatBodySchema.safeParse(req.body ?? {});
  if (!parsed.success || parsed.data.messages[parsed.data.messages.length - 1]!.role !== 'user') {
    res.status(400).json({
      error: {
        message: 'Provide 1–30 messages ending with a user turn (max 8,000 chars per turn).',
        type: 'invalid_request',
      },
    });
    return;
  }
  try {
    const result = await chatWithAssistant(req, res, user, slug, parsed.data);
    if (!result) return;
    res.json(result);
  } catch (err) {
    if (!res.headersSent) handleAiError(res, err);
  }
});

const streamChatBodySchema = z.object({
  assistantRef: z.string().trim().min(1).max(120).optional(),
  threadId: z.number().int().positive().optional(),
  createThread: z.boolean().optional(),
  threadTitle: z.string().trim().max(140).optional(),
  message: z.string().trim().min(1).max(8000).optional(),
  messages: z.array(chatTurnSchema).min(1).max(30).optional(),
  routingMode: z.enum(KEY_ROUTING_MODES).optional(),
  maxTokens: z.number().int().min(64).max(4096).optional(),
  stream: z.boolean().optional(),
}).strict();

customerAiUserRouter.post('/chat/stream', async (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const parsed = streamChatBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => i.message).join(', '), type: 'invalid_request' } });
    return;
  }
  try {
    await streamChatWithAssistant(req, res, user, parsed.data);
  } catch (err) {
    if (!res.headersSent) {
      handleAiError(res, err);
    } else if (!res.writableEnded) {
      const message = err instanceof Error ? err.message : 'Stream interrupted';
      res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\ndata: [DONE]\n\n`);
      res.end();
    }
  }
});

customerAiUserRouter.post('/threads/:id/chat/stream', async (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const threadId = parsePositiveId(req.params.id);
  if (!threadId) {
    res.status(400).json({ error: { message: 'Invalid thread ID', type: 'invalid_request' } });
    return;
  }
  const parsed = streamChatBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => i.message).join(', '), type: 'invalid_request' } });
    return;
  }
  try {
    await streamChatWithAssistant(req, res, user, { ...parsed.data, threadId });
  } catch (err) {
    if (!res.headersSent) {
      handleAiError(res, err);
    } else if (!res.writableEnded) {
      const message = err instanceof Error ? err.message : 'Stream interrupted';
      res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\ndata: [DONE]\n\n`);
      res.end();
    }
  }
});

customerAiUserRouter.post('/assistants/:slug/chat/stream', async (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const slug = String(Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug ?? '').trim();
  const parsed = streamChatBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => i.message).join(', '), type: 'invalid_request' } });
    return;
  }
  try {
    await streamChatWithAssistant(req, res, user, { ...parsed.data, assistantRef: slug });
  } catch (err) {
    if (!res.headersSent) {
      handleAiError(res, err);
    } else if (!res.writableEnded) {
      const message = err instanceof Error ? err.message : 'Stream interrupted';
      res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\ndata: [DONE]\n\n`);
      res.end();
    }
  }
});

// ─── Admin Studio & Anomaly Radar Router (/api/ai-platform/*) ────────────────

export const customerAiAdminRouter = Router();

const assistantCreateSchema = z.object({
  slug: z.string().trim().min(2).max(63),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(400).optional(),
  category: z.enum(ASSISTANT_CATEGORIES).optional(),
  icon: z.string().trim().max(40).optional(),
  systemPrompt: z.string().trim().min(4).max(8000),
  recommendedRoutingMode: z.enum(KEY_ROUTING_MODES).optional(),
  starterPrompts: z.array(z.string().trim().min(1).max(300)).max(6).optional(),
  audience: z.enum(ASSISTANT_AUDIENCES).optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
}).strict();

const assistantUpdateSchema = assistantCreateSchema.partial();

customerAiAdminRouter.get('/customer-assistants', requirePerm('view_prompts'), (_req: Request, res: Response) => {
  res.json({ assistants: listAssistantsForAdmin() });
});

customerAiAdminRouter.post('/customer-assistants', requirePerm('edit_prompts'), (req: Request, res: Response) => {
  const parsed = assistantCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => i.message).join(', '), type: 'invalid_request' } });
    return;
  }
  try {
    const assistant = createAssistant(parsed.data);
    res.status(201).json({ assistant });
  } catch (err) {
    handleAiError(res, err);
  }
});

customerAiAdminRouter.patch('/customer-assistants/:id', requirePerm('edit_prompts'), (req: Request, res: Response) => {
  const id = parsePositiveId(req.params.id);
  if (!id) {
    res.status(400).json({ error: { message: 'Invalid assistant ID', type: 'invalid_request' } });
    return;
  }
  const parsed = assistantUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => i.message).join(', '), type: 'invalid_request' } });
    return;
  }
  try {
    const assistant = updateAssistant(id, parsed.data);
    res.json({ assistant });
  } catch (err) {
    handleAiError(res, err);
  }
});

customerAiAdminRouter.delete('/customer-assistants/:id', requirePerm('edit_prompts'), (req: Request, res: Response) => {
  const id = parsePositiveId(req.params.id);
  if (!id) {
    res.status(400).json({ error: { message: 'Invalid assistant ID', type: 'invalid_request' } });
    return;
  }
  const deleted = deleteAssistant(id);
  if (!deleted) {
    res.status(404).json({ error: { message: 'Assistant not found.', type: 'assistant_not_found' } });
    return;
  }
  res.json({ success: true });
});

customerAiAdminRouter.get('/anomaly-radar', requirePerm('view_ai_platform'), (req: Request, res: Response) => {
  const rawHours = typeof req.query.hours === 'string' ? Number.parseInt(req.query.hours, 10) : 24;
  const hours = Number.isFinite(rawHours) ? rawHours : 24;
  res.json({ report: buildAdminAnomalyRadar(hours) });
});

customerAiAdminRouter.post('/anomaly-radar/users/:userId/apply-eco', requirePerm('edit_ai_flags'), (req: Request, res: Response) => {
  const userId = parsePositiveId(req.params.userId);
  if (!userId) {
    res.status(400).json({ error: { message: 'Invalid user ID', type: 'invalid_request' } });
    return;
  }
  res.json(applyEcoModeToUserKeys(userId));
});
