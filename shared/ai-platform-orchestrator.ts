import type { ScopeKind, Wire } from './ai-platform.js';
import type { PromptVariable } from './ai-platform-prompts.js';

export const FLOW_SLUG_REGEX = /^[a-z0-9-]{1,48}$/;
export const AGENT_SLUG_REGEX = /^[a-z0-9_-]{1,48}$/;

export const FLOW_LIMITS = {
  // Defaults
  defaultMaxSteps: 12,
  defaultMaxToolCalls: 20,
  defaultMaxHandoffs: 4,
  defaultMaxTokens: 60_000,
  defaultMaxSeconds: 120,
  defaultApprovalTtlHours: 24,
  defaultAwaitingApprovalText: 'Your request requires administrator approval before continuing.',

  // Hard ceilings (FR-079, T116)
  hardMaxSteps: 50,
  hardMaxToolCalls: 100,
  hardMaxHandoffs: 10,
  hardMaxTokens: 500_000,
  hardMaxSeconds: 600,
  maxApprovalTtlHours: 168,

  // Trace & loop detection
  stepLogMaxBytes: 8_192,
  loopRepeatLimit: 3,
  maxListLimit: 200,
  defaultListLimit: 50,
} as const;

export type FlowKind = 'single' | 'handoff';

export type FlowStopReason =
  | 'max_steps'
  | 'max_tool_calls'
  | 'max_handoffs'
  | 'max_tokens'
  | 'max_seconds'
  | 'loop_detected'
  | 'quota_exhausted'
  | 'expired';

export type FlowRunStatus =
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'stopped'
  | 'cancelled'
  | 'failed'
  | 'interrupted';

export type FlowStepKind = 'model' | 'tool' | 'handoff' | 'approval' | 'guard' | 'stop';
export type FlowStepStatus = 'ok' | 'error' | 'skipped';

export interface FlowLimitsConfig {
  maxSteps: number;
  maxToolCalls: number;
  maxHandoffs: number;
  maxTokens: number;
  maxSeconds: number;
}

export const DEFAULT_FLOW_LIMITS: Readonly<FlowLimitsConfig> = {
  maxSteps: FLOW_LIMITS.defaultMaxSteps,
  maxToolCalls: FLOW_LIMITS.defaultMaxToolCalls,
  maxHandoffs: FLOW_LIMITS.defaultMaxHandoffs,
  maxTokens: FLOW_LIMITS.defaultMaxTokens,
  maxSeconds: FLOW_LIMITS.defaultMaxSeconds,
};

export interface FlowDefinition {
  kind: FlowKind;
  entryAgent: string;
  agents: string[];
  handoffs: Record<string, string[]>;
  limits: FlowLimitsConfig;
  awaitingApprovalText: string;
  approvalTtlHours: number;
}

export interface PublishedAgentSnapshot {
  agentId: number;
  slug: string;
  name: string;
  model: string;
  promptVersion: number | null;
  promptBody: string;
  promptVariables: PromptVariable[];
  knowledgeScopeKind: ScopeKind | null;
  knowledgeScopeId: string | null;
  outputPolicyScope: string | null;
  maxOutputTokens: number | null;
}

export interface PublishedFlowDefinition extends FlowDefinition {
  agentPromptVersions: Record<string, number | null>;
  agentSnapshots?: Record<string, PublishedAgentSnapshot>;
}

export interface FlowValidationIssue {
  field: string;
  message: string;
}

export interface AgentView {
  id: number;
  slug: string;
  name: string;
  description: string;
  model: string;
  knowledgeScopeKind: ScopeKind | null;
  knowledgeScopeId: string | null;
  outputPolicyScope: string | null;
  maxOutputTokens: number | null;
  enabled: boolean;
  revision: number;
  publishedPromptVersion: number | null;
  systemPrompt: string;
}

export interface AgentInput {
  slug: string;
  name: string;
  description?: string;
  model: string;
  systemPrompt?: string;
  knowledgeScopeKind?: ScopeKind | null;
  knowledgeScopeId?: string | null;
  outputPolicyScope?: string | null;
  maxOutputTokens?: number | null;
  enabled?: boolean;
}

export interface AgentPatchInput {
  revision: number;
  name?: string;
  description?: string;
  model?: string;
  systemPrompt?: string;
  knowledgeScopeKind?: ScopeKind | null;
  knowledgeScopeId?: string | null;
  outputPolicyScope?: string | null;
  maxOutputTokens?: number | null;
  enabled?: boolean;
}

export interface FlowView {
  id: number;
  slug: string;
  name: string;
  description: string;
  draft: FlowDefinition;
  published: PublishedFlowDefinition | null;
  publishedVersion: number;
  enabled: boolean;
  revision: number;
}

export interface FlowDetailView {
  flow: FlowView;
  grantedProfileIds: number[];
}

export interface FlowCreateInput {
  slug: string;
  name: string;
  description?: string;
  enabled?: boolean;
  draft: FlowDefinition;
}

export interface FlowDraftInput {
  revision: number;
  name?: string;
  description?: string;
  enabled?: boolean;
  draft: FlowDefinition;
}

export interface FlowRunView {
  id: string;
  flowId: number;
  flowSlug: string;
  flowVersion: number;
  profileId: number;
  endUser: string | null;
  wire: Wire;
  status: FlowRunStatus;
  stopReason: FlowStopReason | null;
  steps: number;
  toolCalls: number;
  handoffs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  finalTextMasked: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  isDryRun: boolean;
}

export interface FlowRunStepView {
  runId: string;
  seq: number;
  kind: FlowStepKind;
  agentSlug: string;
  model: string | null;
  toolName: string | null;
  inputMasked: string;
  outputMasked: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  status: FlowStepStatus;
  error: string | null;
  createdAt: string;
}

export interface FlowRunDetailResponse {
  run: FlowRunView;
  steps: FlowRunStepView[];
}

export interface PublicFlowRunResponse {
  id: string;
  flow: string;
  status: FlowRunStatus;
  stop_reason: FlowStopReason | null;
  output_text: string | null;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  started_at: string;
  finished_at: string | null;
}
