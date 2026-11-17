import { apiFetch } from '@/lib/api';
import type { SupportOutputDecision, SupportOutputEvent, SupportOutputPolicy } from '../../../../shared/support-output';
import type { SupportRuntimePolicy } from '../../../../shared/support-runtime';
import type {
  SupportDeskSlaPolicy,
  SupportDeskWidgetConfig,
} from '../../../../shared/support-service-desk';
import type {
  TenantMemberRecord,
  TenantMembershipSummary,
  TenantModelOption,
  TenantPermission,
  TenantPortalSummary,
  TenantRolePresetId,
} from '../../../../shared/tenant-rbac';

export interface SupportRoleConfig {
  role: string;
  label: string;
  description?: string;
  permissions: string[];
}

export interface TenantDetail {
  id: number;
  name: string;
  slug: string;
  publicKey: string;
  signingSecretMasked: string;
  defaultModel: string;
  systemPrompt: string;
  allowedOrigins: string[];
  allowGuest: boolean;
  rolesConfig: SupportRoleConfig[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupportKnowledgeDoc {
  id: string;
  tenantId: string;
  title: string;
  category: string;
  content: string;
  tags: string[];
  allowedRoles: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SupportBuiltinMaskDetector = 'email' | 'phone' | 'credit_card' | 'api_key';

export interface SupportMaskingPolicy {
  tenantId: string;
  enabled: boolean;
  builtinDetectors: SupportBuiltinMaskDetector[];
  unmaskedRoles: string[];
  customRules: Array<{
    id: string;
    name: string;
    pattern: string;
    replacement: string;
    enabled: boolean;
  }>;
  updatedAt: string;
}

export interface SupportWebhookTool {
  id: number;
  tenantId: number;
  name: string;
  description: string;
  method: 'GET' | 'POST';
  endpointUrl: string;
  headers: Record<string, string>;
  parametersSchema: Record<string, unknown>;
  allowedRoles: string[];
  lockUserIdParam: string | null;
  bypassUserLockRoles: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupportTablePolicy {
  tableName: string;
  description?: string;
  allowedRoles: string[];
  allowedColumns?: string[];
  deniedColumns?: string[];
  rowOwnerColumn?: string | null;
  bypassRowLockRoles?: string[];
}

export interface SupportDbSource {
  id: number;
  tenantId: number;
  name: string;
  driver: 'sqlite-sandbox' | 'sql-http';
  connectionUrl: string;
  authTokenMasked: string;
  schemaSql: string;
  tablePolicies: SupportTablePolicy[];
  maxRows: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SupportInjectionDetector =
  | 'ignore_instructions'
  | 'role_spoofing'
  | 'system_prompt_leak'
  | 'sql_injection_probe';

export interface SupportRoleQuotaRule {
  maxRequestsPerWindow: number;
  maxTokensPerWindow: number;
  windowSeconds: number;
}

export interface SupportGuardrailPolicy {
  tenantId: string;
  enabled: boolean;
  blockPromptInjection: boolean;
  injectionDetectors: SupportInjectionDetector[];
  blockedTopics: string[];
  competitorKeywords: string[];
  maxInputLength: number;
  bypassRoles: string[];
  roleQuotas: Record<string, SupportRoleQuotaRule>;
  updatedAt: string;
}

export interface SupportConversation {
  id: string;
  tenantId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  userRole: string;
  subject: string;
  status: 'active' | 'escalated' | 'resolved' | 'closed';
  assignedAgent?: string;
  messages: Array<{
    id: string;
    senderType: 'customer' | 'ai_assistant' | 'human_agent' | 'system';
    senderId: string;
    senderName?: string;
    senderRole?: string;
    content: string;
    createdAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface SupportEscalationTicket {
  id: string;
  tenantId: string;
  conversationId?: string;
  userId: string;
  userName?: string;
  userRole: string;
  subject: string;
  reason: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  assignedTo?: string;
  resolutionNotes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SupportPendingAction {
  id: string;
  tenantId: string;
  conversationId?: string;
  userId: string;
  userName?: string;
  userRole: string;
  toolName: string;
  actionSummary: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'failed';
  reviewedBy?: string;
  reviewNote?: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface SupportWebhookSubscription {
  id: string;
  tenantId: string;
  name: string;
  targetUrl: string;
  events: string[];
  secretHeader: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupportWebhookDelivery {
  id: string;
  webhookName: string;
  event: string;
  targetUrl: string;
  status: 'delivered' | 'failed';
  statusCode?: number;
  durationMs: number;
  error?: string;
  createdAt: string;
}

export interface SupportAuditLogEntry {
  id: string;
  tenantId: string;
  timestamp: string;
  action: string;
  userId?: string;
  role?: string;
  details?: Record<string, unknown>;
}

export interface UserTenantMembershipResponse {
  user: { id: number; email: string; role: 'admin' | 'member'; isPrimary: boolean };
  tenants: Array<{ id: number; name: string; slug: string; enabled: boolean }>;
  memberships: TenantMembershipSummary[];
}

export const tenantAdminApi = {
  getUserMemberships: (userId: number) =>
    apiFetch<UserTenantMembershipResponse>(`/api/admin/tenant-memberships/users/${userId}`),

  upsertUserMembership: (
    tenantId: number,
    userId: number,
    body: { rolePreset?: TenantRolePresetId; permissions?: TenantPermission[] },
  ) =>
    apiFetch<{ ok: boolean; member: TenantMemberRecord }>(
      `/api/admin/tenant-memberships/tenants/${tenantId}/users/${userId}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  removeUserMembership: (tenantId: number, userId: number) =>
    apiFetch<{ ok: boolean }>(
      `/api/admin/tenant-memberships/tenants/${tenantId}/users/${userId}`,
      { method: 'DELETE' },
    ),
};

export const tenantPortalApi = {
  listTenants: () =>
    apiFetch<{ tenants: TenantPortalSummary[]; availableModels: TenantModelOption[] }>(
      '/api/tenant-portal/tenants',
    ),

  getTenantAi: (tenantId: number) =>
    apiFetch<{
      tenant: TenantDetail;
      rolePreset: TenantRolePresetId;
      permissions: TenantPermission[];
      isPlatformOperator: boolean;
      availableModels: TenantModelOption[];
    }>(`/api/tenant-portal/tenants/${tenantId}`),

  updateTenantAi: (
    tenantId: number,
    patch: Partial<
      Pick<TenantDetail, 'name' | 'defaultModel' | 'systemPrompt' | 'allowGuest' | 'enabled' | 'rolesConfig'>
    >,
  ) =>
    apiFetch<{ tenant: TenantDetail }>(`/api/tenant-portal/tenants/${tenantId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  simulateChat: (
    tenantId: number,
    body: {
      role: string;
      userId?: string;
      name?: string;
      model?: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    },
  ) =>
    apiFetch<{
      reply: string;
      modelUsed: string | null;
      allowedTools: Array<{ functionName: string }>;
      toolTrace: Array<{ kind: string; name: string; error?: string; durationMs?: number }>;
      usage: { total_tokens: number };
    }>(`/api/tenant-portal/tenants/${tenantId}/simulate-chat`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getKnowledge: (tenantId: number) =>
    apiFetch<{ ok: boolean; docs: SupportKnowledgeDoc[]; masking: SupportMaskingPolicy }>(
      `/api/tenant-portal/tenants/${tenantId}/knowledge`,
    ),

  upsertKnowledgeDoc: (
    tenantId: number,
    body: Partial<SupportKnowledgeDoc> & { title: string; content: string },
  ) =>
    apiFetch<{ ok: boolean; doc: SupportKnowledgeDoc }>(
      `/api/tenant-portal/tenants/${tenantId}/knowledge`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  seedKnowledgeDocs: (tenantId: number) =>
    apiFetch<{ ok: boolean; docs: SupportKnowledgeDoc[] }>(
      `/api/tenant-portal/tenants/${tenantId}/knowledge/seed`,
      { method: 'POST' },
    ),

  deleteKnowledgeDoc: (tenantId: number, docId: string) =>
    apiFetch<{ ok: boolean }>(
      `/api/tenant-portal/tenants/${tenantId}/knowledge/${encodeURIComponent(docId)}`,
      { method: 'DELETE' },
    ),

  searchKnowledge: (tenantId: number, body: { query: string; role: string; topK?: number }) =>
    apiFetch<{
      ok: boolean;
      matches: Array<{ docId: string; title: string; snippet: string; score: number; allowedRoles: string[] }>;
    }>(`/api/tenant-portal/tenants/${tenantId}/knowledge/search`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateMasking: (tenantId: number, body: Partial<SupportMaskingPolicy>) =>
    apiFetch<{ ok: boolean; policy: SupportMaskingPolicy }>(
      `/api/tenant-portal/tenants/${tenantId}/masking`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  getTools: (tenantId: number) =>
    apiFetch<{
      ok: boolean;
      tools: SupportWebhookTool[];
      dbSources: SupportDbSource[];
      sampleSchemaSql: string;
    }>(`/api/tenant-portal/tenants/${tenantId}/tools`),

  createTool: (tenantId: number, body: Record<string, unknown>) =>
    apiFetch<{ ok: boolean; tool: SupportWebhookTool }>(
      `/api/tenant-portal/tenants/${tenantId}/tools`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  deleteTool: (tenantId: number, toolId: number) =>
    apiFetch<{ ok: boolean }>(`/api/tenant-portal/tenants/${tenantId}/tools/${toolId}`, {
      method: 'DELETE',
    }),

  testTool: (tenantId: number, toolId: number, body: { userId: string; role: string; args: Record<string, unknown> }) =>
    apiFetch<{ ok: boolean; status: number; effectiveArgs: Record<string, unknown>; data: unknown }>(
      `/api/tenant-portal/tenants/${tenantId}/tools/${toolId}/test`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  createDbSource: (tenantId: number, body: Record<string, unknown>) =>
    apiFetch<{ ok: boolean; dbSource: SupportDbSource }>(
      `/api/tenant-portal/tenants/${tenantId}/db-sources`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  deleteDbSource: (tenantId: number, sourceId: number) =>
    apiFetch<{ ok: boolean }>(`/api/tenant-portal/tenants/${tenantId}/db-sources/${sourceId}`, {
      method: 'DELETE',
    }),

  queryDbSource: (tenantId: number, sourceId: number, body: { userId: string; role: string; sql: string }) =>
    apiFetch<{ ok: boolean; rows: unknown[]; columns: string[]; rewrittenSql: string }>(
      `/api/tenant-portal/tenants/${tenantId}/db-sources/${sourceId}/query-test`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  getGuardrails: (tenantId: number) =>
    apiFetch<{
      ok: boolean;
      guardrails: SupportGuardrailPolicy;
      outputPolicy: SupportOutputPolicy;
      outputEvents: SupportOutputEvent[];
    }>(`/api/tenant-portal/tenants/${tenantId}/guardrails`),

  updateGuardrails: (tenantId: number, body: Partial<SupportGuardrailPolicy>) =>
    apiFetch<{ ok: boolean; policy: SupportGuardrailPolicy }>(
      `/api/tenant-portal/tenants/${tenantId}/guardrails`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  evaluateGuardrails: (tenantId: number, body: { text: string; role: string; userId?: string }) =>
    apiFetch<{
      ok: boolean;
      evaluation: { allowed: boolean; blockedReason?: string; triggeredRules: string[]; bypassedByRole: boolean };
    }>(`/api/tenant-portal/tenants/${tenantId}/guardrails/evaluate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  resetQuota: (tenantId: number, userId?: string) =>
    apiFetch<{ ok: boolean }>(`/api/tenant-portal/tenants/${tenantId}/quotas/reset`, {
      method: 'POST',
      body: JSON.stringify({ userId: userId || undefined }),
    }),

  saveOutputPolicy: (
    tenantId: number,
    body: {
      expectedVersion: number;
      policy: Pick<SupportOutputPolicy, 'mode' | 'blockedTerms' | 'maxOutputChars' | 'redactCredentials'>;
    },
  ) =>
    apiFetch<{ ok: boolean; policy: SupportOutputPolicy }>(
      `/api/tenant-portal/tenants/${tenantId}/output-policy`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  previewOutputPolicy: (
    tenantId: number,
    body: {
      policy: Pick<SupportOutputPolicy, 'mode' | 'blockedTerms' | 'maxOutputChars' | 'redactCredentials'>;
      text: string;
    },
  ) =>
    apiFetch<{ ok: boolean; decision: SupportOutputDecision }>(
      `/api/tenant-portal/tenants/${tenantId}/output-policy/preview`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  getDesk: (tenantId: number) =>
    apiFetch<{
      ok: boolean;
      conversations: SupportConversation[];
      tickets: SupportEscalationTicket[];
      pendingActions: SupportPendingAction[];
      widgetConfig: SupportDeskWidgetConfig;
      slaPolicy: SupportDeskSlaPolicy;
    }>(`/api/tenant-portal/tenants/${tenantId}/desk`),

  replyConversation: (
    tenantId: number,
    convId: string,
    body: { content: string; resolveConversation?: boolean },
  ) =>
    apiFetch<{ ok: boolean; conversation: SupportConversation }>(
      `/api/tenant-portal/tenants/${tenantId}/conversations/${encodeURIComponent(convId)}/reply`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  updateTicket: (
    tenantId: number,
    ticketId: string,
    patch: Partial<Pick<SupportEscalationTicket, 'status' | 'priority' | 'resolutionNotes'>>,
  ) =>
    apiFetch<{ ok: boolean; ticket: SupportEscalationTicket }>(
      `/api/tenant-portal/tenants/${tenantId}/tickets/${encodeURIComponent(ticketId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),

  reviewAction: (
    tenantId: number,
    actionId: string,
    body: { decision: 'approved' | 'rejected'; reviewNote?: string },
  ) =>
    apiFetch<{ ok: boolean; action: SupportPendingAction }>(
      `/api/tenant-portal/tenants/${tenantId}/actions/${encodeURIComponent(actionId)}/review`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  updateWidgetConfig: (
    tenantId: number,
    body: {
      expectedVersion: number;
      enabled?: boolean;
      appearance?: SupportDeskWidgetConfig['appearance'];
      intake?: SupportDeskWidgetConfig['intake'];
    },
  ) =>
    apiFetch<{ ok: boolean; config: SupportDeskWidgetConfig }>(
      `/api/tenant-portal/tenants/${tenantId}/widget-config`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  updateSlaPolicy: (
    tenantId: number,
    body: {
      expectedVersion: number;
      enabled?: boolean;
      targets?: SupportDeskSlaPolicy['targets'];
    },
  ) =>
    apiFetch<{ ok: boolean; policy: SupportDeskSlaPolicy }>(
      `/api/tenant-portal/tenants/${tenantId}/sla-policy`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  getIntegration: (tenantId: number) =>
    apiFetch<{
      ok: boolean;
      publicKey: string;
      signingSecretMasked: string;
      allowedOrigins: string[];
      embedSnippet: string;
      runtimePolicy: SupportRuntimePolicy;
      webhooks: SupportWebhookSubscription[];
      deliveries: SupportWebhookDelivery[];
    }>(`/api/tenant-portal/tenants/${tenantId}/integration`),

  updateIntegration: (
    tenantId: number,
    body: { allowedOrigins?: string[]; runtimePolicy?: Partial<SupportRuntimePolicy> },
  ) =>
    apiFetch<{ ok: boolean; allowedOrigins: string[]; runtimePolicy: SupportRuntimePolicy }>(
      `/api/tenant-portal/tenants/${tenantId}/integration`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  upsertWebhook: (
    tenantId: number,
    body: { name: string; targetUrl: string; events: string[]; enabled?: boolean },
  ) =>
    apiFetch<{ ok: boolean; webhook: SupportWebhookSubscription }>(
      `/api/tenant-portal/tenants/${tenantId}/webhooks`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  deleteWebhook: (tenantId: number, webhookId: string) =>
    apiFetch<{ ok: boolean }>(
      `/api/tenant-portal/tenants/${tenantId}/webhooks/${encodeURIComponent(webhookId)}`,
      { method: 'DELETE' },
    ),

  rotateSecret: (tenantId: number) =>
    apiFetch<{ ok: boolean; tenant: TenantDetail; signingSecret: string }>(
      `/api/tenant-portal/tenants/${tenantId}/rotate-secret`,
      { method: 'POST' },
    ),

  listMembers: (tenantId: number) =>
    apiFetch<{ ok: boolean; members: TenantMemberRecord[] }>(
      `/api/tenant-portal/tenants/${tenantId}/members`,
    ),

  addMember: (
    tenantId: number,
    body: { email: string; rolePreset?: TenantRolePresetId; permissions: TenantPermission[] },
  ) =>
    apiFetch<{ ok: boolean; member: TenantMemberRecord }>(
      `/api/tenant-portal/tenants/${tenantId}/members`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  updateMember: (
    tenantId: number,
    userId: number,
    body: { rolePreset?: TenantRolePresetId; permissions: TenantPermission[] },
  ) =>
    apiFetch<{ ok: boolean; member: TenantMemberRecord }>(
      `/api/tenant-portal/tenants/${tenantId}/members/${userId}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  removeMember: (tenantId: number, userId: number) =>
    apiFetch<{ ok: boolean }>(`/api/tenant-portal/tenants/${tenantId}/members/${userId}`, {
      method: 'DELETE',
    }),

  getAnalytics: (tenantId: number) =>
    apiFetch<{
      ok: boolean;
      analytics: {
        totalConversations: number;
        activeConversations: number;
        escalatedConversations: number;
        resolvedConversations: number;
        deflectionRatePct: number;
        totalTickets: number;
        openTickets: number;
        awaitingApprovalActions: number;
      };
      csatSummary: {
        totalRatings: number;
        averageScore: number;
        positivePct: number;
      };
      csatRatings: Array<{
        id: string;
        userId: string;
        userRole: string;
        score: number;
        comment?: string;
        createdAt: string;
      }>;
      auditLogs: SupportAuditLogEntry[];
    }>(`/api/tenant-portal/tenants/${tenantId}/analytics`),
};
