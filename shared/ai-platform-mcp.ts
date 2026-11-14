import type { Scope, ScopeKind, Wire } from './ai-platform.js';
import type { ChatMessage, ChatToolCall, ChatToolDefinition, TokenUsage } from './types.js';

export type { Scope, ScopeKind, Wire, ChatMessage, ChatToolCall, ChatToolDefinition, TokenUsage };

// ── Protocol & Validation Constants ──────────────────────────────────────────

export const MCP_PROTOCOL_VERSION = '2025-06-18' as const;
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18'] as const;
export const MCP_SLUG_REGEX = /^[a-z0-9-]{1,32}$/;

export const MCP_LIMITS = {
  slugMaxChars: 32,
  nameMaxChars: 120,
  urlMaxChars: 2048,
  headerNameMaxChars: 128,
  secretMaxChars: 4096,
  exposedToolNameMaxChars: 64,
  minTimeoutMs: 1_000,
  defaultTimeoutMs: 20_000,
  maxTimeoutMs: 120_000,
  minResultBytes: 1_024,
  defaultMaxResultBytes: 262_144,
  maxResultBytes: 1_048_576,
  minConcurrency: 1,
  defaultMaxConcurrency: 4,
  maxConcurrency: 32,
  minRounds: 1,
  defaultMaxRounds: 8,
  maxRounds: 20,
  maxRedirects: 3,
  maxToolPages: 100,
  maxSseFrameBytes: 1_048_576,
  circuitBreakerThreshold: 5,
  circuitBreakerBaseMs: 60_000,
  circuitBreakerMaxMs: 900_000,
  callLogMaxBytes: 8_192,
  approvalTtlHours: 24,
  defaultListLimit: 50,
  maxListLimit: 200,
  maxDecisionNoteChars: 500,
  maxAllowedOrigins: 100,
  defaultRetentionDays: 30,
} as const;

// ── Enums & Status Unions ────────────────────────────────────────────────────

export type McpAuthKind = 'none' | 'bearer' | 'header';
export type McpServerStatus = 'unknown' | 'ok' | 'error' | 'paused';
export type McpToolState = 'pending' | 'allowed' | 'blocked' | 'missing';
export type McpToolEffect = 'read' | 'write';

export type McpToolCallStatus =
  | 'ok'
  | 'tool_error'
  | 'timeout'
  | 'too_large'
  | 'blocked'
  | 'transport_error'
  | 'awaiting_approval'
  | 'rejected';

export type McpApprovalStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'rejected'
  | 'expired';

export type McpTransportErrorCode =
  | 'timeout'
  | 'unsafe_url'
  | 'http'
  | 'protocol'
  | 'too_large';

// ── Public DTOs (strictly camelCase, never expose ciphertext/iv/tag/secrets) ─

