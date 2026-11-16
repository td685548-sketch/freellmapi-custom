export const PROMPT_CACHE_SETTINGS_KEY = 'ai_platform_prompt_cache_v1' as const;

export const PROMPT_CACHE_LIMITS = {
  defaultMaxBreakpoints: 4,
  maxBreakpoints: 16,
  defaultMinTokens: 1024,
  maxMinTokens: 100_000,
  defaultTtlSeconds: 300,
  maxTtlSeconds: 86_400,
  defaultStatsDays: 30,
  maxStatsDays: 365,
  platformMaxChars: 64,
  modelPatternMaxChars: 128,
} as const;

export type PromptCacheMode = 'explicit' | 'implicit' | 'none';
export type PromptCacheCapabilitySource = 'builtin' | 'override';
export type PromptCacheGroupBy = 'day' | 'profile' | 'model';

export interface PromptCacheSettings {
  forward: boolean;
  autoBreakpoints: boolean;
  preferStickyRoute: boolean;
}

export const DEFAULT_PROMPT_CACHE_SETTINGS: Readonly<PromptCacheSettings> = {
  forward: true,
  autoBreakpoints: false,
  preferStickyRoute: false,
};

export interface PromptCacheCapability {
  platform: string;
  modelPattern: string;
  mode: PromptCacheMode;
  maxBreakpoints: number;
  minTokens: number;
  ttlSeconds: number;
  source: PromptCacheCapabilitySource;
  updatedAt: string;
}

export interface PromptCacheCapabilityInput {
  platform: string;
  modelPattern: string;
  mode: PromptCacheMode;
  maxBreakpoints?: number;
  minTokens?: number;
  ttlSeconds?: number;
}

export interface PromptCacheCapabilityDeleteInput {
  platform: string;
  modelPattern: string;
}

export interface PromptCacheStatsRow {
  key: string;
  requests: number;
  requestsWithHit: number;
  hitRate: number;
  requestHitRate: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estSavedUsd: number;
}

export interface PromptCacheStatsResponse {
  days: number;
  groupBy: PromptCacheGroupBy;
  rows: PromptCacheStatsRow[];
}

export interface PromptCacheSettingsResponse {
  settings: PromptCacheSettings;
}

export interface PromptCacheCapabilitiesResponse {
  capabilities: PromptCacheCapability[];
}

export interface PromptCacheCapabilityResponse {
  capability: PromptCacheCapability;
}

export interface PromptCacheCapabilityDeleteResponse {
  deleted: boolean;
}
