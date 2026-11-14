import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Scope } from '@freellmapi/shared/ai-platform.js';
import {
  MCP_LIMITS,
  type McpApprovalStatus,
  type McpToolCallStatus,
} from '@freellmapi/shared/ai-platform-mcp.js';
import type { Permission } from '@freellmapi/shared/permissions.js';
import { hasPermission } from '../../../middleware/requirePermission.js';
import type { SessionUser } from '../../../services/auth.js';
import {
  approveAction,
  listApprovals,
  rejectAction,
} from '../orchestrator/approvals.js';
import { parseScopeParam } from '../scope.js';
import { getBindings, setBindings } from './bindings.js';
import { listToolCalls } from './calls.js';
import { maybeRunMcpMaintenance } from './maintenance.js';
import {
  createServer,
  deleteServer,
  getAllowedInternalOrigins,
  listServerTools,
  listServers,
  reviewTool,
  setAllowedInternalOrigins,
  syncServerTools,
  testServer,
  updateServer,
} from './registry.js';
import { McpServiceError, McpValidationError } from './store.js';

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

function requirePrimary(req: Request, res: Response, next: NextFunction): void {
  const user = getUser(req);
  if (user?.isPrimary === true) {
    next();
    return;
  }
  res.status(403).json({
    error: {
      type: 'forbidden',
      code: 'primary_required',
      message: 'Only the primary administrator can manage allowed internal hosts.',
    },
  });
}

function parsePositiveId(raw: string | string[] | undefined, label: string): number {
  const str = Array.isArray(raw) ? raw[0] : raw;
  if (!str || !/^\d+$/.test(str)) {
    throw new McpValidationError(`Invalid ${label} id.`, 'invalid_id', 400);
  }
  const num = Number(str);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new McpValidationError(`Invalid ${label} id.`, 'invalid_id', 400);
  }
  return num;
}

function parseScopeQuery(raw: unknown): Scope | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const trimmed = raw.trim();
  const sep = trimmed.includes('/') ? '/' : trimmed.includes(':') ? ':' : null;
  if (!sep) {
    throw new McpValidationError('Invalid scope query parameter.', 'invalid_scope', 400);
  }
  const idx = trimmed.indexOf(sep);
  const kindRaw = trimmed.slice(0, idx);
  const idRaw = trimmed.slice(idx + 1);
  try {
    return parseScopeParam(kindRaw, idRaw);
  } catch (err) {
    throw new McpValidationError(
      err instanceof Error ? err.message : 'Invalid scope.',
      'invalid_scope',
      400,
    );
  }
}

function parseBoundLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const num = Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    throw new McpValidationError('limit must be a positive integer.', 'invalid_limit', 400);
  }
  return Math.min(MCP_LIMITS.maxListLimit, num);
}

function sendMcpError(res: Response, err: unknown): void {
  if (err instanceof McpServiceError) {
    const detailsObj =
      err.details && typeof err.details === 'object' && !Array.isArray(err.details)
        ? (err.details as Record<string, unknown>)
        : undefined;
    const current = detailsObj?.current;
    res.status(err.status).json({
      error: {
        type:
          err.status === 404
            ? 'not_found_error'
            : err.status === 409
              ? 'conflict_error'
              : 'invalid_request_error',
        code: err.code,
        message: err.message,
        ...(current !== undefined ? { current } : {}),
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  res.status(500).json({
    error: {
      type: 'internal_error',
      code: 'internal_error',
      message: 'Internal server error.',
    },
  });
}

const serverCreateSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    url: z.string(),
    authKind: z.enum(['none', 'bearer', 'header']),
    authHeaderName: z.string().nullable().optional(),
    secret: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().optional(),
    maxResultBytes: z.number().int().optional(),
    maxConcurrency: z.number().int().optional(),
  })
  .strict();

const serverPatchSchema = z
  .object({
    revision: z.number().int(),
    slug: z.string().optional(),
    name: z.string().optional(),
    url: z.string().optional(),
    authKind: z.enum(['none', 'bearer', 'header']).optional(),
    authHeaderName: z.string().nullable().optional(),
    secret: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().optional(),
    maxResultBytes: z.number().int().optional(),
    maxConcurrency: z.number().int().optional(),
  })
  .strict();

const toolReviewSchema = z
  .object({
    state: z.enum(['allowed', 'blocked']).optional(),
    effect: z.enum(['read', 'write']).optional(),
  })
  .strict();

const bindingPutSchema = z
  .object({
    toolIds: z.array(z.number().int().positive()),
    enabled: z.boolean(),
    maxRounds: z.number().int().nullable().optional(),
  })
  .strict();

const allowedOriginsSchema = z
  .object({
    origins: z.array(z.string()),
  })
  .strict();

const approvalDecisionSchema = z
  .object({
    note: z.string().optional(),
  })
  .strict();

export const mcpAdminRouter = Router();

// ── MCP Servers ──────────────────────────────────────────────────────────────

mcpAdminRouter.get('/mcp/servers', requirePerm('view_mcp_servers'), (_req, res) => {
  try {
    res.json({ servers: listServers() });
  } catch (err) {
    sendMcpError(res, err);
  }
});

mcpAdminRouter.post('/mcp/servers', requirePerm('edit_mcp_servers'), async (req, res) => {
  const parsed = serverCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: 'Invalid MCP server payload.',
      },
    });
    return;
  }
  try {
    const server = await createServer(parsed.data, getUser(req)?.userId ?? null);
    res.status(201).json({ server });
  } catch (err) {
    sendMcpError(res, err);
  }
});

