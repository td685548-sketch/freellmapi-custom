import {
  COPILOT_ACTION_TYPES,
  SUPPORT_SETUP_STEP_IDS,
  type CopilotDiagnosticsResponse,
  type SupportSetupChatResponse,
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
import {
  buildErrorDoctorChatResponse,
  buildUserErrorDiagnosticReport,
  hasDoctorOrActionVietnameseMarkers,
  matchErrorDoctorIntent,
} from './error-doctor.js';
import {
  buildCallerIdentity,
  buildIdentityReply,
  buildWhoAmIResponse,
  identitySuggestedQuickReplies,
} from './identity.js';
import { isIdentityOrPermissionsQuestion } from './human-dialogue.js';
import { applySupportSetupProposal } from './executor.js';
import {
  buildPlatformExpertReply,
  matchPlatformKnowledgeQuestion,
  normalizePlatformPath,
} from './platform-guide.js';
import { tryGroundedGuideReply } from './grounded-guide.js';
import { buildKbGroundedFallback, isTroubleshootingQuestion } from './kb/answer.js';
import { detectConversationLocale, runSupportSetupCopilotTurn } from './playbook.js';
import { canUseSystemTarget, handleSystemTargetChatTurn } from './system-target.js';
import {
  buildTenantDoctorChatResponse,
  buildTenantDoctorReport,
  matchTenantDoctorIntent,
} from './tenant-doctor.js';
import {
  getSetupProposalForUser,
  listPendingProposalsForUser,
  markSetupProposalDeclined,
  SupportSetupCopilotError,
} from './store.js';
import {
  reprojectSystemActionsForUser,
  SYSTEM_SETTING_IDS,
} from './system-settings.js';
import {
  buildActionProposalChatResponse,
  buildOnboardingChecklist,
  executeCopilotUserAction,
  matchUserActionIntent,
} from './user-actions.js';
import {
  authorizePermissionGrant,
  handlePermissionGrantChatTurn,
} from './permission-grants.js';
import type { CopilotPermissionGrant } from '@freellmapi/shared/support-setup-copilot.js';

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

function isPersonalMemberRoute(rawPath?: string): boolean {
  const p = normalizePlatformPath(rawPath);
  return (
    p === '/assistants' ||
    p.startsWith('/assistants/') ||
    p === '/agents' ||
    p.startsWith('/agents/') ||
    p === '/keys' ||
    p.startsWith('/keys/')
  );
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
    targetMode: z.enum(['create_tenant', 'update_tenant', 'system']).optional(),
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
    selectedSystemActions: z.array(z.enum(SYSTEM_SETTING_IDS)).optional(),
  })
  .strict();

const executeActionParamsSchema = z
  .object({
    name: z.string().trim().max(100).optional(),
    routingMode: z.enum(['eco', 'balanced', 'max']).optional(),
    assistantId: z.number().int().positive().nullable().optional(),
    keyId: z.number().int().positive().optional(),
    focusStep: z.enum(['mint_personal_key', 'test_in_playground', 'connect_ide']).optional(),
  })
  .strict();

const executeActionBodySchema = z
  .object({
    actionType: z.enum(COPILOT_ACTION_TYPES),
    confirmed: z.boolean(),
    params: executeActionParamsSchema.optional(),
  })
  .strict();

