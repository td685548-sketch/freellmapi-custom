/**
 * Shared contracts and DTOs for the AI Support Setup Copilot.
 * Keeps step identifiers, diagnostic structures, proposal payloads, and
 * consent-gated apply responses in a single source of truth across server & client.
 */

import type { SupportOutputMode, SupportOutputRule } from './support-output.js';
import type { SupportRuntimePolicy } from './support-runtime.js';
import type {
  SupportDeskDepartment,
  SupportDeskRoutingRule,
  SupportDeskSlaTarget,
  SupportDeskWidgetAppearance,
  SupportTicketPriority,
} from './support-service-desk.js';
import type { Permission } from './user-access.js';
import type { TenantRolePresetId } from './tenant-rbac.js';

/** A single staged permission change (Phase 3). One entry per target user. */
export type CopilotPermissionGrantScope = 'global' | 'tenant';
export type CopilotPermissionGrantAction = 'grant' | 'revoke';

export interface CopilotPermissionGrant {
  /** 'global' = gateway-wide permissions; 'tenant' = membership on one tenant. */
  scope: CopilotPermissionGrantScope;
  /** Tenant id for scope 'tenant'; null for global grants. */
  tenantId: number | null;
  tenantSlug?: string | null;
  tenantName?: string | null;
  targetUserId: number;
  targetEmail: string;
  action: CopilotPermissionGrantAction;
  /**
   * Global: the permissions being added (grant) or removed (revoke).
   * Tenant grant: the permissions being added (union) or the preset's
   * permissions when rolePreset is set (replace). Tenant revoke: the
   * permissions being removed; when the result is empty the member is
   * removed from the tenant entirely.
   */
  permissions: string[];
  /** Tenant preset being assigned (replace semantics); absent = additive permissions. */
  rolePreset?: TenantRolePresetId;
  /** Tenant revoke with no permissions listed = remove the member entirely. */
  removeMember?: boolean;
  /** Target's grants at stage time (re-read live again at apply time). */
  previousPermissions: string[];
  /** Target's expected grants after the change (recomputed live at apply time). */
  newPermissions: string[];
}

export const SYSTEM_SETTING_IDS = [
  'thruline_gateway_enabled',
  'thruline_token_savers',
  'thruline_route_health_ttl',
  'response_cache',
  'prompt_compression',
  'model_unification',
  'mcp_server',
  'auto_update_check',
  'ollama_emulation',
  'ai_platform_pillars',
] as const;

export type SupportSystemSettingId = (typeof SYSTEM_SETTING_IDS)[number];

export interface SupportSystemSettingAction {
  settingId: SupportSystemSettingId;
  requiredPermission: Permission;
  canApply: boolean;
  enabledByDefault: boolean;
  titleVi: string;
  titleEn: string;
  summaryVi: string;
  summaryEn: string;
  currentValueVi: string;
  currentValueEn: string;
  proposedValueVi: string;
  proposedValueEn: string;
  /**
   * Why the Copilot suggests this change, grounded in the live system state it
   * read (never free-form model text). Shown on the Consent Card and written to
   * the audit log when the change is applied.
   */
  reasonVi?: string;
  reasonEn?: string;
  /** Facts the reason rests on, e.g. "12 knowledge documents are keyword-searched only". */
  evidence?: string[];
  payload: Record<string, unknown>;
}

export interface SupportSystemSettingApplyResult {
  settingId: SupportSystemSettingId;
  status: 'applied' | 'skipped';
  detailVi: string;
  detailEn: string;
}

export const SUPPORT_SETUP_STEP_IDS = [
  'tenant_ai',
  'knowledge_masking',
  'guardrails_quotas',
  'output_controls',
  'widget_appearance',
  'sla_routing',
  'runtime_policy',
] as const;

export type SupportSetupStepId = (typeof SUPPORT_SETUP_STEP_IDS)[number];

