import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Permission } from '@freellmapi/shared/permissions.js';
import type { FlowRunStatus } from '@freellmapi/shared/ai-platform-orchestrator.js';
import { hasPermission } from '../../../middleware/requirePermission.js';
import type { SessionUser } from '../../../services/auth.js';
import { isPillarEnabled } from '../flags.js';
import { GatewayCallError } from '../loopback.js';
import { expireApprovals } from './approvals.js';
import {
  OrchestratorConflictError,
  OrchestratorError,
  OrchestratorNotFoundError,
  OrchestratorValidationError,
  createAgent,
  createFlow,
  deleteAgent,
  deleteFlow,
  getAgent,
  getFlow,
  getFlowBySlug,
  getFlowDetail,
  listAgents,
  listFlows,
  publishFlow,
  setFlowGrants,
  updateAgent,
  updateFlowDraft,
  validateFlowDraftDefinition,
} from './definitions.js';
import { cancelRun, recordServerLocalAddress, startRun } from './engine.js';
import {
  deleteFlowSchedule,
  getFlowSchedule,
  tickFlowSchedules,
  triggerAsyncFlowRun,
  upsertFlowSchedule,
} from './scheduler.js';
import { getRunDetail, getRunRecord, listRuns } from './trace.js';

function getUser(req: Request): SessionUser | undefined {
  return (req as Request & { user?: SessionUser }).user;
}

function requirePerm(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = getUser(req);
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

function parsePositiveInt(raw: string | string[] | undefined, label: string): number {
  const str = Array.isArray(raw) ? raw[0] : raw;
  if (!str || !/^\d+$/.test(str)) {
    throw new OrchestratorError(400, 'invalid_id', `Invalid ${label} id.`);
  }
  const num = Number(str);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new OrchestratorError(400, 'invalid_id', `Invalid ${label} id.`);
  }
  return num;
}

function parseNonNegativeInt(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const str = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw);
  if (!/^\d+$/.test(str)) {
    throw new OrchestratorError(400, 'invalid_query', `Invalid ${label}.`);
  }
  const num = Number(str);
  if (!Number.isSafeInteger(num) || num < 0) {
    throw new OrchestratorError(400, 'invalid_query', `Invalid ${label}.`);
  }
  return num;
}

