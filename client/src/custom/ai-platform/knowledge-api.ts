/**
 * AI Platform Semantic Retrieval & Knowledge API client (US4 / T087).
 *
 * Uses shared DTOs from @freellmapi/shared/ai-platform-retrieval.js directly
 * and preserves structured HTTP status + error code (e.g. 'pillar_disabled',
 * 'job_already_running') via KnowledgeApiError.
 */

import * as libApi from '@/lib/api';
import { getSessionRevision } from '@/custom/session-state';
import {
  CITATIONS_HEADER_NAME,
  RETRIEVAL_HEADER_NAME,
  RETRIEVAL_LIMITS,
  type CitationEntry,
  type EmbeddingChunkStatus,
  type EmbeddingUsagePurpose,
  type IndexJobReason,
  type IndexJobStatus,
  type RetrievalDegradedReason,
  type RetrievalEmbeddingModelOption,
  type RetrievalHit,
  type RetrievalIndexJobView,
  type RetrievalIndexStatus,
  type RetrievalMode,
  type RetrievalQueryRequest,
  type RetrievalQueryResponse,
  type RetrievalReindexResponse,
  type RetrievalScopeStatusResponse,
  type RetrievalSettingsInput,
  type RetrievalSettingsView,
  type RetrievalUsageResponse,
  type RetrievalUsageRow,
  type Scope,
  type ScopeKind,
  type Wire,
} from '@freellmapi/shared/ai-platform-retrieval.js';

export type {
  CitationEntry,
  EmbeddingChunkStatus,
  EmbeddingUsagePurpose,
  IndexJobReason,
  IndexJobStatus,
  RetrievalDegradedReason,
  RetrievalEmbeddingModelOption,
  RetrievalHit,
  RetrievalIndexJobView,
  RetrievalIndexStatus,
  RetrievalMode,
  RetrievalQueryRequest,
  RetrievalQueryResponse,
  RetrievalReindexResponse,
  RetrievalScopeStatusResponse,
  RetrievalSettingsInput,
  RetrievalSettingsView,
  RetrievalUsageResponse,
  RetrievalUsageRow,
  Scope,
  ScopeKind,
  Wire,
};

export { CITATIONS_HEADER_NAME, RETRIEVAL_HEADER_NAME, RETRIEVAL_LIMITS };

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const TOKEN_KEY = 'freellmapi_dashboard_token';
const UNAUTHORIZED_EVENT = 'freellmapi:unauthorized';

export class KnowledgeApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly errorType?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    opts: { status: number; code?: string; errorType?: string; details?: unknown },
  ) {
    super(message);
    this.name = 'KnowledgeApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.errorType = opts.errorType;
    this.details = opts.details;
  }
}

export function getKnowledgeErrorInfo(err: unknown): {
  status?: number;
  code?: string;
  message: string;
} {
  if (err instanceof KnowledgeApiError) {
    return { status: err.status, code: err.code, message: err.message };
  }
  if (err && typeof err === 'object') {
    const rec = err as { status?: unknown; code?: unknown; message?: unknown };
    return {
      status: typeof rec.status === 'number' ? rec.status : undefined,
      code: typeof rec.code === 'string' ? rec.code : undefined,
      message: typeof rec.message === 'string' && rec.message ? rec.message : 'Request failed',
    };
  }
  return { message: typeof err === 'string' && err ? err : 'Request failed' };
}

function readToken(): string | null {
  if (typeof libApi.getToken === 'function') {
    return libApi.getToken();
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function readSessionRevision(): number {
  return typeof getSessionRevision === 'function' ? getSessionRevision() : 0;
}

async function knowledgeFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = readToken();
  const revision = readSessionRevision();
  const assertCurrentSession = () => {
    if (revision !== readSessionRevision() || token !== readToken()) {
      throw new DOMException('The dashboard session changed', 'AbortError');
    }
  };

  const headers = new Headers(options?.headers);
  const isFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData;
  if (!isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  });
  assertCurrentSession();

  if (!res.ok) {
    const rawBody = (await res.json().catch(() => null)) as {
      error?: string | { message?: string; type?: string; code?: string; [key: string]: unknown };
    } | null;
    assertCurrentSession();

    const errorObj = rawBody && typeof rawBody.error === 'object' && rawBody.error !== null
      ? rawBody.error
      : undefined;

    if (res.status === 401 && errorObj?.type === 'authentication_error') {
      if (typeof libApi.clearToken === 'function') {
        libApi.clearToken();
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(libApi.UNAUTHORIZED_EVENT ?? UNAUTHORIZED_EVENT));
      }
    }

    const message =
      (typeof rawBody?.error === 'string' ? rawBody.error : errorObj?.message) ||
      res.statusText ||
      `HTTP ${res.status}`;

    throw new KnowledgeApiError(message, {
      status: res.status,
      code: typeof errorObj?.code === 'string' ? errorObj.code : typeof errorObj?.type === 'string' ? errorObj.type : undefined,
      errorType: typeof errorObj?.type === 'string' ? errorObj.type : undefined,
      details: errorObj,
    });
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  assertCurrentSession();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new KnowledgeApiError(
      `Expected JSON from ${path} but received a non-JSON response.`,
      { status: res.status, code: 'invalid_json_response' },
    );
  }
}