export type SupportSetupLanguage = 'vi' | 'en' | 'bilingual';
export type SupportSetupTone = 'friendly' | 'professional' | 'empathetic' | 'technical';

export interface SupportSetupRequirements {
  brandName?: string;
  tenantSlug?: string;
  industry?: string;
  websiteOrigin?: string;
  language?: SupportSetupLanguage;
  tone?: SupportSetupTone;
  primaryColor?: string;
  faqSummaryOrPolicies?: string;
  blockedTopics?: string[];
  competitorKeywords?: string[];
  requireContactIntake?: boolean;
  defaultModel?: string;
}

export interface SupportSetupStepDiagnostic {
  stepId: SupportSetupStepId;
  status: 'complete' | 'partial' | 'missing' | 'restricted';
  canView?: boolean;
  canEdit: boolean;
  summaryEn: string;
  summaryVi: string;
  thrulinePath: string;
  tenantPortalTab: string;
}

export interface SupportSetupTenantSummary {
  id: number;
  name: string;
  slug: string;
  publicKey: string;
  enabled: boolean;
  defaultModel: string;
  allowGuest: boolean;
  allowedOrigins: string[];
}

export interface SupportSetupTenantDiagnostic {
  tenant: SupportSetupTenantSummary;
  completedSteps: number;
  totalSteps: number;
  steps: SupportSetupStepDiagnostic[];
  embedSnippet: string;
}

export interface SupportSetupTenantAiPayload {
  name: string;
  slug: string;
  defaultModel: string;
  systemPrompt: string;
  allowedOrigins?: string[];
  allowGuest: boolean;
  enabled: boolean;
}

export interface SupportSetupKnowledgeDocSeed {
  title: string;
  category: string;
  content: string;
  tags: string[];
  allowedRoles: string[];
}

export interface SupportSetupKnowledgeMaskingPayload {
  docs: SupportSetupKnowledgeDocSeed[];
  masking: {
    enabled: boolean;
    builtinDetectors: Array<'email' | 'phone' | 'credit_card' | 'api_key'>;
    unmaskedRoles: string[];
  };
}

export interface SupportSetupGuardrailsPayload {
  enabled: boolean;
  blockPromptInjection: boolean;
  injectionDetectors: Array<
    'ignore_instructions' | 'role_spoofing' | 'system_prompt_leak' | 'sql_injection_probe'
  >;
  blockedTopics: string[];
  competitorKeywords: string[];
  maxInputLength: number;
  bypassRoles: string[];
  roleQuotas: Record<
    string,
    { maxRequestsPerWindow: number; maxTokensPerWindow: number; windowSeconds: number }
  >;
}

export interface SupportSetupOutputControlsPayload {
  mode: SupportOutputMode;
  blockedTerms: SupportOutputRule[];
  maxOutputChars: number;
  redactCredentials: boolean;
}

export interface SupportSetupWidgetPayload {
  enabled: boolean;
  appearance: SupportDeskWidgetAppearance;
  intake: {
    required: boolean;
    fields: Array<{
      key: string;
      label: string;
      type: 'text' | 'email' | 'number' | 'select';
      required: boolean;
      options?: string[];
    }>;
  };
}

export interface SupportSetupSlaRoutingPayload {
  enabled: boolean;
  targets: Record<SupportTicketPriority, SupportDeskSlaTarget>;
  routingRules: SupportDeskRoutingRule[];
}

export interface SupportSetupRuntimePayload extends Partial<SupportRuntimePolicy> {
  allowedOrigins?: string[];
  allowedModels: string[];
  maxCompletionTokens: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxContextChars: number;
  maxToolResultChars: number;
  maxHistoryMessages: number;
}

export interface SupportSetupStepPayloadMap {
  tenant_ai: SupportSetupTenantAiPayload;
  knowledge_masking: SupportSetupKnowledgeMaskingPayload;
  guardrails_quotas: SupportSetupGuardrailsPayload;
  output_controls: SupportSetupOutputControlsPayload;
  widget_appearance: SupportSetupWidgetPayload;
  sla_routing: SupportSetupSlaRoutingPayload;
  runtime_policy: SupportSetupRuntimePayload;
}

