import {
  AI_PLATFORM_LIMITS,
  type Scope,
  type ScopeKind,
  type Wire,
} from './ai-platform.js';

export type { Scope, ScopeKind, Wire };

// ── Constants & Limits ────────────────────────────────────────────────────────

export const CITATIONS_HEADER_NAME = 'x-freellm-citations' as const;
export const RETRIEVAL_HEADER_NAME = 'x-freellm-retrieval' as const;

export type RetrievalMode = 'keyword' | 'semantic' | 'hybrid';
export type IndexJobReason = 'doc_add' | 'doc_edit' | 'doc_delete' | 'reindex' | 'model_change';
export type IndexJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type EmbeddingChunkStatus = 'pending' | 'ready' | 'error';
export type EmbeddingUsagePurpose = 'index' | 'query';
export type RetrievalDegradedReason =
  | 'pillar_disabled'
  | 'no_model'
  | 'index_not_ready'
  | 'timeout'
  | 'embedding_error';

export const RETRIEVAL_LIMITS = {
  defaultMode: 'hybrid' as RetrievalMode,
  defaultModel: 'auto',
  defaultDimensions: AI_PLATFORM_LIMITS.retrievalDefaultDimensions,
  minDimensions: 64,
  maxDimensions: 4_096,
  defaultTopK: AI_PLATFORM_LIMITS.retrievalDefaultTopK,
  maxTopK: AI_PLATFORM_LIMITS.retrievalMaxTopK,
  defaultMinScore: AI_PLATFORM_LIMITS.retrievalDefaultMinScore,
  rrfK: AI_PLATFORM_LIMITS.retrievalRrfK,
  queryTimeoutMs: AI_PLATFORM_LIMITS.retrievalQueryTimeoutMs,
  indexBatchSize: AI_PLATFORM_LIMITS.retrievalIndexBatchSize,
  vectorCacheMaxBytes: AI_PLATFORM_LIMITS.retrievalVectorCacheMaxBytes,
  citationsHeaderMaxBytes: AI_PLATFORM_LIMITS.citationsHeaderMaxBytes,
  defaultCitationsEnabled: true,
  maxQueryChars: 4_000,
  maxModelNameChars: 128,
} as const;

// ── Settings & Index Status DTOs ──────────────────────────────────────────────

export interface RetrievalSettingsView {
  scopeKind: ScopeKind;
  scopeId: string;
  mode: RetrievalMode;
  embeddingModel: string | null;
  dimensions: number;
  topK: number;
  minScore: number;
  citationsEnabled: boolean;
  updatedAt: string | null;
}

export interface RetrievalSettingsInput {
  mode?: RetrievalMode;
  embeddingModel?: string | null;
  dimensions?: number;
  topK?: number;
  minScore?: number;
  citationsEnabled?: boolean;
}

export interface RetrievalIndexStatus {
  generation: number;
  totalChunks: number;
  readyChunks: number;
  pendingChunks: number;
  errorChunks: number;
  staleChunks: number;
  ready: boolean;
  percentComplete: number;
  indexedModel: string | null;
  indexedDimensions: number | null;
}

export interface RetrievalIndexJobView {
  id: number;
  scopeKind: ScopeKind;
  scopeId: string;
  reason: IndexJobReason;
  status: IndexJobStatus;
  model: string | null;
  totalChunks: number;
  processedChunks: number;
  lastError: string | null;
  retryAfter: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RetrievalEmbeddingModelOption {
  family: string;
  modelId: string;
  displayName: string;
  dimensions: number;
  platform: string;
}

export interface RetrievalScopeStatusResponse {
  scope: Scope;
  settings: RetrievalSettingsView;
  index: RetrievalIndexStatus;
  activeJob: RetrievalIndexJobView | null;
  recentJobs: RetrievalIndexJobView[];
  availableModels: RetrievalEmbeddingModelOption[];
}

export interface RetrievalReindexResponse {
  ok: true;
  job: RetrievalIndexJobView;
}

// ── Query, Hit & Citation DTOs ────────────────────────────────────────────────

export interface RetrievalHit {
  docId: string;
  chunkId: number;
  ord: number;
  title: string;
  snippet: string;
  text: string;
  score: number;
  keywordRank?: number;
  semanticRank?: number;
  sources: Array<'keyword' | 'semantic'>;
}

export interface CitationEntry {
  docId: string;
  chunkId: number;
  title: string;
  score: number;
  snippet: string;
}

export interface RetrievalQueryRequest {
  query: string;
  topK?: number;
  minScore?: number;
  mode?: RetrievalMode;
  roles?: string[];
}

export interface RetrievalQueryResponse {
  scope: Scope;
  query: string;
  modeRequested: RetrievalMode;
  modeUsed: RetrievalMode;
  degraded: boolean;
  degradedReason?: RetrievalDegradedReason;
  latencyMs: number;
  indexGeneration: number;
  hits: RetrievalHit[];
  citations: CitationEntry[];
}

// ── Usage DTOs ────────────────────────────────────────────────────────────────

export interface RetrievalUsageRow {
  day: string;
  scopeKind: ScopeKind;
  scopeId: string;
  model: string;
  purpose: EmbeddingUsagePurpose;
  inputTokens: number;
  requests: number;
}

export interface RetrievalUsageResponse {
  from: string;
  to: string;
  days: number;
  totals: {
    inputTokens: number;
    requests: number;
    indexTokens: number;
    queryTokens: number;
  };
  rows: RetrievalUsageRow[];
}
