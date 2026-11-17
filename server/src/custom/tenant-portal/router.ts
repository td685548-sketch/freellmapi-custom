import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  DEFAULT_SUPPORT_OUTPUT_POLICY,
  SUPPORT_OUTPUT_LIMITS,
  type SupportOutputPolicy,
} from '@freellmapi/shared/support-output.js';
import {
  RUNTIME_POLICY_BOUNDS,
  type SupportRuntimePolicy,
} from '@freellmapi/shared/support-runtime.js';
import type {
  SupportDeskSlaPolicy,
  SupportDeskWidgetConfig,
} from '@freellmapi/shared/support-service-desk.js';
import {
  TENANT_PERMISSIONS,
  type TenantPermission,
  type TenantRolePresetId,
} from '@freellmapi/shared/tenant-rbac.js';
import { allowAuthRequest } from '../../services/auth-security.js';
import type { SessionUser } from '../../services/auth.js';
import {
  DEFAULT_ECOMMERCE_SANDBOX_SQL,
  SupportConnectorError,
  executeSupportDbQuery,
  executeSupportWebhookTool,
} from '../x-gateway/support-connectors.js';
import {
  deleteSupportWebhookSubscription,
  getSupportCsatSummary,
  listSupportCsatRatings,
  listSupportWebhookDeliveries,
  listSupportWebhookSubscriptions,
  SupportCrmWebhookError,
  upsertSupportWebhookSubscription,
} from '../x-gateway/support-crm-webhooks.js';
import {
  appendSupportAuditLog,
  listSupportAuditLogs,
} from '../x-gateway/support-enterprise-router.js';
import {
  evaluateSupportInputGuardrails,
  getSupportGuardrailPolicy,
  resetSupportUserQuota,
  updateSupportGuardrailPolicy,
} from '../x-gateway/support-guardrails.js';
import {
  buildSupportKnowledgeContextPrompt,
  deleteSupportKnowledgeDoc,
  getSupportMaskingPolicy,
  listSupportKnowledgeDocs,
  maskSupportSensitiveData,
  searchSupportKnowledge,
  seedDefaultSupportKnowledgeDocs,
  updateSupportMaskingPolicy,
  upsertSupportKnowledgeDoc,
} from '../x-gateway/support-knowledge.js';
import { evaluateSupportOutput } from '../x-gateway/support-output-engine.js';
import {
  getSupportOutputPolicy,
  listSupportOutputEvents,
  saveSupportOutputPolicy,
  SupportOutputError,
} from '../x-gateway/support-output-store.js';
import { executeSupportChatPipeline } from '../x-gateway/support-router.js';
import {
  dispatchActionReview,
  dispatchPartnerEvent,
  dispatchRuntimeTurn,
  getLocalRuntimePolicy,
  setLocalRuntimePolicy,
} from '../x-gateway/support-runtime-router.js';
import { SupportRuntimeError } from '../x-gateway/support-runtime-store.js';
import { buildSupportDeskEmbedSnippet } from '../x-gateway/support-service-desk-router.js';
import {
  getSupportDeskSlaPolicy,
  getSupportDeskWidgetConfig,
  SupportDeskError,
  updateSupportDeskSlaPolicy,
  updateSupportDeskWidgetConfig,
} from '../x-gateway/support-service-desk-store.js';
import {
  createSupportDbSource,
  createSupportTool,
  deleteSupportDbSource,
  deleteSupportTool,
  getSupportDbSource,
  getSupportDbSourceAuthToken,
  getSupportTenantSigningSecret,
  getSupportTool,
  listSupportDbSources,
  listSupportTools,
  mintSupportUserToken,
  rotateSupportTenantSecret,
  SupportStoreError,
  type SupportUserContext,
  updateSupportDbSource,
  updateSupportTenant,
  updateSupportTool,
  verifySupportUserToken,
} from '../x-gateway/support-store.js';
import {
  addHumanAgentReply,
  getSupportAnalyticsSummary,
  listSupportEscalationTickets,
  listSupportConversations,
  listSupportPendingActions,
  SupportWorkflowError,
  updateSupportEscalationTicket,
} from '../x-gateway/support-workflows.js';
import {
  assertTenantPermission,
  listAccessibleTenantsForUser,
  listSafeTenantModelOptions,
  listTenantMembers,
  removeTenantMember,
  TenantRbacError,
  upsertTenantMemberByTenantAdmin,
} from './store.js';

export const tenantPortalRouter = Router();

const PRESET_VALUES = [
  'tenant_owner',
  'ai_configurator',
  'support_operator',
  'viewer',
  'custom',
] as const;

const roleConfigSchema = z.object({
  role: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string().optional(),
  permissions: z.array(z.string().trim().min(1)),
});

const patchAiConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    defaultModel: z.string().trim().min(1).max(200).optional(),
    systemPrompt: z.string().max(32000).optional(),
    allowGuest: z.boolean().optional(),
    enabled: z.boolean().optional(),
    rolesConfig: z
      .array(roleConfigSchema)
      .refine((roles) => new Set(roles.map((r) => r.role)).size === roles.length, {
        message: 'Role names must be unique.',
      })
      .optional(),
  })
  .strict();

const RULE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function normalizeRuleTerm(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const outputRuleSchema = z
  .object({
    id: z.string().regex(RULE_ID_RE, 'Rule id must match [A-Za-z0-9_-]{1,64}.'),
    text: z.string(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const normalized = normalizeRuleTerm(rule.text);
    if (normalized.length < 1 || normalized.length > SUPPORT_OUTPUT_LIMITS.ruleTextMaxLength) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: `Normalized rule text must be 1..${SUPPORT_OUTPUT_LIMITS.ruleTextMaxLength} code units.`,
      });
    }
  });

