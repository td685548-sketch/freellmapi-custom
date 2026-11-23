/**
 * AI Platform Multi-Scope Semantic Response Cache API client (Spec 030).
 */

import * as libApi from '@/lib/api';
import { getSessionRevision, notifySessionChanged } from '@/custom/session-state';
import {
  DEFAULT_SEMANTIC_CACHE_CONFIG,
  SEMANTIC_CACHE_CONTROL_HEADER_NAME,
  SEMANTIC_CACHE_HEADER_NAME,
  SEMANTIC_CACHE_LIMITS,
  SEMANTIC_CACHE_SCORE_HEADER_NAME,
  type Scope,
  type ScopeKind,
  type SemanticCacheBypassReason,
  type SemanticCacheConfig,
  type SemanticCacheEntrySummary,
  type SemanticCacheFlushRequest,
  type SemanticCacheFlushResponse,
  type SemanticCacheLookupPreviewRequest,
  type SemanticCacheLookupPreviewResponse,
  type SemanticCacheLookupStatus,
  type SemanticCacheSettings,
  type SemanticCacheSettingsInput,
  type SemanticCacheSettingsResponse,
  type SemanticCacheStats,
  type SemanticCacheStatsResponse,
  type Wire,
} from '@freellmapi/shared/ai-platform-semantic-cache.js';

export type {
  Scope,
  ScopeKind,
  SemanticCacheBypassReason,
  SemanticCacheConfig,
  SemanticCacheEntrySummary,
  SemanticCacheFlushRequest,
  SemanticCacheFlushResponse,
  SemanticCacheLookupPreviewRequest,
  SemanticCacheLookupPreviewResponse,
  SemanticCacheLookupStatus,
  SemanticCacheSettings,
  SemanticCacheSettingsInput,
  SemanticCacheSettingsResponse,
  SemanticCacheStats,
  SemanticCacheStatsResponse,
  Wire,
};

export {
  DEFAULT_SEMANTIC_CACHE_CONFIG,
  SEMANTIC_CACHE_CONTROL_HEADER_NAME,
  SEMANTIC_CACHE_HEADER_NAME,
  SEMANTIC_CACHE_LIMITS,
  SEMANTIC_CACHE_SCORE_HEADER_NAME,
};

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const UNAUTHORIZED_EVENT = 'freellmapi:unauthorized';

export class SemanticCacheApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly errorType?: string;

  constructor(
    message: string,
    opts: { status: number; code?: string; errorType?: string },
  ) {
    super(message);
    this.name = 'SemanticCacheApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.errorType = opts.errorType;
  }
}

