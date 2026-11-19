/**
 * Shared types, presets, and validation limits for Token-Budgeted Context Assembly (Spec 021).
 */

export type ContextPreset = 'saver' | 'balanced' | 'max_context' | 'custom';

export type ContextPresetKey = Exclude<ContextPreset, 'custom'>;

export type ClientHistoryMode = 'passthrough' | 'trim_on_overflow' | 'enforce_budget';

export type ContextSegmentKind =
  | 'mandatory'
  | 'summary'
  | 'knowledge'
  | 'history'
  | 'client_history';

export type ContextDropReason =
  | 'budget'
  | 'block_alignment'
  | 'leading_assistant'
  | 'max_messages'
  | 'shingle_dedup'
  | 'min_score';

export interface ContextPolicy {
  profileId?: number;
  enabled: boolean;
  inherited: boolean;
  preset: ContextPreset;
  maxInputTokens: number | null;
  outputReserveTokens: number;
  safetyMarginPct: number;
  summarySharePct: number;
  knowledgeSharePct: number;
  dropBlockTurns: number;
  summarize: boolean;
  clientHistoryMode: ClientHistoryMode;
  knowledgeMinScore: number | null;
  updatedAt: string;
}

export interface ContextPolicyInput {
  enabled?: boolean;
  preset?: ContextPreset;
  maxInputTokens?: number | null;
  outputReserveTokens?: number;
  safetyMarginPct?: number;
  summarySharePct?: number;
  knowledgeSharePct?: number;
  dropBlockTurns?: number;
  summarize?: boolean;
  clientHistoryMode?: ClientHistoryMode;
  knowledgeMinScore?: number | null;
}

export interface ContextPolicyDefault {
  enabled: boolean;
  preset: ContextPresetKey;
  fallbackWindowTokens: number;
  imageTokens: number;
}

export interface ContextPresetValues {
  maxInputTokens: number | null;
  outputReserveTokens: number;
  safetyMarginPct: number;
  summarySharePct: number;
  knowledgeSharePct: number;
  dropBlockTurns: number;
  summarize: boolean;
  clientHistoryMode: ClientHistoryMode;
  knowledgeMinScore: number | null;
}

export const CONTEXT_PRESETS: Record<ContextPresetKey, ContextPresetValues> = {
  saver: {
    maxInputTokens: 8000,
    outputReserveTokens: 1024,
    safetyMarginPct: 10,
    summarySharePct: 15,
    knowledgeSharePct: 20,
    dropBlockTurns: 4,
    summarize: true,
    clientHistoryMode: 'passthrough',
    knowledgeMinScore: null,
  },
  balanced: {
    maxInputTokens: 16000,
    outputReserveTokens: 1024,
    safetyMarginPct: 10,
    summarySharePct: 15,
    knowledgeSharePct: 25,
    dropBlockTurns: 4,
    summarize: true,
    clientHistoryMode: 'trim_on_overflow',
    knowledgeMinScore: null,
  },
  max_context: {
    maxInputTokens: null,
    outputReserveTokens: 2048,
    safetyMarginPct: 10,
    summarySharePct: 10,
    knowledgeSharePct: 30,
    dropBlockTurns: 8,
    summarize: true,
    clientHistoryMode: 'passthrough',
    knowledgeMinScore: null,
  },
};

export const CONTEXT_POLICY_LIMITS = {
  minMaxInputTokens: 2000,
  maxMaxInputTokens: 1_000_000,
  outputReserve: [128, 32_768] as const,
  safetyMarginPct: [0, 30] as const,
  sharePct: [0, 60] as const,
  maxShareSum: 80,
  dropBlockTurns: [1, 16] as const,
  knowledgeMinScore: [0, 1] as const,
  fallbackWindowTokens: [1024, 1_000_000] as const,
  imageTokens: [85, 4096] as const,
} as const;

export const CONTEXT_POLICY_DEFAULT: ContextPolicyDefault = {
  enabled: true,
  preset: 'balanced',
  fallbackWindowTokens: 8192,
  imageTokens: 765,
};

export interface ContextPolicySuggested {
  maxInputTokens: number;
  summarize: boolean;
}

export interface ContextPolicyResponse {
  policy: ContextPolicy;
  suggested: ContextPolicySuggested | null;
  presets: typeof CONTEXT_PRESETS;
  limits: typeof CONTEXT_POLICY_LIMITS;
}

export interface ContextAssemblySummary {
  budget: number;
  window: number | null;
  mandatory: number;
  summary: number;
  knowledge: number;
  history: number;
  histSent: number;
  histDropped: number;
  kbSent: number;
  kbDropped: number;
  clientDropped: number;
  refits: number;
  estimatedTokens: number;
  heuristicTokens: number;
  modelKey: string;
  createdAt: string;
}

export interface ContextEstimateErrorStats {
  samples: number;
  p50Pct: number | null;
  p95Pct: number | null;
  within15PctRate: number | null;
}

export interface ContextStatsByDay {
  day: string;
  requests: number;
  avgInputTokens: number;
  trimmedRate: number;
}

export interface ContextStats {
  days: number;
  requests: number;
  avgInputTokens: number;
  avgBudgetTokens: number;
  trimmedRate: number;
  avgHistoryDropped: number;
  savedTokens: number;
  summaryUsedRate: number;
  estimateError: ContextEstimateErrorStats;
  byDay: ContextStatsByDay[];
}

export interface ContextPreviewSegment {
  kind: ContextSegmentKind;
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  tokens: number;
  messageId?: number;
  preview: string;
  sent: boolean;
  reason?: ContextDropReason;
}

export interface ContextPreview {
  model: {
    key: string;
    contextWindow: number | null;
  };
  budget: {
    effective: number;
    mandatory: number;
    summaryCap: number;
    knowledgeCap: number;
    historyCap: number;
  };
  segments: ContextPreviewSegment[];
  summary: {
    coversThroughMessageId: number | null;
    pendingFoldMessages: number;
  };
  knowledgeNote: string;
  simulatedQuery?: string | null;
}