const outputPolicyMutableSchema = z
  .object({
    mode: z.enum(['off', 'log', 'enforce']),
    blockedTerms: z.array(outputRuleSchema).max(SUPPORT_OUTPUT_LIMITS.maxRules),
    maxOutputChars: z
      .number()
      .int()
      .min(SUPPORT_OUTPUT_LIMITS.maxOutputCharsMin)
      .max(SUPPORT_OUTPUT_LIMITS.maxOutputCharsMax),
    redactCredentials: z.boolean(),
  })
  .strict();

const putOutputPolicySchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    policy: outputPolicyMutableSchema,
  })
  .strict();

const previewOutputPolicySchema = z
  .object({
    policy: outputPolicyMutableSchema,
    text: z.string().max(SUPPORT_OUTPUT_LIMITS.maxTotalRawChars),
  })
  .strict();

const memberWriteSchema = z.object({
  email: z.string().email('A valid email is required.').optional(),
  userId: z.number().int().positive().optional(),
  rolePreset: z.enum(PRESET_VALUES).optional(),
  permissions: z.array(z.enum([...TENANT_PERMISSIONS, '*'])).optional(),
});

const ticketPatchSchema = z
  .object({
    status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    assignedTo: z.string().trim().max(200).optional(),
    resolutionNotes: z.string().max(4000).optional(),
  })
  .strict();

const reviewActionSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    reviewNote: z.string().max(1000).optional(),
  })
  .strict();

function actor(req: Request): SessionUser {
  return (req as Request & { user?: SessionUser }).user!;
}

function paramStr(raw: string | string[] | undefined): string {
  return Array.isArray(raw) ? raw[0] ?? '' : raw ?? '';
}

function parsePositiveInt(raw: string | string[] | undefined, label = 'ID'): number {
  const val = paramStr(raw).trim();
  if (!/^[1-9]\d*$/.test(val)) {
    throw new TenantRbacError(400, 'invalid_input', `${label} must be a positive integer.`);
  }
  const num = Number(val);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new TenantRbacError(400, 'invalid_input', `${label} must be a positive integer.`);
  }
  return num;
}

function guard(
  req: Request,
  permission: TenantPermission,
): { user: SessionUser; tenantId: number; access: ReturnType<typeof assertTenantPermission> } {
  const user = actor(req);
  const tenantId = parsePositiveInt(req.params.tenantId, 'tenantId');
  const access = assertTenantPermission(user, tenantId, permission);
  return { user, tenantId, access };
}

function validateRuntimePolicyPatch(
  tenantId: number,
  raw: unknown,
): Partial<SupportRuntimePolicy> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TenantRbacError(400, 'invalid_input', 'runtimePolicy must be a JSON object.');
  }
  const body = raw as Record<string, unknown>;
  const allowedKeys = new Set([
    'allowedModels',
    'toolPolicies',
    'maxCompletionTokens',
    'maxModelCalls',
    'maxToolCalls',
    'maxContextChars',
    'maxToolResultChars',
    'maxHistoryMessages',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      throw new TenantRbacError(400, 'invalid_input', `Unknown property "${key}" in runtimePolicy.`);
    }
  }

  const numericChecks: Array<[keyof typeof RUNTIME_POLICY_BOUNDS, unknown]> = [
    ['maxCompletionTokens', body.maxCompletionTokens],
    ['maxModelCalls', body.maxModelCalls],
    ['maxToolCalls', body.maxToolCalls],
    ['maxContextChars', body.maxContextChars],
    ['maxToolResultChars', body.maxToolResultChars],
    ['maxHistoryMessages', body.maxHistoryMessages],
  ];
  for (const [key, val] of numericChecks) {
    if (val === undefined) continue;
    const { min, max } = RUNTIME_POLICY_BOUNDS[key];
    if (typeof val !== 'number' || !Number.isInteger(val) || val < min || val > max) {
      throw new TenantRbacError(
        400,
        'invalid_input',
        `${key} must be an integer between ${min} and ${max}.`,
      );
    }
  }

  if (body.allowedModels !== undefined) {
    if (
      !Array.isArray(body.allowedModels) ||
      !body.allowedModels.every((m) => typeof m === 'string')
    ) {
      throw new TenantRbacError(400, 'invalid_input', 'allowedModels must be an array of strings.');
    }
  }

  if (body.toolPolicies !== undefined) {
    if (!Array.isArray(body.toolPolicies)) {
      throw new TenantRbacError(400, 'invalid_input', 'toolPolicies must be an array.');
    }
    const validToolIds = new Set(listSupportTools(tenantId).map((t) => t.id));
    const seen = new Set<number>();
    for (const item of body.toolPolicies) {
      if (
        typeof item !== 'object' ||
        item === null ||
        typeof (item as { toolId?: unknown }).toolId !== 'number' ||
        !['read', 'approval_required'].includes(String((item as { mode?: unknown }).mode))
      ) {
        throw new TenantRbacError(
          400,
          'invalid_input',
          'Each toolPolicy must have toolId and mode ("read" | "approval_required").',
        );
      }
      const toolId = (item as { toolId: number }).toolId;
      if (seen.has(toolId)) {
        throw new TenantRbacError(400, 'invalid_input', `Duplicate toolPolicy for toolId ${toolId}.`);
      }
      seen.add(toolId);
      if (!validToolIds.has(toolId)) {
        throw new TenantRbacError(
          400,
          'invalid_input',
          `Tool #${toolId} does not belong to tenant #${tenantId}.`,
        );
      }
    }
  }

  return body as Partial<SupportRuntimePolicy>;
}

