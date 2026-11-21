/**
 * Permission-aware tool registry for the Setup Copilot agent harness (Phase 2).
 *
 * Registers the tool sets — the 7 tenant setup steps (executor.ts), the 9
 * system settings (system-settings.ts), the 3 personal actions
 * (user-actions.ts), and (Phase 3) the 4 permission grant/revoke tools
 * (permission-grants.ts) — WITHOUT rewriting their handlers.
 *
 * Two separate layers, deliberately kept apart:
 *  1. Prompt assembly (`filterAdmittedTools`): only tools the caller is
 *     permitted for get their schemas into the LLM prompt, so the model is
 *     never even offered a tool it cannot use.
 *  2. Pre-execute gate (`executeCopilotTool`, the SINGLE choke point): the
 *     live permission is re-resolved from the DB on every call and a denied
 *     tool is never executed — the registry filter is only a UX hint, the
 *     gate is the enforcement.
 *
 * PROPOSAL-ONLY: no registry tool applies anything. Tenant-step and
 * system-setting tools stage a proposal (via the existing proposal builders
 * `buildSystemSettingAction` / the personal-action proposal builders); the
 * tenant-step apply handler (`applySupportSetupProposal` in executor.ts),
 * `applySystemSettingsActions`, and `executeCopilotUserAction` are
 * intentionally NEVER called from here — they run only after the user clicks
 * Approve on the existing Consent Card. A tool whose `sideEffect` is
 * 'mutation' therefore has no direct executor in the loop; it is registered
 * so the gate can name it and refuse it outside the consent flow.
 */
import { z } from 'zod';
import {
  SUPPORT_SETUP_STEP_IDS,
  SYSTEM_SETTING_IDS,
  type CopilotActionProposal,
  type SupportSetupStepId,
  type SupportSystemSettingAction,
  type SupportSystemSettingId,
} from '@freellmapi/shared/support-setup-copilot.js';
import type { Permission } from '@freellmapi/shared/user-access.js';
import { SYSTEM_PERMISSIONS } from '@freellmapi/shared/permissions.js';
import {
  TENANT_PERMISSIONS,
  TENANT_ROLE_PRESETS,
  tenantPermissionGranted,
  type TenantPermission,
  type TenantRolePresetId,
} from '@freellmapi/shared/tenant-rbac.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import type { SessionUser } from '../../services/auth.js';
import { listUserApiKeys } from '../../services/user-keys.js';
import { normalizeRoutingMode } from '../customer-ai/store.js';
import {
  isPlatformTenantOperator,
  resolveEffectiveTenantAccess,
} from '../tenant-portal/store.js';
import { listSupportTenants } from '../x-gateway/support-store.js';
import { getSupportTenant } from '../x-gateway/support-store.js';
import { getKbCorpus, searchKb } from './kb/index.js';
import { readSystemSettingsSnapshot } from './kb/settings-state.js';
import { buildTenantSetupDiagnostic, mapTenantPermissionsToViewSteps, resolveCopilotUserScope } from './diagnostics.js';
import { buildTenantDoctorReport } from './tenant-doctor.js';
import { appendSupportAuditLog } from '../x-gateway/support-enterprise-router.js';
import type { CopilotAgentContext } from './identity.js';
import {
  authorizePermissionGrant,
  resolveLiveSessionUser,
  type ParsedPermissionGrantIntent,
} from './permission-grants.js';
import { SURGICAL_STEP_REQUIRED_PERMISSION } from './surgical-steps.js';
import {
  buildSystemSettingAction,
  hasAnySystemSettingPermission,
  isSupportSystemSettingId,
  REQUIRED_PERMISSION_BY_SETTING,
} from './system-settings.js';
import {
  buildCreatePersonalKeyProposal,
  buildOpenOnboardingGuideProposal,
  buildSwitchKeyRoutingModeProposal,
} from './user-actions.js';
import { attachAdviceToActions, buildSystemAdvice } from './system-advisor.js';
import { normalizePillarPatch } from './system-pillars.js';

export type CopilotToolKind =
  | 'tenant_step'
  | 'system_setting'
  | 'personal_action'
  | 'permission_grant'
  /** Read-only lookups (knowledge base, live settings, tenant diagnosis). Never mutate, never stage a proposal. */
  | 'knowledge';
export type CopilotToolSideEffect = 'none' | 'proposal' | 'mutation';

/**
 * A registered tool. `requiredPermission` is the exact leaf permission the
 * gate checks: a tenant permission for tenant steps, a global permission
 * for system settings, and `null` for personal actions (own-account only —
 * the gate only verifies the account still exists).
 */
export interface CopilotToolDefinition {
  id: string;
  kind: CopilotToolKind;
  labelEn: string;
  labelVi: string;
  description: string;
  requiredPermission: TenantPermission | Permission | null;
  inputSchema: z.ZodType<Record<string, unknown>>;
  sideEffect: CopilotToolSideEffect;
  /** Tenant step this tool stages, when kind === 'tenant_step'. */
  stepId?: SupportSetupStepId;
  /** System setting this tool proposes, when kind === 'system_setting'. */
  settingId?: SupportSystemSettingId;
}

export type CopilotToolResultStatus = 'executed' | 'denied' | 'rejected';

export interface CopilotToolResult {
  toolId: string;
  status: CopilotToolResultStatus;
  /** Machine-readable reason for denied/rejected outcomes. */
  reason?: string;
  requiredPermission?: string | null;
  /** Proposal payload produced by the existing proposal builder (executed only). */
  result?: unknown;
  /** Human-readable detail (locale of the caller is applied by the loop). */
  detailEn?: string;
  detailVi?: string;
}

