import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  SUPPORT_DESK_DEPARTMENTS,
  SUPPORT_DESK_LIMITS,
  type SupportDeskDepartment,
  type SupportDeskSlaPolicy,
  type SupportDeskTicketState,
  type SupportDeskWidgetConfig,
  type SupportTicketPriority,
} from '@freellmapi/shared/support-service-desk.js';
import type { SupportEvidenceRole } from '@freellmapi/shared/support-evidence.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import type { SessionUser } from '../../services/auth.js';
import {
  applySupportCors,
  resolveTenant,
  validateSupportPublicAuth,
} from './support-router.js';
import { SupportStoreError, type SupportTenant } from './support-store.js';
import {
  getSupportConversationForUser,
  listSupportEscalationTickets,
  SupportWorkflowError,
  type SupportTicketStatus,
} from './support-workflows.js';
import { maskSupportSensitiveText } from './support-knowledge.js';
import {
  getSupportDeskSlaPolicy,
  getSupportDeskTicketState,
  getSupportDeskWidgetConfig,
  listSupportDeskTicketStates,
  saveSupportDeskIntake,
  SupportDeskError,
  updateSupportDeskSlaPolicy,
  updateSupportDeskTicketState,
  updateSupportDeskWidgetConfig,
} from './support-service-desk-store.js';
import {
  computeSupportDeskIntakeSchemaHash,
  projectSupportDeskWidgetConfig,
  validateSupportDeskIntake,
} from './support-widget-profile.js';
import { calculateSupportDeskSla } from './support-sla-routing.js';
import {
  generateSupportAgentCopilot,
  readSupportAgentCopilotJob,
} from './support-agent-copilot.js';

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const VALID_TICKET_STATUSES: readonly SupportTicketStatus[] = ['open', 'in_progress', 'resolved', 'closed'];

function paramStr(val: string | string[] | undefined): string {
  return Array.isArray(val) ? val[0] ?? '' : val ?? '';
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function assertAllowedKeys(obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || !allowed.includes(key)) {
      throw new SupportDeskError(400, 'invalid_input', `Unsupported field "${key}".`);
    }
  }
}

function assertPositiveInt(val: unknown, label: string): number {
  if (typeof val !== 'number' || !Number.isInteger(val) || val <= 0) {
    throw new SupportDeskError(400, 'invalid_input', `${label} must be a positive integer.`);
  }
  return val;
}

function assertSafeRequestId(val: unknown): string {
  if (typeof val !== 'string' || !REQUEST_ID_RE.test(val.trim())) {
    throw new SupportDeskError(
      400,
      'invalid_input',
      'requestId must be 1..100 characters of ASCII alphanumeric, dash, or underscore.',
    );
  }
  return val.trim();
}

function assertSafeOpaqueId(val: unknown, label: string): string {
  if (typeof val !== 'string') {
    throw new SupportDeskError(400, 'invalid_input', `${label} must be a string.`);
  }
  const trimmed = val.trim();
  if (!trimmed || trimmed.length > 128) {
    throw new SupportDeskError(400, 'invalid_input', `${label} must be 1..128 characters.`);
  }
  return trimmed;
}

function hasEditorAccess(user: SessionUser | undefined): boolean {
  if (!user) return false;
  if (
    user.isPrimary ||
    user.role === 'admin' ||
    user.permissions?.includes('*') ||
    user.permissions?.includes('manage_x_gateway')
  ) {
    return true;
  }
  const hasGateway = Boolean(user.permissions?.includes('use_x_gateway'));
  const hasEdit = Boolean(user.permissions?.includes('edit_x_settings'));
  return hasGateway && hasEdit;
}

function resolveNumericConsoleTenant(req: Request, res: Response): SupportTenant | null {
  const rawId = paramStr(req.params.id).trim();
  if (!/^[1-9]\d*$/.test(rawId)) {
    res.status(400).json({ error: { code: 'invalid_input', message: 'Tenant ID must be a positive integer.' } });
    return null;
  }
  try {
    return resolveTenant(rawId);
  } catch (err) {
    const status = err instanceof SupportStoreError ? err.status : 404;
    res.status(status === 400 ? 400 : 404).json({
      error: {
        code: status === 400 ? 'invalid_input' : 'tenant_not_found',
        message: err instanceof Error ? err.message : 'Support tenant not found.',
      },
    });
    return null;
  }
}