// ---------------------------------------------------------------------------
// 1. Accessible Tenants & Safe Models
// ---------------------------------------------------------------------------

// GET /api/tenant-portal/tenants
tenantPortalRouter.get('/tenants', (req: Request, res: Response) => {
  const user = actor(req);
  res.json({
    tenants: listAccessibleTenantsForUser(user),
    availableModels: listSafeTenantModelOptions(),
  });
});

// ---------------------------------------------------------------------------
// 2. AI Behavior & Model (tenant_ai_config)
// ---------------------------------------------------------------------------

// GET /api/tenant-portal/tenants/:tenantId
tenantPortalRouter.get('/tenants/:tenantId', (req: Request, res: Response) => {
  const tenantId = parsePositiveInt(req.params.tenantId, 'tenantId');
  const access = assertTenantPermission(actor(req), tenantId, 'view_tenant_ai');
  res.json({
    tenant: access.tenant,
    rolePreset: access.rolePreset,
    permissions: access.permissions,
    isPlatformOperator: access.isPlatformOperator,
    availableModels: listSafeTenantModelOptions(),
  });
});

// PATCH /api/tenant-portal/tenants/:tenantId
tenantPortalRouter.patch('/tenants/:tenantId', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_ai');
  const parsed = patchAiConfigSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'invalid_input',
        message: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      },
    });
    return;
  }

  const tenant = updateSupportTenant(tenantId, parsed.data);
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.ai_config.update',
    userId: String(user.userId),
    role: user.role,
    details: { updatedFields: Object.keys(parsed.data) },
  });
  res.json({ tenant });
});

// POST /api/tenant-portal/tenants/:tenantId/mint-token
tenantPortalRouter.post('/tenants/:tenantId/mint-token', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'test_tenant_ai');
  const token = mintSupportUserToken(tenantId, req.body ?? {});
  const context = verifySupportUserToken(tenantId, token);
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.sandbox.mint_token',
    userId: String(user.userId),
    role: user.role,
    details: { targetUserId: context.userId, targetRole: context.role },
  });
  res.json({ token, context });
});

// POST /api/tenant-portal/tenants/:tenantId/simulate-chat
tenantPortalRouter.post('/tenants/:tenantId/simulate-chat', async (req: Request, res: Response) => {
  const { tenantId, access } = guard(req, 'test_tenant_ai');
  const tenant = access.tenant;

  const role = String(req.body?.role || 'guest');
  const roleCfg = tenant.rolesConfig.find((r) => r.role === role);
  const extraPerms = Array.isArray(req.body?.permissions)
    ? (req.body.permissions as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];

  const context: SupportUserContext = {
    tenantId,
    userId: String(req.body?.userId || 'guest'),
    name: req.body?.name ? String(req.body.name) : undefined,
    role,
    permissions: [...new Set([...(roleCfg?.permissions ?? []), ...extraPerms])],
    verified: true,
  };

  const rawMessages = req.body?.messages;
  const messages = Array.isArray(rawMessages)
    ? (rawMessages as Array<{ role: 'user' | 'assistant' | 'system'; content: string }>)
    : [];
  const model = req.body?.model ? String(req.body.model).trim() : undefined;
  const requestId = req.body?.requestId ? String(req.body.requestId).trim() : `sim_${Date.now()}`;
  const conversationId = req.body?.conversationId ? String(req.body.conversationId).trim() : undefined;

  const result = await dispatchRuntimeTurn({
    tenant,
    userContext: context,
    input: {
      tenantKey: tenant.publicKey,
      conversationId,
      requestId,
      messages: messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content ?? ''),
      })),
      model,
    },
    generate: async (genCtx) =>
      executeSupportChatPipeline({
        tenant: genCtx.tenant,
        userContext: genCtx.userContext,
        messages: genCtx.messages,
        model: genCtx.model,
        hooks: {
          trustedContext: genCtx.trustedContext,
          disableTools: genCtx.disableTools,
          maxCompletionTokens: genCtx.policy?.maxCompletionTokens,
          maxModelCalls: genCtx.policy?.maxModelCalls,
          maxToolCalls: genCtx.policy?.maxToolCalls,
          maxContextChars: genCtx.policy?.maxContextChars,
          maxToolResultChars: genCtx.policy?.maxToolResultChars,
          maskToolData: genCtx.maskToolData,
          invokeWebhook: genCtx.invokeWebhook,
          signal: genCtx.signal,
          beforeModelCall: genCtx.beforeModelCall,
          recordModelUsage: genCtx.recordModelUsage,
        },
      }),
  });

  res.json({
    reply: result.reply,
    userContext: result.userContext,
    allowedTools: result.allowedTools,
    toolTrace: result.toolTrace,
    modelUsed: result.modelUsed,
    usage: result.usage,
    runtime: result.runtime,
  });
});

// ---------------------------------------------------------------------------
// 3. Knowledge Base & Masking (tenant_knowledge)
// ---------------------------------------------------------------------------

// GET /api/tenant-portal/tenants/:tenantId/knowledge
tenantPortalRouter.get('/tenants/:tenantId/knowledge', (req: Request, res: Response) => {
  const { tenantId } = guard(req, 'view_tenant_knowledge');
  const tid = String(tenantId);
  res.json({
    ok: true,
    docs: listSupportKnowledgeDocs(tid),
    masking: getSupportMaskingPolicy(tid),
  });
});

