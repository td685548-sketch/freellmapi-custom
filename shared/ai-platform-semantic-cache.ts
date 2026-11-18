import type { Scope, ScopeKind, Wire } from './ai-platform.js';

export type { Scope, ScopeKind, Wire };

export const SEMANTIC_CACHE_HEADER_NAME = 'X-FreeLLM-Semantic-Cache' as const;
export const SEMANTIC_CACHE_SCORE_HEADER_NAME = 'X-FreeLLM-Cache-Score' as const;
export const SEMANTIC_CACHE_CONTROL_HEADER_NAME = 'X-FreeLLM-Cache' as const;

export const SEMANTIC_CACHE_LIMITS = {
  defaultMinSimilarity: 0.94,
  minAllowedSimilarity: 0,
  maxAllowedSimilarity: 1,
  defaultMaxTemperature: 0.2,
  minAllowedTemperature: 0,
  maxAllowedTemperature: 2,
  defaultTtlSeconds: 3600,
  minTtlSeconds: 1,
  maxTtlSeconds: 2_592_000, // 30 days
  defaultMaxEntries: 1000,
  minMaxEntries: 1,
  maxMaxEntries: 50_000,
  maxMemoryEntryBytes: 256 * 1024,
  maxDbEntryBytes: 2 * 1024 * 1024,
  maxTotalMemoryBytes: 32 * 1024 * 1024,
  maxPreviewQueryChars: 8_000,
  embeddingTimeoutMs: 1_500,
  recentEntriesPreviewLimit: 20,
} as const;

export type SemanticCacheLookupStatus =
  | 'EXACT_HIT'
  | 'SEMANTIC_HIT'
  | 'MISS'
  | 'BYPASSED';

export type SemanticCacheBypassReason =
  | 'disabled'
  | 'cache_header_off'
  | 'cache_control_no_store'
  | 'temperature_too_high'
  | 'request_has_tool_calls'
  | 'response_has_tool_calls'
  | 'response_truncated'
  | 'personal_vars_unisolated'
  | 'empty_query'
  | 'non_chat_wire';

export interface SemanticCacheConfig {
  enabled: boolean;
  semanticEnabled: boolean;
  minSimilarity: number;
  maxTemperature: number;
  ttlSeconds: number;
  maxEntries: number;
  persistToDb: boolean;
  isolateByEndUser: boolean;
}

export const DEFAULT_SEMANTIC_CACHE_CONFIG: Readonly<SemanticCacheConfig> = {
  enabled: false,
  semanticEnabled: true,
  minSimilarity: SEMANTIC_CACHE_LIMITS.defaultMinSimilarity,
  maxTemperature: SEMANTIC_CACHE_LIMITS.defaultMaxTemperature,
  ttlSeconds: SEMANTIC_CACHE_LIMITS.defaultTtlSeconds,
  maxEntries: SEMANTIC_CACHE_LIMITS.defaultMaxEntries,
  persistToDb: true,
  isolateByEndUser: false,
};

export interface SemanticCacheSettings extends SemanticCacheConfig {
  scopeKind: ScopeKind;
  scopeId: string;
  updatedAt: string | null;
}

export type SemanticCacheSettingsInput = Partial<SemanticCacheConfig>;

export interface SemanticCacheStats {
  exactHits: number;
  semanticHits: number;
  misses: number;
  bypassed: number;
  tokensSavedEst: number;
  entriesCount: number;
  memoryEntriesCount: number;
  hitRate: number;
}

export interface SemanticCacheEntrySummary {
  id: string;
  scopeKind: ScopeKind;
  scopeId: string;
  endUserScope: string;
  wire: Wire;
  model: string;
  contractHash: string;
  promptVersionHash: string;
  exactHash: string;
  hasEmbedding: boolean;
  embeddingModel: string | null;
  embeddingDims: number | null;
  tokensSaved: number;
  hitCount: number;
  createdAt: string;
  expiresAt: string;
}

export interface SemanticCacheSettingsResponse {
  scope: Scope;
  settings: SemanticCacheSettings;
}

export interface SemanticCacheStatsResponse {
  scope: Scope;
  stats: SemanticCacheStats;
  recentEntries: SemanticCacheEntrySummary[];
}

export interface SemanticCacheFlushRequest {
  resetMetrics?: boolean;
  model?: string;
  endUser?: string;
}

export interface SemanticCacheFlushResponse {
  ok: true;
  scope: Scope;
  deletedEntries: number;
  metricsReset: boolean;
}

export interface SemanticCacheLookupPreviewRequest {
  query?: string;
  messages?: Array<{ role: string; content: unknown; [key: string]: unknown }>;
  model?: string;
  wire?: Wire;
  temperature?: number;
  endUser?: string;
  vars?: Record<string, string | number | boolean>;
  cacheHeader?: string;
  cacheControl?: string;
  tools?: unknown;
  tool_choice?: unknown;
  response_format?: unknown;
  reasoning_effort?: unknown;
  thinking?: unknown;
  seed?: number;
  max_tokens?: number;
  stop?: unknown;
  modalities?: unknown;
}

export interface SemanticCacheLookupPreviewResponse {
  scope: Scope;
  status: SemanticCacheLookupStatus;
  bypassReason?: SemanticCacheBypassReason;
  score: number | null;
  contractHash: string;
  promptVersionHash: string;
  exactHash: string;
  semanticAvailable: boolean;
  latencyMs: number;
  matchedEntry: SemanticCacheEntrySummary | null;
  cachedResponsePreview: string | null;
}
