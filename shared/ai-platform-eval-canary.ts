import type { Scope, ScopeKind } from './ai-platform.js';

export type { Scope, ScopeKind };

export const PROMPT_VARIANT_HEADER = 'x-freellm-prompt-variant' as const;

export const EVAL_CANARY_LIMITS = {
  maxCasesPerScope: 30,
  maxTitleChars: 120,
  maxUserMessageChars: 8_000,
  maxAssertionsPerCase: 10,
  maxAssertionValueChars: 1_000,
  maxRegexPatternChars: 200,
  maxJsonSchemaBytes: 8_192,
  maxRunsRetainedPerScope: 25,
  defaultRunsListLimit: 10,
  maxRunsListLimit: 25,
  minTrafficPercent: 1,
  maxTrafficPercent: 99,
  defaultTrafficPercent: 10,
  defaultScrubWindowChars: 512,
  maxScrubBufferChars: 65_536,
} as const;

// ── Golden Eval Assertions & Cases ────────────────────────────────────────────

export type EvalAssertionType =
  | 'contains'
  | 'not_contains'
  | 'regex'
  | 'json_schema'
  | 'max_chars';

export type EvalAssertion =
  | {
      type: 'contains';
      value: string;
      caseSensitive?: boolean;
    }
  | {
      type: 'not_contains';
      value: string;
      caseSensitive?: boolean;
    }
  | {
      type: 'regex';
      pattern: string;
      flags?: string;
    }
  | {
      type: 'json_schema';
      schema: Record<string, unknown>;
    }
  | {
      type: 'max_chars';
      limit: number;
    };

export interface PromptEvalCase {
  id: number;
  scopeKind: ScopeKind;
  scopeId: string;
  title: string;
  userMessage: string;
  variables: Record<string, string>;
  assertions: EvalAssertion[];
  createdAt: string;
  updatedAt: string;
}

export interface PromptEvalCaseInput {
  title: string;
  userMessage: string;
  variables?: Record<string, string>;
  assertions: EvalAssertion[];
}

export interface PromptEvalCasesListResponse {
  cases: PromptEvalCase[];
}

export interface PromptEvalCaseResponse {
  evalCase: PromptEvalCase;
}

// ── Eval Run & Comparison DTOs ────────────────────────────────────────────────

export interface EvalAssertionResult {
  assertion: EvalAssertion;
  passed: boolean;
  detail?: string;
}

export interface EvalTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface EvalVariantCaseOutcome {
  reply: string;
  renderedPrompt: string;
  passed: boolean;
  latencyMs: number;
  usage: EvalTokenUsage;
  assertionResults: EvalAssertionResult[];
  error?: string;
}

export interface EvalCaseComparison {
  caseId: number;
  title: string;
  userMessage: string;
  baseline: EvalVariantCaseOutcome | null;
  candidate: EvalVariantCaseOutcome;
  regressed: boolean;
  improved: boolean;
  latencyDeltaMs: number | null;
  tokenDelta: number | null;
}

export interface EvalVariantSummary {
  label: 'published' | 'draft' | 'version';
  version: number | null;
  totalCases: number;
  passedCases: number;
  passRate: number;
  avgLatencyMs: number;
  totalTokens: number;
}

export interface PromptEvalRun {
  id: number;
  scopeKind: ScopeKind;
  scopeId: string;
  model: string;
  baselineVersion: number | null;
  candidateVersion: number;
  candidateLabel: 'draft' | 'version';
  baselineSummary: EvalVariantSummary | null;
  candidateSummary: EvalVariantSummary;
  regressions: number;
  improvements: number;
  cases: EvalCaseComparison[];
  actorId: number | null;
  createdAt: string;
}

export interface RunPromptEvalRequest {
  candidateVersion?: number;
  baselineVersion?: number | null;
  model?: string;
  caseIds?: number[];
}

export interface PromptEvalRunResponse {
  run: PromptEvalRun;
}

export interface PromptEvalRunsListResponse {
  runs: PromptEvalRun[];
}

// ── Weighted Canary Traffic Split DTOs ────────────────────────────────────────

export type PromptVariantKind = 'published' | 'canary';

export interface PromptCanaryConfig {
  scopeKind: ScopeKind;
  scopeId: string;
  enabled: boolean;
  candidateVersion: number | null;
  trafficPercent: number;
  publishedImpressions: number;
  publishedErrors: number;
  publishedTotalLatencyMs: number;
  publishedAvgLatencyMs: number;
  canaryImpressions: number;
  canaryErrors: number;
  canaryTotalLatencyMs: number;
  canaryAvgLatencyMs: number;
  updatedBy: number | null;
  updatedAt: string | null;
}

export interface PromptCanaryUpdateInput {
  enabled: boolean;
  candidateVersion: number | null;
  trafficPercent: number;
  resetMetrics?: boolean;
}

export interface PromptCanaryResponse {
  canary: PromptCanaryConfig;
}

export interface PromptCanaryActionResponse {
  canary: PromptCanaryConfig;
  publishedVersion: number | null;
  revision: number;
}

// ── Real-Time SSE Credential Scrubber Settings DTOs ───────────────────────────

export interface CredentialScrubSettings {
  scopeKind: ScopeKind;
  scopeId: string;
  credentialStreamScrubEnabled: boolean;
  updatedBy: number | null;
  updatedAt: string | null;
}

export interface CredentialScrubSettingsInput {
  credentialStreamScrubEnabled: boolean;
}

export interface CredentialScrubSettingsResponse {
  settings: CredentialScrubSettings;
}