const STEP_TOOL_DESCRIPTIONS: Readonly<Record<SupportSetupStepId, { en: string; vi: string }>> = {
  tenant_ai: {
    en: 'Stage the Tenant & AI Persona step for the Consent Card proposal.',
    vi: 'Chuẩn bị bước Tenant & Nhân cách AI cho thẻ đề xuất chờ duyệt.',
  },
  knowledge_masking: {
    en: 'Stage the Knowledge Base & PII Masking step for the Consent Card proposal.',
    vi: 'Chuẩn bị bước Kho tri thức & Che PII cho thẻ đề xuất chờ duyệt.',
  },
  guardrails_quotas: {
    en: 'Stage the Prompt Firewall & Role Quotas step for the Consent Card proposal.',
    vi: 'Chuẩn bị bước Tường lửa Prompt & Hạn mức cho thẻ đề xuất chờ duyệt.',
  },
  output_controls: {
    en: 'Stage the Output Safety Controls step for the Consent Card proposal.',
    vi: 'Chuẩn bị bước Kiểm soát an toàn đầu ra cho thẻ đề xuất chờ duyệt.',
  },
  widget_appearance: {
    en: 'Stage the Customer Chat Widget & Branding step for the Consent Card proposal.',
    vi: 'Chuẩn bị bước Giao diện Widget cho thẻ đề xuất chờ duyệt.',
  },
  sla_routing: {
    en: 'Stage the Service Desk SLA & Department Routing step for the Consent Card proposal.',
    vi: 'Chuẩn bị bước SLA & Phân luồng cho thẻ đề xuất chờ duyệt.',
  },
  runtime_policy: {
    en: 'Stage the CORS Origins & Runtime Limits step for the Consent Card proposal.',
    vi: 'Chuẩn bị bước CORS & Giới hạn Runtime cho thẻ đề xuất chờ duyệt.',
  },
};

const STEP_TOOL_LABELS: Readonly<Record<SupportSetupStepId, { en: string; vi: string }>> = {
  tenant_ai: { en: 'Tenant & AI Persona step', vi: 'Bước Tenant & Nhân cách AI' },
  knowledge_masking: { en: 'Knowledge & Masking step', vi: 'Bước Kho tri thức & Che PII' },
  guardrails_quotas: { en: 'Guardrails & Quotas step', vi: 'Bước Tường lửa & Hạn mức' },
  output_controls: { en: 'Output Controls step', vi: 'Bước Kiểm soát đầu ra' },
  widget_appearance: { en: 'Widget Appearance step', vi: 'Bước Giao diện Widget' },
  sla_routing: { en: 'SLA & Routing step', vi: 'Bước SLA & Phân luồng' },
  runtime_policy: { en: 'Runtime Policy step', vi: 'Bước Runtime & CORS' },
};

const SETTING_INPUT_SCHEMAS: Readonly<Record<SupportSystemSettingId, z.ZodType<Record<string, unknown>>>> = {
  thruline_gateway_enabled: z.object({ enabled: z.boolean() }),
  thruline_token_savers: z.object({
    caveman: z.boolean().optional(),
    ponytail: z.enum(['off', 'lite', 'full', 'ultra']).optional(),
    input: z.enum(['off', 'lossless', 'standard']).optional(),
  }),
  thruline_route_health_ttl: z.object({ minutes: z.number().int() }),
  response_cache: z.object({ enabled: z.boolean() }),
  prompt_compression: z.object({
    enabled: z.boolean().optional(),
    mode: z.enum(['off', 'lossless', 'standard', 'aggressive']).optional(),
  }),
  model_unification: z.object({ enabled: z.boolean() }),
  mcp_server: z.object({ enabled: z.boolean() }),
  auto_update_check: z.object({ enabled: z.boolean() }),
  ollama_emulation: z.object({ mode: z.enum(['off', 'open-loopback', 'key-required']) }),
  ai_platform_pillars: z.object({
    retrieval: z.boolean().optional(),
    prompts: z.boolean().optional(),
    promptCache: z.boolean().optional(),
    mcpClient: z.boolean().optional(),
    outputGuard: z.boolean().optional(),
    orchestrator: z.boolean().optional(),
  }),
};

const SETTING_TOOL_DESCRIPTIONS: Readonly<Record<SupportSystemSettingId, { en: string; vi: string }>> = {
  thruline_gateway_enabled: {
    en: 'Propose enabling/disabling the Thruline gateway (Consent Card only).',
    vi: 'Đề xuất bật/tắt cổng Thruline (chỉ qua thẻ chờ duyệt).',
  },
  thruline_token_savers: {
    en: 'Propose Thruline default token savers (Consent Card only).',
    vi: 'Đề xuất cấu hình tiết kiệm token Thruline (chỉ qua thẻ chờ duyệt).',
  },
  thruline_route_health_ttl: {
    en: 'Propose the Thruline route-health TTL in minutes (Consent Card only).',
    vi: 'Đề xuất thời gian lưu route health Thruline (chỉ qua thẻ chờ duyệt).',
  },
  response_cache: {
    en: 'Propose enabling/disabling the response cache (Consent Card only).',
    vi: 'Đề xuất bật/tắt Response Cache (chỉ qua thẻ chờ duyệt).',
  },
  prompt_compression: {
    en: 'Propose prompt/context compression mode (Consent Card only).',
    vi: 'Đề xuất chế độ nén prompt (chỉ qua thẻ chờ duyệt).',
  },
  model_unification: {
    en: 'Propose enabling/disabling cross-provider model unification (Consent Card only).',
    vi: 'Đề xuất bật/tắt hợp nhất model (chỉ qua thẻ chờ duyệt).',
  },
  mcp_server: {
    en: 'Propose enabling/disabling the gateway MCP server (Consent Card only).',
    vi: 'Đề xuất bật/tắt máy chủ MCP (chỉ qua thẻ chờ duyệt).',
  },
  auto_update_check: {
    en: 'Propose enabling/disabling automatic update checks (Consent Card only).',
    vi: 'Đề xuất bật/tắt kiểm tra cập nhật tự động (chỉ qua thẻ chờ duyệt).',
  },
  ollama_emulation: {
    en: 'Propose the Ollama emulation mode (Consent Card only).',
    vi: 'Đề xuất chế độ giả lập Ollama (chỉ qua thẻ chờ duyệt).',
  },
  ai_platform_pillars: {
    en: 'Propose turning AI Platform pillars on/off — retrieval (document vectorization), prompts, promptCache, mcpClient, outputGuard, orchestrator; send only the pillars to change (Consent Card only).',
    vi: 'Đề xuất bật/tắt trụ cột AI Platform — retrieval (vector hóa tài liệu), prompts, promptCache, mcpClient, outputGuard, orchestrator; chỉ gửi trụ cột cần đổi (chỉ qua thẻ chờ duyệt).',
  },
};

