import { Router, type Request, type Response, type NextFunction } from 'express';
import type { SessionUser } from '../../services/auth.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import {
  SupportStoreError,
  type SupportTenant,
  type SupportUserContext,
  getSupportTenantSigningSecret,
} from './support-store.js';
import { resolveTenant, validateSupportPublicAuth } from './support-router.js';
import { dispatchPartnerEvent } from './support-runtime-router.js';
import { getSupportConversationForUser } from './support-workflows.js';
import {
  type SupportGuardrailPolicy,
  type SupportGuardrailEvaluation,
  type SupportQuotaStatus,
  getSupportGuardrailPolicy,
  updateSupportGuardrailPolicy,
  evaluateSupportInputGuardrails,
  getSupportUserQuotaStatus,
  checkAndConsumeSupportUserQuota,
  resetSupportUserQuota,
} from './support-guardrails.js';
import {
  SupportCrmWebhookError,
  type SupportCustomerProfile,
  type SupportCsatRating,
  type SupportCsatSummary,
  type SupportPartnerEventType,
  type SupportWebhookSubscription,
  type SupportWebhookDelivery,
  listSupportCustomerProfiles,
  getSupportCustomerProfileForRequester,
  upsertSupportCustomerProfile,
  appendCustomerMemoryFact,
  buildCustomerMemoryPrompt,
  submitSupportCsatRating,
  listSupportCsatRatings,
  getSupportCsatSummary,
  listSupportWebhookSubscriptions,
  upsertSupportWebhookSubscription,
  deleteSupportWebhookSubscription,
  listSupportWebhookDeliveries,
  dispatchSupportPartnerEvent,
} from './support-crm-webhooks.js';

// ---------------------------------------------------------------------------
// Helpers
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

export const xSupportGovernanceConsoleRouter = Router();

// Console Auth & Permission Middleware
xSupportGovernanceConsoleRouter.use(requireAuth);
xSupportGovernanceConsoleRouter.use((req: Request, res: Response, next: NextFunction): void => {
  const user = (req as Request & { user?: SessionUser }).user;
  if (
    user?.isPrimary ||
    user?.role === 'admin' ||
    user?.permissions?.includes('*') ||
    user?.permissions?.includes('use_x_gateway') ||
    user?.permissions?.includes('edit_x_settings') ||
    user?.permissions?.includes('manage_x_gateway') ||
    user?.permissions?.includes('x_gateway.support' as never)
  ) {
    next();
    return;
  }
  res.status(403).json({
    error: { message: "Permission denied: 'x_gateway.support' access required.", type: 'forbidden' },
  });
});

// 1.1 Prompt Firewall, Topic Guardrails & Per-Role Quotas
// GET /tenants/:tenantId/guardrails
xSupportGovernanceConsoleRouter.get(
  '/tenants/:tenantId/guardrails',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const policy: SupportGuardrailPolicy = getSupportGuardrailPolicy(tid);
    res.json({ ok: true, policy });
  },
);

// PUT /tenants/:tenantId/guardrails
xSupportGovernanceConsoleRouter.put(
  '/tenants/:tenantId/guardrails',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const policy: SupportGuardrailPolicy = updateSupportGuardrailPolicy(tid, req.body ?? {});
    res.json({ ok: true, policy });
  },
);

// POST /tenants/:tenantId/guardrails/evaluate
xSupportGovernanceConsoleRouter.post(
  '/tenants/:tenantId/guardrails/evaluate',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const text = String(req.body?.text ?? '');
    const userRole = String(req.body?.role || 'customer');
    const userId = req.body?.userId ? String(req.body.userId) : undefined;
    const evaluation: SupportGuardrailEvaluation = evaluateSupportInputGuardrails(tid, {
      text,
      userRole,
      userId,
    });
    res.json({ ok: true, evaluation });
  },
);

// GET /tenants/:tenantId/quotas/:userId
xSupportGovernanceConsoleRouter.get(
  '/tenants/:tenantId/quotas/:userId',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const userId = paramStr(req.params.userId);
    const userRole = String(req.query?.role || 'customer');
    const quota: SupportQuotaStatus = getSupportUserQuotaStatus(tid, { userId, userRole });
    res.json({ ok: true, quota });
  },
);

// POST /tenants/:tenantId/quotas/reset
xSupportGovernanceConsoleRouter.post(
  '/tenants/:tenantId/quotas/reset',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const userId = req.body?.userId ? String(req.body.userId) : undefined;
    resetSupportUserQuota(tid, userId);
    res.json({ ok: true });
  },
);

// 1.2 Customer CRM Profiles & Long-Term Memory
// GET /tenants/:tenantId/customers
xSupportGovernanceConsoleRouter.get(
  '/tenants/:tenantId/customers',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const role = req.query.role ? String(req.query.role) : undefined;
    const tier = req.query.tier ? String(req.query.tier) : undefined;
    const query = req.query.query ? String(req.query.query) : undefined;
    const customers: SupportCustomerProfile[] = listSupportCustomerProfiles(tid, {
      role,
      tier,
      query,
    });
    res.json({ ok: true, customers });
  },
);

