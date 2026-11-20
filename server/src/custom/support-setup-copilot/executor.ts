import type { SupportRuntimePolicy } from '@freellmapi/shared/support-runtime.js';
import {
  SUPPORT_SETUP_STEP_IDS,
  type CopilotPermissionGrant,
  type SupportSetupApplyResponse,
  type SupportSetupGuardrailsPayload,
  type SupportSetupKnowledgeMaskingPayload,
  type SupportSetupOutputControlsPayload,
  type SupportSetupRuntimePayload,
  type SupportSetupSlaRoutingPayload,
  type SupportSetupStepApplyResult,
  type SupportSetupStepId,
  type SupportSetupTenantAiPayload,
  type SupportSetupWidgetPayload,
  type SupportSystemSettingId,
} from '@freellmapi/shared/support-setup-copilot.js';
import type { Permission } from '@freellmapi/shared/user-access.js';
import type { SessionUser } from '../../services/auth.js';
import { setUserPermissions } from '../../services/users.js';
import {
  assertTenantPermission,
  isPlatformTenantOperator,
  listSafeTenantModelOptions,
  removeTenantMember,
  upsertTenantMemberByTenantAdmin,
} from '../tenant-portal/store.js';
import { appendSupportAuditLog } from '../x-gateway/support-enterprise-router.js';
import {
  createSupportEvidenceSource,
  importSupportEvidenceRevision,
  listSupportEvidenceSources,
  publishSupportEvidenceRevision,
  updateSupportEvidenceSource,
} from '../x-gateway/support-evidence-store.js';
import { updateSupportGuardrailPolicy } from '../x-gateway/support-guardrails.js';
import {
  listSupportKnowledgeDocs,
  updateSupportMaskingPolicy,
  upsertSupportKnowledgeDoc,
} from '../x-gateway/support-knowledge.js';
import { getSupportOutputPolicy, saveSupportOutputPolicy } from '../x-gateway/support-output-store.js';
import { updateSupportRuntimePolicy } from '../x-gateway/support-runtime-store.js';
import {
  getSupportDeskSlaPolicy,
  getSupportDeskWidgetConfig,
  updateSupportDeskSlaPolicy,
  updateSupportDeskWidgetConfig,
} from '../x-gateway/support-service-desk-store.js';
import {
  createSupportTenant,
  DEFAULT_SUPPORT_ROLES,
  getSupportTenant,
  listSupportTenants,
  type SupportTenant,
  updateSupportTenant,
} from '../x-gateway/support-store.js';
import { buildTenantSetupDiagnostic, resolveCopilotUserScope } from './diagnostics.js';
import { sanitizeSlug } from './playbook.js';
import {
  getSetupProposalForUser,
  markSetupProposalApplied,
  SupportSetupCopilotError,
} from './store.js';
import {
  authorizePermissionGrant,
  grantDenialStatus,
} from './permission-grants.js';
import { applySystemSettingsActions } from './system-settings.js';

/** Map a coded store error (users.ts / tenant-portal/store.ts) to a copilot error. */
function mapGrantStoreError(err: unknown): SupportSetupCopilotError {
  const code =
    err !== null && typeof err === 'object' && 'code' in err
      ? String((err as { code: unknown }).code)
      : 'internal_error';
  const message = err instanceof Error ? err.message : 'Permission change failed.';
  return new SupportSetupCopilotError(grantDenialStatus(code), code, message);
}