function buildRegistry(): readonly CopilotToolDefinition[] {
  const tools: CopilotToolDefinition[] = [];

  for (const stepId of SUPPORT_SETUP_STEP_IDS) {
    tools.push({
      id: `step.${stepId}`,
      kind: 'tenant_step',
      labelEn: STEP_TOOL_LABELS[stepId].en,
      labelVi: STEP_TOOL_LABELS[stepId].vi,
      description: STEP_TOOL_DESCRIPTIONS[stepId].en,
      requiredPermission: SURGICAL_STEP_REQUIRED_PERMISSION[stepId],
      inputSchema: z.object({ note: z.string().max(500).optional() }),
      sideEffect: 'proposal',
      stepId,
    });
  }

  for (const settingId of SYSTEM_SETTING_IDS) {
    tools.push({
      id: `setting.${settingId}`,
      kind: 'system_setting',
      labelEn: `System setting ${settingId}`,
      labelVi: `Cài đặt hệ thống ${settingId}`,
      description: SETTING_TOOL_DESCRIPTIONS[settingId].en,
      requiredPermission: REQUIRED_PERMISSION_BY_SETTING[settingId],
      inputSchema: SETTING_INPUT_SCHEMAS[settingId],
      sideEffect: 'proposal',
      settingId,
    });
  }

  tools.push(
    {
      id: 'kb.search',
      kind: 'knowledge',
      labelEn: 'Search platform knowledge', labelVi: 'Tra cứu tri thức nền tảng',
      description:
        'READ-ONLY. Search the product knowledge base (pages, settings, permissions, the 7 tenant steps, troubleshooting, docs). Use it BEFORE answering any "where is / how do I / what does X do / why" question you are unsure about. Returns the best-matching entries with the page path to open.',
      requiredPermission: null,
      inputSchema: z.object({ query: z.string().min(2).max(300), limit: z.number().int().min(1).max(6).optional() }),
      sideEffect: 'none',
    },
    {
      id: 'settings.read',
      kind: 'knowledge',
      labelEn: 'Read current system settings', labelVi: 'Đọc cài đặt hệ thống hiện tại',
      description:
        'READ-ONLY. Return the CURRENT value of every system setting this user is permitted to manage (cache, compression, token savers, TTL, MCP, Ollama, unification, update checks, Thruline gateway). Use it to answer "is X on?" or before proposing a change.',
      requiredPermission: null,
      inputSchema: z.object({}),
      sideEffect: 'none',
    },
    {
      id: 'system.advise',
      kind: 'knowledge',
      labelEn: 'Advise on system settings', labelVi: 'Gợi ý chỉnh cài đặt hệ thống',
      description:
        'READ-ONLY. Measure the live system (AI Platform switches, knowledge documents, embedding keys, last-24h 429 rate and prompt sizes) and return recommendations — each with the reason and evidence — limited to settings this user may change. Use it when the user asks "what should I turn on/off?", "is X worth enabling?" or "why do you suggest that?". A recommendation marked recommend can then be staged with the matching setting.* tool.',
      requiredPermission: null,
      inputSchema: z.object({}),
      sideEffect: 'none',
    },
    {
      id: 'tenant.diagnose',
      kind: 'knowledge',
      labelEn: 'Diagnose the selected tenant', labelVi: 'Chẩn đoán tenant đang chọn',
      description:
        'READ-ONLY. Diagnose why the SELECTED tenant fails: recent failed turns, firewall blocks, output-control events, provider-route availability and policy, each with the specific cause and fix. Use it for "why does this tenant error / not answer" instead of guessing.',
      requiredPermission: null,
      inputSchema: z.object({ windowHours: z.number().int().min(1).max(168).optional() }),
      sideEffect: 'none',
    },
  );

  tools.push(
    {
      id: 'action.create_personal_key',
      kind: 'personal_action',
      labelEn: 'Create Personal API Key (proposal)',
      labelVi: 'Tạo Personal API Key (đề xuất)',
      description:
        'Stage a Personal API Key proposal for the caller’s own account (Confirm & Run card only — never mints a key directly).',
      requiredPermission: null,
      inputSchema: z.object({
        name: z.string().min(1).max(80).optional(),
        routingMode: z.enum(['eco', 'balanced', 'max']).optional(),
        assistantId: z.number().int().positive().nullable().optional(),
      }),
      sideEffect: 'proposal',
    },
    {
      id: 'action.switch_key_routing_mode',
      kind: 'personal_action',
      labelEn: 'Switch Personal Key routing mode (proposal)',
      labelVi: 'Chuyển chế độ routing của Personal Key (đề xuất)',
      description:
        'Stage a routing-mode switch proposal for one of the caller’s own active Personal API Keys (Confirm & Run card only).',
      requiredPermission: null,
      inputSchema: z.object({
        keyId: z.number().int().positive(),
        routingMode: z.enum(['eco', 'balanced', 'max']),
      }),
      sideEffect: 'proposal',
    },
    {
      id: 'action.open_onboarding_guide',
      kind: 'personal_action',
      labelEn: 'Open member onboarding guide',
      labelVi: 'Mở hướng dẫn bắt đầu cho thành viên',
      description:
        'Show the caller’s live 3-step member onboarding checklist (read-only preview, no mutation).',
      requiredPermission: null,
      inputSchema: z.object({
        focusStep: z.enum(['mint_personal_key', 'test_in_playground', 'connect_ide']).optional(),
      }),
      sideEffect: 'none',
    },
  );

  // Phase 3: permission grant/revoke for OTHER users. Each tool only stages
  // a grant descriptor (authorizePermissionGrant, live DB re-read); the
  // Consent Card + apply branch do the actual write.
  const globalPermissionSchema = z.object({
    targetEmail: z.string().email().max(254),
    permissions: z.array(z.string().min(1).max(64)).min(1).max(100),
  });
  const tenantPermissionSchema = z.object({
    targetEmail: z.string().email().max(254),
    tenantId: z.number().int().positive().optional(),
    tenantSlug: z.string().min(1).max(64).optional(),
    permissions: z.array(z.string().min(1).max(64)).max(100).optional(),
    rolePreset: z.enum(['tenant_owner', 'ai_configurator', 'support_operator', 'viewer']).optional(),
  });
  tools.push(
    {
      id: 'permission.grant_global',
      kind: 'permission_grant',
      labelEn: 'Grant global permissions (proposal)',
      labelVi: 'Cấp quyền toàn cục (đề xuất)',
      description:
        'Stage a proposal to ADD global permissions to another user (Consent Card only — never applies directly). Requires edit_user_permissions; can only grant permissions the caller holds.',
      requiredPermission: 'edit_user_permissions',
      inputSchema: globalPermissionSchema,
      sideEffect: 'proposal',
    },
    {
      id: 'permission.revoke_global',
      kind: 'permission_grant',
      labelEn: 'Revoke global permissions (proposal)',
      labelVi: 'Thu hồi quyền toàn cục (đề xuất)',
      description:
        'Stage a proposal to REMOVE global permissions from another user (Consent Card only — never applies directly). Requires edit_user_permissions; cannot remove the last delegated full admin.',
      requiredPermission: 'edit_user_permissions',
      inputSchema: globalPermissionSchema,
      sideEffect: 'proposal',
    },
    {
      id: 'permission.grant_tenant',
      kind: 'permission_grant',
      labelEn: 'Grant tenant permissions (proposal)',
      labelVi: 'Cấp quyền tenant (đề xuất)',
      description:
        'Stage a proposal to ADD tenant permissions (or assign a role preset, which replaces) to another user on a tenant (Consent Card only). Requires manage_tenant_members on that tenant; can only grant permissions the caller holds there.',
      requiredPermission: 'manage_tenant_members',
      inputSchema: tenantPermissionSchema.refine(
        (v) => (v.permissions?.length ?? 0) > 0 || v.rolePreset !== undefined,
        { message: 'Provide permissions or a rolePreset.' },
      ),
      sideEffect: 'proposal',
    },
    {
      id: 'permission.revoke_tenant',
      kind: 'permission_grant',
      labelEn: 'Revoke tenant permissions (proposal)',
      labelVi: 'Thu hồi quyền tenant (đề xuất)',
      description:
        'Stage a proposal to REMOVE tenant permissions from another user (Consent Card only). Omit permissions to remove the member from the tenant entirely. Requires manage_tenant_members on that tenant; cannot remove the last member manager.',
      requiredPermission: 'manage_tenant_members',
      inputSchema: tenantPermissionSchema,
      sideEffect: 'proposal',
    },
  );

  return tools;
}

