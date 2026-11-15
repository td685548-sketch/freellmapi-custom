/**
 * Frozen external DTOs, constants, and notices for AI Support Output Controls (Spec 020).
 * Belongs to shared/support-output.ts (Agent 1 ownership).
 */

export type SupportOutputMode = 'off' | 'log' | 'enforce';

export type SupportOutputSurface = 'chat' | 'copilot';

export type SupportOutputReason =
  | 'blocked_term'
  | 'too_long'
  | 'credential'
  | 'inspection_limit';

export interface SupportOutputRule {
  id: string;
  text: string;
}

export interface SupportOutputPolicy {
  tenantId: number;
  version: number;
  mode: SupportOutputMode;
  blockedTerms: SupportOutputRule[];
  maxOutputChars: number;
  redactCredentials: boolean;
  updatedAt: string;
}

export interface SupportOutputLeaf {
  path: string;
  text: string;
}

export interface SupportOutputDecision {
  action: 'allow' | 'observe' | 'redact' | 'block';
  leaves: SupportOutputLeaf[];
  reasons: SupportOutputReason[];
  ruleIds: string[];
  redactionCount: number;
  policyVersion: number;
}

export interface SupportOutputMetadata {
  policyVersion: number;
  action: SupportOutputDecision['action'];
  reasons: SupportOutputReason[];
  redactionCount: number;
}

export interface SupportOutputEvent {
  id: string;
  tenantId: number;
  operationId: string;
  surface: SupportOutputSurface;
  policyVersion: number;
  action: SupportOutputDecision['action'];
  reasons: SupportOutputReason[];
  ruleIds: string[];
  redactionCount: number;
  createdAt: string;
}

export const SUPPORT_OUTPUT_LIMITS = {
  maxRules: 50,
  ruleIdMaxLength: 64,
  ruleTextMinLength: 1,
  ruleTextMaxLength: 100,
  maxOutputCharsMin: 256,
  maxOutputCharsMax: 64000,
  maxOutputCharsDefault: 16000,
  maxLeaves: 32,
  leafPathMaxLength: 128,
  maxTotalRawChars: 128000,
  eventsLimitMin: 1,
  eventsLimitMax: 100,
  eventsLimitDefault: 50,
  eventsCursorMaxLength: 512,
  eventsRetentionDays: 30,
  eventsMaxPerTenant: 10000,
} as const;

export const DEFAULT_SUPPORT_OUTPUT_POLICY: Omit<SupportOutputPolicy, 'tenantId'> = {
  version: 0,
  mode: 'off',
  blockedTerms: [],
  maxOutputChars: SUPPORT_OUTPUT_LIMITS.maxOutputCharsDefault,
  redactCredentials: false,
  updatedAt: '1970-01-01T00:00:00.000Z',
};

export const SUPPORT_OUTPUT_BLOCK_NOTICE =
  "This AI response was withheld by the organization's output policy. Please contact support.";

export const SUPPORT_OUTPUT_HISTORY_NOTICE =
  'This AI response is unavailable under the current output policy.';
