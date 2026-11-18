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
  targetMode: 'create_tenant' | 'update_tenant';
  tenantId: number | null;
  tenantName: string;
  tenantSlug: string;
  status: 'pending_consent' | 'applied' | 'declined' | 'expired';
  summary: string;
  requirements: SupportSetupRequirements;
  steps: SupportSetupPlannedStep[];
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

export interface SupportSetupStatusResponse {
  ok: true;
  visible: boolean;
  canCreateTenant: boolean;
  availableModels: Array<{ id: string; label: string }>;
  tenants: SupportSetupStatusTenantItem[];
  activeTenant: SupportSetupTenantDiagnostic | null;
  pendingProposals: SupportSetupProposal[];
}

export interface SupportSetupChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SupportSetupChatRequest {
  tenantId?: number | null;
  targetMode?: 'create_tenant' | 'update_tenant';
  locale?: 'vi' | 'en';
  messages: SupportSetupChatMessage[];
  requirementsHint?: Partial<SupportSetupRequirements>;
  baseProposalId?: string;
}

export type SupportSetupChatIntent = 'guide' | 'gather_requirements' | 'propose_setup';

export interface SupportSetupChatResponse {
  ok: true;
  reply: string;
  replyLocale?: 'vi' | 'en';
  intent: SupportSetupChatIntent;
  missingQuestions: string[];
  suggestedQuickReplies: string[];
  proposal: SupportSetupProposal | null;
  modelUsed: string | null;
  usedFallback: boolean;
}

export interface SupportSetupApplyRequest {
  approved: boolean;
  selectedSteps?: SupportSetupStepId[];
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
  tenant: { id: number; name: string; slug: string; publicKey: string };
  stepResults: SupportSetupStepApplyResult[];
  diagnostic: SupportSetupTenantDiagnostic;
}

export const SUPPORT_SETUP_DEPARTMENTS_SUPPORTED: readonly SupportDeskDepartment[] = [
  'billing',
  'technical',
  'returns',
  'general',
] as const;

export const SUPPORT_SETUP_PROPOSAL_TTL_SECONDS = 1800;