mcpAdminRouter.patch('/mcp/servers/:id', requirePerm('edit_mcp_servers'), async (req, res) => {
  const parsed = serverPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: 'Invalid MCP server update payload.',
      },
    });
    return;
  }
  try {
    const id = parsePositiveId(req.params.id, 'server');
    const server = await updateServer(id, parsed.data, getUser(req)?.userId ?? null);
    res.json({ server });
  } catch (err) {
    sendMcpError(res, err);
  }
});

mcpAdminRouter.delete('/mcp/servers/:id', requirePerm('edit_mcp_servers'), (req, res) => {
  try {
    const id = parsePositiveId(req.params.id, 'server');
    const force = req.query.force === '1' || req.query.force === 'true';
    const result = deleteServer(id, { force });
    res.json(result);
  } catch (err) {
    sendMcpError(res, err);
  }
});

mcpAdminRouter.post('/mcp/servers/:id/test', requirePerm('edit_mcp_servers'), async (req, res) => {
  try {
    const id = parsePositiveId(req.params.id, 'server');
    const result = await testServer(id);
    res.json(result);
  } catch (err) {
    sendMcpError(res, err);
  }
});

mcpAdminRouter.post('/mcp/servers/:id/sync', requirePerm('edit_mcp_servers'), async (req, res) => {
  try {
    const id = parsePositiveId(req.params.id, 'server');
    const result = await syncServerTools(id, getUser(req)?.userId ?? null);
    res.json(result);
  } catch (err) {
    sendMcpError(res, err);
  }
});

// ── MCP Tools & Review ───────────────────────────────────────────────────────

mcpAdminRouter.get('/mcp/servers/:id/tools', requirePerm('view_mcp_servers'), (req, res) => {
  try {
    const id = parsePositiveId(req.params.id, 'server');
    res.json({ tools: listServerTools(id) });
  } catch (err) {
    sendMcpError(res, err);
  }
});

mcpAdminRouter.patch('/mcp/tools/:id', requirePerm('review_mcp_tools'), (req, res) => {
  const parsed = toolReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: 'Invalid tool review payload.',
      },
    });
    return;
  }
  try {
    const id = parsePositiveId(req.params.id, 'tool');
    const tool = reviewTool(id, parsed.data, getUser(req)?.userId ?? null);
    res.json({ tool });
  } catch (err) {
    sendMcpError(res, err);
  }
});

// ── Scope Bindings ───────────────────────────────────────────────────────────

mcpAdminRouter.get('/mcp/bindings/:scopeKind/:scopeId', requirePerm('view_mcp_servers'), (req, res) => {
  try {
    const kindRaw = Array.isArray(req.params.scopeKind) ? req.params.scopeKind[0]! : req.params.scopeKind!;
    const idRaw = Array.isArray(req.params.scopeId) ? req.params.scopeId[0]! : req.params.scopeId!;
    const scope = parseScopeParam(kindRaw, idRaw);
    res.json({ binding: getBindings(scope) });
  } catch (err) {
    if (err instanceof McpServiceError) {
      sendMcpError(res, err);
      return;
    }
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_scope',
        message: err instanceof Error ? err.message : 'Invalid scope.',
      },
    });
  }
});