/** The full registry: 7 tenant steps + 9 system settings + 3 personal actions + 4 permission tools. */
export const COPILOT_TOOL_REGISTRY: readonly CopilotToolDefinition[] = buildRegistry();

export function findCopilotTool(toolId: string): CopilotToolDefinition | undefined {
  return COPILOT_TOOL_REGISTRY.find((t) => t.id === toolId);
}

export function isKnownCopilotToolId(toolId: string): boolean {
  return findCopilotTool(toolId) !== undefined;
}

/**
 * Prompt-assembly filter: only tools the caller is admitted for are offered
 * to the LLM. Tenant steps require the step in the target tenant's
 * canEditSteps (or `canCreateTenant` when no tenant exists yet, i.e. the
 * create_tenant flow); system settings require the live global permission
 * on the session user; personal actions are always admitted (own account).
 * This is a UX filter only — `executeCopilotTool` re-checks live.
 */
export function filterAdmittedTools(params: {
  agentContext: CopilotAgentContext | null;
  user: SessionUser | undefined;
  tenantId?: number | null;
}): CopilotToolDefinition[] {
  const { agentContext, user, tenantId } = params;
  if (!agentContext || !user) return [];
  const tenantEntry =
    tenantId != null
      ? agentContext.tenants.find((t) => t.id === tenantId)
      : undefined;
  const canEditSteps: ReadonlySet<SupportSetupStepId> =
    tenantEntry !== undefined
      ? new Set<SupportSetupStepId>(tenantEntry.canEditSteps)
      : tenantId == null && agentContext.canCreateTenant
        ? new Set<SupportSetupStepId>(SUPPORT_SETUP_STEP_IDS)
        : new Set<SupportSetupStepId>();

  return COPILOT_TOOL_REGISTRY.filter((tool) => {
    if (tool.kind === 'personal_action') return true;
    if (tool.kind === 'knowledge') {
      if (tool.id === 'kb.search') return true;
      if (tool.id === 'settings.read' || tool.id === 'system.advise') return hasAnySystemSettingPermission(user);
      return tenantEntry !== undefined && tenantEntry.canViewSteps.length > 0; // tenant.diagnose
    }
    if (tool.kind === 'tenant_step') {
      return tool.stepId !== undefined && canEditSteps.has(tool.stepId);
    }
    if (tool.kind === 'system_setting') {
      return (
        tool.requiredPermission !== null &&
        hasPermission(user, tool.requiredPermission as Permission)
      );
    }
    if (tool.kind === 'permission_grant') {
      // Global tools: the exact leaf global permission (session snapshot —
      // the gate re-checks live). Tenant tools: manage_tenant_members on the
      // scoped tenant, or on any tenant the caller manages (the LLM must
      // then name the tenant via tenantSlug); operators always qualify.
      if (tool.id === 'permission.grant_global' || tool.id === 'permission.revoke_global') {
        return hasPermission(user, 'edit_user_permissions');
      }
      if (isPlatformTenantOperator(user)) return true;
      if (
        tenantEntry !== undefined &&
        tenantPermissionGranted(tenantEntry.permissions, 'manage_tenant_members')
      ) {
        return true;
      }
      return agentContext.tenants.some((t) =>
        tenantPermissionGranted(t.permissions, 'manage_tenant_members'),
      );
    }
    return false;
  });
}