// POST /api/tenant-portal/tenants/:tenantId/knowledge
tenantPortalRouter.post('/tenants/:tenantId/knowledge', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_knowledge');
  const { title, content } = req.body ?? {};
  if (!title || !content) {
    res.status(400).json({ error: { code: 'invalid_input', message: 'Title and content are required.' } });
    return;
  }
  const doc = upsertSupportKnowledgeDoc(String(tenantId), req.body);
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.knowledge.upsert',
    userId: String(user.userId),
    role: user.role,
    details: { docId: doc.id, title: doc.title },
  });
  res.status(201).json({ ok: true, doc });
});

// POST /api/tenant-portal/tenants/:tenantId/knowledge/seed
tenantPortalRouter.post('/tenants/:tenantId/knowledge/seed', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_knowledge');
  const docs = seedDefaultSupportKnowledgeDocs(String(tenantId));
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.knowledge.seed',
    userId: String(user.userId),
    role: user.role,
    details: { count: docs.length },
  });
  res.json({ ok: true, docs });
});

// DELETE /api/tenant-portal/tenants/:tenantId/knowledge/:docId
tenantPortalRouter.delete('/tenants/:tenantId/knowledge/:docId', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_knowledge');
  const docId = paramStr(req.params.docId);
  const removed = deleteSupportKnowledgeDoc(String(tenantId), docId);
  if (!removed) {
    res.status(404).json({ error: { code: 'not_found', message: 'Knowledge document not found.' } });
    return;
  }
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.knowledge.delete',
    userId: String(user.userId),
    role: user.role,
    details: { docId },
  });
  res.json({ ok: true });
});

// POST /api/tenant-portal/tenants/:tenantId/knowledge/search
tenantPortalRouter.post('/tenants/:tenantId/knowledge/search', (req: Request, res: Response) => {
  const { tenantId } = guard(req, 'view_tenant_knowledge');
  const tid = String(tenantId);
  const query = String(req.body?.query ?? '');
  const role = String(req.body?.role || 'admin');
  const topK = typeof req.body?.topK === 'number' ? req.body.topK : 5;
  const category = req.body?.category ? String(req.body.category) : undefined;
  const matches = searchSupportKnowledge(tid, query, role, { topK, category });
  const maskedResult = maskSupportSensitiveData(tid, matches, role);
  const contextPrompt = buildSupportKnowledgeContextPrompt(maskedResult.masked);
  res.json({ ok: true, matches: maskedResult.masked, contextPrompt });
});

// PUT /api/tenant-portal/tenants/:tenantId/masking
tenantPortalRouter.put('/tenants/:tenantId/masking', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_knowledge');
  const policy = updateSupportMaskingPolicy(String(tenantId), req.body ?? {});
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.masking.update',
    userId: String(user.userId),
    role: user.role,
    details: { enabled: policy.enabled, detectors: policy.builtinDetectors },
  });
  res.json({ ok: true, policy });
});

// ---------------------------------------------------------------------------
// 4. Webhook Tools & Database Sources (tenant_tools)
// ---------------------------------------------------------------------------

// GET /api/tenant-portal/tenants/:tenantId/tools
tenantPortalRouter.get('/tenants/:tenantId/tools', (req: Request, res: Response) => {
  const { tenantId } = guard(req, 'view_tenant_tools');
  res.json({
    ok: true,
    tools: listSupportTools(tenantId),
    dbSources: listSupportDbSources(tenantId),
    sampleSchemaSql: DEFAULT_ECOMMERCE_SANDBOX_SQL,
  });
});

// POST /api/tenant-portal/tenants/:tenantId/tools
tenantPortalRouter.post('/tenants/:tenantId/tools', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_tools');
  const tool = createSupportTool(tenantId, req.body ?? {});
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.tool.create',
    userId: String(user.userId),
    role: user.role,
    details: { toolId: tool.id, name: tool.name },
  });
  res.status(201).json({ ok: true, tool });
});

// PATCH /api/tenant-portal/tenants/:tenantId/tools/:toolId
tenantPortalRouter.patch('/tenants/:tenantId/tools/:toolId', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_tools');
  const toolId = parsePositiveInt(req.params.toolId, 'toolId');
  const tool = updateSupportTool(tenantId, toolId, req.body ?? {});
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.tool.update',
    userId: String(user.userId),
    role: user.role,
    details: { toolId: tool.id, name: tool.name },
  });
  res.json({ ok: true, tool });
});

// DELETE /api/tenant-portal/tenants/:tenantId/tools/:toolId
tenantPortalRouter.delete('/tenants/:tenantId/tools/:toolId', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_tools');
  const toolId = parsePositiveInt(req.params.toolId, 'toolId');
  const removed = deleteSupportTool(tenantId, toolId);
  if (!removed) {
    res.status(404).json({ error: { code: 'not_found', message: 'Webhook tool not found.' } });
    return;
  }
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.tool.delete',
    userId: String(user.userId),
    role: user.role,
    details: { toolId },
  });
  res.json({ ok: true });
});

// POST /api/tenant-portal/tenants/:tenantId/tools/:toolId/test
tenantPortalRouter.post('/tenants/:tenantId/tools/:toolId/test', async (req: Request, res: Response) => {
  const { tenantId } = guard(req, 'test_tenant_tools');
  const toolId = parsePositiveInt(req.params.toolId, 'toolId');
  const tool = getSupportTool(tenantId, toolId);
  const signingSecret = getSupportTenantSigningSecret(tenantId);
  const context: SupportUserContext = {
    tenantId,
    userId: String(req.body?.userId || 'test-user'),
    role: String(req.body?.role || 'customer'),
    name: req.body?.name ? String(req.body.name) : undefined,
    permissions: [],
    verified: true,
  };
  const result = await executeSupportWebhookTool({
    tool,
    context,
    args: (req.body?.args as Record<string, unknown>) ?? {},
    signingSecret,
  });
  res.json(result);
});