mcpAdminRouter.put('/mcp/bindings/:scopeKind/:scopeId', requirePerm('review_mcp_tools'), (req, res) => {
  const parsed = bindingPutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: 'Invalid bindings payload.',
      },
    });
    return;
  }
  try {
    const kindRaw = Array.isArray(req.params.scopeKind) ? req.params.scopeKind[0]! : req.params.scopeKind!;
    const idRaw = Array.isArray(req.params.scopeId) ? req.params.scopeId[0]! : req.params.scopeId!;
    const scope = parseScopeParam(kindRaw, idRaw);
    res.json({ binding: setBindings(scope, parsed.data) });
  } catch (err) {
    if (err instanceof McpServiceError) {
      sendMcpError(res, err);
      return;
    }
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_scope',
        message: err instanceof Error ? err.message : 'Invalid scope.',
      },
    });
  }
});

// ── Call Logs ────────────────────────────────────────────────────────────────

mcpAdminRouter.get('/mcp/calls', requirePerm('view_mcp_servers'), (req, res) => {
  try {
    const scope = parseScopeQuery(req.query.scope);
    const serverId =
      typeof req.query.server === 'string' && req.query.server.trim()
        ? parsePositiveId(req.query.server, 'server')
        : undefined;
    const status =
      typeof req.query.status === 'string' && req.query.status.trim()
        ? (req.query.status.trim() as McpToolCallStatus)
        : undefined;
    const before =
      typeof req.query.before === 'string' && req.query.before.trim()
        ? req.query.before.trim()
        : undefined;
    const limit = parseBoundLimit(req.query.limit);
    maybeRunMcpMaintenance();
    const result = listToolCalls({ scope, serverId, status, before, limit });
    res.json(result);
  } catch (err) {
    sendMcpError(res, err);
  }
});

// ── Primary-Only Allowed Internal Hosts ──────────────────────────────────────

mcpAdminRouter.get('/mcp/allowed-internal-hosts', requirePrimary, (_req, res) => {
  try {
    res.json({ origins: getAllowedInternalOrigins() });
  } catch (err) {
    sendMcpError(res, err);
  }
});

mcpAdminRouter.put('/mcp/allowed-internal-hosts', requirePrimary, (req, res) => {
  const parsed = allowedOriginsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_origin',
        message: 'Expected { origins: string[] }.',
      },
    });
    return;
  }
  try {
    res.json({ origins: setAllowedInternalOrigins(parsed.data.origins) });
  } catch (err) {
    sendMcpError(res, err);
  }
});

// ── Approvals Queue ──────────────────────────────────────────────────────────

mcpAdminRouter.get('/approvals', requirePerm('approve_ai_actions'), (req, res) => {
  try {
    const scope = parseScopeQuery(req.query.scope);
    const status =
      typeof req.query.status === 'string' && req.query.status.trim()
        ? (req.query.status.trim() as McpApprovalStatus)
        : undefined;
    const limit = parseBoundLimit(req.query.limit);
    maybeRunMcpMaintenance();
    res.json({ approvals: listApprovals({ status, scope, limit }) });
  } catch (err) {
    sendMcpError(res, err);
  }
});

mcpAdminRouter.post('/approvals/:id/approve', requirePerm('approve_ai_actions'), async (req, res) => {
  const parsed = approvalDecisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: 'Invalid approval decision payload.',
      },
    });
    return;
  }
  try {
    const id = parsePositiveId(req.params.id, 'approval');
    const approval = await approveAction(id, getUser(req)?.userId ?? null, parsed.data);
    res.json({ approval });
  } catch (err) {
    sendMcpError(res, err);
  }
});

mcpAdminRouter.post('/approvals/:id/reject', requirePerm('approve_ai_actions'), async (req, res) => {
  const parsed = approvalDecisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: 'Invalid rejection decision payload.',
      },
    });
    return;
  }
  try {
    const id = parsePositiveId(req.params.id, 'approval');
    const approval = await rejectAction(id, getUser(req)?.userId ?? null, parsed.data);
    res.json({ approval });
  } catch (err) {
    sendMcpError(res, err);
  }
});