export interface McpServerView {
  id: number;
  slug: string;
  name: string;
  url: string;
  authKind: McpAuthKind;
  authHeaderName: string | null;
  hasSecret: boolean;
  enabled: boolean;
  timeoutMs: number;
  maxResultBytes: number;
  maxConcurrency: number;
  status: McpServerStatus;
  lastError: string | null;
  lastConnectedAt: string | null;
  failCount: number;
  pausedUntil: string | null;
  protocolVersion: string | null;
  serverInfo: Record<string, unknown> | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface McpServerInput {
  slug: string;
  name: string;
  url: string;
  authKind: McpAuthKind;
  authHeaderName?: string | null;
  secret?: string | null;
  enabled?: boolean;
  timeoutMs?: number;
  maxResultBytes?: number;
  maxConcurrency?: number;
}

export interface McpServerPatch {
  revision: number;
  slug?: string;
  name?: string;
  url?: string;
  authKind?: McpAuthKind;
  authHeaderName?: string | null;
  secret?: string | null;
  enabled?: boolean;
  timeoutMs?: number;
  maxResultBytes?: number;
  maxConcurrency?: number;
}

export interface McpToolView {
  id: number;
  serverId: number;
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  schemaHash: string;
  exposedName: string;
  state: McpToolState;
  effect: McpToolEffect;
  reviewedBy: number | null;
  reviewedAt: string | null;
  missingSince: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpToolReviewPatch {
  state?: 'allowed' | 'blocked';
  effect?: McpToolEffect;
}

export interface McpBindingView {
  scope: Scope;
  aiToolsEnabled: boolean;
  maxRounds: number | null;
  toolIds: number[];
  tools: McpToolView[];
}

export interface McpBindingPutInput {
  toolIds: number[];
  enabled: boolean;
  maxRounds?: number | null;
}

export interface McpCallView {
  id: number;
  runId: string | null;
  scopeKind: ScopeKind;
  scopeId: string;
  endUser: string | null;
  serverId: number;
  serverSlug?: string;
  toolName: string;
  argsMasked: string | null;
  resultMasked: string | null;
  status: McpToolCallStatus;
  durationMs: number;
  resultBytes: number;
  createdAt: string;
}

export interface McpApprovalView {
  id: number;
  executionKey: string;
  runId: string | null;
  stepSeq: number;
  scopeKind: ScopeKind;
  scopeId: string;
  endUser: string | null;
  toolId: number;
  toolName?: string;
  exposedName?: string;
  serverId?: number;
  serverSlug?: string;
  argsMasked: string;
  status: McpApprovalStatus;
  decidedBy: number | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface McpApprovalDecisionInput {
  note?: string;
}

// ── API Envelopes ────────────────────────────────────────────────────────────

export interface McpServersResponse {
  servers: McpServerView[];
}

export interface McpServerResponse {
  server: McpServerView;
}

export interface McpDeleteServerResponse {
  ok: true;
}

export interface McpInUseErrorDetails {
  profiles: Array<{ id: number; name: string }>;
  supportTenants: Array<{ id: string }>;
  agents: Array<{ id: string }>;
}

export interface McpTestServerResponse {
  ok: boolean;
  protocolVersion?: string;
  serverInfo?: Record<string, unknown>;
  toolCount?: number;
  error?: string;
}

export interface McpSyncServerResponse {
  added: number;
  changed: number;
  missing: number;
  unchanged: number;
}

export interface McpToolsResponse {
  tools: McpToolView[];
}

export interface McpToolResponse {
  tool: McpToolView;
}

export interface McpBindingResponse {
  binding: McpBindingView;
}

export interface McpCallsResponse {
  calls: McpCallView[];
  nextBefore: string | null;
}

export interface McpAllowedOriginsResponse {
  origins: string[];
}

export interface McpAllowedOriginsInput {
  origins: string[];
}

export interface McpApprovalsResponse {
  approvals: McpApprovalView[];
}

export interface McpApprovalResponse {
  approval: McpApprovalView;
}

// ── Runtime / Cross-Module Contract Types ────────────────────────────────────

export interface McpToolDescriptor {
  name: string;
  description?: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | null;
  annotations?: Record<string, unknown>;
}

export interface McpCallToolResult {
  content: string;
  isError: boolean;
  bytes: number;
  truncated: boolean;
}

export interface BoundTool {
  toolId: number;
  serverId: number;
  serverSlug: string;
  name: string;
  exposedName: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  schemaHash: string;
  effect: McpToolEffect;
  timeoutMs: number;
  maxResultBytes: number;
  maxConcurrency: number;
}

export interface ToolContext {
  scope: Scope;
  endUser: string | null;
  role?: string;
  runId?: string | null;
  turnId: string;
  stepSeq: number;
  signal: AbortSignal;
}

export type ToolExecutionErrorType =
  | 'timeout'
  | 'too_large'
  | 'transport_error'
  | 'tool_error'
  | 'blocked'
  | 'rejected';

export type ToolExecutionResult =
  | {
      kind: 'result';
      text: string;
      bytes: number;
      truncated: boolean;
      durationMs: number;
    }
  | {
      kind: 'error';
      errorType: ToolExecutionErrorType;
      text: string;
      durationMs: number;
    }
  | {
      kind: 'awaiting_approval';
      approvalId: number;
      executionKey: string;
    };

export interface McpLoopResult {
  message: ChatMessage;
  finishReason: string;
  usage: TokenUsage;
  rounds: number;
  pendingApprovalId?: number;
  callerToolCalls?: ChatToolCall[];
}

export interface McpTakeoverPlan {
  scope: Scope;
  maxRounds: number;
  tools: BoundTool[];
  callerTools: ChatToolDefinition[];
  wire: Wire;
  stream: boolean;
  model: string;
}