function sendOrchestratorError(res: Response, err: unknown): void {
  if (err instanceof OrchestratorValidationError) {
    res.status(422).json({
      error: {
        type: 'invalid_request_error',
        code: err.code,
        message: err.message,
        errors: err.errors,
      },
      errors: err.errors,
    });
    return;
  }

  if (err instanceof OrchestratorConflictError) {
    const detailsObj =
      err.details && typeof err.details === 'object' && !Array.isArray(err.details)
        ? (err.details as Record<string, unknown>)
        : undefined;
    const current = detailsObj?.current;
    const flows = detailsObj?.flows;
    res.status(409).json({
      error: {
        type: 'conflict_error',
        code: err.code,
        message: err.message,
        ...(current !== undefined ? { current } : {}),
        ...(flows !== undefined ? { flows } : {}),
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
      ...(current !== undefined ? { current } : {}),
      ...(flows !== undefined ? { flows } : {}),
    });
    return;
  }

  if (err instanceof OrchestratorNotFoundError) {
    res.status(404).json({
      error: {
        type: 'not_found_error',
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  if (err instanceof OrchestratorError) {
    res.status(err.status).json({
      error: {
        type: err.status === 404 ? 'not_found_error' : 'invalid_request_error',
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  if (err instanceof GatewayCallError) {
    res.status(err.status).json({
      error: {
        type: err.status === 429 ? 'rate_limit_error' : 'api_error',
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  res.status(500).json({
    error: {
      type: 'internal_error',
      code: 'internal_error',
      message: err instanceof Error ? err.message : 'Internal server error.',
    },
  });
}

const VALID_RUN_STATUSES = new Set<FlowRunStatus>([
  'running',
  'awaiting_approval',
  'completed',
  'stopped',
  'cancelled',
  'failed',
  'interrupted',
]);

const scopeKindSchema = z.enum(['profile', 'support_tenant', 'agent']);

const agentCreateSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    description: z.string().optional(),
    model: z.string(),
    systemPrompt: z.string().optional(),
    knowledgeScopeKind: scopeKindSchema.nullable().optional(),
    knowledgeScopeId: z.string().nullable().optional(),
    outputPolicyScope: z.string().nullable().optional(),
    maxOutputTokens: z.number().int().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const agentPatchSchema = z
  .object({
    revision: z.number().int(),
    name: z.string().optional(),
    description: z.string().optional(),
    model: z.string().optional(),
    systemPrompt: z.string().optional(),
    knowledgeScopeKind: scopeKindSchema.nullable().optional(),
    knowledgeScopeId: z.string().nullable().optional(),
    outputPolicyScope: z.string().nullable().optional(),
    maxOutputTokens: z.number().int().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const flowLimitsSchema = z.object({
  maxSteps: z.number(),
  maxToolCalls: z.number(),
  maxHandoffs: z.number(),
  maxTokens: z.number(),
  maxSeconds: z.number(),
});

const flowDefinitionSchema = z.object({
  kind: z.enum(['single', 'handoff']),
  entryAgent: z.string(),
  agents: z.array(z.string()),
  handoffs: z.record(z.string(), z.array(z.string())),
  limits: flowLimitsSchema,
  awaitingApprovalText: z.string(),
  approvalTtlHours: z.number(),
});

const flowCreateSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
    draft: flowDefinitionSchema,
  })
  .strict();

const flowDraftPutSchema = z
  .object({
    revision: z.number().int(),
    name: z.string().optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
    draft: flowDefinitionSchema,
  })
  .strict();

const flowPublishSchema = z
  .object({
    revision: z.number().int(),
  })
  .strict();

const flowGrantsSchema = z
  .object({
    profileIds: z.array(z.number().int().positive()),
  })
  .strict();

const flowTrySchema = z
  .object({
    message: z.string().min(1),
    endUser: z.string().nullable().optional(),
  })
  .strict();

const asyncFlowRunSchema = z
  .object({
    message: z.string().min(1),
    profileId: z.number().int().nonnegative().optional(),
    endUser: z.string().nullable().optional(),
    isDryRun: z.boolean().optional(),
  })
  .strict();

const flowScheduleSchema = z
  .object({
    enabled: z.boolean(),
    scheduleKind: z.enum(['interval', 'cron']),
    intervalSeconds: z.number().int().nullable().optional(),
    cronExpr: z.string().nullable().optional(),
    profileId: z.number().int().nonnegative().optional(),
    endUser: z.string().nullable().optional(),
    inputMessage: z.string().min(1),
  })
  .strict();

export const orchestratorAdminRouter = Router();

// ── Agents ───────────────────────────────────────────────────────────────────

orchestratorAdminRouter.get('/agents', requirePerm('view_flows'), (_req, res) => {
  try {
    res.json({ agents: listAgents() });
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

orchestratorAdminRouter.post('/agents', requirePerm('edit_flows'), (req, res) => {
  const parsed = agentCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'Invalid agent payload.',
      },
    });
    return;
  }
  try {
    const agent = createAgent(parsed.data, getUser(req)?.userId ?? null);
    res.status(201).json({ agent });
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

orchestratorAdminRouter.get('/agents/:id', requirePerm('view_flows'), (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id, 'agent');
    res.json({ agent: getAgent(id) });
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

orchestratorAdminRouter.patch('/agents/:id', requirePerm('edit_flows'), (req, res) => {
  const parsed = agentPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'Invalid agent update payload.',
      },
    });
    return;
  }
  try {
    const id = parsePositiveInt(req.params.id, 'agent');
    const agent = updateAgent(id, parsed.data, getUser(req)?.userId ?? null);
    res.json({ agent });
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

orchestratorAdminRouter.delete('/agents/:id', requirePerm('edit_flows'), (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id, 'agent');
    deleteAgent(id);
    res.json({ deleted: true });
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

// ── Flows ────────────────────────────────────────────────────────────────────

orchestratorAdminRouter.get('/flows', requirePerm('view_flows'), (_req, res) => {
  try {
    res.json({ flows: listFlows() });
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

orchestratorAdminRouter.post('/flows', requirePerm('edit_flows'), (req, res) => {
  const parsed = flowCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'Invalid flow payload.',
      },
    });
    return;
  }
  try {
    const flow = createFlow(parsed.data);
    res.status(201).json({ flow });
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

orchestratorAdminRouter.get('/flows/:id', requirePerm('view_flows'), (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id, 'flow');
    res.json(getFlowDetail(id));
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

orchestratorAdminRouter.put('/flows/:id/draft', requirePerm('edit_flows'), (req, res) => {
  const parsed = flowDraftPutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'Invalid flow draft payload.',
      },
    });
    return;
  }
  try {
    const id = parsePositiveInt(req.params.id, 'flow');
    const flow = updateFlowDraft(id, parsed.data);
    res.json({ flow });
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

orchestratorAdminRouter.post('/flows/:id/try', requirePerm('edit_flows'), async (req, res) => {
  recordServerLocalAddress(req);
  if (!isPillarEnabled('orchestrator')) {
    res.status(409).json({
      error: {
        type: 'conflict_error',
        code: 'pillar_disabled',
        message: 'Orchestrator pillar is disabled.',
      },
    });
    return;
  }

  const parsed = flowTrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'Invalid dry-run payload.',
      },
    });
    return;
  }

  const ac = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) ac.abort();
  };
  res.once('close', onClose);

  try {
    const id = parsePositiveInt(req.params.id, 'flow');
    const flow = getFlow(id);
    validateFlowDraftDefinition(flow.draft);

    const result = await startRun({
      flowId: id,
      profileId: 0,
      endUser: parsed.data.endUser ?? null,
      wire: 'openai-chat',
      messages: [{ role: 'user', content: parsed.data.message }],
      isDryRun: true,
      stream: false,
      signal: ac.signal,
    });

    const detail = getRunDetail(result.run.id);
    res.json({
      run: detail?.run ?? result.run,
      steps: detail?.steps ?? [],
      outputText: result.outputText,
      stopReason: result.run.stopReason,
      usage: result.usage,
    });
  } catch (err) {
    sendOrchestratorError(res, err);
  } finally {
    res.off('close', onClose);
  }
});

orchestratorAdminRouter.post('/flows/:id/publish', requirePerm('publish_flows'), (req, res) => {
  const parsed = flowPublishSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: 'Invalid publish payload; expected { revision }.',
      },
    });
    return;
  }
  try {
    const id = parsePositiveInt(req.params.id, 'flow');
    const flow = publishFlow(id, parsed.data.revision, getUser(req)?.userId ?? null);
    res.json({ flow });
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

orchestratorAdminRouter.put('/flows/:id/grants', requirePerm('publish_flows'), (req, res) => {
  const parsed = flowGrantsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: 'Invalid grants payload; expected { profileIds: number[] }.',
      },
    });
    return;
  }
  try {
    const id = parsePositiveInt(req.params.id, 'flow');
    const detail = setFlowGrants(id, parsed.data.profileIds);
    res.json({ flowId: id, ...detail });
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

orchestratorAdminRouter.delete('/flows/:id', requirePerm('edit_flows'), (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id, 'flow');
    deleteFlow(id);
    res.json({ deleted: true });
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

// ── Async Flow Runs & Schedules ──────────────────────────────────────────────

orchestratorAdminRouter.post('/flows/:id/runs/async', requirePerm('edit_flows'), (req, res) => {
  recordServerLocalAddress(req);
  const parsed = asyncFlowRunSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'Invalid async flow run payload.',
      },
    });
    return;
  }
  try {
    const id = parsePositiveInt(req.params.id, 'flow');
    const accepted = triggerAsyncFlowRun(id, parsed.data, { req });
    res.status(202).json(accepted);
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

orchestratorAdminRouter.get('/flows/:id/schedule', requirePerm('view_flows'), (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id, 'flow');
    res.json({ schedule: getFlowSchedule(id) });
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

orchestratorAdminRouter.put('/flows/:id/schedule', requirePerm('edit_flows'), (req, res) => {
  const parsed = flowScheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_schedule',
        message: parsed.error.issues[0]?.message ?? 'Invalid flow schedule payload.',
      },
    });
    return;
  }
  try {
    const id = parsePositiveInt(req.params.id, 'flow');
    const schedule = upsertFlowSchedule(id, parsed.data);
    res.json({ schedule });
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

orchestratorAdminRouter.delete('/flows/:id/schedule', requirePerm('edit_flows'), (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id, 'flow');
    res.json(deleteFlowSchedule(id));
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

orchestratorAdminRouter.post('/flows/:id/schedule/tick', requirePerm('edit_flows'), async (req, res) => {
  recordServerLocalAddress(req);
  try {
    parsePositiveInt(req.params.id, 'flow');
    const result = await tickFlowSchedules();
    res.json(result);
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

// ── Runs ─────────────────────────────────────────────────────────────────────

orchestratorAdminRouter.get('/runs', requirePerm('view_flow_runs'), (req, res) => {
  try {
    try {
      expireApprovals();
    } catch {
      // Best-effort approval expiry sync
    }

    let flowId: number | undefined;
    if (typeof req.query.flow === 'string' && req.query.flow.trim()) {
      const rawFlow = req.query.flow.trim();
      if (/^\d+$/.test(rawFlow)) {
        flowId = Number(rawFlow);
      } else {
        const flow = getFlowBySlug(rawFlow);
        if (!flow) {
          res.json({ runs: [] });
          return;
        }
        flowId = flow.id;
      }
    }

    const profileId =
      typeof req.query.profile === 'string' && req.query.profile.trim()
        ? parsePositiveInt(req.query.profile.trim(), 'profile')
        : undefined;

    let status: FlowRunStatus | undefined;
    if (typeof req.query.status === 'string' && req.query.status.trim()) {
      const candidate = req.query.status.trim() as FlowRunStatus;
      if (!VALID_RUN_STATUSES.has(candidate)) {
        throw new OrchestratorError(400, 'invalid_status', `Invalid run status '${candidate}'.`);
      }
      status = candidate;
    }

    const before =
      typeof req.query.before === 'string' && req.query.before.trim()
        ? req.query.before.trim()
        : undefined;

    const limit = parseNonNegativeInt(req.query.limit, 'limit');

    const runs = listRuns({
      ...(flowId !== undefined ? { flowId } : {}),
      ...(profileId !== undefined ? { profileId } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(limit !== undefined && limit > 0 ? { limit } : {}),
    });

    res.json({ runs });
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

orchestratorAdminRouter.get('/runs/:id', requirePerm('view_flow_runs'), (req, res) => {
  try {
    try {
      expireApprovals();
    } catch {
      // Best-effort approval expiry sync
    }

    const runId = Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!;
    const afterSeq = parseNonNegativeInt(req.query.after, 'after');
    const detail = getRunDetail(runId, afterSeq);
    if (!detail) {
      throw new OrchestratorNotFoundError(`Run '${runId}' not found.`);
    }
    res.json(detail);
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});

orchestratorAdminRouter.post('/runs/:id/cancel', requirePerm('cancel_flow_runs'), (req, res) => {
  try {
    const runId = Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!;
    const existing = getRunRecord(runId);
    if (!existing) {
      throw new OrchestratorNotFoundError(`Run '${runId}' not found.`);
    }
    if (existing.run.status !== 'running' && existing.run.status !== 'awaiting_approval') {
      throw new OrchestratorConflictError(
        'already_finished',
        `Run '${runId}' is already '${existing.run.status}'.`,
        { current: existing.run },
      );
    }
    cancelRun(runId, 'admin');
    const updated = getRunRecord(runId)!.run;
    res.json({ run: updated });
  } catch (err) {
    sendOrchestratorError(res, err);
  }
});
