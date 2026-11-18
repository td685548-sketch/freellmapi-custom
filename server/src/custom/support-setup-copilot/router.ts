import {
  SUPPORT_SETUP_STEP_IDS,
  type SupportSetupProposal,
  type SupportSetupStatusResponse,
  type SupportSetupStepId,
} from '@freellmapi/shared/support-setup-copilot.js';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { allowAuthRequest } from '../../services/auth-security.js';
import type { SessionUser } from '../../services/auth.js';
import { isGuestRequest } from '../../services/guest-access.js';
import { TenantRbacError } from '../tenant-portal/store.js';
import { SupportEvidenceError } from '../x-gateway/support-evidence-store.js';
import { SupportOutputError } from '../x-gateway/support-output-store.js';
import { SupportDeskError } from '../x-gateway/support-service-desk-store.js';
import { SupportStoreError } from '../x-gateway/support-store.js';
import {
  buildTenantSetupDiagnostic,
  listCopilotModelOptions,
  resolveCopilotUserScope,
  resolvePublicServerOrigin,
  type CopilotUserScope,
} from './diagnostics.js';
import { applySupportSetupProposal } from './executor.js';
import { runSupportSetupCopilotTurn } from './playbook.js';
import {
  listPendingProposalsForUser,
  markSetupProposalDeclined,
  SupportSetupCopilotError,
} from './store.js';

export const supportSetupCopilotRouter = Router();

function requireSignedInUser(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: SessionUser }).user;
  if (isGuestRequest(req) || !user || !user.userId) {
    res.status(401).json({
      error: {
        code: 'authentication_required',
        type: 'authentication_error',
        message: 'Authentication required.',
      },
    });
    return;
  }
  next();
}

supportSetupCopilotRouter.use(requireSignedInUser);

function extractGatewayLoopback(req: Request): {
  host: string;
  port: number;
  sessionToken?: string;
} | undefined {
  const port = req.socket?.localPort ?? 0;
  if (!port || port <= 0) return undefined;
  const rawAddr = (req.socket?.localAddress ?? '').replace(/^::ffff:/i, '');
  const host =
    !rawAddr || rawAddr === '::' || rawAddr === '0.0.0.0'
      ? '127.0.0.1'
      : rawAddr.includes(':')
        ? `[${rawAddr}]`
        : rawAddr;
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  const dash = req.headers['x-dashboard-token'];
  const sessionToken =
    bearer || (Array.isArray(dash) ? dash[0] : dash)?.trim() || undefined;
  return { host, port, sessionToken };
}

function paramStr(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
}

const chatMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().trim().min(1).max(8000),
  })
  .strict();

const requirementsHintSchema = z
  .object({
    brandName: z.string().trim().max(80).optional(),
    tenantSlug: z.string().trim().max(48).optional(),
    industry: z.string().trim().max(80).optional(),
    websiteOrigin: z.string().trim().max(200).optional(),
    language: z.enum(['vi', 'en', 'bilingual']).optional(),
    tone: z.enum(['friendly', 'professional', 'empathetic', 'technical']).optional(),
    primaryColor: z.string().trim().max(40).optional(),
    faqSummaryOrPolicies: z.string().trim().max(2000).optional(),
    blockedTopics: z.array(z.string().trim().max(80)).max(20).optional(),
    competitorKeywords: z.array(z.string().trim().max(80)).max(20).optional(),
    requireContactIntake: z.boolean().optional(),
    defaultModel: z.string().trim().max(120).optional(),
  })
  .strict();