export function buildSupportDeskEmbedSnippet(req: Request, tenant: SupportTenant): string {
  let publicBase: URL;
  try {
    publicBase = new URL(process.env.SUPPORT_PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`);
  } catch {
    throw new SupportDeskError(400, 'invalid_input', 'Invalid SUPPORT_PUBLIC_BASE_URL configuration.');
  }
  if (
    !['http:', 'https:'].includes(publicBase.protocol) ||
    publicBase.username ||
    publicBase.password ||
    publicBase.search ||
    publicBase.hash
  ) {
    throw new SupportDeskError(400, 'invalid_input', 'Invalid SUPPORT_PUBLIC_BASE_URL configuration.');
  }
  const serverOrigin = publicBase.toString().replace(/\/$/, '');
  const configJson = JSON.stringify({
    tenantKey: tenant.publicKey,
    serverBase: serverOrigin,
    allowGuestSession: tenant.allowGuest,
    loadTenantProfile: true,
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<script src="${serverOrigin}/thruline/v1/support/widget.js"></script>\n<script>window.FreeLLMAPISupport.init(${configJson});</script>`;
}

function sendDeskError(res: Response, err: unknown, requestId?: string): void {
  if (res.writableEnded) return;
  if (err instanceof SupportDeskError) {
    if (err.retryAfterSeconds) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
    }
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.fields ? { fields: err.fields } : {}),
      },
      ...(requestId ? { requestId } : {}),
    });
    return;
  }
  if (err instanceof SupportWorkflowError) {
    const code = err.status === 404 ? 'conversation_not_found' : err.status === 403 ? 'permission_denied' : 'invalid_input';
    res.status(err.status).json({
      error: { code, message: err.message },
      ...(requestId ? { requestId } : {}),
    });
    return;
  }
  if (err instanceof SupportStoreError) {
    const code = (err as SupportStoreError & { code?: string }).code || (err.status === 404 ? 'tenant_not_found' : 'invalid_input');
    res.status(err.status).json({
      error: { code, message: err.message },
      ...(requestId ? { requestId } : {}),
    });
    return;
  }
  res.status(503).json({
    error: {
      code: 'service_desk_storage_unavailable',
      message: 'Service desk operation failed.',
    },
    ...(requestId ? { requestId } : {}),
  });
}

function decodeQueueCursor(cursor: string): { openedAt: string; ticketId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      openedAt?: unknown;
      ticketId?: unknown;
    };
    if (typeof parsed.openedAt !== 'string' || typeof parsed.ticketId !== 'string') {
      throw new Error('invalid');
    }
    return { openedAt: parsed.openedAt, ticketId: parsed.ticketId };
  } catch {
    throw new SupportDeskError(400, 'invalid_input', 'Invalid queue cursor.');
  }
}

function encodeQueueCursor(openedAt: string, ticketId: string): string {
  return Buffer.from(JSON.stringify({ openedAt, ticketId }), 'utf8').toString('base64url');
}

// ---------------------------------------------------------------------------
// Console Router (/api/thruline/support/tenants/:id/service-desk/*)
// ---------------------------------------------------------------------------

export const xSupportServiceDeskConsoleRouter = Router();

xSupportServiceDeskConsoleRouter.use('/tenants/:id/service-desk', requireAuth);
xSupportServiceDeskConsoleRouter.use(
  '/tenants/:id/service-desk',
  (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: SessionUser }).user;
    if (!hasEditorAccess(user)) {
      res.status(403).json({
        error: {
          code: 'permission_denied',
          message: "Permission denied: 'use_x_gateway' and 'edit_x_settings' permissions required.",
        },
      });
      return;
    }
    next();
  },
);