export function getSemanticCacheErrorInfo(err: unknown): {
  status?: number;
  code?: string;
  message: string;
} {
  if (err instanceof SemanticCacheApiError) {
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

function readSessionRevision(): number {
  return typeof getSessionRevision === 'function' ? getSessionRevision() : 0;
}

async function semanticCacheFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const revision = readSessionRevision();
  const assertCurrentSession = () => {
    if (revision !== readSessionRevision()) {
      throw new DOMException('The dashboard session changed', 'AbortError');
    }
  };

  const headers = new Headers(options?.headers);
  const isFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData;
  if (!isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  // Phase 2 of the httpOnly-cookie move: the session rides the httpOnly
  // cookie; mutations additionally send the CSRF token (services/csrf.ts).
  // No token is read or sent by JS any more.
  const method = (options?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const csrf = libApi.getCsrfToken();
    if (csrf) headers.set(libApi.CSRF_HEADER_NAME, csrf);
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  assertCurrentSession();

  if (!res.ok) {
    const rawBody = (await res.json().catch(() => null)) as {
      error?: string | { message?: string; type?: string; code?: string };
    } | null;
    assertCurrentSession();

    const errorObj =
      rawBody && typeof rawBody.error === 'object' && rawBody.error !== null
        ? rawBody.error
        : undefined;

    if (res.status === 401 && errorObj?.type === 'authentication_error') {
      notifySessionChanged();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(libApi.UNAUTHORIZED_EVENT ?? UNAUTHORIZED_EVENT));
      }
    }

    const message =
      (typeof rawBody?.error === 'string' ? rawBody.error : errorObj?.message) ||
      res.statusText ||
      `HTTP ${res.status}`;

    throw new SemanticCacheApiError(message, {
      status: res.status,
      code:
        typeof errorObj?.code === 'string'
          ? errorObj.code
          : typeof errorObj?.type === 'string'
            ? errorObj.type
            : undefined,
      errorType: typeof errorObj?.type === 'string' ? errorObj.type : undefined,
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
    throw new SemanticCacheApiError(
      `Expected JSON from ${path} but received a non-JSON response.`,
      { status: res.status, code: 'invalid_json_response' },
    );
  }
}

export function semanticScopePath(scopeKind: ScopeKind, scopeId: string): string {
  const kindSegment = scopeKind === 'support_tenant' ? 'support-tenant' : scopeKind;
  return `${kindSegment}/${encodeURIComponent(scopeId)}`;
}

export function createDefaultSemanticCacheSettings(
  scopeKind: ScopeKind,
  scopeId: string,
): SemanticCacheSettings {
  return {
    scopeKind,
    scopeId,
    ...DEFAULT_SEMANTIC_CACHE_CONFIG,
    updatedAt: null,
  };
}

export function createDefaultSemanticCacheStats(): SemanticCacheStats {
  return {
    exactHits: 0,
    semanticHits: 0,
    misses: 0,
    bypassed: 0,
    tokensSavedEst: 0,
    entriesCount: 0,
    memoryEntriesCount: 0,
    hitRate: 0,
  };
}

export async function fetchSemanticCacheSettings(
  scopeKind: ScopeKind,
  scopeId: string,
  signal?: AbortSignal,
): Promise<SemanticCacheSettingsResponse> {
  return semanticCacheFetch<SemanticCacheSettingsResponse>(
    `/api/ai-platform/semantic-cache/${semanticScopePath(scopeKind, scopeId)}/settings`,
    { signal },
  );
}

export async function updateSemanticCacheSettings(
  scopeKind: ScopeKind,
  scopeId: string,
  input: SemanticCacheSettingsInput,
  signal?: AbortSignal,
): Promise<SemanticCacheSettingsResponse> {
  return semanticCacheFetch<SemanticCacheSettingsResponse>(
    `/api/ai-platform/semantic-cache/${semanticScopePath(scopeKind, scopeId)}/settings`,
    {
      method: 'PUT',
      body: JSON.stringify(input),
      signal,
    },
  );
}

export async function fetchSemanticCacheStats(
  scopeKind: ScopeKind,
  scopeId: string,
  signal?: AbortSignal,
): Promise<SemanticCacheStatsResponse> {
  return semanticCacheFetch<SemanticCacheStatsResponse>(
    `/api/ai-platform/semantic-cache/${semanticScopePath(scopeKind, scopeId)}/stats`,
    { signal },
  );
}

export async function flushSemanticCache(
  scopeKind: ScopeKind,
  scopeId: string,
  input?: SemanticCacheFlushRequest,
  signal?: AbortSignal,
): Promise<SemanticCacheFlushResponse> {
  return semanticCacheFetch<SemanticCacheFlushResponse>(
    `/api/ai-platform/semantic-cache/${semanticScopePath(scopeKind, scopeId)}/flush`,
    {
      method: 'POST',
      body: JSON.stringify(input ?? {}),
      signal,
    },
  );
}

export async function previewSemanticCacheLookup(
  scopeKind: ScopeKind,
  scopeId: string,
  input: SemanticCacheLookupPreviewRequest,
  signal?: AbortSignal,
): Promise<SemanticCacheLookupPreviewResponse> {
  return semanticCacheFetch<SemanticCacheLookupPreviewResponse>(
    `/api/ai-platform/semantic-cache/${semanticScopePath(scopeKind, scopeId)}/lookup-preview`,
    {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    },
  );
}
