import {
  SUPPORT_SETUP_STEP_IDS,
  type SupportSetupStepDiagnostic,
  type SupportSetupStepId,
  type SupportSetupTenantDiagnostic,
} from '@freellmapi/shared/support-setup-copilot.js';
import { tenantPermissionGranted, type TenantPermission } from '@freellmapi/shared/tenant-rbac.js';
import type { Request } from 'express';
import { hasPermission } from '../../middleware/requirePermission.js';
import type { SessionUser } from '../../services/auth.js';
import {
  isPlatformTenantOperator,
  listAccessibleTenantsForUser,
  listSafeTenantModelOptions,
} from '../tenant-portal/store.js';
import { getSupportGuardrailPolicy } from '../x-gateway/support-guardrails.js';
import { getSupportMaskingPolicy, listSupportKnowledgeDocs } from '../x-gateway/support-knowledge.js';
import { listSupportEvidenceSources } from '../x-gateway/support-evidence-store.js';
import { getSupportOutputPolicy } from '../x-gateway/support-output-store.js';
import { getSupportRuntimePolicy } from '../x-gateway/support-runtime-store.js';
import {
  getSupportDeskSlaPolicy,
  getSupportDeskWidgetConfig,
} from '../x-gateway/support-service-desk-store.js';
import { ensureSupportTables, listSupportTenants, type SupportTenant } from '../x-gateway/support-store.js';
import { hasAnySystemSettingPermission } from './system-settings.js';

export interface ScopedTenantEntry {
  tenant: SupportTenant;
  canViewSteps: Set<SupportSetupStepId>;
  canEditSteps: Set<SupportSetupStepId>;
}

export interface CopilotUserScope {
  hasAccess: boolean;
  canCreateTenant: boolean;
  isPlatformOperator: boolean;
  tenants: ScopedTenantEntry[];
}

/**
 * Steps readable via Thruline `use_x_gateway` alone (without `edit_x_settings`).
 * Matches `permissionForAction('manage_x_gateway', 'GET', ...)` in `permission-actions.ts`,
 * where `/api/thruline/support/tenants/:id/output-policy` requires `edit_x_settings`.
 */
const THRULINE_READ_ONLY_VIEW_STEPS: readonly SupportSetupStepId[] = [
  'tenant_ai',
  'knowledge_masking',
  'guardrails_quotas',
  'widget_appearance',
  'sla_routing',
  'runtime_policy',
];

export function mapTenantPermissionsToEditSteps(
  permissions: readonly TenantPermission[],
): Set<SupportSetupStepId> {
  const editable = new Set<SupportSetupStepId>();
  if (tenantPermissionGranted(permissions, 'edit_tenant_ai')) {
    editable.add('tenant_ai');
  }
  if (tenantPermissionGranted(permissions, 'edit_tenant_knowledge')) {
    editable.add('knowledge_masking');
  }
  if (tenantPermissionGranted(permissions, 'edit_tenant_guardrails')) {
    editable.add('guardrails_quotas');
    editable.add('output_controls');
  }
  if (tenantPermissionGranted(permissions, 'edit_tenant_widget')) {
    editable.add('widget_appearance');
    editable.add('sla_routing');
  }
  if (tenantPermissionGranted(permissions, 'edit_tenant_integration')) {
    editable.add('runtime_policy');
  }
  return editable;
}

export function mapTenantPermissionsToViewSteps(
  permissions: readonly TenantPermission[],
): Set<SupportSetupStepId> {
  const viewable = new Set<SupportSetupStepId>();
  if (
    tenantPermissionGranted(permissions, 'view_tenant_ai') ||
    tenantPermissionGranted(permissions, 'edit_tenant_ai')
  ) {
    viewable.add('tenant_ai');
  }
  if (
    tenantPermissionGranted(permissions, 'view_tenant_knowledge') ||
    tenantPermissionGranted(permissions, 'edit_tenant_knowledge')
  ) {
    viewable.add('knowledge_masking');
  }
  if (
    tenantPermissionGranted(permissions, 'view_tenant_guardrails') ||
    tenantPermissionGranted(permissions, 'edit_tenant_guardrails')
  ) {
    viewable.add('guardrails_quotas');
    viewable.add('output_controls');
  }
  if (
    tenantPermissionGranted(permissions, 'view_tenant_desk') ||
    tenantPermissionGranted(permissions, 'edit_tenant_widget')
  ) {
    viewable.add('widget_appearance');
    viewable.add('sla_routing');
  }
  if (
    tenantPermissionGranted(permissions, 'view_tenant_integration') ||
    tenantPermissionGranted(permissions, 'edit_tenant_integration')
  ) {
    viewable.add('runtime_policy');
  }
  return viewable;
}