export interface SupportSetupPlannedStep<K extends SupportSetupStepId = SupportSetupStepId> {
  stepId: K;
  canApply: boolean;
  enabledByDefault: boolean;
  titleEn: string;
  titleVi: string;
  summaryEn: string;
  summaryVi: string;
  highlightsEn: string[];
  highlightsVi: string[];
  payload: Record<string, unknown>;
}

export interface SupportSetupProposal {
  id: string;
  userId: number;
  targetMode: 'create_tenant' | 'update_tenant' | 'system_settings' | 'permission_grant';
  tenantId: number | null;
  tenantName: string;
  tenantSlug: string;
  status: 'pending_consent' | 'applied' | 'declined' | 'expired';
  summary: string;
  requirements: SupportSetupRequirements;
  steps: SupportSetupPlannedStep[];
  isSurgical?: boolean;
  targetedSteps?: SupportSetupStepId[];
  systemActions?: SupportSystemSettingAction[];
  /** Phase 3: staged permission grants — applied only via the Consent Card. */
  permissionGrants?: CopilotPermissionGrant[];
  createdAt: string;
  expiresAt: string;
  appliedAt?: string | null;
}

export interface SupportSetupStatusTenantItem {
  id: number;
  name: string;
  slug: string;
  publicKey: string;
  enabled: boolean;
  defaultModel: string;
  canViewSteps?: SupportSetupStepId[];
  canEditSteps: SupportSetupStepId[];
}

export const COPILOT_ACTION_TYPES = [
  'create_personal_key',
  'switch_key_routing_mode',
  'open_onboarding_guide',
] as const;

export type CopilotActionType = (typeof COPILOT_ACTION_TYPES)[number];
export type CopilotActionRoutingMode = 'eco' | 'balanced' | 'max';
export type CopilotEffectiveRoutingMode = 'default' | 'eco' | 'balanced' | 'max';

export type CopilotErrorCategory =
  | 'rate_limit_429'
  | 'bad_request_400'
  | 'quota_guardrail_403'
  | 'upstream_5xx_timeout'
  | 'other_error';

export type CopilotOnboardingStepId =
  | 'mint_personal_key'
  | 'test_in_playground'
  | 'connect_ide';

export interface CopilotOnboardingStep {
  stepNumber: 1 | 2 | 3;
  id: CopilotOnboardingStepId;
  completed: boolean;
  titleEn: string;
  titleVi: string;
  descriptionEn: string;
  descriptionVi: string;
  ctaLabelEn: string;
  ctaLabelVi: string;
  targetPath: string;
}

export interface CopilotOnboardingChecklist {
  completedCount: number;
  totalCount: 3;
  steps: CopilotOnboardingStep[];
}