async function syncEvidencePackBestEffort(
  tenant: SupportTenant,
  payload: SupportSetupKnowledgeMaskingPayload,
): Promise<boolean> {
  if (!payload.docs.length) return false;
  try {
    const combinedMarkdown = payload.docs
      .map((doc) => `## ${doc.title}\n\n${doc.content}`)
      .join('\n\n---\n\n');

    const sources = listSupportEvidenceSources(tenant.id);
    let source = sources.find(
      (s) => s.name === 'Setup Copilot Knowledge Pack' && s.kind === 'markdown',
    );
    if (!source) {
      source = createSupportEvidenceSource(tenant.id, {
        name: 'Setup Copilot Knowledge Pack',
        kind: 'markdown',
        allowedRoles: ['guest', 'customer', 'staff', 'admin'],
      });
    } else if (source.status === 'archived') {
      source = updateSupportEvidenceSource(
        tenant.id,
        source.id,
        {
          status: 'active',
          allowedRoles: ['guest', 'customer', 'staff', 'admin'],
        },
        source.version,
      );
    }

    const imported = await importSupportEvidenceRevision({
      tenantId: tenant.id,
      sourceId: source.id,
      expectedVersion: source.version,
      title: `${tenant.name} - Support Knowledge Pack`,
      category: 'faq',
      tags: ['setup-copilot', 'faq'],
      format: 'markdown',
      content: combinedMarkdown,
    });
    publishSupportEvidenceRevision(
      tenant.id,
      source.id,
      imported.revision.id,
      imported.source.version,
    );
    return true;
  } catch {
    return false;
  }
}

function buildAllowedTenantModelSet(currentDefaultModel?: string): Set<string> {
  return new Set<string>([
    'auto',
    ...listSafeTenantModelOptions().map((m) => m.id),
    ...(currentDefaultModel ? [currentDefaultModel] : []),
  ]);
}

