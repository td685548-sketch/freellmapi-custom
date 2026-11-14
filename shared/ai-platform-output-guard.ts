import type { Scope, ScopeKind, Wire } from './ai-platform.js';
import type { TokenUsage } from './types.js';

export type { Scope, ScopeKind, Wire, TokenUsage };

// ── Constants & Limits ────────────────────────────────────────────────────────

export const GUARD_HEADER_NAME = 'x-freellm-guard' as const;
export const GUARD_DEFAULT_END_USER_ROLE = 'user' as const;
export const GUARD_DEFAULT_REPLACEMENT_TEXT = 'This response was blocked by the output guard.' as const;

/**
 * Character-based limits use UTF-16 code units (`string.length`), consistent with
 * JS/TypeScript string indexing and SQLite TEXT length checks.
 * Byte-based limits (`maxStreamBufferBytes`) use UTF-8 byte length.
 */
export const OUTPUT_GUARD_LIMITS = {
  maxKeywords: 200,
  keywordMaxChars: 80,
  maxPatterns: 20,
  patternMaxChars: 200,
  patternIdMaxChars: 64,
  patternNameMaxChars: 120,
  patternEvalBudgetMs: 5,
  patternRuntimeBudgetMs: 25,
  patternEvalSampleChars: 10_000,
  minHoldChars: 0,
  defaultHoldChars: 200,
  maxHoldChars: 2_000,
  minDelayMs: 0,
  defaultMaxDelayMs: 300,
  maxDelayMs: 2_000,
  replacementMaxChars: 1_000,
  maxBypassRoles: 20,
  bypassRoleMaxChars: 64,
  minShingles: 1,
  defaultMinShingles: 2,
  maxMinShingles: 20,
  shingleWords: 12,
  minLengthChars: 1,
  defaultMaxLengthChars: 20_000,
  hardMaxLengthChars: 1_000_000,
  judgeModelMaxChars: 128,
  judgeCriteriaMaxChars: 2_000,
  judgeMaxOutputTokens: 256,
  externalTimeoutMs: 10_000,
  excerptMaxChars: 500,
  excerptTtlDays: 7,
  eventsRetentionDays: 90,
  defaultListLimit: 50,
  maxListLimit: 200,
  maxTestTextChars: 100_000,
  eventRateLimitWindowMs: 60_000,
  eventRateLimitMaxPerKey: 10,
  eventRateLimitMaxKeys: 10_000,
  maxStreamBufferBytes: 4 * 1024 * 1024,
} as const;

export const GUARD_ALLOWED_PATTERN_FLAGS = ['i', 'm', 'u', 's'] as const;

// ── Enums & Unions ────────────────────────────────────────────────────────────

export type GuardMode = 'off' | 'log' | 'block';
export type GuardFailMode = 'allow' | 'block';
export type GuardPiiAction = 'mask' | 'block';

export type GuardDetectorId =
  | 'keywords'
  | 'patterns'
  | 'promptLeak'
  | 'pii'
  | 'maxLength'
  | 'moderation'
  | 'judge';

export type GuardEventAction =
  | 'logged'
  | 'blocked'
  | 'masked'
  | 'bypassed'
  | 'check_failed';

export type GuardEvalAction = 'pass' | 'logged' | 'masked' | 'blocked';

export type GuardWire = Wire | 'support';

export type GuardBufferingReason =
  | 'none'
  | 'streaming_window'
  | 'unbounded_pattern'
  | 'custom_pattern'
  | 'external_detector'
  | 'non_stream';

// ── Detector Configuration DTOs ───────────────────────────────────────────────

export interface GuardKeywordsConfig {
  enabled: boolean;
  terms: string[];
}

export interface GuardPatternRule {
  id: string;
  name: string;
  pattern: string;
  flags: string;
}

export interface GuardPatternsConfig {
  enabled: boolean;
  rules: GuardPatternRule[];
}

export interface GuardPromptLeakConfig {
  enabled: boolean;
  minShingles: number;
}

export interface GuardPiiConfig {
  enabled: boolean;
  action: GuardPiiAction;
}

export interface GuardMaxLengthConfig {
  enabled: boolean;
  chars: number;
}

export interface GuardModerationConfig {
  enabled: boolean;
}

export interface GuardJudgeConfig {
  enabled: boolean;
  model: string;
  criteria: string;
}