export interface CopilotPersonalKeySummary {
  id: number;
  name: string;
  keyPrefix: string;
  rpmLimit: number;
  routingMode: CopilotEffectiveRoutingMode;
  assistantId: number | null;
  assistantName: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CopilotQuotaWindowMetric {
  used: number;
  limit: number | null;
  pct: number | null;
}

export interface CopilotQuotaUsageSummary {
  tracked: boolean;
  rpmLimit: number;
  dailyRequests: CopilotQuotaWindowMetric;
  dailyTokens: CopilotQuotaWindowMetric;
  monthlyRequests: CopilotQuotaWindowMetric;
  monthlyTokens: CopilotQuotaWindowMetric;
  highestUsagePct: number | null;
  isNearExhaustion: boolean;
  isExhausted: boolean;
  resetsAt: { day: string; month: string };
}

export interface CopilotDiagnosticIssue {
  category: CopilotErrorCategory | 'quota_pressure' | 'high_latency';
  severity: 'critical' | 'warning' | 'info';
  count: number;
  latestAt: string | null;
  sampleError: string | null;
  titleEn: string;
  titleVi: string;
  rootCauseEn: string;
  rootCauseVi: string;
  remediationEn: string;
  remediationVi: string;
}

export interface CopilotCreateKeyActionParams {
  name: string;
  routingMode?: CopilotActionRoutingMode;
  assistantId?: number | null;
  assistantName?: string | null;
}

export interface CopilotSwitchRoutingModeActionParams {
  keyId: number;
  keyName: string;
  keyPrefix: string;
  fromRoutingMode: CopilotEffectiveRoutingMode;
  routingMode: CopilotActionRoutingMode;
}

export interface CopilotOpenOnboardingActionParams {
  focusStep?: CopilotOnboardingStepId;
}

export type CopilotActionParams =
  | CopilotCreateKeyActionParams
  | CopilotSwitchRoutingModeActionParams
  | CopilotOpenOnboardingActionParams;

export interface CopilotActionProposal {
  id: string;
  actionType: CopilotActionType;
  requiresConfirmation: true;
  titleEn: string;
  titleVi: string;
  summaryEn: string;
  summaryVi: string;
  confirmLabelEn: string;
  confirmLabelVi: string;
  params: CopilotActionParams;
  onboardingPreview?: CopilotOnboardingChecklist;
}

export interface CopilotUserDiagnosticReport {
  generatedAt: string;
  windowHours: number;
  overallHealth: 'healthy' | 'degraded' | 'critical';
  headlineEn: string;
  headlineVi: string;
  recentRequests: {
    total: number;
    succeeded: number;
    failed: number;
    errorRatePct: number;
    avgLatencyMs: number;
    highLatencyCount: number;
  };
  errorBreakdown: Record<CopilotErrorCategory, number>;
  issues: CopilotDiagnosticIssue[];
  activeKeys: CopilotPersonalKeySummary[];
  quota: CopilotQuotaUsageSummary;
  onboarding: CopilotOnboardingChecklist;
  recommendedAction: CopilotActionProposal | null;
}

export interface CopilotDiagnosticsResponse {
  ok: true;
  diagnostic: CopilotUserDiagnosticReport;
}

export interface CopilotIdeConfigSnippets {
  gatewayBaseUrl: string;
  openAiBaseUrl: string;
  cursor: string;
  claudeCode: string;
  openCode: string;
}

export interface CopilotExecuteActionRequest {
  actionType: CopilotActionType;
  confirmed: boolean;
  params?: {
    name?: string;
    routingMode?: CopilotActionRoutingMode;
    assistantId?: number | null;
    keyId?: number;
    focusStep?: CopilotOnboardingStepId;
  };
}

export interface CopilotExecuteActionResponse {
  ok: true;
  actionType: CopilotActionType;
  messageEn: string;
  messageVi: string;
  createdKey?: {
    id: number;
    name: string;
    rawKey: string;
    keyPrefix: string;
    routingMode: CopilotEffectiveRoutingMode;
    assistantId: number | null;
    assistantName: string | null;
    createdAt: string;
    snippets: CopilotIdeConfigSnippets;
  };
  updatedKey?: {
    id: number;
    name: string;
    keyPrefix: string;
    previousRoutingMode: CopilotEffectiveRoutingMode;
    routingMode: CopilotActionRoutingMode;
    assistantId: number | null;
    assistantName: string | null;
  };
  onboarding?: CopilotOnboardingChecklist;
}

export interface CopilotWhoAmITenant {
  id: number;
  name: string;
  slug: string;
  rolePreset: string;
  permissions: string[];
  canViewSteps: SupportSetupStepId[];
  canEditSteps: SupportSetupStepId[];
}

/**
 * GET /api/support-setup-copilot/whoami — the caller's OWN identity only.
 * Built strictly from the caller's session + custom_tenant_memberships rows;
 * a caller never sees tenants they have no access to.
 */
export interface CopilotWhoAmIResponse {
  ok: true;
  email: string;
  accountRole: 'admin' | 'member';
  isPrimary: boolean;
  isPlatformOperator: boolean;
  canCreateTenant: boolean;
  globalPermissions: string[];
  tenants: CopilotWhoAmITenant[];
}

export interface SupportSetupStatusResponse {
  ok: true;
  visible: boolean;
  memberCopilotVisible?: boolean;
  canCreateTenant: boolean;
  /** Full-power (wildcard) admins only: the platform-wide "System" Target is offered. */
  canUseSystemTarget?: boolean;
  availableModels: Array<{ id: string; label: string }>;
  tenants: SupportSetupStatusTenantItem[];
  activeTenant: SupportSetupTenantDiagnostic | null;
  pendingProposals: SupportSetupProposal[];
  onboarding?: CopilotOnboardingChecklist;
}

export interface SupportSetupChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SupportSetupChatRequest {
  tenantId?: number | null;
  /** 'system' = platform-wide Target (system settings, permissions); full-power admins only. */
  targetMode?: 'create_tenant' | 'update_tenant' | 'system';
  locale?: 'vi' | 'en';
  currentPath?: string;
  messages: SupportSetupChatMessage[];
  requirementsHint?: Partial<SupportSetupRequirements>;
  baseProposalId?: string;
}

export type SupportSetupChatIntent =
  | 'guide'
  | 'gather_requirements'
  | 'propose_setup'
  | 'diagnose_errors'
  | 'propose_action';

export interface SupportSetupChatResponse {
  ok: true;
  reply: string;
  replyLocale?: 'vi' | 'en';
  intent: SupportSetupChatIntent;
  missingQuestions: string[];
  suggestedQuickReplies: string[];
  proposal: SupportSetupProposal | null;
  userDiagnostic?: CopilotUserDiagnosticReport | null;
  actionProposal?: CopilotActionProposal | null;
  modelUsed: string | null;
  usedFallback: boolean;
  /**
   * What this reply actually cost: real upstream model requests and tool calls made while answering.
   * Only present when the reply was streamed (see `SupportSetupTraceStep`); 0 model calls = answered by rules.
   */
  usage?: SupportSetupUsage;
}

export interface SupportSetupUsage {
  modelCalls: number;
  toolCalls: number;
}

/**
 * One visible step of how the Copilot is working on a message (shown live while it runs, kept
 * collapsed afterwards). Streamed as Server-Sent Events from POST /chat when the client sends
 * `Accept: text/event-stream`: `event: step` (this shape; same `id` = update that step) and a
 * final `event: final` carrying `{ status, body }` (the usual JSON response or error body).
 */
export interface SupportSetupTraceStep {
  id: string;
  kind: 'analyze' | 'knowledge' | 'measure' | 'model' | 'tool' | 'decide';
  status: 'running' | 'done' | 'error';
  titleVi: string;
  titleEn: string;
  detailVi?: string;
  detailEn?: string;
}

export interface SupportSetupApplyRequest {
  approved: boolean;
  selectedSteps?: SupportSetupStepId[];
  selectedSystemActions?: SupportSystemSettingId[];
}

export interface SupportSetupStepApplyResult {
  stepId: SupportSetupStepId;
  status: 'applied' | 'skipped';
  detailEn: string;
  detailVi: string;
}

export interface SupportSetupApplyResponse {
  ok: true;
  proposalId: string;
  proposal: SupportSetupProposal;
  tenant: { id: number; name: string; slug: string; publicKey: string } | null;
  stepResults: SupportSetupStepApplyResult[];
  systemResults?: SupportSystemSettingApplyResult[];
  diagnostic: SupportSetupTenantDiagnostic | null;
}

export const SUPPORT_SETUP_DEPARTMENTS_SUPPORTED: readonly SupportDeskDepartment[] = [
  'billing',
  'technical',
  'returns',
  'general',
] as const;

export const SUPPORT_SETUP_PROPOSAL_TTL_SECONDS = 1800;