xSupportServiceDeskConsoleRouter.get(
  '/tenants/:id/service-desk/widget-config',
  (req: Request, res: Response): void => {
    const tenant = resolveNumericConsoleTenant(req, res);
    if (!tenant) return;
    try {
      const config = getSupportDeskWidgetConfig(tenant.id);
      const publicConfig = projectSupportDeskWidgetConfig(config);
      const embedSnippet = buildSupportDeskEmbedSnippet(req, tenant);
      res.json({ ok: true, config, publicConfig, embedSnippet });
    } catch (err) {
      sendDeskError(res, err);
    }
  },
);

xSupportServiceDeskConsoleRouter.put(
  '/tenants/:id/service-desk/widget-config',
  (req: Request, res: Response): void => {
    const tenant = resolveNumericConsoleTenant(req, res);
    if (!tenant) return;
    try {
      if (!isPlainObject(req.body)) {
        throw new SupportDeskError(400, 'invalid_input', 'Request body must be a JSON object.');
      }
      assertAllowedKeys(req.body, ['expectedVersion', 'enabled', 'appearance', 'intake']);
      const expectedVersion = assertPositiveInt(req.body.expectedVersion, 'expectedVersion');
      const patch: Partial<Pick<SupportDeskWidgetConfig, 'enabled' | 'appearance' | 'intake'>> = {};
      if (req.body.enabled !== undefined) patch.enabled = req.body.enabled as boolean;
      if (req.body.appearance !== undefined) patch.appearance = req.body.appearance as SupportDeskWidgetConfig['appearance'];
      if (req.body.intake !== undefined) patch.intake = req.body.intake as SupportDeskWidgetConfig['intake'];

      const config = updateSupportDeskWidgetConfig(tenant.id, patch, expectedVersion);
      const publicConfig = projectSupportDeskWidgetConfig(config);
      const embedSnippet = buildSupportDeskEmbedSnippet(req, tenant);
      res.json({ ok: true, config, publicConfig, embedSnippet });
    } catch (err) {
      sendDeskError(res, err);
    }
  },
);

xSupportServiceDeskConsoleRouter.post(
  '/tenants/:id/service-desk/copilot',
  async (req: Request, res: Response): Promise<void> => {
    const tenant = resolveNumericConsoleTenant(req, res);
    if (!tenant) return;
    const actorId = (req as Request & { user?: SessionUser }).user?.userId;
    if (!actorId) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required.' } });
      return;
    }

    let requestId: string | undefined;
    const abortController = new AbortController();
    const onAborted = () => abortController.abort();
    const onResClose = () => {
      if (!res.writableEnded) abortController.abort();
    };
    req.on('aborted', onAborted);
    res.on('close', onResClose);

    try {
      if (!isPlainObject(req.body)) {
        throw new SupportDeskError(400, 'invalid_input', 'Request body must be a JSON object.');
      }
      assertAllowedKeys(req.body, ['requestId', 'conversationId']);
      requestId = assertSafeRequestId(req.body.requestId);
      const conversationId = assertSafeOpaqueId(req.body.conversationId, 'conversationId');

      const result = await generateSupportAgentCopilot({
        tenantId: tenant.id,
        actorId,
        input: { requestId, conversationId },
        signal: abortController.signal,
      });

      if (!res.writableEnded) {
        res.json({ ok: true, result });
      }
    } catch (err) {
      sendDeskError(res, err, requestId);
    } finally {
      req.off('aborted', onAborted);
      res.off('close', onResClose);
    }
  },
);

xSupportServiceDeskConsoleRouter.get(
  '/tenants/:id/service-desk/copilot/jobs/:jobId',
  (req: Request, res: Response): void => {
    const tenant = resolveNumericConsoleTenant(req, res);
    if (!tenant) return;
    const actorId = (req as Request & { user?: SessionUser }).user?.userId;
    if (!actorId) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required.' } });
      return;
    }
    try {
      const jobId = assertSafeOpaqueId(paramStr(req.params.jobId), 'jobId');
      const result = readSupportAgentCopilotJob({ tenantId: tenant.id, actorId, jobId });
      res.json({ ok: true, result });
    } catch (err) {
      sendDeskError(res, err);
    }
  },
);