// POST /api/tenant-portal/tenants/:tenantId/db-sources
tenantPortalRouter.post('/tenants/:tenantId/db-sources', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_tools');
  const dbSource = createSupportDbSource(tenantId, req.body ?? {});
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.db_source.create',
    userId: String(user.userId),
    role: user.role,
    details: { sourceId: dbSource.id, name: dbSource.name, driver: dbSource.driver },
  });
  res.status(201).json({ ok: true, dbSource });
});

// PATCH /api/tenant-portal/tenants/:tenantId/db-sources/:sourceId
tenantPortalRouter.patch('/tenants/:tenantId/db-sources/:sourceId', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_tools');
  const sourceId = parsePositiveInt(req.params.sourceId, 'sourceId');
  const dbSource = updateSupportDbSource(tenantId, sourceId, req.body ?? {});
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.db_source.update',
    userId: String(user.userId),
    role: user.role,
    details: { sourceId: dbSource.id, name: dbSource.name },
  });
  res.json({ ok: true, dbSource });
});

// DELETE /api/tenant-portal/tenants/:tenantId/db-sources/:sourceId
tenantPortalRouter.delete('/tenants/:tenantId/db-sources/:sourceId', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_tools');
  const sourceId = parsePositiveInt(req.params.sourceId, 'sourceId');
  const removed = deleteSupportDbSource(tenantId, sourceId);
  if (!removed) {
    res.status(404).json({ error: { code: 'not_found', message: 'Database source not found.' } });
    return;
  }
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.db_source.delete',
    userId: String(user.userId),
    role: user.role,
    details: { sourceId },
  });
  res.json({ ok: true });
});

// POST /api/tenant-portal/tenants/:tenantId/db-sources/:sourceId/query-test
tenantPortalRouter.post(
  '/tenants/:tenantId/db-sources/:sourceId/query-test',
  async (req: Request, res: Response) => {
    const { tenantId } = guard(req, 'test_tenant_tools');
    const sourceId = parsePositiveInt(req.params.sourceId, 'sourceId');
    const source = getSupportDbSource(tenantId, sourceId);
    const authToken = getSupportDbSourceAuthToken(tenantId, source.id);
    const context: SupportUserContext = {
      tenantId,
      userId: String(req.body?.userId || 'guest'),
      role: String(req.body?.role || 'guest'),
      name: req.body?.name ? String(req.body.name) : undefined,
      permissions: [],
      verified: true,
    };
    const result = await executeSupportDbQuery({
      source,
      context,
      sql: String(req.body?.sql || ''),
      authToken,
    });
    res.json({ ok: true, ...result });
  },
);

// ---------------------------------------------------------------------------
// 5. Guardrails & Output Controls (tenant_guardrails)
// ---------------------------------------------------------------------------

// GET /api/tenant-portal/tenants/:tenantId/guardrails
tenantPortalRouter.get('/tenants/:tenantId/guardrails', (req: Request, res: Response) => {
  const { tenantId } = guard(req, 'view_tenant_guardrails');
  const guardrails = getSupportGuardrailPolicy(String(tenantId));
  let outputPolicy: SupportOutputPolicy = { ...DEFAULT_SUPPORT_OUTPUT_POLICY, tenantId };
  let outputEvents: ReturnType<typeof listSupportOutputEvents>['items'] = [];
  try {
    outputPolicy = getSupportOutputPolicy(tenantId);
    outputEvents = listSupportOutputEvents({ tenantId, limit: 30 }).items;
  } catch {
    outputPolicy = { ...DEFAULT_SUPPORT_OUTPUT_POLICY, tenantId };
    outputEvents = [];
  }
  res.json({ ok: true, guardrails, outputPolicy, outputEvents });
});

// PUT /api/tenant-portal/tenants/:tenantId/guardrails
tenantPortalRouter.put('/tenants/:tenantId/guardrails', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_guardrails');
  const policy = updateSupportGuardrailPolicy(String(tenantId), req.body ?? {});
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.guardrails.update',
    userId: String(user.userId),
    role: user.role,
    details: { enabled: policy.enabled, blockPromptInjection: policy.blockPromptInjection },
  });
  res.json({ ok: true, policy });
});

// POST /api/tenant-portal/tenants/:tenantId/guardrails/evaluate
tenantPortalRouter.post('/tenants/:tenantId/guardrails/evaluate', (req: Request, res: Response) => {
  const { tenantId } = guard(req, 'view_tenant_guardrails');
  const evaluation = evaluateSupportInputGuardrails(String(tenantId), {
    text: String(req.body?.text ?? ''),
    userRole: String(req.body?.role || 'customer'),
    userId: req.body?.userId ? String(req.body.userId) : undefined,
  });
  res.json({ ok: true, evaluation });
});

// POST /api/tenant-portal/tenants/:tenantId/quotas/reset
tenantPortalRouter.post('/tenants/:tenantId/quotas/reset', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_guardrails');
  const targetEndUserId = req.body?.userId ? String(req.body.userId) : undefined;
  resetSupportUserQuota(String(tenantId), targetEndUserId);
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.quotas.reset',
    userId: String(user.userId),
    role: user.role,
    details: { targetEndUserId: targetEndUserId ?? 'all' },
  });
  res.json({ ok: true });
});