export function resolveCopilotUserScope(user: SessionUser | undefined): CopilotUserScope {
  if (!user) {
    return {
      hasAccess: false,
      canCreateTenant: false,
      isPlatformOperator: false,
      tenants: [],
    };
  }

  ensureSupportTables();
  if (isPlatformTenantOperator(user)) {
    const allTenants = listSupportTenants();
    return {
      hasAccess: true,
      canCreateTenant: true,
      isPlatformOperator: true,
      tenants: allTenants.map((tenant) => ({
        tenant,
        canViewSteps: new Set<SupportSetupStepId>(SUPPORT_SETUP_STEP_IDS),
        canEditSteps: new Set<SupportSetupStepId>(SUPPORT_SETUP_STEP_IDS),
      })),
    };
  }

  const accessible = listAccessibleTenantsForUser(user);
  const memberPermsByTenant = new Map(accessible.map((t) => [t.id, t.permissions]));

  if (hasPermission(user, 'use_x_gateway')) {
    const allTenants = listSupportTenants();
    return {
      hasAccess: true,
      canCreateTenant: false,
      isPlatformOperator: false,
      tenants: allTenants.map((tenant) => {
        const perms = memberPermsByTenant.get(tenant.id);
        const memberView = perms ? mapTenantPermissionsToViewSteps(perms) : new Set<SupportSetupStepId>();
        const memberEdit = perms ? mapTenantPermissionsToEditSteps(perms) : new Set<SupportSetupStepId>();
        return {
          tenant,
          canViewSteps: new Set<SupportSetupStepId>([
            ...THRULINE_READ_ONLY_VIEW_STEPS,
            ...memberView,
          ]),
          canEditSteps: memberEdit,
        };
      }),
    };
  }

  const canEditSystemSettings = hasAnySystemSettingPermission(user);

  if (accessible.length > 0) {
    const byId = new Map(listSupportTenants().map((t) => [t.id, t]));
    const tenants: ScopedTenantEntry[] = [];
    for (const item of accessible) {
      const tenant = byId.get(item.id);
      if (!tenant) continue;
      const canViewSteps = mapTenantPermissionsToViewSteps(item.permissions);
      const canEditSteps = mapTenantPermissionsToEditSteps(item.permissions);
      // Users who hold neither setup view nor setup edit permissions (e.g. members-only or reply-only)
      // must not gain visibility into tenant setup diagnostics or Copilot endpoints.
      if (canViewSteps.size === 0 && canEditSteps.size === 0) continue;
      tenants.push({
        tenant,
        canViewSteps,
        canEditSteps,
      });
    }
    return {
      hasAccess: tenants.length > 0 || canEditSystemSettings,
      canCreateTenant: false,
      isPlatformOperator: false,
      tenants,
    };
  }

  return {
    hasAccess: canEditSystemSettings,
    canCreateTenant: false,
    isPlatformOperator: false,
    tenants: [],
  };
}

export function resolvePublicServerOrigin(req: Request): string {
  const configured = process.env.SUPPORT_PUBLIC_BASE_URL;
  const host = req.get('host') || '127.0.0.1:3001';
  const raw = configured && configured.trim() ? configured.trim() : `${req.protocol || 'http'}://${host}`;
  try {
    const url = new URL(raw);
    if (['http:', 'https:'].includes(url.protocol)) {
      return url.origin;
    }
  } catch {
    // Fall back safely when synthetic request headers omit host
  }
  return 'http://127.0.0.1:3001';
}

export function buildSupportEmbedSnippet(tenant: SupportTenant, serverOrigin: string): string {
  const cleanOrigin = serverOrigin.replace(/\/$/, '');
  const config = JSON.stringify({
    tenantKey: tenant.publicKey,
    serverBase: cleanOrigin,
    allowGuestSession: tenant.allowGuest,
  }).replace(/</g, '\\u003c');
  return `<script src="${cleanOrigin}/thruline/v1/support/widget.js"></script>\n<script>window.FreeLLMAPISupport.init(${config});</script>`;
}

export function listCopilotModelOptions(): Array<{ id: string; label: string }> {
  return listSafeTenantModelOptions().map((opt) => ({
    id: opt.id,
    label: opt.label,
  }));
}

export interface DiagnosticAccessOptions {
  canViewSteps?: ReadonlySet<SupportSetupStepId>;
  isPlatformOperator?: boolean;
}