xSupportServiceDeskConsoleRouter.get(
  '/tenants/:id/service-desk/sla-policy',
  (req: Request, res: Response): void => {
    const tenant = resolveNumericConsoleTenant(req, res);
    if (!tenant) return;
    try {
      const policy = getSupportDeskSlaPolicy(tenant.id);
      res.json({ ok: true, policy });
    } catch (err) {
      sendDeskError(res, err);
    }
  },
);

xSupportServiceDeskConsoleRouter.put(
  '/tenants/:id/service-desk/sla-policy',
  (req: Request, res: Response): void => {
    const tenant = resolveNumericConsoleTenant(req, res);
    if (!tenant) return;
    try {
      if (!isPlainObject(req.body)) {
        throw new SupportDeskError(400, 'invalid_input', 'Request body must be a JSON object.');
      }
      assertAllowedKeys(req.body, ['expectedVersion', 'enabled', 'targets', 'routingRules']);
      const expectedVersion = assertPositiveInt(req.body.expectedVersion, 'expectedVersion');
      const patch: Partial<Pick<SupportDeskSlaPolicy, 'enabled' | 'targets' | 'routingRules'>> = {};
      if (req.body.enabled !== undefined) patch.enabled = req.body.enabled as boolean;
      if (req.body.targets !== undefined) {
        patch.targets = req.body.targets as Record<SupportTicketPriority, SupportDeskSlaPolicy['targets']['urgent']>;
      }
      if (req.body.routingRules !== undefined) {
        patch.routingRules = req.body.routingRules as SupportDeskSlaPolicy['routingRules'];
      }
      const policy = updateSupportDeskSlaPolicy(tenant.id, patch, expectedVersion);
      res.json({ ok: true, policy });
    } catch (err) {
      sendDeskError(res, err);
    }
  },
);

xSupportServiceDeskConsoleRouter.get(
  '/tenants/:id/service-desk/queue',
  (req: Request, res: Response): void => {
    const tenant = resolveNumericConsoleTenant(req, res);
    if (!tenant) return;
    try {
      const rawDepartment = typeof req.query.department === 'string' ? req.query.department.trim() : '';
      const rawStatus = typeof req.query.status === 'string' ? req.query.status.trim() : '';
      const rawCursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : '';
      const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : 50;

      if (rawDepartment && !(SUPPORT_DESK_DEPARTMENTS as readonly string[]).includes(rawDepartment)) {
        throw new SupportDeskError(400, 'invalid_input', 'Invalid department filter.');
      }
      if (rawStatus && !(VALID_TICKET_STATUSES as readonly string[]).includes(rawStatus)) {
        throw new SupportDeskError(400, 'invalid_input', 'Invalid status filter.');
      }
      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > SUPPORT_DESK_LIMITS.maxQueuePageSize) {
        throw new SupportDeskError(
          400,
          'invalid_input',
          `limit must be an integer between 1 and ${SUPPORT_DESK_LIMITS.maxQueuePageSize}.`,
        );
      }

      const cursorBound = rawCursor ? decodeQueueCursor(rawCursor) : null;

      // Load all tracked states into a map without any writes or read backfill
      const stateMap = new Map<string, SupportDeskTicketState>();
      let stateCursor: string | undefined;
      do {
        const page = listSupportDeskTicketStates(tenant.id, { cursor: stateCursor, limit: 100 });
        for (const st of page.items) {
          stateMap.set(st.ticketId, st);
        }
        stateCursor = page.nextCursor ?? undefined;
      } while (stateCursor);

      const now = Date.now();
      const tickets = listSupportEscalationTickets(String(tenant.id));

      const rows = tickets
        .map((ticket) => {
          const state = stateMap.get(ticket.id) ?? null;
          const sla = calculateSupportDeskSla(state, now);
          const openedAt = state?.cycleOpenedAt ?? ticket.createdAt;
          return { ticket, state, sla, openedAt };
        })
        .filter((row) => {
          if (rawDepartment && row.state?.department !== rawDepartment) return false;
          if (rawStatus && row.ticket.status !== rawStatus) return false;
          if (cursorBound) {
            if (row.openedAt < cursorBound.openedAt) return false;
            if (row.openedAt === cursorBound.openedAt && row.ticket.id <= cursorBound.ticketId) return false;
          }
          return true;
        })
        .sort((a, b) => {
          if (a.openedAt !== b.openedAt) return a.openedAt < b.openedAt ? -1 : 1;
          return a.ticket.id < b.ticket.id ? -1 : a.ticket.id > b.ticket.id ? 1 : 0;
        });

      const hasMore = rows.length > rawLimit;
      const sliced = hasMore ? rows.slice(0, rawLimit) : rows;
      const last = sliced[sliced.length - 1];
      const nextCursor = hasMore && last ? encodeQueueCursor(last.openedAt, last.ticket.id) : null;

      const items = sliced.map((row) => ({
        ticket: {
          ...row.ticket,
          subject: maskSupportSensitiveText(String(tenant.id), row.ticket.subject, row.ticket.userRole).masked,
          reason: maskSupportSensitiveText(String(tenant.id), row.ticket.reason, row.ticket.userRole).masked,
          ...(row.ticket.resolutionNotes !== undefined
            ? {
                resolutionNotes: maskSupportSensitiveText(
                  String(tenant.id),
                  row.ticket.resolutionNotes,
                  row.ticket.userRole,
                ).masked,
              }
            : {}),
        },
        tracked: row.sla.tracked,
        state: row.state,
        sla: {
          firstResponse: row.sla.firstResponse,
          resolution: row.sla.resolution,
        },
      }));

      res.json({ ok: true, items, nextCursor });
    } catch (err) {
      sendDeskError(res, err);
    }
  },
);

