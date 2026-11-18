/**
 * Cross-Turn Reasoning & Thought-Signature Continuity DTOs (Spec 031).
 *
 * Strictly metadata and configuration shapes — raw thinking text and
 * cryptographic signatures are never logged or exposed in diagnostics payloads.
 */

export const THINKING_CONTINUITY_MODES = ['enabled', 'bypass'] as const;
export type ThinkingContinuityMode = (typeof THINKING_CONTINUITY_MODES)[number];

export const DEFAULT_THINKING_CONTINUITY_MODE: ThinkingContinuityMode = 'enabled';

export type ThoughtSignatureModelFamily = 'gemini' | 'claude';

export const CANONICAL_THINKING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'auto',
] as const;

export type CanonicalThinkingEffort = (typeof CANONICAL_THINKING_EFFORTS)[number];

export type ClaudeAdaptiveEffort = 'low' | 'medium' | 'high' | 'max';

export type ClaudeSignedThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

export interface ClaudeThinkingSegment {
  toolUseId: string;
  blocks: ClaudeSignedThinkingBlock[];
}

export interface ThinkingContinuityConfig {
  mode: ThinkingContinuityMode;
}

export interface ThinkingContinuityDiagnostics {
  geminiStored: number;
  geminiRestored: number;
  geminiPersistedHits: number;
  claudeTurnsStored: number;
  claudeTurnsRestored: number;
  foreignSignaturesStripped: number;
  memoryEntries: number;
}

export interface ThinkingContinuitySnapshot {
  mode: ThinkingContinuityMode;
  diagnostics: ThinkingContinuityDiagnostics;
  persistedEntries: number;
}

export interface ThinkingContinuityClearResult {
  ok: true;
  clearedMemoryEntries: number;
  clearedPersistedEntries: number;
  snapshot: ThinkingContinuitySnapshot;
}

export interface NormalizedThinkingBudget {
  mode: 'none' | 'auto' | 'budget' | 'level';
  effort?: CanonicalThinkingEffort;
  budgetTokens?: number;
  maxTokens?: number;
  clampedBudget: boolean;
}
