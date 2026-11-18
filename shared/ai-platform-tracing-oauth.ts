import type { ScopeKind, Wire } from './ai-platform.js';

// ── Hierarchical Request Span Tracing DTOs ───────────────────────────────────

export const TRACE_SPAN_KINDS = [
  'request',
  'prompt_render',
  'retrieval',
  'context_budget',
  'mcp_tool_call',
  'orchestrator_step',
  'upstream_attempt',
  'output_guard',
] as const;

export type TraceSpanKind = (typeof TRACE_SPAN_KINDS)[number];

export type TraceSpanStatus =
  | 'ok'
  | 'error'
  | 'skipped'
  | 'cancelled'
  | 'awaiting_approval';

export type TraceStatus =
  | 'ok'
  | 'error'
  | 'awaiting_approval'
  | 'cancelled';

export type TraceAttributeValue = string | number | boolean | null;

export const TRACING_LIMITS = {
  maxSpansPerTrace: 250,
  maxAttributesPerSpan: 32,
  maxAttributeStringChars: 300,
  maxErrorSummaryChars: 300,
  maxRetainedTraces: 5_000,
  defaultListLimit: 50,
  maxListLimit: 200,
  traceHeaderName: 'x-freellm-trace-id',
  parentSpanHeaderName: 'x-freellm-parent-span-id',
} as const;

export interface TraceSpanNode {
  id: string;
  parentId: string | null;
  name: string;
  kind: TraceSpanKind;
  startOffsetMs: number;
  durationMs: number;
  status: TraceSpanStatus;
  model?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  errorSummary?: string | null;
  attributes: Record<string, TraceAttributeValue>;
  children: TraceSpanNode[];
}

export interface TraceSummary {
  traceId: string;
  requestId: string;
  threadId: string | null;
  traceSource: string;
  scopeKind: ScopeKind;
  scopeId: string;
  endUser: string | null;
  wire: Wire;
  requestedModel: string;
  servedModel: string | null;
  status: TraceStatus;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  spansCount: number;
  errorSummary: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface TraceRecord extends TraceSummary {
  rootSpan: TraceSpanNode;
}

export interface TracesListResponse {
  traces: TraceSummary[];
  nextBefore: string | null;
}

export interface TraceDetailResponse {
  trace: TraceRecord;
}

export interface TracesDeleteResponse {
  deleted: number;
}

// ── Remote MCP OAuth 2.1 + PKCE (S256) DTOs ──────────────────────────────────

export type McpOAuthConnectionStatus = 'connected' | 'expired' | 'unconfigured';
export type McpOAuthPkceMethod = 'S256';

export const MCP_OAUTH_LIMITS = {
  pkceStateTtlMs: 10 * 60_000,
  refreshSkewMs: 30_000,
  maxScopes: 32,
  maxScopeChars: 128,
  maxClientIdChars: 256,
  maxClientSecretChars: 2048,
  maxUrlChars: 2048,
  httpTimeoutMs: 15_000,
} as const;

export interface McpOAuthConfigInput {
  issuerUrl?: string | null;
  authorizationEndpoint?: string | null;
  tokenEndpoint?: string | null;
  revocationEndpoint?: string | null;
  clientId: string;
  clientSecret?: string | null;
  clearClientSecret?: boolean;
  scopes?: string[];
  redirectUri: string;
}

export interface McpOAuthStatusView {
  serverId: number;
  connectionStatus: McpOAuthConnectionStatus;
  issuerUrl: string | null;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  revocationEndpoint: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
  scopes: string[];
  redirectUri: string | null;
  pkceMethod: McpOAuthPkceMethod;
  expiresAt: string | null;
  hasRefreshToken: boolean;
  lastRefreshedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

export interface McpOAuthStatusResponse {
  oauth: McpOAuthStatusView;
}

export interface McpOAuthStartInput {
  config?: McpOAuthConfigInput;
  redirectUri?: string;
  scopes?: string[];
}

export interface McpOAuthStartResponse {
  authorizationUrl: string;
  state: string;
  codeChallengeMethod: McpOAuthPkceMethod;
  expiresAt: string;
  oauth: McpOAuthStatusView;
}

export interface McpOAuthCallbackInput {
  code: string;
  state: string;
  redirectUri?: string;
}

export interface McpOAuthRevokeResponse {
  ok: true;
  oauth: McpOAuthStatusView;
}

// ── Background / Scheduled Orchestrator Flow Triggers ────────────────────────

export type FlowScheduleKind = 'interval' | 'cron';

export const FLOW_SCHEDULE_LIMITS = {
  minIntervalSeconds: 10,
  maxIntervalSeconds: 604_800,
  maxCronChars: 120,
  maxMessageChars: 16_000,
  defaultTickMs: 15_000,
} as const;

export interface AsyncFlowRunInput {
  message: string;
  profileId?: number;
  endUser?: string | null;
  isDryRun?: boolean;
}

export interface AsyncFlowRunResponse {
  runId: string;
  statusUrl: string;
  publicStatusUrl?: string | null;
  status: 'running';
}

export interface FlowScheduleView {
  id: number;
  flowId: number;
  flowSlug: string;
  enabled: boolean;
  scheduleKind: FlowScheduleKind;
  intervalSeconds: number | null;
  cronExpr: string | null;
  profileId: number;
  endUser: string | null;
  inputMessage: string;
  lastRunId: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FlowScheduleInput {
  enabled: boolean;
  scheduleKind: FlowScheduleKind;
  intervalSeconds?: number | null;
  cronExpr?: string | null;
  profileId?: number;
  endUser?: string | null;
  inputMessage: string;
}

export interface FlowScheduleResponse {
  schedule: FlowScheduleView | null;
}

export interface FlowScheduleTickResponse {
  checked: number;
  triggeredRunIds: string[];
}

// ── Outer-Chat Write Approval Auto-Resume Continuation ───────────────────────

export type ChatContinuationStatus =
  | 'awaiting_approval'
  | 'resuming'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'expired';

export interface ChatApprovalContinuationView {
  approvalId: number;
  scopeKind: ScopeKind;
  scopeId: string;
  endUser: string | null;
  wire: Wire;
  model: string;
  servedModel: string | null;
  status: ChatContinuationStatus;
  assistantMessageMasked: string | null;
  finishReason: string | null;
  rounds: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  nextApprovalId: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ChatApprovalContinuationResponse {
  continuation: ChatApprovalContinuationView | null;
}