// POST /tenants/:tenantId/customers
xSupportGovernanceConsoleRouter.post(
  '/tenants/:tenantId/customers',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    if (!req.body?.userId || typeof req.body.userId !== 'string') {
      res.status(400).json({ error: { message: 'userId is required.', status: 400 } });
      return;
    }
    const customer: SupportCustomerProfile = upsertSupportCustomerProfile(tid, req.body);
    res.status(201).json({ ok: true, customer });
  },
);

// GET /tenants/:tenantId/customers/:userId
xSupportGovernanceConsoleRouter.get(
  '/tenants/:tenantId/customers/:userId',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const userId = paramStr(req.params.userId);
    const customers = listSupportCustomerProfiles(tid);
    const customer = customers.find((c) => c.userId === userId) ?? null;
    const memoryPrompt = buildCustomerMemoryPrompt(tid, userId, 'admin');
    res.json({ ok: true, customer, memoryPrompt });
  },
);

// POST /tenants/:tenantId/customers/:userId/facts
xSupportGovernanceConsoleRouter.post(
  '/tenants/:tenantId/customers/:userId/facts',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const userId = paramStr(req.params.userId);
    const fact = String(req.body?.fact ?? '').trim();
    if (!fact) {
      res.status(400).json({ error: { message: 'Fact content is required.', status: 400 } });
      return;
    }
    const customer: SupportCustomerProfile = appendCustomerMemoryFact(tid, userId, fact);
    const memoryPrompt = buildCustomerMemoryPrompt(tid, userId, 'admin');
    res.json({ ok: true, customer, memoryPrompt });
  },
);

// 1.3 CSAT Ratings & Summary
// GET /tenants/:tenantId/csat
xSupportGovernanceConsoleRouter.get(
  '/tenants/:tenantId/csat',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const userId = req.query.userId ? String(req.query.userId) : undefined;
    const minScore = req.query.minScore ? Number(req.query.minScore) : undefined;
    const maxScore = req.query.maxScore ? Number(req.query.maxScore) : undefined;
    const ratings: SupportCsatRating[] = listSupportCsatRatings(tid, {
      userId,
      minScore,
      maxScore,
    });
    const summary: SupportCsatSummary = getSupportCsatSummary(tid);
    res.json({ ok: true, ratings, summary });
  },
);

// 1.4 Outbound Partner Event Webhooks & Delivery Logs
// GET /tenants/:tenantId/webhooks
xSupportGovernanceConsoleRouter.get(
  '/tenants/:tenantId/webhooks',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const webhooks: SupportWebhookSubscription[] = listSupportWebhookSubscriptions(tid);
    const deliveries: SupportWebhookDelivery[] = listSupportWebhookDeliveries(tid);
    res.json({ ok: true, webhooks, deliveries });
  },
);

// POST /tenants/:tenantId/webhooks
xSupportGovernanceConsoleRouter.post(
  '/tenants/:tenantId/webhooks',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const name = String(req.body?.name ?? '').trim();
    const targetUrl = String(req.body?.targetUrl ?? '').trim();
    if (!name || !targetUrl) {
      res.status(400).json({ error: { message: 'Webhook name and targetUrl are required.', status: 400 } });
      return;
    }
    const webhook: SupportWebhookSubscription = upsertSupportWebhookSubscription(tid, req.body);
    res.status(201).json({ ok: true, webhook });
  },
);

// DELETE /tenants/:tenantId/webhooks/:webhookId
xSupportGovernanceConsoleRouter.delete(
  '/tenants/:tenantId/webhooks/:webhookId',
  (req: Request, res: Response): void => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const webhookId = paramStr(req.params.webhookId);
    deleteSupportWebhookSubscription(tid, webhookId);
    res.json({ ok: true });
  },
);

// POST /tenants/:tenantId/webhooks/test
xSupportGovernanceConsoleRouter.post(
  '/tenants/:tenantId/webhooks/test',
  async (req: Request, res: Response): Promise<void> => {
    const tid = resolveTenantIdParam(req.params.tenantId);
    const event = (req.body?.event as SupportPartnerEventType) || 'webhook.test';
    const payload = (req.body?.payload as Record<string, unknown>) ?? {
      message: 'Test ping from FreeLLMAPI Support Studio',
      timestamp: new Date().toISOString(),
    };
    const signingSecret = getSupportTenantSigningSecret(Number(tid));
    const deliveries = await dispatchSupportPartnerEvent(tid, event, payload, {
      signingSecret,
      allowLocalhost: true,
    });
    res.json({ ok: true, deliveries });
  },
);

// Error Handler for Console Router
xSupportGovernanceConsoleRouter.use(
  (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof SupportStoreError || err instanceof SupportCrmWebhookError) {
      res.status(err.status).json({ error: { message: err.message, status: err.status } });
      return;
    }
    const message = err instanceof Error ? err.message : 'Support governance operation failed.';
    res.status(500).json({ error: { message, status: 500 } });
  },
);

