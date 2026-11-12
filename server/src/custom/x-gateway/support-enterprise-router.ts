import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { SessionUser } from '../../services/auth.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { getDb } from '../../db/index.js';
import {
  SupportStoreError,
  type SupportTenant,
  type SupportUserContext,
  listSupportTools,
  createSupportTool,
} from './support-store.js';
import { invokeSupportRuntimeWebhook } from './support-action-executor.js';
import {
  listSupportKnowledgeDocs,
  upsertSupportKnowledgeDoc,
  deleteSupportKnowledgeDoc,
  seedDefaultSupportKnowledgeDocs,
  searchSupportKnowledge,
  buildSupportKnowledgeContextPrompt,
  getSupportMaskingPolicy,
  updateSupportMaskingPolicy,
  maskSupportSensitiveText,
  maskSupportSensitiveData,
} from './support-knowledge.js';
import {
  SupportWorkflowError,
  type SupportConversationStatus,
  type SupportTicketPriority,
  type SupportTicketStatus,
  type SupportPendingActionStatus,
  listSupportConversations,
  getSupportConversationForUser,
  createOrAppendSupportConversation,
  addHumanAgentReply,
  listSupportEscalationTickets,
  createSupportEscalationTicket,
  updateSupportEscalationTicket,
  listSupportPendingActions,
  proposeSupportPendingAction,
  getSupportAnalyticsSummary,
} from './support-workflows.js';
import { resolveTenant, validateSupportPublicAuth } from './support-router.js';
import { dispatchActionReview, dispatchPartnerEvent } from './support-runtime-router.js';

// ---------------------------------------------------------------------------
// Audit Log Persistence
// ---------------------------------------------------------------------------

const AUDIT_KEY = 'x_gateway_support_audit_v1';

export interface SupportAuditLogEntry {
  id: string;
  tenantId: string;
  timestamp: string;
  action: string;
  userId?: string;
  role?: string;
  details?: Record<string, unknown>;
}

