/**
 * Frozen external DTOs and types for AI Support Runtime Integration (Spec 017).
 * Belongs to shared/support-runtime.ts (Agent 1 ownership).
 */

import type { SupportAnswerEvidence } from './support-evidence.js';

export interface SupportRuntimePolicy {
  allowedModels: string[]; // extra requested model selectors; default [] permits tenant.defaultModel only
  toolPolicies: Array<{ toolId: number; mode: 'read' | 'approval_required' }>;
  maxCompletionTokens: number; // integer 1..4096, default 512, per model call
  maxModelCalls: number; // integer 1..3, default 3
  maxToolCalls: number; // integer 0..3, default 3
  maxContextChars: number; // integer 1000..32000, default 16000
  maxToolResultChars: number; // integer 256..16000, default 8000, each result
  maxHistoryMessages: number; // integer 2..100, default 40
}

export interface SupportRuntimeChatInput {
  tenantKey: string;
  contextToken?: string;
  conversationId?: string;
  requestId?: string; // ASCII [A-Za-z0-9_-], 1..128; generate if absent, but replay needs client-supplied ID
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  model?: string;
  intakeReceiptId?: string;
}

export type SupportActionExecutionStatus = 'pending' | 'executing' | 'succeeded' | 'failed' | 'unknown';

export interface SupportRuntimeMetadata {
  requestId: string;
  conversationId?: string; // absent only for compatible stateless unsigned guest requests
  replayed: boolean;
  replySource: 'model' | 'knowledge_abstention';
  knowledgeDocIds: string[]; // only role-visible docs, no full snippets/raw CRM
  redactionCount: number;
  quota: { requestsUsed: number; tokensUsed: number; resetAt: string; accounting: 'actual' | 'estimated' };
  pendingActions: Array<{ id: string; toolName: string; executionStatus: SupportActionExecutionStatus }>;
  evidence?: SupportAnswerEvidence;
  intake?: { schemaHash: string; submittedAt: string };
}

export interface SupportIntegrationCheck {
  id: 'tenant' | 'origins' | 'model' | 'knowledge' | 'masking' | 'guardrails' | 'quota' | 'approvals' | 'worker';
  status: 'ready' | 'warning' | 'error';
  code: string; // stable machine code; UI localizes, no secret or raw configuration
}

export interface SupportIntegrationReadiness {
  tenantId: number;
  ready: boolean; // no error checks; warnings do not imply a false guarantee
  checks: SupportIntegrationCheck[];
  runtimePolicy: SupportRuntimePolicy;
  embedSnippet: string; // public key + server origin only, never a signing secret or a stored user's token
}

export interface SupportOutboxItem {
  id: string;
  eventId: string;
  event: string;
  webhookId: string;
  webhookName: string;
  status: 'pending' | 'delivering' | 'delivered' | 'dead';
  attempts: number;
  nextAttemptAt: string | null;
  statusCode?: number;
  lastError?: string; // sanitized, never response body/credentials
  createdAt: string;
}

export const DEFAULT_RUNTIME_POLICY: SupportRuntimePolicy = {
  allowedModels: [],
  toolPolicies: [],
  maxCompletionTokens: 512,
  maxModelCalls: 3,
  maxToolCalls: 3,
  maxContextChars: 16000,
  maxToolResultChars: 8000,
  maxHistoryMessages: 40,
};

export const RUNTIME_POLICY_BOUNDS = {
  maxCompletionTokens: { min: 1, max: 4096, default: 512 },
  maxModelCalls: { min: 1, max: 3, default: 3 },
  maxToolCalls: { min: 0, max: 3, default: 3 },
  maxContextChars: { min: 1000, max: 32000, default: 16000 },
  maxToolResultChars: { min: 256, max: 16000, default: 8000 },
  maxHistoryMessages: { min: 2, max: 100, default: 40 },
} as const;