// ===========================================================================
// 2. Public Partner API (/x/v1/support/*)
// ===========================================================================

export const xSupportGovernancePublicRouter = Router();

// Handle CORS Preflight
xSupportGovernancePublicRouter.use((req: Request, res: Response, next: NextFunction): void => {
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
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

// POST /guardrails/check
xSupportGovernancePublicRouter.post(
  '/guardrails/check',
  partnerAuthMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenant, userContext } = req as AuthenticatedPartnerRequest;
    const text = String(req.body?.text ?? req.body?.prompt ?? '');

    // 1. Evaluate guardrails
    const evaluation = evaluateSupportInputGuardrails(String(tenant.id), {
      text,
      userId: userContext.userId,
      userRole: userContext.role,
    });

    if (!evaluation.allowed) {
      dispatchPartnerEvent({
        tenantId: Number(tenant.id),
        event: 'guardrail.blocked',
        payload: {
          userId: userContext.userId,
          role: userContext.role,
          evaluation,
        },
        dedupKey: `blocked_${userContext.userId}_${Date.now()}`,
      });
      res.status(403).json({
        ok: false,
        blocked: true,
        evaluation,
      });
      return;
    }

    // 2. Check and consume quota
    const tokens = typeof req.body?.tokens === 'number' ? req.body.tokens : undefined;
    const quota = checkAndConsumeSupportUserQuota(String(tenant.id), {
      userId: userContext.userId,
      userRole: userContext.role,
      tokens,
    });

    if (!quota.allowed) {
      res.status(429).json({
        ok: false,
        quotaExceeded: true,
        quota,
      });
      return;
    }

    res.json({
      ok: true,
      evaluation,
      quota,
    });
  },
);

// GET /profile
xSupportGovernancePublicRouter.get(
  '/profile',
  partnerAuthMiddleware,
  (req: Request, res: Response): void => {
    const { tenant, userContext } = req as AuthenticatedPartnerRequest;
    const targetUserId = req.query.userId ? String(req.query.userId) : userContext.userId;

    const profile = getSupportCustomerProfileForRequester(
      String(tenant.id),
      targetUserId,
      {
        userId: userContext.userId,
        role: userContext.role,
      },
    );

    const memoryPrompt = buildCustomerMemoryPrompt(
      String(tenant.id),
      targetUserId,
      userContext.role,
    );

    res.json({
      ok: true,
      profile: profile ?? null,
      memoryPrompt,
    });
  },
);

// PATCH /profile
xSupportGovernancePublicRouter.patch(
  '/profile',
  partnerAuthMiddleware,
  (req: Request, res: Response): void => {
    const { tenant, userContext } = req as AuthenticatedPartnerRequest;

    const profile = upsertSupportCustomerProfile(String(tenant.id), {
      userId: userContext.userId,
      name: userContext.name,
      email: userContext.email,
      role: userContext.role,
      tags: Array.isArray(req.body?.tags) ? (req.body.tags as string[]) : undefined,
      customAttributes:
        req.body?.customAttributes && typeof req.body.customAttributes === 'object'
          ? (req.body.customAttributes as Record<string, string | number | boolean>)
          : undefined,
      memoryFacts: Array.isArray(req.body?.memoryFacts)
        ? (req.body.memoryFacts as string[])
        : undefined,
      tier: req.body?.tier ? String(req.body.tier) : undefined,
    });

    res.json({
      ok: true,
      profile,
    });
  },
);

// POST /csat
xSupportGovernancePublicRouter.post(
  '/csat',
  partnerAuthMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenant, userContext } = req as AuthenticatedPartnerRequest;
    const score = Number(req.body?.score);
    if (!Number.isFinite(score) || score < 1 || score > 5) {
      res.status(400).json({ error: { message: 'CSAT score must be an integer between 1 and 5.', status: 400 } });
      return;
    }

    if (req.body?.conversationId) {
      getSupportConversationForUser(String(tenant.id), String(req.body.conversationId), {
        userId: userContext.userId,
        role: userContext.role,
      });
    }

    const rating = submitSupportCsatRating(String(tenant.id), {
      conversationId: req.body?.conversationId ? String(req.body.conversationId) : undefined,
      userId: userContext.userId,
      userName: userContext.name,
      userRole: userContext.role,
      score,
      category: req.body?.category ? String(req.body.category) : undefined,
      comment: req.body?.comment ? String(req.body.comment) : undefined,
    });

    const summary = getSupportCsatSummary(String(tenant.id));

    dispatchPartnerEvent({
      tenantId: Number(tenant.id),
      event: 'csat.submitted',
      payload: { rating, summary },
      dedupKey: `csat_${rating.id}`,
    });

    res.status(201).json({
      ok: true,
      rating,
      summary,
    });
  },
);

// Error Handler for Public Partner Router
xSupportGovernancePublicRouter.use(
  (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (
      err instanceof SupportStoreError ||
      err instanceof SupportCrmWebhookError ||
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