// PUT /api/tenant-portal/tenants/:tenantId/output-policy
tenantPortalRouter.put('/tenants/:tenantId/output-policy', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_guardrails');
  const parsed = putOutputPolicySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'invalid_input',
        message: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      },
    });
    return;
  }
  const policy = saveSupportOutputPolicy({
    tenantId,
    expectedVersion: parsed.data.expectedVersion,
    policy: parsed.data.policy,
  });
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.output_policy.update',
    userId: String(user.userId),
    role: user.role,
    details: { mode: policy.mode, version: policy.version },
  });
  res.json({ ok: true, policy });
});

// POST /api/tenant-portal/tenants/:tenantId/output-policy/preview
tenantPortalRouter.post('/tenants/:tenantId/output-policy/preview', (req: Request, res: Response) => {
  const { tenantId } = guard(req, 'view_tenant_guardrails');
  const parsed = previewOutputPolicySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'invalid_input',
        message: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      },
    });
    return;
  }
  const decision = evaluateSupportOutput({
    policy: {
      tenantId,
      version: 0,
      mode: parsed.data.policy.mode,
      blockedTerms: parsed.data.policy.blockedTerms,
      maxOutputChars: parsed.data.policy.maxOutputChars,
      redactCredentials: parsed.data.policy.redactCredentials,
      updatedAt: '1970-01-01T00:00:00.000Z',
    },
    leaves: [{ path: 'reply', text: parsed.data.text }],
  });
  res.json({ ok: true, decision });
});

// ---------------------------------------------------------------------------
// 6. Widget & Service Desk (tenant_desk)
// ---------------------------------------------------------------------------

// GET /api/tenant-portal/tenants/:tenantId/desk
tenantPortalRouter.get('/tenants/:tenantId/desk', (req: Request, res: Response) => {
  const { tenantId } = guard(req, 'view_tenant_desk');
  const tid = String(tenantId);
  res.json({
    ok: true,
    conversations: listSupportConversations(tid),
    tickets: listSupportEscalationTickets(tid),
    pendingActions: listSupportPendingActions(tid),
    widgetConfig: getSupportDeskWidgetConfig(tenantId),
    slaPolicy: getSupportDeskSlaPolicy(tenantId),
  });
});

// POST /api/tenant-portal/tenants/:tenantId/conversations/:convId/reply
tenantPortalRouter.post(
  '/tenants/:tenantId/conversations/:convId/reply',
  (req: Request, res: Response) => {
    const { user, tenantId } = guard(req, 'reply_tenant_desk');
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) {
      res.status(400).json({ error: { code: 'invalid_input', message: 'Reply content is required.' } });
      return;
    }
    const conversationId = paramStr(req.params.convId);
    const agentName =
      typeof req.body?.agentName === 'string' && req.body.agentName.trim()
        ? req.body.agentName.trim()
        : user.email;
    const conversation = addHumanAgentReply(String(tenantId), conversationId, {
      agentName,
      content,
      resolveConversation: Boolean(req.body?.resolveConversation),
    });
    appendSupportAuditLog({
      tenantId: String(tenantId),
      action: 'tenant_portal.conversation.reply',
      userId: String(user.userId),
      role: user.role,
      details: { conversationId, resolveConversation: Boolean(req.body?.resolveConversation) },
    });
    res.json({ ok: true, conversation });
  },
);

// PATCH /api/tenant-portal/tenants/:tenantId/tickets/:ticketId
tenantPortalRouter.patch('/tenants/:tenantId/tickets/:ticketId', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'reply_tenant_desk');
  const parsed = ticketPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'invalid_input',
        message: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      },
    });
    return;
  }
  const tid = String(tenantId);
  const ticketId = paramStr(req.params.ticketId);
  const previous = listSupportEscalationTickets(tid).find((t) => t.id === ticketId);
  const ticket = updateSupportEscalationTicket(tid, ticketId, parsed.data);
  if (!ticket) {
    res.status(404).json({ error: { code: 'not_found', message: `Ticket '${ticketId}' not found.` } });
    return;
  }
  if (ticket.status === 'resolved' && previous?.status !== 'resolved') {
    dispatchPartnerEvent({
      tenantId,
      event: 'ticket.resolved',
      payload: { ticket },
      dedupKey: `ticket_resolved_${ticket.id}`,
    });
  }
  appendSupportAuditLog({
    tenantId: tid,
    action: 'tenant_portal.ticket.update',
    userId: String(user.userId),
    role: user.role,
    details: { ticketId, status: ticket.status, priority: ticket.priority },
  });
  res.json({ ok: true, ticket });
});

// POST /api/tenant-portal/tenants/:tenantId/actions/:actionId/review
tenantPortalRouter.post(
  '/tenants/:tenantId/actions/:actionId/review',
  async (req: Request, res: Response) => {
    const { user, tenantId } = guard(req, 'reply_tenant_desk');
    const parsed = reviewActionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'invalid_input',
          message: parsed.error.issues.map((i) => i.message).join(', '),
        },
      });
      return;
    }
    const actionId = paramStr(req.params.actionId);
    const action = await dispatchActionReview({
      tenantId,
      actionId,
      decision: parsed.data.decision,
      reviewedBy: user.email,
      reviewNote: parsed.data.reviewNote,
    });
    appendSupportAuditLog({
      tenantId: String(tenantId),
      action: `tenant_portal.action.${parsed.data.decision}`,
      userId: String(user.userId),
      role: user.role,
      details: { actionId },
    });
    res.json({ ok: true, action });
  },
);

