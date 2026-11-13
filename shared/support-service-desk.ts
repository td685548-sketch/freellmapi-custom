/**
 * Frozen external DTOs, limits, and constants for AI Support Service Desk & Widget Studio (Spec 019).
 * Owned by Agent 1 (shared/support-service-desk.ts).
 */

import type { SupportEvidenceCitation, SupportEvidenceRole } from './support-evidence.js';

export type SupportTicketPriority = 'low' | 'medium' | 'high' | 'urgent';

export const SUPPORT_DESK_DEPARTMENTS = ['billing', 'technical', 'returns', 'general'] as const;
export type SupportDeskDepartment = (typeof SUPPORT_DESK_DEPARTMENTS)[number];

export const SUPPORT_DESK_WIDGET_POSITIONS = ['bottom-right', 'bottom-left'] as const;
export type SupportDeskWidgetPosition = (typeof SUPPORT_DESK_WIDGET_POSITIONS)[number];

export const SUPPORT_DESK_INTAKE_FIELD_TYPES = ['text', 'email', 'number', 'select'] as const;
export type SupportDeskIntakeFieldType = (typeof SUPPORT_DESK_INTAKE_FIELD_TYPES)[number];

export const SUPPORT_DESK_LIMITS = {
  maxFields: 10,
  maxOptions: 20,
  maxValueChars: 500,
  maxQuickPrompts: 6,
  maxLabelChars: 80,
  maxTextChars: 500,
  maxIntakeBytes: 8192,
  intakeTtlSeconds: 1800,
  maxQueuePageSize: 100,
  copilotRequestsPerHour: 10,
  copilotTokensPerDay: 250000,
  copilotMaxModelCalls: 2,
  copilotMaxCompletionTokens: 1024,
  copilotDeadlineMs: 15000,
  copilotMaxPromptChars: 16000,
  copilotJobTtlSeconds: 86400,
  maxRoutingRules: 20,
  maxKeywordsPerRule: 10,
  maxKeywordChars: 60,
  maxSlaMinutes: 10080,
} as const;

export const SUPPORT_DESK_INTAKE_MAX_PER_HOUR = 10;
export const SUPPORT_DESK_INTAKE_MAX_LIVE_RECEIPTS = 100;

export const RESERVED_INTAKE_FIELD_KEYS = [
  '__proto__',
  'prototype',
  'constructor',
  'role',
  'user_role',
  'user_id',
  'userid',
  'userrole',
  'permissions',
  'tenant_id',
  'tenantid',
  'token',
  'contexttoken',
  'request_id',
  'conversation_id',
  'intakereceiptid',
] as const;

export interface SupportDeskIntakeField {
  key: string;
  label: string;
  type: SupportDeskIntakeFieldType;
  required: boolean;
  options?: string[];
}

export interface SupportDeskWidgetAppearance {
  primaryColor: string;
  title: string;
  welcomeMessage: string;
  position: SupportDeskWidgetPosition;
  quickPrompts: string[];
}

export interface SupportDeskWidgetConfig {
  version: number;
  updatedAt: string;
  enabled: boolean;
  appearance: SupportDeskWidgetAppearance;
  intake: {
    required: boolean;
    fields: SupportDeskIntakeField[];
  };
}

export interface SupportDeskPublicWidgetConfig {
  version: number;
  enabled: boolean;
  appearance: SupportDeskWidgetAppearance;
  intake: {
    required: boolean;
    fields: SupportDeskIntakeField[];
    schemaHash: string;
  };
}

export const DEFAULT_SUPPORT_DESK_WIDGET_CONFIG: SupportDeskWidgetConfig = {
  version: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
  enabled: false,
  appearance: {
    primaryColor: '#2563eb',
    title: 'Support Assistant',
    welcomeMessage: '',
    position: 'bottom-right',
    quickPrompts: [],
  },
  intake: {
    required: false,
    fields: [],
  },
};

export interface SupportDeskIntakeInput {
  requestId: string;
  configVersion: number;
  values: Record<string, string | number>;
  conversationId?: string;
}

export interface SupportDeskStoredIntake {
  receiptHash: string;
  tenantId: number;
  userId: string;
  role: SupportEvidenceRole;
  requestId: string;
  schemaHash: string;
  conversationId: string | null;
  expiresAt: string;
  createdAt: string;
  values: Record<string, string | number>;
}

export interface SupportDeskIntakeReceipt {
  intakeReceiptId: string;
  expiresAt: string;
  schemaHash: string;
  replayed: boolean;
}

export interface SupportDeskConversationIntake {
  schemaHash: string;
  submittedAt: string;
  values?: Record<string, string | number>;
}

export interface SupportDeskInternalConversationIntake {
  schemaHash: string;
  submittedAt: string;
  receiptHash: string;
}

export interface SupportDeskCopilotInput {
  requestId: string;
  conversationId: string;
}

export type SupportDeskCopilotTone = 'empathetic' | 'direct' | 'technical';

export interface SupportDeskCopilotDraft {
  tone: SupportDeskCopilotTone;
  text: string;
  citations: SupportEvidenceCitation[];
}

export interface SupportDeskCopilotResult {
  jobId: string;
  requestId: string;
  conversationId: string;
  status: 'completed' | 'abstained';
  reason?: 'no_evidence' | 'invalid_result' | 'sources_changed';
  summary: string;
  drafts: SupportDeskCopilotDraft[];
  summaryCitations: SupportEvidenceCitation[];
  conversationSnapshot: string;
  evidenceSnapshot: string;
  policyVersion: number;
  modelUsed: string | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    accounting: 'actual' | 'estimated';
  };
  replayed: boolean;
  createdAt: string;
}

export interface SupportDeskSlaTarget {
  firstResponseMinutes: number;
  resolutionMinutes: number;
}

export interface SupportDeskRoutingRule {
  id: string;
  department: SupportDeskDepartment;
  keywords: string[];
}

export interface SupportDeskSlaPolicy {
  version: number;
  updatedAt: string;
  enabled: boolean;
  targets: Record<SupportTicketPriority, SupportDeskSlaTarget>;
  routingRules: SupportDeskRoutingRule[];
}

export const DEFAULT_SUPPORT_DESK_SLA_POLICY: SupportDeskSlaPolicy = {
  version: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
  enabled: false,
  targets: {
    urgent: { firstResponseMinutes: 5, resolutionMinutes: 60 },
    high: { firstResponseMinutes: 15, resolutionMinutes: 240 },
    medium: { firstResponseMinutes: 60, resolutionMinutes: 1440 },
    low: { firstResponseMinutes: 240, resolutionMinutes: 4320 },
  },
  routingRules: [],
};

export interface SupportDeskTicketState {
  tenantId: number;
  ticketId: string;
  conversationId?: string;
  version: number;
  cycle: number;
  cycleOpenedAt: string;
  tracking: 'tracked' | 'paused';
  policyVersion: number;
  policyTargets: Record<SupportTicketPriority, SupportDeskSlaTarget>;
  priority: SupportTicketPriority;
  department: SupportDeskDepartment;
  routingSource: 'rule' | 'fallback' | 'manual';
  firstHumanReplyAt: string | null;
  resolvedAt: string | null;
  terminal: boolean;
}

export type SupportDeskSlaClockStatus = 'healthy' | 'warning' | 'breached' | 'met' | 'not_observed';

export interface SupportDeskSlaClock {
  status: SupportDeskSlaClockStatus;
  deadlineAt: string | null;
  elapsedMs: number | null;
}
