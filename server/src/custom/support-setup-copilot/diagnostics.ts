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

export interface ScopedTenantEntry {
  tenant: SupportTenant;
  canEditSteps: Set<SupportSetupStepId>;
}

export interface CopilotUserScope {
  hasAccess: boolean;
  canCreateTenant: boolean;
  isPlatformOperator: boolean;
  tenants: ScopedTenantEntry[];
}

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
        return {
          tenant,
          canEditSteps: perms ? mapTenantPermissionsToEditSteps(perms) : new Set<SupportSetupStepId>(),
        };
      }),
    };
  }

  if (accessible.length > 0) {
    const byId = new Map(listSupportTenants().map((t) => [t.id, t]));
    const tenants: ScopedTenantEntry[] = [];
    for (const item of accessible) {
      const tenant = byId.get(item.id);
      if (!tenant) continue;
      tenants.push({
        tenant,
        canEditSteps: mapTenantPermissionsToEditSteps(item.permissions),
      });
    }
    return {
      hasAccess: tenants.length > 0,
      canCreateTenant: false,
      isPlatformOperator: false,
      tenants,
    };
  }

  return {
    hasAccess: false,
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

export function buildTenantSetupDiagnostic(
  tenant: SupportTenant,
  canEditSteps: ReadonlySet<SupportSetupStepId>,
  serverOrigin: string,
): SupportSetupTenantDiagnostic {
  const tid = String(tenant.id);
  const steps: SupportSetupStepDiagnostic[] = [];

  // 1. Tenant & AI Persona
  const promptLen = tenant.systemPrompt.trim().length;
  steps.push({
    stepId: 'tenant_ai',
    status: !tenant.enabled ? 'missing' : promptLen >= 30 ? 'complete' : 'partial',
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

  // 2. Knowledge Base & PII Masking
  const docs = listSupportKnowledgeDocs(tid).filter(
    (d) => d.enabled && (d.allowedRoles.includes('customer') || d.allowedRoles.includes('guest')),
  );
  let publishedEvidenceCount = 0;
  try {
    publishedEvidenceCount = listSupportEvidenceSources(tenant.id).filter(
      (s) => s.status === 'active' && Boolean(s.publishedRevisionId),
    ).length;
  } catch {
    publishedEvidenceCount = 0;
  }
  const masking = getSupportMaskingPolicy(tid);
  const hasKnowledge = docs.length > 0 || publishedEvidenceCount > 0;
  steps.push({
    stepId: 'knowledge_masking',
    status: hasKnowledge && masking.enabled ? 'complete' : hasKnowledge || masking.enabled ? 'partial' : 'missing',
    canEdit: canEditSteps.has('knowledge_masking'),
    summaryEn: hasKnowledge
      ? `${docs.length} customer/guest KB doc(s), ${publishedEvidenceCount} published evidence source(s); PII masking ${masking.enabled ? 'ON' : 'OFF'}.`
      : `No customer/guest knowledge docs yet; PII masking ${masking.enabled ? 'ON' : 'OFF'}.`,
    summaryVi: hasKnowledge
      ? `Có ${docs.length} tài liệu KB cho khách/khách vãng lai, ${publishedEvidenceCount} nguồn Evidence đã xuất bản; che dữ liệu nhạy cảm ${masking.enabled ? 'BẬT' : 'TẮT'}.`
      : `Chưa có tài liệu tri thức cho khách; che dữ liệu nhạy cảm ${masking.enabled ? 'BẬT' : 'TẮT'}.`,
    thrulinePath: '/thruline/support-knowledge',
    tenantPortalTab: 'tenant_knowledge',
  });

  // 3. Guardrails & Quotas
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

  // 4. Output Controls
  const outPolicy = getSupportOutputPolicy(tenant.id);
  steps.push({
    stepId: 'output_controls',
    status:
      outPolicy.mode === 'enforce' && outPolicy.redactCredentials
        ? 'complete'
        : outPolicy.mode === 'off' && !outPolicy.redactCredentials
          ? 'missing'
          : 'partial',
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

  // 5. Widget Appearance & Intake
  const widget = getSupportDeskWidgetConfig(tenant.id);
  const widgetComplete =
    widget.enabled &&
    widget.appearance.welcomeMessage.trim().length > 0 &&
    widget.appearance.quickPrompts.length > 0;
  steps.push({
    stepId: 'widget_appearance',
    status: !widget.enabled ? 'missing' : widgetComplete ? 'complete' : 'partial',
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

  // 6. Service Desk SLA & Routing
  const sla = getSupportDeskSlaPolicy(tenant.id);
  steps.push({
    stepId: 'sla_routing',
    status: !sla.enabled ? 'missing' : sla.routingRules.length > 0 ? 'complete' : 'partial',
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

  // 7. Integration, Origins & Runtime Policy
  const origins = tenant.allowedOrigins ?? [];
  const runtimePolicy = getSupportRuntimePolicy(tenant.id);
  const originsRestricted = origins.length > 0 && !origins.includes('*');
  steps.push({
    stepId: 'runtime_policy',
    status: originsRestricted ? 'complete' : 'partial',
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

  const completedSteps = steps.filter((s) => s.status === 'complete').length;

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      publicKey: tenant.publicKey,
      enabled: tenant.enabled,
      defaultModel: tenant.defaultModel,
      allowGuest: tenant.allowGuest,
      allowedOrigins: [...origins],
    },
    completedSteps,
    totalSteps: SUPPORT_SETUP_STEP_IDS.length,
    steps,
    embedSnippet: buildSupportEmbedSnippet(tenant, serverOrigin),
  };
}