/**
 * Minimal JSON-schema view of the admitted tools for the LLM system prompt.
 * Uses zod v4 `z.toJSONSchema`; falls back to an empty schema object if a
 * schema cannot be rendered, so prompt assembly never throws.
 */
export function toolSchemasForPrompt(
  tools: readonly CopilotToolDefinition[],
): Array<{ id: string; description: string; inputSchema: Record<string, unknown> }> {
  return tools.map((tool) => {
    let inputSchema: Record<string, unknown> = {};
    try {
      const rendered = z.toJSONSchema(tool.inputSchema) as unknown;
      if (rendered && typeof rendered === 'object') {
        inputSchema = rendered as Record<string, unknown>;
      }
    } catch {
      inputSchema = {};
    }
    return { id: tool.id, description: tool.description, inputSchema };
  });
}

/** Prompt section listing ONLY the admitted tools (never the full registry). */
export function buildAdmittedToolsPromptSection(
  tools: readonly CopilotToolDefinition[],
): string {
  if (tools.length === 0) {
    return [
      'AVAILABLE COPILOT TOOLS: none — this caller has no tool admitted in the current scope.',
      'Do not emit any toolCalls. Answer with a terminal intent (guide / gather_requirements / propose_setup) only.',
    ].join('\n');
  }
  const lines = toolSchemasForPrompt(tools).map(
    (t) => `- ${t.id}: ${t.description} Input JSON schema: ${JSON.stringify(t.inputSchema)}`,
  );
  return [
    'AVAILABLE COPILOT TOOLS (permission-filtered — these are the ONLY tools you may call):',
    ...lines,
    'TOOL-CALL RULES: to use a tool, return a `toolCalls` array alongside your JSON reply, e.g. {"toolCalls": [{"id": "<tool id>", "input": {...}}]}. Only use the ids listed above — any other id is rejected immediately and counts against your budget. Tool calls NEVER apply anything: they only stage a proposal for the user to review on the Consent Card, and nothing changes until the user clicks Approve. If no tool is needed, omit `toolCalls` and answer with a terminal intent.',
  ].join('\n');
}

/** Denial raised by a tool handler after the gate passed (target checks). */
export class CopilotToolDenialError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CopilotToolDenialError';
  }
}

/**
 * Final pre-dispatch guards (DeepSeek Harness `ToolGuard` pattern): they run
 * AFTER the permission gate and can only DENY — a guard never grants anything
 * the gate refused. Each returns a denial reason or null.
 */
type CopilotToolGuard = (ctx: { tool: CopilotToolDefinition; input: Record<string, unknown> }) => string | null;

/** Secrets, credentials, backups and invites are never changed through chat — even if a future tool tried. */
const SECRET_SURFACE_RE = /(?:api_?key|secret|password|credential|backup|restore|invite)/i;

export const COPILOT_TOOL_GUARDS: readonly CopilotToolGuard[] = [
  ({ tool }) =>
    tool.kind === 'system_setting' && SECRET_SURFACE_RE.test(`${tool.id} ${tool.settingId ?? ''}`)
      ? 'secret_surface_not_allowed_via_chat'
      : null,
  ({ tool, input }) =>
    tool.settingId === 'ai_platform_pillars' && Object.keys(normalizePillarPatch(input)).length === 0
      ? 'empty_pillar_patch'
      : null,
];

function runToolGuards(ctx: { tool: CopilotToolDefinition; input: Record<string, unknown> }): string | null {
  for (const guard of COPILOT_TOOL_GUARDS) {
    const denial = guard(ctx);
    if (denial) return denial;
  }
  return null;
}