// PUT /api/tenant-portal/tenants/:tenantId/widget-config
tenantPortalRouter.put('/tenants/:tenantId/widget-config', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_widget');
  const body = req.body ?? {};
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
    res.status(400).json({ error: { code: 'invalid_input', message: 'expectedVersion must be a positive integer.' } });
    return;
  }
  const patch: Partial<Pick<SupportDeskWidgetConfig, 'enabled' | 'appearance' | 'intake'>> = {};
  if (body.enabled !== undefined) patch.enabled = body.enabled as boolean;
  if (body.appearance !== undefined) patch.appearance = body.appearance as SupportDeskWidgetConfig['appearance'];
  if (body.intake !== undefined) patch.intake = body.intake as SupportDeskWidgetConfig['intake'];

  const config = updateSupportDeskWidgetConfig(tenantId, patch, expectedVersion);
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.widget_config.update',
    userId: String(user.userId),
    role: user.role,
    details: { version: config.version, enabled: config.enabled },
  });
  res.json({ ok: true, config });
});

// PUT /api/tenant-portal/tenants/:tenantId/sla-policy
tenantPortalRouter.put('/tenants/:tenantId/sla-policy', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_widget');
  const body = req.body ?? {};
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
    res.status(400).json({ error: { code: 'invalid_input', message: 'expectedVersion must be a positive integer.' } });
    return;
  }
  const patch: Partial<Pick<SupportDeskSlaPolicy, 'enabled' | 'targets' | 'routingRules'>> = {};
  if (body.enabled !== undefined) patch.enabled = body.enabled as boolean;
  if (body.targets !== undefined) patch.targets = body.targets as SupportDeskSlaPolicy['targets'];
  if (body.routingRules !== undefined) patch.routingRules = body.routingRules as SupportDeskSlaPolicy['routingRules'];

  const policy = updateSupportDeskSlaPolicy(tenantId, patch, expectedVersion);
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.sla_policy.update',
    userId: String(user.userId),
    role: user.role,
    details: { version: policy.version, enabled: policy.enabled },
  });
  res.json({ ok: true, policy });
});

// ---------------------------------------------------------------------------
// 7. Integration, Domains & Secret Rotation (tenant_integration)
// ---------------------------------------------------------------------------

// GET /api/tenant-portal/tenants/:tenantId/integration
tenantPortalRouter.get('/tenants/:tenantId/integration', (req: Request, res: Response) => {
  const tenantId = parsePositiveInt(req.params.tenantId, 'tenantId');
  const access = assertTenantPermission(actor(req), tenantId, 'view_tenant_integration');
  const tenant = access.tenant;
  const tid = String(tenantId);

  res.json({
    ok: true,
    publicKey: tenant.publicKey,
    signingSecretMasked: tenant.signingSecretMasked,
    allowedOrigins: tenant.allowedOrigins,
    embedSnippet: buildSupportDeskEmbedSnippet(req, tenant),
    runtimePolicy: getLocalRuntimePolicy(tenantId),
    webhooks: listSupportWebhookSubscriptions(tid),
    deliveries: listSupportWebhookDeliveries(tid),
  });
});

// PUT /api/tenant-portal/tenants/:tenantId/integration
tenantPortalRouter.put('/tenants/:tenantId/integration', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_integration');
  const body = (req.body ?? {}) as Record<string, unknown>;
  let allowedOrigins: string[] | undefined;
  if (body.allowedOrigins !== undefined) {
    if (!Array.isArray(body.allowedOrigins) || !body.allowedOrigins.every((x) => typeof x === 'string')) {
      res.status(400).json({ error: { code: 'invalid_input', message: 'allowedOrigins must be an array of strings.' } });
      return;
    }
    allowedOrigins = body.allowedOrigins.map((s) => s.trim()).filter(Boolean);
  }

  let runtimePolicy = getLocalRuntimePolicy(tenantId);
  if (body.runtimePolicy !== undefined) {
    const patch = validateRuntimePolicyPatch(tenantId, body.runtimePolicy);
    runtimePolicy = { ...runtimePolicy, ...patch };
    setLocalRuntimePolicy(tenantId, runtimePolicy);
  }

  const tenant =
    allowedOrigins !== undefined
      ? updateSupportTenant(tenantId, { allowedOrigins })
      : assertTenantPermission(user, tenantId, 'edit_tenant_integration').tenant;

  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.integration.update',
    userId: String(user.userId),
    role: user.role,
    details: {
      updatedOrigins: allowedOrigins !== undefined,
      updatedRuntimePolicy: body.runtimePolicy !== undefined,
    },
  });

  res.json({
    ok: true,
    allowedOrigins: tenant.allowedOrigins,
    runtimePolicy: getLocalRuntimePolicy(tenantId),
  });
});

// POST /api/tenant-portal/tenants/:tenantId/webhooks
tenantPortalRouter.post('/tenants/:tenantId/webhooks', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'edit_tenant_integration');
  const name = String(req.body?.name ?? '').trim();
  const targetUrl = String(req.body?.targetUrl ?? '').trim();
  if (!name || !targetUrl) {
    res.status(400).json({
      error: { code: 'invalid_input', message: 'Webhook name and targetUrl are required.' },
    });
    return;
  }
  const webhook = upsertSupportWebhookSubscription(String(tenantId), req.body);
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.webhook.upsert',
    userId: String(user.userId),
    role: user.role,
    details: { webhookId: webhook.id, name: webhook.name },
  });
  res.status(201).json({ ok: true, webhook });
});