export async function applySupportSetupProposal(params: {
  user: SessionUser;
  proposalId: string;
  approved: boolean;
  selectedSteps?: SupportSetupStepId[];
  selectedSystemActions?: SupportSystemSettingId[];
  serverOrigin: string;
}): Promise<SupportSetupApplyResponse> {
  const { user, proposalId, approved, selectedSteps, selectedSystemActions, serverOrigin } = params;

  if (approved !== true) {
    throw new SupportSetupCopilotError(
      400,
      'consent_required',
      'Explicit customer consent (approved: true) is required before deploying changes.',
    );
  }

  const proposal = getSetupProposalForUser(proposalId, user.userId);
  if (proposal.status === 'applied') {
    throw new SupportSetupCopilotError(
      409,
      'proposal_already_applied',
      'This setup proposal has already been deployed.',
    );
  }
  if (proposal.status === 'expired') {
    throw new SupportSetupCopilotError(
      409,
      'proposal_expired',
      'This setup proposal has expired. Ask the Copilot to generate a fresh plan.',
    );
  }
  if (proposal.status !== 'pending_consent') {
    throw new SupportSetupCopilotError(
      409,
      'proposal_not_pending',
      `Setup proposal is in '${proposal.status}' state and cannot be applied.`,
    );
  }

  // Phase 3: permission grants. This branch runs BEFORE the scope.hasAccess
  // gate: a delegated edit_user_permissions admin may hold no tenant access
  // at all, and the grant authorization below is the enforcement — not the
  // copilot scope.
  if (proposal.targetMode === 'permission_grant') {
    const grants = proposal.permissionGrants ?? [];
    if (grants.length === 0) {
      throw new SupportSetupCopilotError(
        400,
        'invalid_proposal',
        'Permission grant proposal has no grants.',
      );
    }

    // Re-authorize EVERY grant live before applying ANY of them, so a stale
    // stage can never apply after the caller lost the permission, the
    // target gained broader authority, or the last admin changed.
    const freshGrants: CopilotPermissionGrant[] = [];
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
        throw new SupportSetupCopilotError(
          grantDenialStatus(auth.code),
          auth.code,
          auth.messageEn,
        );
      }
      freshGrants.push(auth.grant);
    }

    const appliedGrants: Array<{
      targetEmail: string;
      scope: string;
      action: string;
      previousPermissions: string[];
      newPermissions: string[];
    }> = [];
    for (const grant of freshGrants) {
      try {
        if (grant.scope === 'global') {
          setUserPermissions(
            grant.targetUserId,
            grant.newPermissions as Permission[],
            user.userId,
          );
        } else if (grant.action === 'revoke' && grant.newPermissions.length === 0) {
          removeTenantMember({
            tenantId: grant.tenantId!,
            targetUserId: grant.targetUserId,
            actor: user,
          });
        } else if (grant.action === 'grant' && grant.rolePreset) {
          upsertTenantMemberByTenantAdmin({
            tenantId: grant.tenantId!,
            userId: grant.targetUserId,
            rolePreset: grant.rolePreset,
            actor: user,
          });
        } else {
          upsertTenantMemberByTenantAdmin({
            tenantId: grant.tenantId!,
            userId: grant.targetUserId,
            permissions: grant.newPermissions,
            actor: user,
          });
        }
      } catch (err) {
        throw mapGrantStoreError(err);
      }

      appendSupportAuditLog({
        tenantId: grant.scope === 'tenant' ? String(grant.tenantId) : 'system',
        action: `support.setup_copilot.permission_${grant.action}_apply`,
        userId: String(user.userId),
        role: user.role,
        details: {
          proposalId,
          targetUserId: grant.targetUserId,
          targetEmail: grant.targetEmail,
          scope: grant.scope,
          tenantId: grant.tenantId,
          action: grant.action,
          ...(grant.action === 'grant'
            ? { permissionsGranted: grant.permissions }
            : { permissionsRemoved: grant.permissions }),
          previousPermissions: grant.previousPermissions,
          newPermissions: grant.newPermissions,
          rolePreset: grant.rolePreset,
          via: 'copilot',
        },
      });
      appliedGrants.push({
        targetEmail: grant.targetEmail,
        scope: grant.scope,
        action: grant.action,
        previousPermissions: grant.previousPermissions,
        newPermissions: grant.newPermissions,
      });
    }

    const savedProposal = markSetupProposalApplied(
      proposal.id,
      user.userId,
      proposal.tenantId,
      { ...proposal, permissionGrants: freshGrants },
      { appliedGrants },
    );
    return {
      ok: true,
      proposalId: savedProposal.id,
      proposal: savedProposal,
      tenant:
        proposal.tenantId != null
          ? {
              id: proposal.tenantId,
              name: proposal.tenantName,
              slug: proposal.tenantSlug,
              publicKey: '',
            }
          : null,
      stepResults: [],
      diagnostic: null,
    };
  }

  const scope = resolveCopilotUserScope(user);
  if (!scope.hasAccess) {
    throw new SupportSetupCopilotError(403, 'forbidden', 'Support setup access denied.');
  }

  if (proposal.targetMode === 'system_settings') {
    const systemResults = applySystemSettingsActions({
      user,
      actions: proposal.systemActions ?? [],
      selectedIds: selectedSystemActions,
    });
    const appliedSystemActions = systemResults
      .filter((r) => r.status === 'applied')
      .map((r) => r.settingId);
    const savedProposal = markSetupProposalApplied(
      proposal.id,
      user.userId,
      null,
      proposal,
      { appliedSystemActions, systemResults },
    );
    return {
      ok: true,
      proposalId: savedProposal.id,
      proposal: savedProposal,
      tenant: null,
      stepResults: [],
      systemResults,
      diagnostic: null,
    };
  }

  const actorIsOperator = isPlatformTenantOperator(user);
  let canEditSet: Set<SupportSetupStepId>;
  let canViewSet: Set<SupportSetupStepId>;

  if (proposal.targetMode === 'create_tenant') {
    if (!scope.canCreateTenant || !actorIsOperator) {
      throw new SupportSetupCopilotError(
        403,
        'forbidden',
        'Your account does not have permission to create new Support Tenants.',
      );
    }
    canEditSet = new Set<SupportSetupStepId>(SUPPORT_SETUP_STEP_IDS);
    canViewSet = new Set<SupportSetupStepId>(SUPPORT_SETUP_STEP_IDS);
  } else {
    if (!proposal.tenantId) {
      throw new SupportSetupCopilotError(400, 'invalid_proposal', 'Target tenantId is missing.');
    }
    const entry = scope.tenants.find((t) => t.tenant.id === proposal.tenantId);
    if (!entry) {
      throw new SupportSetupCopilotError(
        403,
        'forbidden',
        'You do not have access to the target Support Tenant.',
      );
    }
    canEditSet = entry.canEditSteps;
    canViewSet = entry.canViewSteps;
    if (canEditSet.size === 0) {
      throw new SupportSetupCopilotError(
        403,
        'forbidden',
        'Your account has read-only access on this Support Tenant and cannot deploy changes.',
      );
    }
  }

  const stepMap = new Map(proposal.steps.map((s) => [s.stepId, s]));
  const requestedSet =
    selectedSteps && selectedSteps.length > 0
      ? [...new Set(selectedSteps)].filter((id) => stepMap.has(id))
      : proposal.steps.filter((s) => s.canApply && s.enabledByDefault).map((s) => s.stepId);

  if (requestedSet.length === 0) {
    throw new SupportSetupCopilotError(
      400,
      'no_steps_selected',
      'Select at least one permitted setup step to apply.',
    );
  }

  for (const stepId of requestedSet) {
    if (!canEditSet.has(stepId)) {
      throw new SupportSetupCopilotError(
        403,
        'forbidden',
        `Permission denied to apply setup step '${stepId}'.`,
      );
    }
  }

  if (proposal.targetMode === 'create_tenant' && !requestedSet.includes('tenant_ai')) {
    throw new SupportSetupCopilotError(
      400,
      'invalid_input',
      "Creating a new tenant requires including the 'tenant_ai' step.",
    );
  }

  const selectedLookup = new Set<SupportSetupStepId>(requestedSet);
  const stepResults: SupportSetupStepApplyResult[] = [];
  let targetTenant: SupportTenant;

  const tenantAiStep = stepMap.get('tenant_ai');
  const runtimeStep = stepMap.get('runtime_policy');

  // Step 1: tenant_ai (create or update)
  if (selectedLookup.has('tenant_ai') && tenantAiStep) {
    const payload = tenantAiStep.payload as unknown as SupportSetupTenantAiPayload;
    if (proposal.targetMode === 'create_tenant') {
      if (!actorIsOperator) {
        throw new SupportSetupCopilotError(
          403,
          'forbidden',
          'Permission denied: creating Support Tenants requires Platform Operator privileges.',
        );
      }
      const existingSlugs = new Set(listSupportTenants().map((t) => t.slug.toLowerCase()));
      const uniqueSlug = sanitizeSlug(payload.slug || payload.name, existingSlugs);
      const runtimePayload = runtimeStep?.payload as SupportSetupRuntimePayload | undefined;
      const initialOrigins =
        selectedLookup.has('runtime_policy') &&
        Array.isArray(runtimePayload?.allowedOrigins) &&
        runtimePayload.allowedOrigins.length > 0
          ? runtimePayload.allowedOrigins
          : ['*'];
      const created = createSupportTenant({
        name: payload.name,
        slug: uniqueSlug,
        defaultModel: payload.defaultModel || 'auto',
        systemPrompt: payload.systemPrompt,
        allowedOrigins: initialOrigins,
        allowGuest: payload.allowGuest,
        rolesConfig: DEFAULT_SUPPORT_ROLES,
        createdBy: user.userId,
      });
      targetTenant = created.tenant;
      stepResults.push({
        stepId: 'tenant_ai',
        status: 'applied',
        detailEn: `Created tenant "${targetTenant.name}" (${targetTenant.slug}).`,
        detailVi: `Đã tạo tenant "${targetTenant.name}" (${targetTenant.slug}).`,
      });
    } else {
      const access = assertTenantPermission(user, proposal.tenantId!, 'edit_tenant_ai');
      const requestedModel = payload.defaultModel || access.tenant.defaultModel || 'auto';
      if (!actorIsOperator) {
        const safeModels = buildAllowedTenantModelSet(access.tenant.defaultModel);
        if (!safeModels.has(requestedModel)) {
          throw new SupportSetupCopilotError(
            403,
            'forbidden',
            `Model '${requestedModel}' is not permitted for Tenant Portal accounts.`,
          );
        }
      }
      // Strictly never touch allowedOrigins here — CORS origins require edit_tenant_integration (Step 7).
      targetTenant = updateSupportTenant(proposal.tenantId!, {
        name: payload.name,
        defaultModel: requestedModel,
        systemPrompt: payload.systemPrompt,
        allowGuest: payload.allowGuest,
        enabled: typeof payload.enabled === 'boolean' ? payload.enabled : true,
      });
      stepResults.push({
        stepId: 'tenant_ai',
        status: 'applied',
        detailEn: `Updated AI persona & model "${targetTenant.defaultModel}".`,
        detailVi: `Đã cập nhật nhân cách AI & model "${targetTenant.defaultModel}".`,
      });
    }
  } else {
    targetTenant = getSupportTenant(proposal.tenantId!);
    stepResults.push({
      stepId: 'tenant_ai',
      status: 'skipped',
      detailEn: 'Kept existing tenant AI configuration.',
      detailVi: 'Giữ nguyên cấu hình Tenant AI hiện tại.',
    });
  }

  // Step 2: knowledge_masking
  const kbStep = stepMap.get('knowledge_masking');
  if (selectedLookup.has('knowledge_masking') && kbStep) {
    assertTenantPermission(user, targetTenant.id, 'edit_tenant_knowledge');
    const payload = kbStep.payload as unknown as SupportSetupKnowledgeMaskingPayload;
    const tid = String(targetTenant.id);
    const existingDocs = listSupportKnowledgeDocs(tid);
    const byTitle = new Map(existingDocs.map((d) => [d.title.trim().toLowerCase(), d]));

    let upsertedCount = 0;
    for (const doc of payload.docs) {
      const existing = byTitle.get(doc.title.trim().toLowerCase());
      upsertSupportKnowledgeDoc(tid, {
        ...(existing ? { id: existing.id } : {}),
        title: doc.title,
        category: doc.category,
        content: doc.content,
        tags: doc.tags,
        allowedRoles: doc.allowedRoles,
        enabled: true,
      });
      upsertedCount += 1;
    }

    // Evidence library (/knowledge-library) requires Platform Operator (edit_x_settings);
    // never execute Evidence store writes for non-operator Tenant Portal accounts.
    const evidenceSynced = actorIsOperator
      ? await syncEvidencePackBestEffort(targetTenant, payload)
      : false;
    updateSupportMaskingPolicy(tid, {
      enabled: payload.masking.enabled,
      builtinDetectors: payload.masking.builtinDetectors,
      unmaskedRoles: payload.masking.unmaskedRoles,
    });

    stepResults.push({
      stepId: 'knowledge_masking',
      status: 'applied',
      detailEn: `Seeded ${upsertedCount} knowledge doc(s)${evidenceSynced ? ' + published Evidence pack' : ''} & enabled PII masking.`,
      detailVi: `Đã nạp ${upsertedCount} tài liệu KB${evidenceSynced ? ' + xuất bản gói Evidence' : ''} & bật che dữ liệu nhạy cảm.`,
    });
  } else {
    stepResults.push({
      stepId: 'knowledge_masking',
      status: 'skipped',
      detailEn: 'Skipped knowledge & masking step.',
      detailVi: 'Bỏ qua bước tri thức & che PII.',
    });
  }

  // Step 3: guardrails_quotas
  const guardrailsStep = stepMap.get('guardrails_quotas');
  if (selectedLookup.has('guardrails_quotas') && guardrailsStep) {
    assertTenantPermission(user, targetTenant.id, 'edit_tenant_guardrails');
    const payload = guardrailsStep.payload as unknown as SupportSetupGuardrailsPayload;
    updateSupportGuardrailPolicy(String(targetTenant.id), {
      enabled: payload.enabled,
      blockPromptInjection: payload.blockPromptInjection,
      injectionDetectors: payload.injectionDetectors,
      blockedTopics: payload.blockedTopics,
      competitorKeywords: payload.competitorKeywords,
      maxInputLength: payload.maxInputLength,
      bypassRoles: payload.bypassRoles,
      roleQuotas: payload.roleQuotas,
    });
    stepResults.push({
      stepId: 'guardrails_quotas',
      status: 'applied',
      detailEn: 'Enabled prompt firewall, topic/competitor guards & role quotas.',
      detailVi: 'Đã bật tường lửa prompt, chặn chủ đề/đối thủ & hạn mức vai trò.',
    });
  } else {
    stepResults.push({
      stepId: 'guardrails_quotas',
      status: 'skipped',
      detailEn: 'Skipped guardrails & quotas step.',
      detailVi: 'Bỏ qua bước tường lửa & hạn mức.',
    });
  }

  // Step 4: output_controls
  const outputStep = stepMap.get('output_controls');
  if (selectedLookup.has('output_controls') && outputStep) {
    assertTenantPermission(user, targetTenant.id, 'edit_tenant_guardrails');
    const payload = outputStep.payload as unknown as SupportSetupOutputControlsPayload;
    const currentOut = getSupportOutputPolicy(targetTenant.id);
    saveSupportOutputPolicy({
      tenantId: targetTenant.id,
      expectedVersion: currentOut.version,
      policy: {
        mode: payload.mode,
        blockedTerms: payload.blockedTerms,
        maxOutputChars: payload.maxOutputChars,
        redactCredentials: payload.redactCredentials,
      },
    });
    stepResults.push({
      stepId: 'output_controls',
      status: 'applied',
      detailEn: `Enabled output policy (${payload.mode}) with credential redaction.`,
      detailVi: `Đã bật kiểm soát đầu ra (${payload.mode}) và che khóa bí mật.`,
    });
  } else {
    stepResults.push({
      stepId: 'output_controls',
      status: 'skipped',
      detailEn: 'Skipped output controls step.',
      detailVi: 'Bỏ qua bước kiểm soát đầu ra.',
    });
  }

  // Step 5: widget_appearance
  const widgetStep = stepMap.get('widget_appearance');
  if (selectedLookup.has('widget_appearance') && widgetStep) {
    assertTenantPermission(user, targetTenant.id, 'edit_tenant_widget');
    const payload = widgetStep.payload as unknown as SupportSetupWidgetPayload;
    const currentWidget = getSupportDeskWidgetConfig(targetTenant.id);
    updateSupportDeskWidgetConfig(
      targetTenant.id,
      {
        enabled: payload.enabled,
        appearance: payload.appearance,
        intake: payload.intake,
      },
      currentWidget.version,
    );
    stepResults.push({
      stepId: 'widget_appearance',
      status: 'applied',
      detailEn: `Enabled customer widget ("${payload.appearance.title}").`,
      detailVi: `Đã bật widget khách hàng ("${payload.appearance.title}").`,
    });
  } else {
    stepResults.push({
      stepId: 'widget_appearance',
      status: 'skipped',
      detailEn: 'Skipped widget appearance step.',
      detailVi: 'Bỏ qua bước giao diện Widget.',
    });
  }

  // Step 6: sla_routing
  const slaStep = stepMap.get('sla_routing');
  if (selectedLookup.has('sla_routing') && slaStep) {
    assertTenantPermission(user, targetTenant.id, 'edit_tenant_widget');
    const payload = slaStep.payload as unknown as SupportSetupSlaRoutingPayload;
    const currentSla = getSupportDeskSlaPolicy(targetTenant.id);
    updateSupportDeskSlaPolicy(
      targetTenant.id,
      {
        enabled: payload.enabled,
        targets: payload.targets,
        routingRules: payload.routingRules,
      },
      currentSla.version,
    );
    stepResults.push({
      stepId: 'sla_routing',
      status: 'applied',
      detailEn: `Enabled Service Desk SLA & ${payload.routingRules.length} department routing rules.`,
      detailVi: `Đã bật SLA Service Desk & ${payload.routingRules.length} quy tắc phân luồng bộ phận.`,
    });
  } else {
    stepResults.push({
      stepId: 'sla_routing',
      status: 'skipped',
      detailEn: 'Skipped SLA & routing step.',
      detailVi: 'Bỏ qua bước SLA & phân luồng.',
    });
  }

  // Step 7: runtime_policy (and CORS allowedOrigins — gated strictly by edit_tenant_integration)
  if (selectedLookup.has('runtime_policy') && runtimeStep) {
    assertTenantPermission(user, targetTenant.id, 'edit_tenant_integration');
    const payload = runtimeStep.payload as unknown as SupportSetupRuntimePayload;
    const legacyAiPayload = tenantAiStep?.payload as SupportSetupTenantAiPayload | undefined;
    const nextOrigins =
      Array.isArray(payload.allowedOrigins) && payload.allowedOrigins.length > 0
        ? payload.allowedOrigins
        : Array.isArray(legacyAiPayload?.allowedOrigins) && legacyAiPayload.allowedOrigins.length > 0
          ? legacyAiPayload.allowedOrigins
          : undefined;

    if (!actorIsOperator && Array.isArray(payload.allowedModels)) {
      const safeModels = buildAllowedTenantModelSet(targetTenant.defaultModel);
      for (const modelId of payload.allowedModels) {
        if (!safeModels.has(modelId)) {
          throw new SupportSetupCopilotError(
            403,
            'forbidden',
            `Model '${modelId}' is not permitted in runtime allowedModels for Tenant Portal accounts.`,
          );
        }
      }
    }

    if (nextOrigins) {
      targetTenant = updateSupportTenant(targetTenant.id, {
        allowedOrigins: nextOrigins,
      });
    }

    const runtimePatch: Partial<SupportRuntimePolicy> = {
      allowedModels: payload.allowedModels,
      ...(proposal.targetMode === 'create_tenant' && payload.toolPolicies !== undefined
        ? { toolPolicies: payload.toolPolicies }
        : {}),
      maxCompletionTokens: payload.maxCompletionTokens,
      maxModelCalls: payload.maxModelCalls,
      maxToolCalls: payload.maxToolCalls,
      maxContextChars: payload.maxContextChars,
      maxToolResultChars: payload.maxToolResultChars,
      maxHistoryMessages: payload.maxHistoryMessages,
    };
    updateSupportRuntimePolicy(targetTenant.id, runtimePatch);

    stepResults.push({
      stepId: 'runtime_policy',
      status: 'applied',
      detailEn: 'Updated runtime bounds & CORS allowed origins.',
      detailVi: 'Đã cập nhật giới hạn runtime & domain CORS cho phép.',
    });
  } else {
    stepResults.push({
      stepId: 'runtime_policy',
      status: 'skipped',
      detailEn: 'Skipped runtime policy step.',
      detailVi: 'Bỏ qua bước runtime & CORS.',
    });
  }

  const finalTenant = getSupportTenant(targetTenant.id);
  const appliedSteps = stepResults
    .filter((r) => r.status === 'applied')
    .map((r) => r.stepId);

  appendSupportAuditLog({
    tenantId: String(finalTenant.id),
    action: 'support.setup_copilot.apply',
    userId: String(user.userId),
    role: user.role,
    details: {
      proposalId,
      targetMode: proposal.targetMode,
      appliedSteps,
    },
  });

  const savedProposal = markSetupProposalApplied(
    proposal.id,
    user.userId,
    finalTenant.id,
    {
      ...proposal,
      tenantName: finalTenant.name,
      tenantSlug: finalTenant.slug,
    },
    { appliedSteps, stepResults },
  );

  const diagnostic = buildTenantSetupDiagnostic(finalTenant, canEditSet, serverOrigin, {
    canViewSteps: canViewSet,
    isPlatformOperator: scope.isPlatformOperator,
  });
  const canExposePublicKey = canViewSet.has('runtime_policy') || canViewSet.has('tenant_ai');

  return {
    ok: true,
    proposalId: savedProposal.id,
    proposal: savedProposal,
    tenant: {
      id: finalTenant.id,
      name: finalTenant.name,
      slug: finalTenant.slug,
      publicKey: canExposePublicKey ? finalTenant.publicKey : '',
    },
    stepResults,
    diagnostic,
  };
}