/** Live gate check for one tool. Returns the denial reason, or null when permitted. */
function livePermissionDenial(params: {
  tool: CopilotToolDefinition;
  user: SessionUser;
  tenantId?: number | null;
  input?: Record<string, unknown>;
}): string | null {
  const { tool, user, tenantId, input } = params;
  if (tool.kind === 'personal_action') {
    // Own-account only: the account must still exist in the DB.
    return resolveLiveSessionUser(user.userId) ? null : 'account_not_found';
  }
  if (tool.kind === 'knowledge') {
    const liveUser = resolveLiveSessionUser(user.userId);
    if (!liveUser) return 'account_not_found';
    if (tool.id === 'settings.read' || tool.id === 'system.advise') {
      return hasAnySystemSettingPermission(liveUser) ? null : 'missing_system_setting_permission';
    }
    if (tool.id === 'tenant.diagnose') {
      if (tenantId == null) return 'tenant_required';
      try {
        const access = resolveEffectiveTenantAccess(user, tenantId);
        return mapTenantPermissionsToViewSteps(access.permissions).size > 0 ? null : 'missing_tenant_view_permission';
      } catch {
        return 'missing_tenant_view_permission';
      }
    }
    return null; // kb.search: any signed-in account; chunks are permission-filtered at search time
  }
  if (tool.kind === 'permission_grant') {
    if (tool.id === 'permission.grant_global' || tool.id === 'permission.revoke_global') {
      // Global grants: exact leaf global permission, live from the DB row.
      const liveUser = resolveLiveSessionUser(user.userId);
      if (!liveUser) return 'account_not_found';
      return hasPermission(liveUser, 'edit_user_permissions')
        ? null
        : 'missing_permission:edit_user_permissions';
    }
    // Tenant grants: manage_tenant_members on the tenant named by the tool
    // input (id, then slug), else the loop's scoped tenant.
    let resolvedTenantId: number | null = null;
    const inputTenantId = input?.tenantId;
    if (typeof inputTenantId === 'number' && Number.isInteger(inputTenantId) && inputTenantId > 0) {
      resolvedTenantId = inputTenantId;
    } else if (typeof input?.tenantSlug === 'string' && input.tenantSlug.trim()) {
      const found = listSupportTenants().find(
        (t) => t.slug.toLowerCase() === String(input.tenantSlug).trim().toLowerCase(),
      );
      if (!found) return 'tenant_not_found';
      resolvedTenantId = found.id;
    } else if (tenantId != null) {
      resolvedTenantId = tenantId;
    }
    if (resolvedTenantId == null) return 'tenant_required';
    try {
      const access = resolveEffectiveTenantAccess(user, resolvedTenantId);
      return tenantPermissionGranted(access.permissions, 'manage_tenant_members')
        ? null
        : 'missing_permission:manage_tenant_members';
    } catch {
      return 'missing_permission:manage_tenant_members';
    }
  }
  if (tool.kind === 'tenant_step') {
    const required = tool.requiredPermission as TenantPermission;
    if (tenantId == null) {
      // Create-tenant flow: no tenant exists yet; only platform operators
      // (canCreateTenant) may stage tenant steps.
      return isPlatformTenantOperator(user) ? null : 'missing_create_tenant_permission';
    }
    try {
      const access = resolveEffectiveTenantAccess(user, tenantId);
      return tenantPermissionGranted(access.permissions, required)
        ? null
        : `missing_tenant_permission:${required}`;
    } catch {
      return `missing_tenant_permission:${required}`;
    }
  }
  // system_setting: exact leaf global permission, live from the DB row.
  const liveUser = resolveLiveSessionUser(user.userId);
  if (!liveUser) return 'account_not_found';
  const required = tool.requiredPermission as Permission;
  return hasPermission(liveUser, required) ? null : `missing_permission:${required}`;
}

/**
 * Run the EXISTING proposal builder for a permitted tool. Never writes:
 * tenant steps return a staged-step descriptor (the real proposal is built
 * by playbook.ts after the loop and applied only via the Consent Card);
 * system settings use `buildSystemSettingAction`; personal actions use the
 * existing `build*Proposal` builders in user-actions.ts.
 */