export interface GuardDetectorsConfig {
  keywords: GuardKeywordsConfig;
  patterns: GuardPatternsConfig;
  promptLeak: GuardPromptLeakConfig;
  pii: GuardPiiConfig;
  maxLength: GuardMaxLengthConfig;
  moderation: GuardModerationConfig;
  judge: GuardJudgeConfig;
}

export const DEFAULT_GUARD_DETECTORS: Readonly<GuardDetectorsConfig> = {
  keywords: { enabled: true, terms: [] },
  patterns: { enabled: false, rules: [] },
  promptLeak: { enabled: true, minShingles: OUTPUT_GUARD_LIMITS.defaultMinShingles },
  pii: { enabled: true, action: 'mask' },
  maxLength: { enabled: false, chars: OUTPUT_GUARD_LIMITS.defaultMaxLengthChars },
  moderation: { enabled: false },
  judge: { enabled: false, model: 'auto', criteria: '' },
};

export const DEFAULT_GUARD_POLICY_BASE = {
  mode: 'off' as GuardMode,
  replacementText: GUARD_DEFAULT_REPLACEMENT_TEXT,
  failMode: 'allow' as GuardFailMode,
  bypassRoles: [] as string[],
  holdChars: OUTPUT_GUARD_LIMITS.defaultHoldChars,
  maxDelayMs: OUTPUT_GUARD_LIMITS.defaultMaxDelayMs,
} as const;

// ── Policy Public DTOs ────────────────────────────────────────────────────────

export interface GuardPolicyInput {
  mode: GuardMode;
  detectors: GuardDetectorsConfig;
  replacementText: string;
  failMode: GuardFailMode;
  bypassRoles: string[];
  holdChars: number;
  maxDelayMs: number;
  revision: number;
}

export interface GuardPolicyView extends GuardPolicyInput {
  scopeKind: ScopeKind;
  scopeId: string;
  updatedBy: number | null;
  updatedAt: string | null;
  bufferingReason: GuardBufferingReason;
}

// ── Event Public DTOs (strictly metadata; never expose cipher/iv/tag/text) ────

export interface GuardEventView {
  id: number;
  scopeKind: ScopeKind;
  scopeId: string;
  endUser: string | null;
  detector: GuardDetectorId;
  action: GuardEventAction;
  wire: GuardWire;
  streamed: boolean;
  runId: string | null;
  hasExcerpt: boolean;
  excerptExpired: boolean;
  excerptExpiresAt: string | null;
  createdAt: string;
}

export interface GuardEventsQuery {
  scope?: string;
  detector?: GuardDetectorId;
  action?: GuardEventAction;
  before?: string;
  limit?: number;
}

// ── Evaluation & Wire Metadata DTOs ───────────────────────────────────────────

export interface GuardEvaluateResult {
  action: GuardEvalAction;
  text: string;
  reason?: GuardDetectorId;
  triggered?: GuardDetectorId[];
}

export interface GuardTerminalMeta {
  action: GuardEvalAction;
  reason?: GuardDetectorId;
}

// ── Admin API Envelopes ───────────────────────────────────────────────────────

export interface GuardPolicyResponse {
  policy: GuardPolicyView;
}

export interface GuardTestRequest {
  text: string;
  role?: string;
  policy?: GuardPolicyInput;
  includeExternal?: boolean;
}

export interface GuardTestTriggeredHit {
  detector: GuardDetectorId;
  match: string;
}

export interface GuardTestResponse {
  action: GuardEvalAction;
  triggered: GuardTestTriggeredHit[];
  maskedText: string;
  buffering: boolean;
  bufferingReason: GuardBufferingReason;
  warnings?: string[];
}

export interface GuardEventsListResponse {
  events: GuardEventView[];
  nextBefore: string | null;
}

export interface GuardEventExcerptResponse {
  excerpt: string;
  expiresAt: string;
}

export type GuardErrorCode =
  | 'missing_permission'
  | 'invalid_scope'
  | 'scope_not_found'
  | 'scope_unavailable'
  | 'not_found'
  | 'revision_conflict'
  | 'pillar_disabled'
  | 'excerpt_expired'
  | 'validation_error'
  | 'unsafe_pattern'
  | 'invalid_limit'
  | 'invalid_cursor';