// DELETE /api/tenant-portal/tenants/:tenantId/webhooks/:webhookId
tenantPortalRouter.delete(
  '/tenants/:tenantId/webhooks/:webhookId',
  (req: Request, res: Response) => {
    const { user, tenantId } = guard(req, 'edit_tenant_integration');
    const webhookId = paramStr(req.params.webhookId);
    deleteSupportWebhookSubscription(String(tenantId), webhookId);
    appendSupportAuditLog({
      tenantId: String(tenantId),
      action: 'tenant_portal.webhook.delete',
      userId: String(user.userId),
      role: user.role,
      details: { webhookId },
    });
    res.json({ ok: true });
  },
);

// POST /api/tenant-portal/tenants/:tenantId/rotate-secret
tenantPortalRouter.post('/tenants/:tenantId/rotate-secret', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'rotate_tenant_secret');
  const { tenant, signingSecret } = rotateSupportTenantSecret(tenantId);
  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.secret.rotate',
    userId: String(user.userId),
    role: user.role,
    details: { rotatedBy: user.email },
  });
  res.json({ ok: true, tenant, signingSecret });
});

// ---------------------------------------------------------------------------
// 8. Team & Delegated Permissions (tenant_members)
// ---------------------------------------------------------------------------

// GET /api/tenant-portal/tenants/:tenantId/members
tenantPortalRouter.get('/tenants/:tenantId/members', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'view_tenant_members');
  res.json({ ok: true, members: listTenantMembers(tenantId, user.userId) });
});

// POST /api/tenant-portal/tenants/:tenantId/members
tenantPortalRouter.post('/tenants/:tenantId/members', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'manage_tenant_members');
  if (!allowAuthRequest('tenant-member:' + user.userId, 30)) {
    res.status(429).json({
      error: {
        code: 'rate_limit_error',
        type: 'rate_limit_error',
        message: 'Too many member updates. Try again later.',
      },
    });
    return;
  }

  const parsed = memberWriteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'invalid_input',
        message: parsed.error.issues.map((i) => i.message).join(', '),
      },
    });
    return;
  }

  const member = upsertTenantMemberByTenantAdmin({
    tenantId,
    email: parsed.data.email,
    userId: parsed.data.userId,
    rolePreset: parsed.data.rolePreset as TenantRolePresetId | undefined,
    permissions: parsed.data.permissions,
    actor: user,
  });

  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.member.upsert',
    userId: String(user.userId),
    role: user.role,
    details: {
      targetUserId: member.userId,
      targetEmail: member.email,
      rolePreset: member.rolePreset,
      permissions: member.permissions,
    },
  });

  res.status(201).json({ ok: true, member });
});

// PUT /api/tenant-portal/tenants/:tenantId/members/:userId
tenantPortalRouter.put('/tenants/:tenantId/members/:userId', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'manage_tenant_members');
  const targetUserId = parsePositiveInt(req.params.userId, 'userId');
  const parsed = memberWriteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'invalid_input',
        message: parsed.error.issues.map((i) => i.message).join(', '),
      },
    });
    return;
  }

  const member = upsertTenantMemberByTenantAdmin({
    tenantId,
    userId: targetUserId,
    rolePreset: parsed.data.rolePreset as TenantRolePresetId | undefined,
    permissions: parsed.data.permissions,
    actor: user,
  });

  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.member.update',
    userId: String(user.userId),
    role: user.role,
    details: {
      targetUserId: member.userId,
      targetEmail: member.email,
      rolePreset: member.rolePreset,
      permissions: member.permissions,
    },
  });

  res.json({ ok: true, member });
});

// DELETE /api/tenant-portal/tenants/:tenantId/members/:userId
tenantPortalRouter.delete('/tenants/:tenantId/members/:userId', (req: Request, res: Response) => {
  const { user, tenantId } = guard(req, 'manage_tenant_members');
  const targetUserId = parsePositiveInt(req.params.userId, 'userId');
  removeTenantMember({
    tenantId,
    targetUserId,
    actor: user,
    viaPlatformAdmin: false,
  });

  appendSupportAuditLog({
    tenantId: String(tenantId),
    action: 'tenant_portal.member.remove',
    userId: String(user.userId),
    role: user.role,
    details: { targetUserId },
  });

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 9. Analytics, CSAT & History (tenant_analytics)
// ---------------------------------------------------------------------------

// GET /api/tenant-portal/tenants/:tenantId/analytics
tenantPortalRouter.get('/tenants/:tenantId/analytics', (req: Request, res: Response) => {
  const { tenantId } = guard(req, 'view_tenant_analytics');
  const tid = String(tenantId);
  res.json({
    ok: true,
    analytics: getSupportAnalyticsSummary(tid),
    csatSummary: getSupportCsatSummary(tid),
    csatRatings: listSupportCsatRatings(tid),
    auditLogs: listSupportAuditLogs(tid).slice(0, 100),
  });
});

// ---------------------------------------------------------------------------
// Error Handler
// ---------------------------------------------------------------------------

tenantPortalRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  if (err instanceof TenantRbacError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        type: err.code,
        message: err.message,
      },
    });
    return;
  }
  if (
    err instanceof SupportDeskError ||
    err instanceof SupportOutputError ||
    err instanceof SupportRuntimeError
  ) {
    res.status(err.status).json({
      error: {
        code: err.code,
        type: err.code,
        message: err.message,
      },
    });
    return;
  }
  if (
    err instanceof SupportStoreError ||
    err instanceof SupportConnectorError ||
    err instanceof SupportWorkflowError ||
    err instanceof SupportCrmWebhookError
  ) {
    res.status(err.status).json({
      error: {
        code: 'support_error',
        message: err.message,
      },
    });
    return;
  }
  const message = err instanceof Error ? err.message : 'Tenant portal operation failed.';
  res.status(500).json({ error: { code: 'internal_error', message } });
});