xSupportServiceDeskConsoleRouter.patch(
  '/tenants/:id/service-desk/tickets/:ticketId/routing',
  (req: Request, res: Response): void => {
    const tenant = resolveNumericConsoleTenant(req, res);
    if (!tenant) return;
    try {
      const ticketId = assertSafeOpaqueId(paramStr(req.params.ticketId), 'ticketId');
      if (!isPlainObject(req.body)) {
        throw new SupportDeskError(400, 'invalid_input', 'Request body must be a JSON object.');
      }
      assertAllowedKeys(req.body, ['expectedVersion', 'department']);
      const expectedVersion = assertPositiveInt(req.body.expectedVersion, 'expectedVersion');
      const department = req.body.department as SupportDeskDepartment;
      if (!(SUPPORT_DESK_DEPARTMENTS as readonly string[]).includes(department)) {
        throw new SupportDeskError(400, 'invalid_input', 'Invalid department.');
      }

      const existing = getSupportDeskTicketState(tenant.id, ticketId);
      if (!existing) {
        const ticketExists = listSupportEscalationTickets(String(tenant.id)).some((t) => t.id === ticketId);
        if (!ticketExists) {
          throw new SupportDeskError(404, 'ticket_not_found', 'Ticket not found.');
        }
        throw new SupportDeskError(409, 'ticket_not_tracked', 'Ticket does not have active SLA tracking.');
      }
      if (existing.tracking === 'paused') {
        throw new SupportDeskError(409, 'ticket_not_tracked', 'Ticket SLA tracking is paused.');
      }

      const state = updateSupportDeskTicketState(
        tenant.id,
        ticketId,
        { department, routingSource: 'manual' },
        expectedVersion,
      );
      res.json({ ok: true, state });
    } catch (err) {
      sendDeskError(res, err);
    }
  },
);

// ---------------------------------------------------------------------------
// Public Router (/thruline/v1/support/widget/*)
// ---------------------------------------------------------------------------

export const xSupportServiceDeskPublicRouter = Router();