const chatBodySchema = z
  .object({
    tenantId: z.number().int().positive().nullable().optional(),
    targetMode: z.enum(['create_tenant', 'update_tenant']).optional(),
    locale: z.enum(['vi', 'en']).optional(),
    currentPath: z.string().trim().max(240).optional(),
    messages: z.array(chatMessageSchema).min(1).max(30),
    requirementsHint: requirementsHintSchema.optional(),
    baseProposalId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const applyBodySchema = z
  .object({
    approved: z.boolean(),
    selectedSteps: z.array(z.enum(SUPPORT_SETUP_STEP_IDS)).optional(),
  })
  .strict();

function reprojectPendingProposalsForScope(
  proposals: SupportSetupProposal[],
  scope: CopilotUserScope,
): SupportSetupProposal[] {
  const projected: SupportSetupProposal[] = [];
  for (const proposal of proposals) {
    let liveCanEdit: Set<SupportSetupStepId>;
    if (proposal.targetMode === 'create_tenant') {
      if (!scope.canCreateTenant) continue;
      liveCanEdit = new Set<SupportSetupStepId>(SUPPORT_SETUP_STEP_IDS);
    } else {
      if (!proposal.tenantId) continue;
      const entry = scope.tenants.find((t) => t.tenant.id === proposal.tenantId);
      if (!entry || entry.canEditSteps.size === 0) continue;
      liveCanEdit = entry.canEditSteps;
    }

    const nextSteps = proposal.steps.map((step) => {
      const canApply = liveCanEdit.has(step.stepId);
      return canApply
        ? { ...step, canApply: true }
        : {
            ...step,
            canApply: false,
            enabledByDefault: false,
            highlightsEn: [],
            highlightsVi: [],
            payload: {},
          };
    });

    if (nextSteps.some((s) => s.canApply)) {
      projected.push({ ...proposal, steps: nextSteps });
    }
  }
  return projected;
}

// GET /api/support-setup-copilot/status
supportSetupCopilotRouter.get('/status', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const scope = resolveCopilotUserScope(user);

  if (!scope.hasAccess) {
    const hidden: SupportSetupStatusResponse = {
      ok: true,
      visible: false,
      canCreateTenant: false,
      availableModels: [],
      tenants: [],
      activeTenant: null,
      pendingProposals: [],
    };
    res.json(hidden);
    return;
  }

  const rawTenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
  const requestedTenantId = rawTenantId ? Number(rawTenantId) : null;
  const activeEntry =
    requestedTenantId && Number.isInteger(requestedTenantId) && requestedTenantId > 0
      ? scope.tenants.find((t) => t.tenant.id === requestedTenantId) ?? null
      : rawTenantId === 'new'
        ? null
        : scope.tenants[0] ?? null;

  const serverOrigin = resolvePublicServerOrigin(req);
  const activeTenant = activeEntry
    ? buildTenantSetupDiagnostic(activeEntry.tenant, activeEntry.canEditSteps, serverOrigin, {
        canViewSteps: activeEntry.canViewSteps,
        isPlatformOperator: scope.isPlatformOperator,
      })
    : null;

  const rawPending = listPendingProposalsForUser(
    user.userId,
    activeTenant ? activeTenant.tenant.id : null,
  );

  const payload: SupportSetupStatusResponse = {
    ok: true,
    visible: true,
    canCreateTenant: scope.canCreateTenant,
    availableModels: listCopilotModelOptions(),
    tenants: scope.tenants.map((entry) => {
      const canSeeKey =
        entry.canViewSteps.has('runtime_policy') || entry.canViewSteps.has('tenant_ai');
      return {
        id: entry.tenant.id,
        name: entry.tenant.name,
        slug: entry.tenant.slug,
        publicKey: canSeeKey ? entry.tenant.publicKey : '',
        enabled: entry.tenant.enabled,
        defaultModel: entry.canViewSteps.has('tenant_ai') ? entry.tenant.defaultModel : '',
        canViewSteps: [...entry.canViewSteps] as SupportSetupStepId[],
        canEditSteps: [...entry.canEditSteps] as SupportSetupStepId[],
      };
    }),
    activeTenant,
    pendingProposals: reprojectPendingProposalsForScope(rawPending, scope),
  };

  res.json(payload);
});

// POST /api/support-setup-copilot/chat
supportSetupCopilotRouter.post('/chat', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as Request & { user?: SessionUser }).user!;
    const scope = resolveCopilotUserScope(user);
    if (!scope.hasAccess) {
      throw new SupportSetupCopilotError(
        403,
        'forbidden',
        'You do not have permission to use AI Support Setup Copilot.',
      );
    }

    if (!allowAuthRequest(`setup-copilot-chat:${user.userId}`, 30)) {
      throw new SupportSetupCopilotError(
        429,
        'rate_limit_error',
        'Too many Setup Copilot requests. Please wait a moment and try again.',
      );
    }

    const parsed = chatBodySchema.safeParse(req.body ?? {});
    if (
      !parsed.success ||
      parsed.data.messages[parsed.data.messages.length - 1]!.role !== 'user'
    ) {
      throw new SupportSetupCopilotError(
        400,
        'invalid_input',
        'Provide 1–30 messages ending with a user turn.',
      );
    }

    const {
      tenantId,
      targetMode,
      locale = 'vi',
      currentPath,
      messages,
      requirementsHint,
      baseProposalId,
    } = parsed.data;

    let scopedEntry = null;
    if (tenantId !== undefined && tenantId !== null) {
      scopedEntry = scope.tenants.find((t) => t.tenant.id === tenantId) ?? null;
      if (!scopedEntry) {
        throw new SupportSetupCopilotError(
          403,
          'forbidden',
          'You do not have access to the requested Support Tenant.',
        );
      }
    } else if (targetMode !== 'create_tenant' && scope.tenants.length > 0) {
      scopedEntry = scope.tenants[0]!;
    }

    const serverOrigin = resolvePublicServerOrigin(req);
    const diagnostic = scopedEntry
      ? buildTenantSetupDiagnostic(scopedEntry.tenant, scopedEntry.canEditSteps, serverOrigin, {
          canViewSteps: scopedEntry.canViewSteps,
          isPlatformOperator: scope.isPlatformOperator,
        })
      : null;

    const response = await runSupportSetupCopilotTurn({
      user,
      scope,
      messages,
      tenantId: scopedEntry?.tenant.id ?? null,
      targetMode,
      locale,
      currentPath,
      requirementsHint,
      baseProposalId,
      diagnostic,
      gatewayLoopback: extractGatewayLoopback(req),
    });

    res.json(response);
  } catch (err) {
    next(err);
  }
});