export function scopeToPath(scopeKind: ScopeKind, scopeId: string): string {
  const kindSegment = scopeKind === 'support_tenant' ? 'support-tenant' : scopeKind;
  return `${kindSegment}/${encodeURIComponent(scopeId)}`;
}

export function createDefaultRetrievalStatus(scopeKind: ScopeKind, scopeId: string): RetrievalScopeStatusResponse {
  return {
    scope: { kind: scopeKind, id: scopeId },
    settings: {
      scopeKind,
      scopeId,
      mode: 'keyword',
      embeddingModel: null,
      dimensions: RETRIEVAL_LIMITS.defaultDimensions,
      topK: RETRIEVAL_LIMITS.defaultTopK,
      minScore: RETRIEVAL_LIMITS.defaultMinScore,
      citationsEnabled: RETRIEVAL_LIMITS.defaultCitationsEnabled,
      updatedAt: null,
    },
    index: {
      generation: 0,
      totalChunks: 0,
      readyChunks: 0,
      pendingChunks: 0,
      errorChunks: 0,
      staleChunks: 0,
      ready: false,
      percentComplete: 0,
      indexedModel: null,
      indexedDimensions: null,
    },
    activeJob: null,
    recentJobs: [],
    availableModels: [],
  };
}

// ─── API calls ────────────────────────────────────────────────────────────────

export async function fetchRetrievalScope(
  scopeKind: ScopeKind,
  scopeId: string,
  signal?: AbortSignal,
): Promise<RetrievalScopeStatusResponse> {
  return knowledgeFetch<RetrievalScopeStatusResponse>(
    `/api/ai-platform/retrieval/${scopeToPath(scopeKind, scopeId)}`,
    { signal },
  );
}

export async function updateRetrievalSettings(
  scopeKind: ScopeKind,
  scopeId: string,
  input: RetrievalSettingsInput,
  signal?: AbortSignal,
): Promise<RetrievalScopeStatusResponse> {
  return knowledgeFetch<RetrievalScopeStatusResponse>(
    `/api/ai-platform/retrieval/${scopeToPath(scopeKind, scopeId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(input),
      signal,
    },
  );
}

export async function triggerRetrievalReindex(
  scopeKind: ScopeKind,
  scopeId: string,
  signal?: AbortSignal,
): Promise<RetrievalReindexResponse> {
  return knowledgeFetch<RetrievalReindexResponse>(
    `/api/ai-platform/retrieval/${scopeToPath(scopeKind, scopeId)}/reindex`,
    {
      method: 'POST',
      signal,
    },
  );
}

export async function runRetrievalTestQuery(
  scopeKind: ScopeKind,
  scopeId: string,
  input: RetrievalQueryRequest,
  signal?: AbortSignal,
): Promise<RetrievalQueryResponse> {
  return knowledgeFetch<RetrievalQueryResponse>(
    `/api/ai-platform/retrieval/${scopeToPath(scopeKind, scopeId)}/query`,
    {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    },
  );
}

export async function fetchRetrievalUsage(
  opts?: { days?: number; scopeKind?: ScopeKind; scopeId?: string },
  signal?: AbortSignal,
): Promise<RetrievalUsageResponse> {
  const params = new URLSearchParams();
  if (opts?.days !== undefined) params.set('days', String(opts.days));
  if (opts?.scopeKind) params.set('scopeKind', opts.scopeKind);
  if (opts?.scopeId?.trim()) params.set('scopeId', opts.scopeId.trim());
  const qs = params.toString();
  return knowledgeFetch<RetrievalUsageResponse>(
    `/api/ai-platform/retrieval/usage${qs ? `?${qs}` : ''}`,
    { signal },
  );
}