function runToolHandler(params: {
  tool: CopilotToolDefinition;
  user: SessionUser;
  input: Record<string, unknown>;
  tenantId?: number | null;
}): unknown {
  const { tool, user, input, tenantId } = params;
  if (tool.kind === 'knowledge') return runKnowledgeTool({ tool, user, input, tenantId });
  if (tool.kind === 'tenant_step' && tool.stepId) {
    return {
      stepId: tool.stepId,
      status: 'proposed',
      tenantId: tenantId ?? null,
      note:
        'Step staged for the Consent Card proposal. Nothing has been applied — the user must review and click Approve.',
    };
  }
  if (tool.kind === 'system_setting' && tool.settingId) {
    const [action] = attachAdviceToActions(
      [buildSystemSettingAction(tool.settingId, input, true)],
      user,
    ) as [SupportSystemSettingAction];
    return { settingId: tool.settingId, action };
  }
  if (tool.id === 'action.create_personal_key') {
    const proposal: CopilotActionProposal = buildCreatePersonalKeyProposal({
      name: typeof input.name === 'string' ? input.name : undefined,
      routingMode:
        input.routingMode === 'eco' || input.routingMode === 'balanced' || input.routingMode === 'max'
          ? input.routingMode
          : undefined,
      assistantId:
        typeof input.assistantId === 'number' ? input.assistantId : null,
    });
    return { actionType: 'create_personal_key', proposal };
  }
  if (tool.id === 'action.switch_key_routing_mode') {
    const keyId = input.keyId as number;
    const activeKeys = listUserApiKeys(user.userId).filter((k) => !k.revoked);
    const chosen = activeKeys.find((k) => k.id === keyId);
    if (!chosen) {
      throw new Error(`Active personal API key ${keyId} not found for this account.`);
    }
    const proposal: CopilotActionProposal = buildSwitchKeyRoutingModeProposal({
      keyId: chosen.id,
      keyName: chosen.name,
      keyPrefix: chosen.keyPrefix,
      fromRoutingMode: normalizeRoutingMode(chosen.routingMode, 'default'),
      routingMode: input.routingMode as 'eco' | 'balanced' | 'max',
    });
    return { actionType: 'switch_key_routing_mode', proposal };
  }
  if (tool.id === 'action.open_onboarding_guide') {
    const proposal: CopilotActionProposal = buildOpenOnboardingGuideProposal({
      userId: user.userId,
      focusStep:
        input.focusStep === 'mint_personal_key' ||
        input.focusStep === 'test_in_playground' ||
        input.focusStep === 'connect_ide'
          ? input.focusStep
          : undefined,
    });
    return { actionType: 'open_onboarding_guide', proposal };
  }
  if (tool.kind === 'permission_grant') {
    // Phase 3: stage a grant descriptor only — the gate already verified
    // the caller's own permission; authorizePermissionGrant re-validates
    // the target, subset, self/primary and last-admin guards live. Never writes.
    const isTenant = tool.id === 'permission.grant_tenant' || tool.id === 'permission.revoke_tenant';
    const isGrant = tool.id === 'permission.grant_global' || tool.id === 'permission.grant_tenant';
    const permissions = Array.isArray(input.permissions)
      ? (input.permissions as unknown[]).filter((p): p is string => typeof p === 'string')
      : [];
    const knownIds = new Set<string>(
      isTenant ? [...TENANT_PERMISSIONS, '*'] : [...SYSTEM_PERMISSIONS, '*'],
    );
    for (const p of permissions) {
      if (!knownIds.has(p)) throw new Error(`Unknown permission '${p}'.`);
    }
    let rolePreset: TenantRolePresetId | undefined;
    if (isTenant && typeof input.rolePreset === 'string') {
      if (!(input.rolePreset in TENANT_ROLE_PRESETS)) {
        throw new Error(`Unknown tenant role preset '${input.rolePreset}'.`);
      }
      rolePreset = input.rolePreset as TenantRolePresetId;
    }
    const intent: ParsedPermissionGrantIntent = {
      action: isGrant ? 'grant' : 'revoke',
      scope: isTenant ? 'tenant' : 'global',
      targetEmail: String(input.targetEmail),
      permissions,
      rolePreset,
      tenantSlug: typeof input.tenantSlug === 'string' ? input.tenantSlug : null,
      tenantId: typeof input.tenantId === 'number' ? input.tenantId : null,
      removeMember: isTenant && !isGrant && permissions.length === 0 && rolePreset === undefined,
    };
    const auth = authorizePermissionGrant({ user, intent, tenantId: tenantId ?? null });
    if (!auth.ok) throw new CopilotToolDenialError(auth.code, auth.messageEn);
    return { grant: auth.grant };
  }
  throw new Error(`No handler registered for tool '${tool.id}'.`);
}

/**
 * THE single choke point for Copilot tool execution.
 *
 *  1. Unknown tool id → rejected immediately, handler never runs.
 *  2. Input fails the zod schema → rejected immediately.
 *  3. Live permission (re-resolved from the DB) missing → denied + audit
 *     log, handler never runs, NO execution.
 *  4. Permitted → run the existing (proposal-only) handler → audit log.
 *
 * Nothing in this function applies a tenant step, writes a system setting,
 * or mints/switches a key — those still require the user's Approve click.
 */