function validatePublicTenantOrigin(req: Request, res: Response): SupportTenant {
  const headerTenantKey = req.headers['x-support-tenant-key'] as string | undefined;
  const authHeader = req.headers['authorization'] as string | undefined;
  const bearerKey = authHeader?.startsWith('Bearer ') ? authHeader.substring(7).trim() : undefined;
  const queryTenantKey = typeof req.query?.tenantKey === 'string' ? req.query.tenantKey.trim() : undefined;
  const rawKey = headerTenantKey?.trim() || queryTenantKey || (bearerKey?.startsWith('pk_sup_') ? bearerKey : undefined);
  if (!rawKey) {
    throw new SupportDeskError(401, 'unauthorized', 'Support tenant key is required.');
  }

  let tenant: SupportTenant;
  try {
    tenant = resolveTenant(rawKey);
  } catch (err) {
    throw new SupportDeskError(401, 'unauthorized', err instanceof Error ? err.message : 'Invalid support tenant key.');
  }

  const origin = req.headers.origin;
  if (origin) {
    const allowed = tenant.allowedOrigins ?? [];
    const isAllowed = allowed.length === 0 || allowed.includes('*') || allowed.includes(origin);
    if (!isAllowed) {
      throw new SupportDeskError(403, 'origin_denied', 'CORS origin denied.');
    }
    applySupportCors(req, res, tenant);
  }

  if (!tenant.enabled) {
    throw new SupportDeskError(403, 'tenant_disabled', 'Support tenant is disabled.');
  }

  return tenant;
}

xSupportServiceDeskPublicRouter.get('/widget/config', (req: Request, res: Response): void => {
  try {
    const tenant = validatePublicTenantOrigin(req, res);
    const config = getSupportDeskWidgetConfig(tenant.id);
    const publicConfig = projectSupportDeskWidgetConfig(config);
    res.json({ ok: true, config: publicConfig });
  } catch (err) {
    sendDeskError(res, err);
  }
});

xSupportServiceDeskPublicRouter.post('/widget/intake', (req: Request, res: Response): void => {
  let requestId: string | undefined;
  try {
    const { tenant, userContext } = validateSupportPublicAuth(req, res, { allowGuestSession: true });
    if (!userContext.verified) {
      throw new SupportDeskError(
        401,
        'signed_session_required',
        'A verified signed session is required to submit intake.',
      );
    }

    if (!isPlainObject(req.body)) {
      throw new SupportDeskError(400, 'invalid_input', 'Request body must be a JSON object.');
    }
    if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > SUPPORT_DESK_LIMITS.maxIntakeBytes) {
      throw new SupportDeskError(400, 'invalid_input', 'Intake payload exceeds maximum size.');
    }

    assertAllowedKeys(req.body, ['requestId', 'configVersion', 'values', 'conversationId']);
    requestId = assertSafeRequestId(req.body.requestId);
    const configVersion = assertPositiveInt(req.body.configVersion, 'configVersion');
    if (!isPlainObject(req.body.values)) {
      throw new SupportDeskError(400, 'invalid_intake', 'values must be a plain object.');
    }
    const conversationId =
      req.body.conversationId !== undefined
        ? assertSafeOpaqueId(req.body.conversationId, 'conversationId')
        : undefined;

    const config = getSupportDeskWidgetConfig(tenant.id);
    if (!config.enabled || config.intake.fields.length === 0) {
      throw new SupportDeskError(400, 'invalid_input', 'Widget intake is not enabled for this tenant.');
    }
    if (configVersion !== config.version) {
      throw new SupportDeskError(409, 'widget_config_changed', 'Widget configuration version is stale.');
    }

    const validatedValues = validateSupportDeskIntake(config, req.body.values);

    if (conversationId) {
      getSupportConversationForUser(String(tenant.id), conversationId, {
        userId: userContext.userId,
        role: userContext.role,
      });
    }

    const schemaHash = computeSupportDeskIntakeSchemaHash(config);
    const receipt = saveSupportDeskIntake({
      tenantId: tenant.id,
      userId: userContext.userId,
      role: userContext.role as SupportEvidenceRole,
      input: { requestId, configVersion, values: validatedValues, conversationId },
      schemaHash,
      validatedValues,
    });

    res.status(receipt.replayed ? 200 : 201).json({ ok: true, receipt });
  } catch (err) {
    sendDeskError(res, err, requestId);
  }
});