function restrictedStepDiagnostic(
  stepId: SupportSetupStepId,
  thrulinePath: string,
  tenantPortalTab: string,
): SupportSetupStepDiagnostic {
  return {
    stepId,
    status: 'restricted',
    canView: false,
    canEdit: false,
    summaryEn: 'Restricted — your account does not have permission to view this section.',
    summaryVi: 'Giới hạn quyền — tài khoản của bạn chưa có quyền xem mục này.',
    thrulinePath,
    tenantPortalTab,
  };
}

export function buildTenantSetupDiagnostic(
  tenant: SupportTenant,
  canEditSteps: ReadonlySet<SupportSetupStepId>,
  serverOrigin: string,
  options?: DiagnosticAccessOptions,
): SupportSetupTenantDiagnostic {
  const canViewSteps =
    options?.canViewSteps ?? new Set<SupportSetupStepId>(SUPPORT_SETUP_STEP_IDS);
  const isPlatformOperator = Boolean(options?.isPlatformOperator);
  const tid = String(tenant.id);
  const steps: SupportSetupStepDiagnostic[] = [];

  // 1. Tenant & AI Persona
  if (!canViewSteps.has('tenant_ai')) {
    steps.push(restrictedStepDiagnostic('tenant_ai', '/thruline/support', 'tenant_ai_config'));
  } else {
    const promptLen = tenant.systemPrompt.trim().length;
    steps.push({
      stepId: 'tenant_ai',
      status: !tenant.enabled ? 'missing' : promptLen >= 30 ? 'complete' : 'partial',
      canView: true,
      canEdit: canEditSteps.has('tenant_ai'),
      summaryEn: !tenant.enabled
        ? 'Tenant is currently disabled.'
        : promptLen >= 30
          ? `Enabled with model "${tenant.defaultModel}" and customized system prompt (${promptLen} chars).`
          : `Enabled with model "${tenant.defaultModel}", but system prompt is empty or minimal.`,
      summaryVi: !tenant.enabled
        ? 'Tenant hiện đang tắt.'
        : promptLen >= 30
          ? `Đang bật với model "${tenant.defaultModel}" và System Prompt (${promptLen} ký tự).`
          : `Đang bật với model "${tenant.defaultModel}", nhưng System Prompt còn trống hoặc quá ngắn.`,
      thrulinePath: '/thruline/support',
      tenantPortalTab: 'tenant_ai_config',
    });
  }

  // 2. Knowledge Base & PII Masking
  if (!canViewSteps.has('knowledge_masking')) {
    steps.push(
      restrictedStepDiagnostic(
        'knowledge_masking',
        '/thruline/support-knowledge',
        'tenant_knowledge',
      ),
    );
  } else {
    const docs = listSupportKnowledgeDocs(tid).filter(
      (d) => d.enabled && (d.allowedRoles.includes('customer') || d.allowedRoles.includes('guest')),
    );
    // Evidence library (/knowledge-library) is restricted to Platform Operators (edit_x_settings).
    let publishedEvidenceCount = 0;
    if (isPlatformOperator) {
      try {
        publishedEvidenceCount = listSupportEvidenceSources(tenant.id).filter(
          (s) => s.status === 'active' && Boolean(s.publishedRevisionId),
        ).length;
      } catch {
        publishedEvidenceCount = 0;
      }
    }
    const masking = getSupportMaskingPolicy(tid);
    const hasKnowledge = docs.length > 0 || (isPlatformOperator && publishedEvidenceCount > 0);
    const evidenceSuffixEn = isPlatformOperator
      ? `, ${publishedEvidenceCount} published evidence source(s)`
      : '';
    const evidenceSuffixVi = isPlatformOperator
      ? `, ${publishedEvidenceCount} nguồn Evidence đã xuất bản`
      : '';
    steps.push({
      stepId: 'knowledge_masking',
      status:
        hasKnowledge && masking.enabled
          ? 'complete'
          : hasKnowledge || masking.enabled
            ? 'partial'
            : 'missing',
      canView: true,
      canEdit: canEditSteps.has('knowledge_masking'),
      summaryEn: hasKnowledge
        ? `${docs.length} customer/guest KB doc(s)${evidenceSuffixEn}; PII masking ${masking.enabled ? 'ON' : 'OFF'}.`
        : `No customer/guest knowledge docs yet; PII masking ${masking.enabled ? 'ON' : 'OFF'}.`,
      summaryVi: hasKnowledge
        ? `Có ${docs.length} tài liệu KB cho khách/khách vãng lai${evidenceSuffixVi}; che dữ liệu nhạy cảm ${masking.enabled ? 'BẬT' : 'TẮT'}.`
        : `Chưa có tài liệu tri thức cho khách; che dữ liệu nhạy cảm ${masking.enabled ? 'BẬT' : 'TẮT'}.`,
      thrulinePath: '/thruline/support-knowledge',
      tenantPortalTab: 'tenant_knowledge',
    });
  }

  // 3. Guardrails & Quotas
  if (!canViewSteps.has('guardrails_quotas')) {
    steps.push(
      restrictedStepDiagnostic(
        'guardrails_quotas',
        '/thruline/support-guardrails',
        'tenant_guardrails',
      ),
    );
  } else {
    const guardrails = getSupportGuardrailPolicy(tid);
    const hasCustomGuardrailConfig =
      guardrails.blockedTopics.length > 0 ||
      guardrails.competitorKeywords.length > 0 ||
      guardrails.updatedAt !== new Date(0).toISOString();
    steps.push({
      stepId: 'guardrails_quotas',
      status: !guardrails.enabled
        ? 'missing'
        : guardrails.blockPromptInjection && hasCustomGuardrailConfig
          ? 'complete'
          : 'partial',
      canView: true,
      canEdit: canEditSteps.has('guardrails_quotas'),
      summaryEn: !guardrails.enabled
        ? 'Prompt firewall & quotas are disabled.'
        : hasCustomGuardrailConfig
          ? `Firewall ON (${guardrails.blockedTopics.length} blocked topic(s), ${guardrails.competitorKeywords.length} competitor keyword(s)).`
          : 'Default prompt-injection shield is ON; blocked topics/competitors not customized yet.',
      summaryVi: !guardrails.enabled
        ? 'Tường lửa prompt và hạn mức đang tắt.'
        : hasCustomGuardrailConfig
          ? `Tường lửa BẬT (${guardrails.blockedTopics.length} chủ đề chặn, ${guardrails.competitorKeywords.length} từ khóa đối thủ).`
          : 'Chống prompt-injection mặc định đang BẬT; chưa tùy chỉnh chủ đề cấm/đối thủ.',
      thrulinePath: '/thruline/support-guardrails',
      tenantPortalTab: 'tenant_guardrails',
    });
  }

  // 4. Output Controls
  if (!canViewSteps.has('output_controls')) {
    steps.push(
      restrictedStepDiagnostic(
        'output_controls',
        '/thruline/support-output',
        'tenant_guardrails',
      ),
    );
  } else {
    const outPolicy = getSupportOutputPolicy(tenant.id);
    steps.push({
      stepId: 'output_controls',
      status:
        outPolicy.mode === 'enforce' && outPolicy.redactCredentials
          ? 'complete'
          : outPolicy.mode === 'off' && !outPolicy.redactCredentials
            ? 'missing'
            : 'partial',
      canView: true,
      canEdit: canEditSteps.has('output_controls'),
      summaryEn:
        outPolicy.mode === 'enforce' && outPolicy.redactCredentials
          ? `Enforcing output safety (${outPolicy.blockedTerms.length} blocked term(s), credential redaction ON).`
          : `Output control mode is "${outPolicy.mode}" (credential redaction ${outPolicy.redactCredentials ? 'ON' : 'OFF'}).`,
      summaryVi:
        outPolicy.mode === 'enforce' && outPolicy.redactCredentials
          ? `Đang thực thi kiểm soát đầu ra (${outPolicy.blockedTerms.length} từ cấm, che khóa bí mật BẬT).`
          : `Chế độ kiểm soát đầu ra là "${outPolicy.mode}" (che khóa bí mật ${outPolicy.redactCredentials ? 'BẬT' : 'TẮT'}).`,
      thrulinePath: '/thruline/support-output',
      tenantPortalTab: 'tenant_guardrails',
    });
  }

  // 5. Widget Appearance & Intake
  if (!canViewSteps.has('widget_appearance')) {
    steps.push(
      restrictedStepDiagnostic('widget_appearance', '/thruline/support-desk', 'tenant_desk'),
    );
  } else {
    const widget = getSupportDeskWidgetConfig(tenant.id);
    const widgetComplete =
      widget.enabled &&
      widget.appearance.welcomeMessage.trim().length > 0 &&
      widget.appearance.quickPrompts.length > 0;
    steps.push({
      stepId: 'widget_appearance',
      status: !widget.enabled ? 'missing' : widgetComplete ? 'complete' : 'partial',
      canView: true,
      canEdit: canEditSteps.has('widget_appearance'),
      summaryEn: !widget.enabled
        ? 'Embeddable customer widget is disabled.'
        : widgetComplete
          ? `Widget enabled ("${widget.appearance.title}", ${widget.appearance.quickPrompts.length} quick prompt(s)).`
          : 'Widget enabled, but welcome message or quick prompts are incomplete.',
      summaryVi: !widget.enabled
        ? 'Widget chat nhúng web hiện đang tắt.'
        : widgetComplete
          ? `Widget đang BẬT ("${widget.appearance.title}", ${widget.appearance.quickPrompts.length} câu gợi ý nhanh).`
          : 'Widget đang BẬT, nhưng thiếu lời chào mở đầu hoặc câu gợi ý nhanh.',
      thrulinePath: '/thruline/support-desk',
      tenantPortalTab: 'tenant_desk',
    });
  }

  // 6. Service Desk SLA & Routing
  if (!canViewSteps.has('sla_routing')) {
    steps.push(restrictedStepDiagnostic('sla_routing', '/thruline/support-desk', 'tenant_desk'));
  } else {
    const sla = getSupportDeskSlaPolicy(tenant.id);
    steps.push({
      stepId: 'sla_routing',
      status: !sla.enabled ? 'missing' : sla.routingRules.length > 0 ? 'complete' : 'partial',
      canView: true,
      canEdit: canEditSteps.has('sla_routing'),
      summaryEn: !sla.enabled
        ? 'SLA tracking & department auto-routing are disabled.'
        : sla.routingRules.length > 0
          ? `SLA active with ${sla.routingRules.length} keyword routing rule(s).`
          : 'SLA tracking active, but no keyword routing rules defined yet.',
      summaryVi: !sla.enabled
        ? 'Theo dõi SLA và phân luồng bộ phận đang tắt.'
        : sla.routingRules.length > 0
          ? `SLA đang BẬT với ${sla.routingRules.length} quy tắc phân luồng theo từ khóa.`
          : 'SLA đang BẬT, nhưng chưa có quy tắc phân luồng bộ phận.',
      thrulinePath: '/thruline/support-desk',
      tenantPortalTab: 'tenant_desk',
    });
  }

  // 7. Integration, Origins & Runtime Policy
  const origins = tenant.allowedOrigins ?? [];
  if (!canViewSteps.has('runtime_policy')) {
    steps.push(
      restrictedStepDiagnostic(
        'runtime_policy',
        '/thruline/support-integration',
        'tenant_integration',
      ),
    );
  } else {
    const runtimePolicy = getSupportRuntimePolicy(tenant.id);
    const originsRestricted = origins.length > 0 && !origins.includes('*');
    steps.push({
      stepId: 'runtime_policy',
      status: originsRestricted ? 'complete' : 'partial',
      canView: true,
      canEdit: canEditSteps.has('runtime_policy'),
      summaryEn: originsRestricted
        ? `Restricted to ${origins.length} origin(s); maxCompletionTokens=${runtimePolicy.maxCompletionTokens}.`
        : `Origins unrestricted (*); maxCompletionTokens=${runtimePolicy.maxCompletionTokens}.`,
      summaryVi: originsRestricted
        ? `Giới hạn ${origins.length} domain CORS hợp lệ; maxCompletionTokens=${runtimePolicy.maxCompletionTokens}.`
        : `CORS đang mở rộng (*); maxCompletionTokens=${runtimePolicy.maxCompletionTokens}.`,
      thrulinePath: '/thruline/support-integration',
      tenantPortalTab: 'tenant_integration',
    });
  }

  const completedSteps = steps.filter((s) => s.canView !== false && s.status === 'complete').length;
  const canViewIntegration = canViewSteps.has('runtime_policy');
  const canViewAi = canViewSteps.has('tenant_ai');

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      publicKey: canViewIntegration || canViewAi ? tenant.publicKey : '',
      enabled: tenant.enabled,
      defaultModel: canViewAi ? tenant.defaultModel : '',
      allowGuest: canViewAi ? tenant.allowGuest : false,
      allowedOrigins: canViewIntegration ? [...origins] : [],
    },
    completedSteps,
    totalSteps: SUPPORT_SETUP_STEP_IDS.length,
    steps,
    embedSnippet: canViewIntegration ? buildSupportEmbedSnippet(tenant, serverOrigin) : '',
  };
}