// POST /api/support-setup-copilot/proposals/:proposalId/apply
supportSetupCopilotRouter.post(
  '/proposals/:proposalId/apply',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as Request & { user?: SessionUser }).user!;
      const scope = resolveCopilotUserScope(user);
      if (!scope.hasAccess) {
        throw new SupportSetupCopilotError(
          403,
          'forbidden',
          'You do not have permission to deploy Support Copilot proposals.',
        );
      }

      if (!allowAuthRequest(`setup-copilot-apply:${user.userId}`, 20)) {
        throw new SupportSetupCopilotError(
          429,
          'rate_limit_error',
          'Too many setup deployment requests. Please try again later.',
        );
      }

      const parsed = applyBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new SupportSetupCopilotError(
          400,
          'invalid_input',
          parsed.error.issues.map((i) => i.message).join(', '),
        );
      }

      const result = await applySupportSetupProposal({
        user,
        proposalId: paramStr(req.params.proposalId).trim(),
        approved: parsed.data.approved,
        selectedSteps: parsed.data.selectedSteps,
        serverOrigin: resolvePublicServerOrigin(req),
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/support-setup-copilot/proposals/:proposalId/decline
supportSetupCopilotRouter.post(
  '/proposals/:proposalId/decline',
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as Request & { user?: SessionUser }).user!;
      const scope = resolveCopilotUserScope(user);
      if (!scope.hasAccess) {
        throw new SupportSetupCopilotError(
          403,
          'forbidden',
          'You do not have permission to manage Support Copilot proposals.',
        );
      }
      const proposal = markSetupProposalDeclined(
        paramStr(req.params.proposalId).trim(),
        user.userId,
      );
      res.json({ ok: true, proposal });
    } catch (err) {
      next(err);
    }
  },
);

// Error handler
supportSetupCopilotRouter.use(
  (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof SupportSetupCopilotError) {
      res.status(err.status).json({
        error: { code: err.code, type: err.code, message: err.message },
      });
      return;
    }
    if (
      err instanceof SupportDeskError ||
      err instanceof SupportOutputError ||
      err instanceof SupportEvidenceError ||
      err instanceof TenantRbacError
    ) {
      res.status(err.status).json({
        error: { code: err.code, type: err.code, message: err.message },
      });
      return;
    }
    if (err instanceof SupportStoreError) {
      res.status(err.status).json({
        error: { code: 'support_error', type: 'support_error', message: err.message },
      });
      return;
    }
    const message = err instanceof Error ? err.message : 'Setup Copilot request failed.';
    res.status(500).json({ error: { code: 'internal_error', type: 'internal_error', message } });
  },
);
