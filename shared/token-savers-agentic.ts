/**
 * Shared contracts for Spec 029 — Token Savers v2 (Agentic & Code-Safe Input Compaction Suite).
 */

export const AGENTIC_PROSE_MODES = ['off', 'lite', 'standard', 'aggressive'] as const;
export type AgenticProseMode = (typeof AGENTIC_PROSE_MODES)[number];

export const AGENTIC_STRATEGY_IDS = [
  'source_code',
  'grep_search',
  'terminal_ansi',
  'json_payload',
  'stack_trace',
  'evidence_digest',
  'prose_caveman',
  'tools_dedup',
] as const;
export type AgenticStrategyId = (typeof AGENTIC_STRATEGY_IDS)[number];

export interface AgenticCompactorConfig {
  enabled: boolean;
  toolCompaction: boolean;
  toolResultMaxChars: number;
  jsonMinChars: number;
  proseMode: AgenticProseMode;
  prefixFreezeEnabled: boolean;
  prefixFreezeThreshold: number;
  dedupTools: boolean;
  source?: 'setting' | 'env' | 'default';
}

export const AGENTIC_COMPACTOR_LIMITS = {
  minToolResultMaxChars: 1_000,
  maxToolResultMaxChars: 200_000,
  defaultToolResultMaxChars: 12_000,
  minJsonMinChars: 500,
  maxJsonMinChars: 100_000,
  defaultJsonMinChars: 2_000,
  minPrefixFreezeThreshold: 1,
  maxPrefixFreezeThreshold: 50,
  defaultPrefixFreezeThreshold: 3,
  previewTextMaxChars: 250_000,
  previewMaxMessages: 200,
} as const;

export const DEFAULT_AGENTIC_COMPACTOR_CONFIG: Readonly<AgenticCompactorConfig> = {
  enabled: false,
  toolCompaction: true,
  toolResultMaxChars: AGENTIC_COMPACTOR_LIMITS.defaultToolResultMaxChars,
  jsonMinChars: AGENTIC_COMPACTOR_LIMITS.defaultJsonMinChars,
  proseMode: 'standard',
  prefixFreezeEnabled: true,
  prefixFreezeThreshold: AGENTIC_COMPACTOR_LIMITS.defaultPrefixFreezeThreshold,
  dedupTools: true,
  source: 'default',
};

export interface AgenticCompactorStats {
  requestsProcessed: number;
  requestsCompressed: number;
  bytesBefore: number;
  bytesAfter: number;
  tokensSavedEst: number;
  strategyHits: Record<AgenticStrategyId, number>;
  frozenPrefixesSkipped: number;
  fidelityRollbacks: number;
  trackedPrefixes: number;
  frozenPrefixes: number;
}

export interface AgenticCompactorStatusResponse {
  config: AgenticCompactorConfig;
  stats: AgenticCompactorStats;
}

export interface AgenticPreviewMessage {
  role: string;
  content: unknown;
  tool_call_id?: string;
}

export interface AgenticPreviewRequest {
  text?: string;
  role?: 'tool' | 'user' | 'assistant' | 'system';
  messages?: AgenticPreviewMessage[];
  tools?: unknown[];
  configOverride?: Partial<AgenticCompactorConfig>;
}

export interface AgenticPreviewResponse {
  ok: true;
  originalChars: number;
  compressedChars: number;
  savedChars: number;
  tokensBeforeEst: number;
  tokensAfterEst: number;
  tokensSavedEst: number;
  savedPct: number;
  strategiesApplied: AgenticStrategyId[];
  protectedSpansCount: number;
  prefixFrozen: boolean;
  fidelityRolledBack: boolean;
  originalPreview: string;
  compressedPreview: string;
}