function reprojectPendingProposalsForScope(
  proposals: SupportSetupProposal[],
  scope: CopilotUserScope,
  user: SessionUser,
): SupportSetupProposal[] {
  const projected: SupportSetupProposal[] = [];
  for (const proposal of proposals) {
    // Phase 3: permission grants are re-authorized live on every status
    // read — a proposal whose caller lost the permission, or whose target
    // changed, disappears instead of showing a stale Approve button.
    if (proposal.targetMode === 'permission_grant') {
      const grants = proposal.permissionGrants ?? [];
      if (grants.length === 0) continue;
      const fresh: CopilotPermissionGrant[] = [];
      let authorized = true;
      for (const staged of grants) {
        const auth = authorizePermissionGrant({
          user,
          intent: {
            action: staged.action,
            scope: staged.scope,
            targetEmail: staged.targetEmail,
            permissions: staged.permissions,
            rolePreset: staged.rolePreset,
            tenantId: staged.tenantId,
            tenantSlug: staged.tenantSlug ?? null,
            removeMember: staged.removeMember ?? false,
          },
          tenantId: staged.tenantId,
        });
        if (!auth.ok) {
          authorized = false;
          break;
        }
        fresh.push(auth.grant);
      }
      if (authorized) {
        projected.push({ ...proposal, permissionGrants: fresh });
      }
      continue;
    }

    if (proposal.targetMode === 'system_settings') {
      const nextActions = reprojectSystemActionsForUser(proposal.systemActions ?? [], user);
      if (nextActions.some((a) => a.canApply)) {
        projected.push({
          ...proposal,
          steps: [],
          systemActions: nextActions,
        });
      }
      continue;
    }

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

function buildMemberAssistantGuideReply(locale: 'vi' | 'en'): SupportSetupChatResponse {
  return {
    ok: true,
    replyLocale: locale,
    reply:
      locale === 'vi'
        ? 'Chào bạn! Mình là **Trợ lý AI & Bác sĩ Chẩn đoán Lỗi** của tài khoản bạn. Mình có thể kiểm tra ngay vì sao gọi API bị lỗi (`429`, `400`, `403`, `5xx`/lag), xem phần trăm hạn mức Quota, tạo **Personal API Key** kèm cấu hình **Cursor / Claude Code / OpenCode**, hoặc mở **Checklist 3 bước cho thành viên mới** — mọi thao tác đều chờ bạn bấm xác nhận trước khi thực thi nhé!'
        : 'Hi there! I am your **In-App Copilot & AI Error Doctor**. I can diagnose recent API errors (`429`, `400`, `403`, `5xx`/latency), inspect your Quota usage %, mint a new **Personal API Key** with ready-to-copy **Cursor / Claude Code / OpenCode** configs, or open your **3-Step Member Onboarding Checklist** — nothing changes without your explicit confirmation!',
    intent: 'guide',
    missingQuestions: [],
    suggestedQuickReplies:
      locale === 'vi'
        ? [
            'Kiểm tra tài khoản & chẩn đoán lỗi giúp mình',
            'Tạo Personal API Key mới chế độ Balanced',
            'Mở checklist 3 bước cho thành viên mới',
          ]
        : [
            'Diagnose my account & recent API errors',
            'Create a new Personal API Key in Balanced mode',
            'Open 3-step member onboarding checklist',
          ],
    proposal: null,
    userDiagnostic: null,
    actionProposal: null,
    modelUsed: null,
    usedFallback: true,
  };
}

// GET /api/support-setup-copilot/status
supportSetupCopilotRouter.get('/status', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const scope = resolveCopilotUserScope(user);
  const onboarding = buildOnboardingChecklist(user.userId);

  if (!scope.hasAccess) {
    // Phase 3: a delegated permissions admin holds no tenant access, but
    // their own pending grant proposals must stay visible (and approvable)
    // across reloads — the Consent Card lives in the chat turn otherwise.
    const grantProposals = reprojectPendingProposalsForScope(
      listPendingProposalsForUser(user.userId),
      scope,
      user,
    ).filter((p) => p.targetMode === 'permission_grant');
    const hidden: SupportSetupStatusResponse = {
      ok: true,
      visible: false,
      memberCopilotVisible: true,
      canCreateTenant: false,
      availableModels: [],
      tenants: [],
      activeTenant: null,
      pendingProposals: grantProposals,
      onboarding,
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
    memberCopilotVisible: true,
    canCreateTenant: scope.canCreateTenant,
    canUseSystemTarget: canUseSystemTarget(user),
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
    pendingProposals: reprojectPendingProposalsForScope(rawPending, scope, user),
    onboarding,
  };

  res.json(payload);
});

// GET /api/support-setup-copilot/whoami — the caller's OWN identity only.
// A caller with no access to a tenant sees nothing about that tenant.
supportSetupCopilotRouter.get('/whoami', (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as Request & { user?: SessionUser }).user!;
    if (!allowAuthRequest(`setup-copilot-whoami:${user.userId}`, 40)) {
      throw new SupportSetupCopilotError(
        429,
        'rate_limit_error',
        'Too many identity requests. Please wait a moment and try again.',
      );
    }
    const scope = resolveCopilotUserScope(user);
    const identity = buildCallerIdentity(user, scope);
    if (!identity) {
      throw new SupportSetupCopilotError(
        401,
        'authentication_required',
        'Authentication required.',
      );
    }
    res.json(buildWhoAmIResponse(identity));
  } catch (err) {
    next(err);
  }
});