export function appendSupportAuditLog(
  entry: Omit<SupportAuditLogEntry, 'id' | 'timestamp'>,
): SupportAuditLogEntry {
  const item: SupportAuditLogEntry = {
    id: `aud_${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(AUDIT_KEY) as
      | { value: string }
      | undefined;
    let list: SupportAuditLogEntry[] = [];
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed)) list = parsed;
      } catch {
        /* empty */
      }
    }
    list.unshift(item);
    if (list.length > 500) list.length = 500;
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(AUDIT_KEY, JSON.stringify(list));
  } catch {
    /* ignore audit log failure */
  }
  return item;
}

export function listSupportAuditLogs(tenantId?: string): SupportAuditLogEntry[] {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(AUDIT_KEY) as
      | { value: string }
      | undefined;
    if (!row?.value) return [];
    const list = JSON.parse(row.value) as SupportAuditLogEntry[];
    if (!Array.isArray(list)) return [];
    if (tenantId) return list.filter((e) => String(e.tenantId) === String(tenantId));
    return list;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helper: Resolve Tenant ID from param
// ---------------------------------------------------------------------------

function paramStr(val: unknown): string {
  if (Array.isArray(val)) return String(val[0] ?? '');
  return String(val ?? '');
}

function resolveTenantIdParam(param: unknown): string {
  const tenant = resolveTenant(paramStr(param));
  return String(tenant.id);
}

// ===========================================================================
// 1. Admin Console API (/api/x-gateway/support/*)
// ===========================================================================

export const xSupportEnterpriseConsoleRouter = Router();

// Console Auth & Permission Middleware
xSupportEnterpriseConsoleRouter.use(requireAuth);
xSupportEnterpriseConsoleRouter.use((req: Request, res: Response, next: NextFunction): void => {
  const user = (req as Request & { user?: SessionUser }).user;
  if (
    user?.isPrimary ||
    user?.role === 'admin' ||
    user?.permissions?.includes('*') ||
    user?.permissions?.includes('use_x_gateway') ||
    user?.permissions?.includes('edit_x_settings') ||
    user?.permissions?.includes('manage_x_gateway') ||
    user?.permissions?.includes('x_gateway.support' as any)
  ) {
    return next();
  }
  res.status(403).json({
    error: { message: "Permission denied: 'x_gateway.support' access required.", type: 'forbidden' },
  });
});

// 1.1 Knowledge Base & Role RAG
// GET /tenants/:tenantId/knowledge
xSupportEnterpriseConsoleRouter.get(
  '/tenants/:tenantId/knowledge',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const docs = listSupportKnowledgeDocs(tid);
    res.json({ ok: true, docs });
  },
);

// POST /tenants/:tenantId/knowledge
xSupportEnterpriseConsoleRouter.post(
  '/tenants/:tenantId/knowledge',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const { title, content } = req.body ?? {};
    if (!title || !content) {
      res.status(400).json({ error: { message: 'Title and content are required.', status: 400 } });
      return;
    }
    const doc = upsertSupportKnowledgeDoc(tid, req.body);
    res.status(201).json({ ok: true, doc });
  },
);

// POST /tenants/:tenantId/knowledge/seed
xSupportEnterpriseConsoleRouter.post(
  '/tenants/:tenantId/knowledge/seed',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const docs = seedDefaultSupportKnowledgeDocs(tid);
    res.json({ ok: true, docs });
  },
);

// DELETE /tenants/:tenantId/knowledge/:docId
xSupportEnterpriseConsoleRouter.delete(
  '/tenants/:tenantId/knowledge/:docId',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    deleteSupportKnowledgeDoc(tid, paramStr(req.params.docId));
    res.json({ ok: true });
  },
);

// POST /tenants/:tenantId/knowledge/search
xSupportEnterpriseConsoleRouter.post(
  '/tenants/:tenantId/knowledge/search',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const query = String(req.body?.query ?? '');
    const role = String(req.body?.role || 'admin');
    const topK = typeof req.body?.topK === 'number' ? req.body.topK : 5;
    const category = req.body?.category ? String(req.body.category) : undefined;

    const matches = searchSupportKnowledge(tid, query, role, { topK, category });
    const maskedResult = maskSupportSensitiveData(tid, matches, role);
    const contextPrompt = buildSupportKnowledgeContextPrompt(maskedResult.masked);

    res.json({ ok: true, matches: maskedResult.masked, contextPrompt });
  },
);

// 1.2 PII & Data Masking Policy
// GET /tenants/:tenantId/masking
xSupportEnterpriseConsoleRouter.get(
  '/tenants/:tenantId/masking',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const policy = getSupportMaskingPolicy(tid);
    res.json({ ok: true, policy });
  },
);

// PUT /tenants/:tenantId/masking
xSupportEnterpriseConsoleRouter.put(
  '/tenants/:tenantId/masking',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const policy = updateSupportMaskingPolicy(tid, req.body ?? {});
    res.json({ ok: true, policy });
  },
);

// POST /tenants/:tenantId/masking/test
xSupportEnterpriseConsoleRouter.post(
  '/tenants/:tenantId/masking/test',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const text = String(req.body?.text ?? '');
    const role = String(req.body?.role || 'customer');
    const result = maskSupportSensitiveText(tid, text, role);
    res.json({ ok: true, result });
  },
);

// 1.3 Conversations, Escalation Tickets & Action Approvals
// GET /tenants/:tenantId/conversations
xSupportEnterpriseConsoleRouter.get(
  '/tenants/:tenantId/conversations',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const userId = req.query.userId ? String(req.query.userId) : undefined;
    const status = req.query.status as SupportConversationStatus | undefined;
    const conversations = listSupportConversations(tid, { userId, status });
    res.json({ ok: true, conversations });
  },
);

// POST /tenants/:tenantId/conversations/:conversationId/reply
xSupportEnterpriseConsoleRouter.post(
  '/tenants/:tenantId/conversations/:conversationId/reply',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const content = req.body?.content ? String(req.body.content).trim() : '';
    if (!content) {
      res.status(400).json({ error: { message: 'Reply content is required.', status: 400 } });
      return;
    }
    const agentName = req.body?.agentName
      ? String(req.body.agentName)
      : (req as Request & { user?: SessionUser }).user?.email || 'Support Agent';
    const conversation = addHumanAgentReply(tid, paramStr(req.params.conversationId), {
      agentName,
      content,
      resolveConversation: !!req.body?.resolveConversation,
    });
    res.json({ ok: true, conversation });
  },
);

// GET /tenants/:tenantId/tickets
xSupportEnterpriseConsoleRouter.get(
  '/tenants/:tenantId/tickets',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const userId = req.query.userId ? String(req.query.userId) : undefined;
    const status = req.query.status as SupportTicketStatus | undefined;
    const priority = req.query.priority as SupportTicketPriority | undefined;
    const tickets = listSupportEscalationTickets(tid, { userId, status, priority });
    res.json({ ok: true, tickets });
  },
);

// PATCH /tenants/:tenantId/tickets/:ticketId
xSupportEnterpriseConsoleRouter.patch(
  '/tenants/:tenantId/tickets/:ticketId',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const ticketId = paramStr(req.params.ticketId);
    const currentTicket = listSupportEscalationTickets(tid).find((t) => t.id === ticketId);
    const wasResolved = currentTicket?.status === 'resolved';

    const ticket = updateSupportEscalationTicket(tid, ticketId, req.body ?? {});
    if (!ticket) {
      res.status(404).json({ error: { message: `Ticket '${ticketId}' not found.`, status: 404 } });
      return;
    }

    if (ticket.status === 'resolved' && !wasResolved) {
      dispatchPartnerEvent({
        tenantId: Number(tid),
        event: 'ticket.resolved',
        payload: { ticket },
        dedupKey: `ticket_resolved_${ticket.id}`,
      });
    }

    res.json({ ok: true, ticket });
  },
);

// GET /tenants/:tenantId/actions
xSupportEnterpriseConsoleRouter.get(
  '/tenants/:tenantId/actions',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const userId = req.query.userId ? String(req.query.userId) : undefined;
    const status = req.query.status as SupportPendingActionStatus | undefined;
    const actions = listSupportPendingActions(tid, { userId, status });
    res.json({ ok: true, actions });
  },
);

// POST /tenants/:tenantId/actions/:actionId/approve
xSupportEnterpriseConsoleRouter.post(
  '/tenants/:tenantId/actions/:actionId/approve',
  async (req: Request, res: Response): Promise<void> => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const actionId = paramStr(req.params.actionId);
    const reviewedBy =
      (req as Request & { user?: SessionUser }).user?.email ||
      (req as Request & { user?: SessionUser }).user?.userId ||
      'admin';

    try {
      const action = await dispatchActionReview({
        tenantId: Number(tid),
        actionId,
        decision: 'approved',
        reviewedBy: String(reviewedBy),
        reviewNote: req.body?.reviewNote ? String(req.body.reviewNote) : undefined,
      });
      res.json({ ok: true, action });
    } catch (err: any) {
      const status = err.status || err.statusCode || 500;
      res.status(status).json({
        error: { message: err.message || 'Action approval failed.', status },
      });
    }
  },
);

// POST /tenants/:tenantId/actions/:actionId/reject
xSupportEnterpriseConsoleRouter.post(
  '/tenants/:tenantId/actions/:actionId/reject',
  async (req: Request, res: Response): Promise<void> => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const actionId = paramStr(req.params.actionId);
    const reviewedBy =
      (req as Request & { user?: SessionUser }).user?.email ||
      (req as Request & { user?: SessionUser }).user?.userId ||
      'admin';

    try {
      const action = await dispatchActionReview({
        tenantId: Number(tid),
        actionId,
        decision: 'rejected',
        reviewedBy: String(reviewedBy),
        reviewNote: req.body?.reviewNote ? String(req.body.reviewNote) : undefined,
      });
      res.json({ ok: true, action });
    } catch (err: any) {
      const status = err.status || err.statusCode || 500;
      res.status(status).json({
        error: { message: err.message || 'Action rejection failed.', status },
      });
    }
  },
);

// GET /tenants/:tenantId/analytics
xSupportEnterpriseConsoleRouter.get(
  '/tenants/:tenantId/analytics',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const analytics = getSupportAnalyticsSummary(tid);
    res.json({ ok: true, analytics });
  },
);

// Error Handler for Console Router
xSupportEnterpriseConsoleRouter.use(
  (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof SupportStoreError || err instanceof SupportWorkflowError) {
      res.status(err.status).json({ error: { message: err.message, status: err.status } });
      return;
    }
    const message = err instanceof Error ? err.message : 'Support console operation failed.';
    res.status(500).json({ error: { message, status: 500 } });
  },
);

// ===========================================================================
// 2. Public Partner API (/x/v1/support/*)
// ===========================================================================

export const xSupportEnterprisePublicRouter = Router();

// Handle CORS Preflight
xSupportEnterprisePublicRouter.use((req: Request, res: Response, next: NextFunction): void => {
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin;
    const tenantKey =
      (req.headers['x-support-tenant-key'] as string) || (req.query.tenantKey as string);
    let tenant: SupportTenant | undefined;
    if (tenantKey) {
      try {
        tenant = resolveTenant(tenantKey);
        if (origin) {
          const allowed = tenant.allowedOrigins ?? [];
          if (allowed.length > 0 && !allowed.includes('*') && !allowed.includes(origin)) {
            res.status(403).json({ error: { code: 'origin_denied', message: 'CORS origin denied.' } });
            return;
          }
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
      } catch {
        /* ignore */
      }
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH, DELETE');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Tenant-Secret, X-Support-Tenant-Key, X-Support-User-Token, X-Support-Context-Token',
    );
    res.status(204).end();
    return;
  }
  next();
});

interface AuthenticatedPartnerRequest extends Request {
  tenant: SupportTenant;
  userContext: SupportUserContext;
}

function partnerAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  try {
    const { tenant, userContext } = validateSupportPublicAuth(req, res);
    (req as AuthenticatedPartnerRequest).tenant = tenant;
    (req as AuthenticatedPartnerRequest).userContext = userContext;
    next();
  } catch (err: any) {
    const status = err.status || 401;
    const code =
      err.code ||
      (status === 400
        ? 'conflicting_identity'
        : status === 403
          ? 'origin_denied'
          : 'invalid_context_token');
    res.status(status).json({ error: { code, message: (err as Error).message, status } });
  }
}

// POST /knowledge/query
xSupportEnterprisePublicRouter.post(
  '/knowledge/query',
  partnerAuthMiddleware,
  (req: Request, res: Response): void => {
    const { tenant, userContext } = req as AuthenticatedPartnerRequest;
    const query = String(req.body?.query ?? '');
    const topK = typeof req.body?.topK === 'number' ? req.body.topK : 5;
    const category = req.body?.category ? String(req.body.category) : undefined;

    const matches = searchSupportKnowledge(String(tenant.id), query, userContext.role, {
      topK,
      category,
    });
    const maskedResult = maskSupportSensitiveData(String(tenant.id), matches, userContext.role);

    appendSupportAuditLog({
      tenantId: String(tenant.id),
      action: 'knowledge.query',
      userId: userContext.userId,
      role: userContext.role,
      details: { query, count: matches.length, redactionCount: maskedResult.redactionCount },
    });

    res.json({
      ok: true,
      role: userContext.role,
      matches: maskedResult.masked,
      redactionCount: maskedResult.redactionCount,
    });
  },
);

// GET /conversations
xSupportEnterprisePublicRouter.get(
  '/conversations',
  partnerAuthMiddleware,
  (req: Request, res: Response): void => {
    const { tenant, userContext } = req as AuthenticatedPartnerRequest;
    const isAdminOrStaff = ['admin', 'staff'].includes(userContext.role);
    const userId = isAdminOrStaff
      ? req.query.userId
        ? String(req.query.userId)
        : undefined
      : userContext.userId;
    const status = req.query.status as SupportConversationStatus | undefined;

    const conversations = listSupportConversations(String(tenant.id), { userId, status });
    const maskedConversations = conversations.map((c) => ({
      ...c,
      messages: c.messages.map((m) => ({
        ...m,
        content: maskSupportSensitiveText(String(tenant.id), m.content, userContext.role).masked,
      })),
    }));
    res.json({ ok: true, conversations: maskedConversations });
  },
);

// POST /conversations/messages
xSupportEnterprisePublicRouter.post(
  '/conversations/messages',
  partnerAuthMiddleware,
  (req: Request, res: Response): void => {
    const { tenant, userContext } = req as AuthenticatedPartnerRequest;
    const content = req.body?.content ? String(req.body.content).trim() : '';
    if (!content) {
      res.status(400).json({ error: { message: 'Message content is required.', status: 400 } });
      return;
    }

    if (req.body?.conversationId) {
      getSupportConversationForUser(String(tenant.id), String(req.body.conversationId), {
        userId: userContext.userId,
        role: userContext.role,
      });
    }

    const conversation = createOrAppendSupportConversation(String(tenant.id), {
      conversationId: req.body?.conversationId ? String(req.body.conversationId) : undefined,
      userId: userContext.userId,
      userName: userContext.name,
      userEmail: userContext.email,
      userRole: userContext.role,
      subject: req.body?.subject ? String(req.body.subject) : undefined,
      message: {
        senderType: 'customer',
        senderId: userContext.userId,
        senderName: userContext.name,
        senderRole: userContext.role,
        content,
      },
    });

    res.json({ ok: true, conversation });
  },
);

// GET /conversations/:conversationId
xSupportEnterprisePublicRouter.get(
  '/conversations/:conversationId',
  partnerAuthMiddleware,
  (req: Request, res: Response): void => {
    const { tenant, userContext } = req as AuthenticatedPartnerRequest;
    const conversation = getSupportConversationForUser(
      String(tenant.id),
      paramStr(req.params.conversationId),
      {
        userId: userContext.userId,
        role: userContext.role,
      },
    );
    const maskedMessages = conversation.messages.map((m) => ({
      ...m,
      content: maskSupportSensitiveText(String(tenant.id), m.content, userContext.role).masked,
    }));
    res.json({ ok: true, conversation: { ...conversation, messages: maskedMessages } });
  },
);

// POST /escalate
xSupportEnterprisePublicRouter.post(
  '/escalate',
  partnerAuthMiddleware,
  (req: Request, res: Response): void => {
    const { tenant, userContext } = req as AuthenticatedPartnerRequest;
    const subject = req.body?.subject ? String(req.body.subject).trim() : '';
    const reason = req.body?.reason ? String(req.body.reason).trim() : '';
    if (!subject || !reason) {
      res.status(400).json({ error: { message: 'Subject and reason are required.', status: 400 } });
      return;
    }

    if (req.body?.conversationId) {
      getSupportConversationForUser(String(tenant.id), String(req.body.conversationId), {
        userId: userContext.userId,
        role: userContext.role,
      });
    }

    const ticket = createSupportEscalationTicket(String(tenant.id), {
      conversationId: req.body?.conversationId ? String(req.body.conversationId) : undefined,
      userId: userContext.userId,
      userName: userContext.name,
      userRole: userContext.role,
      subject,
      reason,
      priority: req.body?.priority as SupportTicketPriority | undefined,
    });

    dispatchPartnerEvent({
      tenantId: Number(tenant.id),
      event: 'ticket.created',
      payload: { ticket },
      dedupKey: `ticket_${ticket.id}`,
    });

    res.status(201).json({ ok: true, ticket });
  },
);

// POST /actions/propose
xSupportEnterprisePublicRouter.post(
  '/actions/propose',
  partnerAuthMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenant, userContext } = req as AuthenticatedPartnerRequest;
    const toolName = req.body?.toolName ? String(req.body.toolName).trim() : '';
    const actionSummary = req.body?.actionSummary ? String(req.body.actionSummary).trim() : '';
    if (!toolName || !actionSummary) {
      res.status(400).json({ error: { message: 'Tool name and action summary are required.', status: 400 } });
      return;
    }

    if (req.body?.conversationId) {
      getSupportConversationForUser(String(tenant.id), String(req.body.conversationId), {
        userId: userContext.userId,
        role: userContext.role,
      });
    }

    const tools = listSupportTools(Number(tenant.id));
    let tool = tools.find((t) => t.name.toLowerCase() === toolName.toLowerCase());
    if (!tool) {
      tool = createSupportTool(Number(tenant.id), {
        name: toolName,
        description: actionSummary,
        method: 'POST',
        endpointUrl: 'https://example.com/api/actions',
        allowedRoles: ['customer', 'admin', 'staff', 'guest'],
        enabled: true,
      });
    }

    try {
      const resExec = await invokeSupportRuntimeWebhook({
        tenantId: Number(tenant.id),
        context: userContext,
        tool,
        args: (req.body?.payload as Record<string, unknown>) ?? {},
        requestId: `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        conversationId: req.body?.conversationId ? String(req.body.conversationId) : undefined,
      });
      const pendingActionId = (resExec.data as any)?.pendingActionId;
      const allActions = listSupportPendingActions(String(tenant.id));
      const action = allActions.find((a) => a.id === pendingActionId);
      res.status(201).json({ ok: true, action });
      return;
    } catch {
      // Fallback proposal if action executor is unavailable
    }

    const action = proposeSupportPendingAction(String(tenant.id), {
      conversationId: req.body?.conversationId ? String(req.body.conversationId) : undefined,
      userId: userContext.userId,
      userName: userContext.name,
      userRole: userContext.role,
      toolName,
      actionSummary,
      payload: (req.body?.payload as Record<string, unknown>) ?? {},
    });

    res.status(201).json({ ok: true, action });
  },
);

// GET /actions
xSupportEnterprisePublicRouter.get(
  '/actions',
  partnerAuthMiddleware,
  (req: Request, res: Response): void => {
    const { tenant, userContext } = req as AuthenticatedPartnerRequest;
    const isAdminOrStaff = ['admin', 'staff'].includes(userContext.role);
    const userId = isAdminOrStaff
      ? req.query.userId
        ? String(req.query.userId)
        : undefined
      : userContext.userId;
    const status = req.query.status as SupportPendingActionStatus | undefined;

    const actions = listSupportPendingActions(String(tenant.id), { userId, status });
    res.json({ ok: true, actions });
  },
);

// Error Handler for Public Partner Router
xSupportEnterprisePublicRouter.use(
  (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (
      err instanceof SupportStoreError ||
      err instanceof SupportWorkflowError ||
      typeof (err as any).status === 'number'
    ) {
      const status = (err as any).status;
      res.status(status).json({ error: { message: (err as Error).message, status } });
      return;
    }
    const message = err instanceof Error ? err.message : 'Support gateway error.';
    res.status(500).json({ error: { message, status: 500 } });
  },
);