export async function executeCopilotTool(params: {
  user: SessionUser;
  toolId: string;
  input: unknown;
  tenantId?: number | null;
  /** Per-tool timeout in ms (default 10_000). Handlers are synchronous, but the race keeps the contract. */
  timeoutMs?: number;
}): Promise<CopilotToolResult> {
  const { user, toolId, input, tenantId, timeoutMs = 10_000 } = params;
  const auditTenantId = tenantId != null ? String(tenantId) : 'system';

  const tool = findCopilotTool(toolId);
  if (!tool) {
    appendSupportAuditLog({
      tenantId: auditTenantId,
      action: 'support.setup_copilot.tool_rejected',
      userId: String(user.userId),
      role: user.role,
      details: { toolId, reason: 'unknown_tool' },
    });
    return {
      toolId,
      status: 'rejected',
      reason: 'unknown_tool',
      detailEn: `Unknown tool '${toolId}'.`,
      detailVi: `Công cụ không xác định '${toolId}'.`,
    };
  }

  const parsed = tool.inputSchema.safeParse(
    input && typeof input === 'object' && !Array.isArray(input) ? input : {},
  );
  if (!parsed.success) {
    appendSupportAuditLog({
      tenantId: auditTenantId,
      action: 'support.setup_copilot.tool_rejected',
      userId: String(user.userId),
      role: user.role,
      details: { toolId, reason: 'invalid_input' },
    });
    return {
      toolId,
      status: 'rejected',
      reason: 'invalid_input',
      detailEn: `Invalid input for tool '${toolId}'.`,
      detailVi: `Dữ liệu đầu vào không hợp lệ cho công cụ '${toolId}'.`,
    };
  }

  const denial = livePermissionDenial({ tool, user, tenantId, input: parsed.data });
  if (denial) {
    appendSupportAuditLog({
      tenantId: auditTenantId,
      action: 'support.setup_copilot.tool_denied',
      userId: String(user.userId),
      role: user.role,
      details: {
        toolId,
        requiredPermission: tool.requiredPermission,
        reason: denial,
      },
    });
    return {
      toolId,
      status: 'denied',
      reason: denial,
      requiredPermission: tool.requiredPermission,
      detailEn: `Permission denied for tool '${toolId}' (requires '${String(tool.requiredPermission)}'). No change was made.`,
      detailVi: `Không đủ quyền dùng công cụ '${toolId}' (cần quyền '${String(tool.requiredPermission)}'). Không có thay đổi nào được thực hiện.`,
    };
  }

  const guardDenial = runToolGuards({ tool, input: parsed.data });
  if (guardDenial) {
    appendSupportAuditLog({
      tenantId: auditTenantId,
      action: 'support.setup_copilot.tool_denied',
      userId: String(user.userId),
      role: user.role,
      details: { toolId, reason: guardDenial, guard: true },
    });
    return {
      toolId,
      status: 'denied',
      reason: guardDenial,
      requiredPermission: tool.requiredPermission,
      detailEn: `Tool '${toolId}' was blocked by a safety guard (${guardDenial}). No change was made.`,
      detailVi: `Công cụ '${toolId}' bị chặn bởi chốt an toàn (${guardDenial}). Không có thay đổi nào được thực hiện.`,
    };
  }

  try {
    const result = await Promise.race([
      Promise.resolve().then(() =>
        runToolHandler({ tool, user, input: parsed.data, tenantId }),
      ),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`Tool '${toolId}' timed out.`)), timeoutMs);
      }),
    ]);
    const grantDetails =
      tool.kind === 'permission_grant' &&
      result !== null &&
      typeof result === 'object' &&
      'grant' in result &&
      (result as { grant: unknown }).grant !== null &&
      typeof (result as { grant: unknown }).grant === 'object'
        ? {
            targetEmail: ((result as { grant: { targetEmail?: unknown } }).grant.targetEmail as string | undefined) ?? undefined,
            scope: ((result as { grant: { scope?: unknown } }).grant.scope as string | undefined) ?? undefined,
            action: ((result as { grant: { action?: unknown } }).grant.action as string | undefined) ?? undefined,
          }
        : {};
    appendSupportAuditLog({
      tenantId: auditTenantId,
      action: 'support.setup_copilot.tool_executed',
      userId: String(user.userId),
      role: user.role,
      details: { toolId, requiredPermission: tool.requiredPermission, ...grantDetails },
    });
    return {
      toolId,
      status: 'executed',
      requiredPermission: tool.requiredPermission,
      result,
      detailEn:
        tool.sideEffect === 'none'
          ? `Tool '${toolId}' returned read-only data. Nothing was changed.`
          : `Tool '${toolId}' staged a proposal. Nothing has been applied yet.`,
      detailVi:
        tool.sideEffect === 'none'
          ? `Công cụ '${toolId}' trả về dữ liệu chỉ-đọc. Không có gì bị thay đổi.`
          : `Công cụ '${toolId}' đã chuẩn bị xong đề xuất. Chưa có thay đổi nào được áp dụng.`,
    };
  } catch (err) {
    // Target-level refusals (unknown target, self, primary, subset,
    // last-admin) are denials, not handler errors — same audit trail as
    // the pre-execute gate, handler never ran a write.
    if (err instanceof CopilotToolDenialError) {
      appendSupportAuditLog({
        tenantId: auditTenantId,
        action: 'support.setup_copilot.tool_denied',
        userId: String(user.userId),
        role: user.role,
        details: {
          toolId,
          requiredPermission: tool.requiredPermission,
          reason: err.code,
        },
      });
      return {
        toolId,
        status: 'denied',
        reason: err.code,
        requiredPermission: tool.requiredPermission,
        detailEn: err.message,
        detailVi: err.message,
      };
    }
    const message = err instanceof Error ? err.message : 'Tool execution failed.';
    appendSupportAuditLog({
      tenantId: auditTenantId,
      action: 'support.setup_copilot.tool_rejected',
      userId: String(user.userId),
      role: user.role,
      details: { toolId, reason: 'handler_error', message },
    });
    return { toolId, status: 'rejected', reason: 'handler_error', detailEn: message, detailVi: message };
  }
}

/** Re-exported for tests: a setting id is only a tool when it is a known id. */
export function isCopilotSettingTool(settingId: string): settingId is SupportSystemSettingId {
  return isSupportSystemSettingId(settingId);
}


/** Read-only handlers. They return plain data for the agent loop to feed back to the model. */
async function runKnowledgeTool(params: {
  tool: CopilotToolDefinition;
  user: SessionUser;
  input: Record<string, unknown>;
  tenantId?: number | null;
}): Promise<unknown> {
  const { tool, user, input, tenantId } = params;
  if (tool.id === 'kb.search') {
    const query = String(input.query ?? '');
    const limit = typeof input.limit === 'number' ? input.limit : 4;
    const hits = await searchKb(query, { caller: user, limit });
    return {
      corpusSize: getKbCorpus().length,
      results: hits.map((h) => ({
        id: h.chunk.id,
        title: h.chunk.title,
        path: h.chunk.path ?? null,
        doc: h.chunk.docFile ?? null,
        text: h.chunk.text.length > 900 ? `${h.chunk.text.slice(0, 899)}…` : h.chunk.text,
      })),
    };
  }
  if (tool.id === 'settings.read') {
    return readSystemSettingsSnapshot(user);
  }
  if (tool.id === 'system.advise') {
    return buildSystemAdvice(user);
  }
  // tenant.diagnose
  const tenant = tenantId != null ? getSupportTenant(tenantId) : null;
  if (!tenant) throw new Error('Tenant not found.');
  const scope = resolveCopilotUserScope(user);
  const entry = scope.tenants.find((t) => t.tenant.id === tenant.id);
  const diagnostic = entry
    ? buildTenantSetupDiagnostic(entry.tenant, entry.canEditSteps, '', {
        canViewSteps: entry.canViewSteps,
        isPlatformOperator: scope.isPlatformOperator,
      })
    : null;
  const windowHours = typeof input.windowHours === 'number' ? input.windowHours : 72;
  const report = buildTenantDoctorReport({ tenant, diagnostic, windowHours });
  return {
    tenant: { name: report.tenantName, slug: report.tenantSlug },
    evidence: report.evidence,
    findings: report.findings.slice(0, 5).map((f) => ({
      id: f.id, severity: f.severity, title: f.titleEn, cause: f.causeEn, evidence: f.evidenceEn, fix: f.fixEn, path: f.path,
    })),
  };
}