// GET /api/support-setup-copilot/diagnostics — Strictly scoped to req.user.userId
supportSetupCopilotRouter.get('/diagnostics', (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as Request & { user?: SessionUser }).user!;
    if (!allowAuthRequest(`setup-copilot-diag:${user.userId}`, 40)) {
      throw new SupportSetupCopilotError(
        429,
        'rate_limit_error',
        'Too many diagnostic requests. Please wait a moment and try again.',
      );
    }

    const rawWindow =
      typeof req.query.windowHours === 'string' ? Number.parseInt(req.query.windowHours, 10) : 72;
    const windowHours = Number.isFinite(rawWindow) ? rawWindow : 72;

    const payload: CopilotDiagnosticsResponse = {
      ok: true,
      diagnostic: buildUserErrorDiagnosticReport(user, { windowHours }),
    };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// POST /api/support-setup-copilot/execute-action — Consent-gated Human-in-the-Loop actions
supportSetupCopilotRouter.post(
  '/execute-action',
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as Request & { user?: SessionUser }).user!;
      if (!allowAuthRequest(`setup-copilot-action:${user.userId}`, 25)) {
        throw new SupportSetupCopilotError(
          429,
          'rate_limit_error',
          'Too many action execution requests. Please wait a moment and try again.',
        );
      }

      const parsed = executeActionBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new SupportSetupCopilotError(
          400,
          'invalid_input',
          parsed.error.issues.map((i) => i.message).join(', '),
        );
      }

      const result = executeCopilotUserAction({
        user,
        body: parsed.data,
        serverOrigin: resolvePublicServerOrigin(req),
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/support-setup-copilot/chat
supportSetupCopilotRouter.post('/chat', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as Request & { user?: SessionUser }).user!;
    const scope = resolveCopilotUserScope(user);

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

    const latestUserMessage =
      [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const effectiveLocale: 'vi' | 'en' = hasDoctorOrActionVietnameseMarkers(latestUserMessage)
      ? 'vi'
      : detectConversationLocale(messages, locale);

    // 0. Tenant Doctor: "why does THIS tenant fail?" is answered from the
    // tenant's own evidence (turns, guardrail/output events, routes, policy),
    // not from the caller's personal API usage. Explicit tenant wording wins;
    // a bare "why error" only counts when a tenant Target is actually selected.
    {
      const tenantTargetSelected = targetMode === 'update_tenant' && scopedEntry !== null;
      const doctorEntry = scopedEntry ?? (targetMode === 'create_tenant' ? null : scope.tenants[0] ?? null);
      if (
        doctorEntry &&
        doctorEntry.canViewSteps.size > 0 &&
        matchTenantDoctorIntent(latestUserMessage, tenantTargetSelected)
      ) {
        const diagnostic = buildTenantSetupDiagnostic(
          doctorEntry.tenant,
          doctorEntry.canEditSteps,
          resolvePublicServerOrigin(req),
          { canViewSteps: doctorEntry.canViewSteps, isPlatformOperator: scope.isPlatformOperator },
        );
        res.json(
          buildTenantDoctorChatResponse({
            report: buildTenantDoctorReport({ tenant: doctorEntry.tenant, diagnostic }),
            locale: effectiveLocale,
          }),
        );
        return;
      }
    }

    // 1. Self-Service AI Error Doctor (available to every signed-in user, strictly scoped to user.userId)
    if (matchErrorDoctorIntent(latestUserMessage)) {
      const personal = buildErrorDoctorChatResponse({
        user,
        locale: effectiveLocale,
      });
      // This report is about the caller's own API usage. When a tenant is the
      // selected Target, say so and point at the tenant diagnosis, so the two
      // are never confused (a tenant never uses a Personal API key).
      if (scopedEntry) {
        const hint =
          effectiveLocale === 'vi'
            ? `\n\n_Đây là lỗi API của **tài khoản bạn**. Muốn biết vì sao tenant **${scopedEntry.tenant.name}** bị lỗi, hãy hỏi "tenant này bị lỗi vì sao"._`
            : `\n\n_This is about **your own account's** API usage. To see why tenant **${scopedEntry.tenant.name}** errors, ask "why does this tenant error"._`;
        personal.reply = `${personal.reply}${hint}`;
      }
      res.json(personal);
      return;
    }

    // 2. Consent-gated Personal API Key & Onboarding Action Proposals (zero state mutation on chat)
    const matchedAction = matchUserActionIntent(latestUserMessage, user);
    if (matchedAction) {
      res.json(
        buildActionProposalChatResponse({
          matched: matchedAction,
          locale: effectiveLocale,
        }),
      );
      return;
    }

    // 2b. Permission-aware identity (Phase 1): answer role/permissions
    // questions DETERMINISTICALLY from the DB-grounded identity record,
    // before the LLM and before the hasAccess gate — even members without
    // tenant access deserve to know who they are.
    if (isIdentityOrPermissionsQuestion(latestUserMessage)) {
      const identity = buildCallerIdentity(user, scope);
      if (identity) {
        res.json({
          ok: true,
          replyLocale: effectiveLocale,
          reply: buildIdentityReply(identity, effectiveLocale),
          intent: 'guide',
          missingQuestions: [],
          suggestedQuickReplies: identitySuggestedQuickReplies(effectiveLocale),
          proposal: null,
          userDiagnostic: null,
          actionProposal: null,
          modelUsed: null,
          usedFallback: true,
        } satisfies SupportSetupChatResponse);
        return;
      }
    }

    // 2c. Phase 3: deterministic grant/revoke — before the hasAccess gate,
    // so a delegated edit_user_permissions admin with no tenant access can
    // still grant/revoke via chat.
    const grantResponse = handlePermissionGrantChatTurn({
      user,
      scope,
      messages,
      tenantId: scopedEntry?.tenant.id ?? null,
      locale: effectiveLocale,
    });
    if (grantResponse) {
      res.json(grantResponse);
      return;
    }

    // 2d. System Target (platform-wide, full-power admins only): system
    // settings + platform guidance, never a tenant. Placed after the
    // identity / grant handlers above and before any tenant gate.
    if (targetMode === 'system') {
      if (!canUseSystemTarget(user)) {
        throw new SupportSetupCopilotError(
          403,
          'forbidden',
          'The System target is only available to administrators with full access.',
        );
      }
      res.json(
        handleSystemTargetChatTurn({
          user,
          messages,
          locale: effectiveLocale,
          currentPath,
        }),
      );
      return;
    }

    // 3. Regular members without Support Tenant permissions:
    // Allow platform/member guidance on personal AI Hub/Agents/Keys screens; enforce 403 on tenant setup attempts.
    if (!scope.hasAccess) {
      if (isPersonalMemberRoute(currentPath) && targetMode !== 'create_tenant') {
        // Grounded answer first (retrieved knowledge + read-only lookup tools);
        // the scripted replies below remain the fallback when no model answers.
        const grounded = await tryGroundedGuideReply({
          user,
          messages,
          locale: effectiveLocale,
          currentPath,
          gatewayLoopback: extractGatewayLoopback(req),
        });
        if (grounded) {
          res.json(grounded);
          return;
        }
        if (isTroubleshootingQuestion(latestUserMessage)) {
          const kbReply = await buildKbGroundedFallback({
            messages,
            locale: effectiveLocale,
            caller: user,
            currentPath,
          });
          if (kbReply) {
            res.json({
              ok: true,
              replyLocale: effectiveLocale,
              reply: kbReply.reply,
              intent: 'guide',
              missingQuestions: [],
              suggestedQuickReplies: kbReply.suggestedQuickReplies,
              proposal: null,
              userDiagnostic: null,
              actionProposal: null,
              modelUsed: null,
              usedFallback: true,
            } satisfies SupportSetupChatResponse);
            return;
          }
        }
        const platformMatch = matchPlatformKnowledgeQuestion(latestUserMessage, currentPath);
        if (platformMatch) {
          const priorAssistantMessages = messages
            .filter((m) => m.role === 'assistant')
            .map((m) => m.content);
          const expert = buildPlatformExpertReply({
            match: platformMatch,
            locale: effectiveLocale,
            currentPath,
            diagnostic: null,
            canCreateTenant: false,
            canEditAny: false,
            priorAssistantMessages,
          });
          res.json({
            ok: true,
            replyLocale: effectiveLocale,
            reply: expert.reply,
            intent: 'guide',
            missingQuestions: [],
            suggestedQuickReplies: expert.suggestedQuickReplies,
            proposal: null,
            userDiagnostic: null,
            actionProposal: null,
            modelUsed: null,
            usedFallback: true,
          } satisfies SupportSetupChatResponse);
          return;
        }

        res.json(buildMemberAssistantGuideReply(effectiveLocale));
        return;
      }

      throw new SupportSetupCopilotError(
        403,
        'forbidden',
        'You do not have permission to use AI Support Setup Copilot.',
      );
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

// Phase 3: a permission_grant proposal is owned by its creator and
// enforced by the apply branch — it must stay applicable/declinable even
// when the creator holds no tenant access (scope.hasAccess === false).
function isPermissionGrantProposalForUser(proposalId: string, userId: number): boolean {
  try {
    return getSetupProposalForUser(proposalId, userId).targetMode === 'permission_grant';
  } catch {
    return false;
  }
}

// POST /api/support-setup-copilot/proposals/:proposalId/apply
supportSetupCopilotRouter.post(
  '/proposals/:proposalId/apply',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as Request & { user?: SessionUser }).user!;
      const proposalId = paramStr(req.params.proposalId).trim();
      const scope = resolveCopilotUserScope(user);
      if (!scope.hasAccess && !isPermissionGrantProposalForUser(proposalId, user.userId)) {
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
        proposalId,
        approved: parsed.data.approved,
        selectedSteps: parsed.data.selectedSteps,
        selectedSystemActions: parsed.data.selectedSystemActions,
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
      const proposalId = paramStr(req.params.proposalId).trim();
      if (!scope.hasAccess && !isPermissionGrantProposalForUser(proposalId, user.userId)) {
        throw new SupportSetupCopilotError(
          403,
          'forbidden',
          'You do not have permission to manage Support Copilot proposals.',
        );
      }
      const proposal = markSetupProposalDeclined(
        proposalId,
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
