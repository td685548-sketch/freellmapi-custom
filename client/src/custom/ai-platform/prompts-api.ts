/**
 * AI Platform Versioned Prompts API client (US6 / T113, T114).
 *
 * Uses shared DTOs from shared/ai-platform-prompts.ts directly and preserves
 * structured 422 template validation (`line`, `column`, `reason`) and
 * 409 conflict (`revision_conflict` with `current`, `pillar_disabled`) payloads.
 */

import * as libApi from '@/lib/api';
import { getSessionRevision } from '@/custom/session-state';
import type { Scope, ScopeKind } from '../../../../shared/ai-platform';
import {
  PROMPT_LIMITS,
  PROMPT_VAR_NAME_REGEX,
  SYSTEM_PROMPT_VARIABLES,
  SYSTEM_PROMPT_VARIABLE_NAMES,
  type PromptAbUpdateRequest,
  type PromptDiffLine,
  type PromptDiffResponse,
  type PromptDiffStats,
  type PromptDraftInput,
  type PromptEvalCase,
  type PromptEvalCaseComparison,
  type PromptEvalCaseInput,
  type PromptEvalRun,
  type PromptEvalVariantMetrics,
  type PromptEvalVariantOutcome,
  type PromptEvaluateRequest,
  type PromptHead,
  type PromptPreviewRequest,
  type PromptPreviewResponse,
  type PromptPublishRequest,
  type PromptRestoreRequest,
  type PromptScopeStateResponse,
  type PromptTryRequest,
  type PromptTryResponse,
  type PromptVariable,
  type PromptVariableSource,
  type PromptVersion,
  type PromptVersionResponse,
  type PromptVersionStatus,
  type PromptVersionSummary,
  type SystemPromptVariableDescriptor,
} from '../../../../shared/ai-platform-prompts';

export type {
  PromptAbUpdateRequest,
  PromptDiffLine,
  PromptDiffResponse,
  PromptDiffStats,
  PromptDraftInput,
  PromptEvalCase,
  PromptEvalCaseComparison,
  PromptEvalCaseInput,
  PromptEvalRun,
  PromptEvalVariantMetrics,
  PromptEvalVariantOutcome,
  PromptEvaluateRequest,
  PromptHead,
  PromptPreviewRequest,
  PromptPreviewResponse,
  PromptPublishRequest,
  PromptRestoreRequest,
  PromptScopeStateResponse,
  PromptTryRequest,
  PromptTryResponse,
  PromptVariable,
  PromptVariableSource,
  PromptVersion,
  PromptVersionResponse,
  PromptVersionStatus,
  PromptVersionSummary,
  Scope,
  ScopeKind,
  SystemPromptVariableDescriptor,
};

export {
  PROMPT_LIMITS,
  PROMPT_VAR_NAME_REGEX,
  SYSTEM_PROMPT_VARIABLES,
  SYSTEM_PROMPT_VARIABLE_NAMES,
};

export interface ProfileOption {
  id: number;
  name: string;
}

export interface SupportTenantOption {
  id: string;
  name: string;
}

export interface PromptVariablesCatalogResponse {
  variables: SystemPromptVariableDescriptor[];
}

export type PromptMutationResponse =
  | { version?: PromptVersion; head?: PromptHead; scope?: Scope }
  | PromptScopeStateResponse;

export class PromptsApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly errorType?: string;
  readonly line?: number;
  readonly column?: number;
  readonly reason?: string;
  readonly current?: PromptScopeStateResponse;

  constructor(
    message: string,
    opts: {
      status: number;
      code?: string;
      errorType?: string;
      line?: number;
      column?: number;
      reason?: string;
      current?: PromptScopeStateResponse;
    },
  ) {
    super(message);
    this.name = 'PromptsApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.errorType = opts.errorType;
    this.line = opts.line;
    this.column = opts.column;
    this.reason = opts.reason;
    this.current = opts.current;
  }
}

export interface PromptErrorInfo {
  status?: number;
  code?: string;
  message: string;
  line?: number;
  column?: number;
  reason?: string;
  current?: PromptScopeStateResponse;
}

export function getPromptErrorInfo(err: unknown): PromptErrorInfo {
  if (err instanceof PromptsApiError) {
    return {
      status: err.status,
      code: err.code,
      message: err.message,
      line: err.line,
      column: err.column,
      reason: err.reason,
      current: err.current,
    };
  }
  if (err && typeof err === 'object') {
    const rec = err as {
      status?: unknown;
      code?: unknown;
      message?: unknown;
      line?: unknown;
      column?: unknown;
      reason?: unknown;
      current?: unknown;
    };
    return {
      status: typeof rec.status === 'number' ? rec.status : undefined,
      code: typeof rec.code === 'string' ? rec.code : undefined,
      message: typeof rec.message === 'string' && rec.message ? rec.message : 'Request failed',
      line: typeof rec.line === 'number' ? rec.line : undefined,
      column: typeof rec.column === 'number' ? rec.column : undefined,
      reason: typeof rec.reason === 'string' ? rec.reason : undefined,
      current: rec.current && typeof rec.current === 'object'
        ? (rec.current as PromptScopeStateResponse)
        : undefined,
    };
  }
  return { message: typeof err === 'string' && err ? err : 'Request failed' };
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const TOKEN_KEY = 'freellmapi_dashboard_token';
const UNAUTHORIZED_EVENT = 'freellmapi:unauthorized';

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

async function promptsFetch<T>(path: string, options?: RequestInit): Promise<T> {
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
      error?: string | {
        message?: string;
        type?: string;
        code?: string;
        line?: number;
        column?: number;
        reason?: string;
        current?: PromptScopeStateResponse;
      };
      line?: number;
      column?: number;
      reason?: string;
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

    const line = typeof rawBody?.line === 'number'
      ? rawBody.line
      : typeof errorObj?.line === 'number'
        ? errorObj.line
        : undefined;
    const column = typeof rawBody?.column === 'number'
      ? rawBody.column
      : typeof errorObj?.column === 'number'
        ? errorObj.column
        : undefined;
    const reason = typeof rawBody?.reason === 'string'
      ? rawBody.reason
      : typeof errorObj?.reason === 'string'
        ? errorObj.reason
        : undefined;

    throw new PromptsApiError(message, {
      status: res.status,
      code: typeof errorObj?.code === 'string'
        ? errorObj.code
        : typeof errorObj?.type === 'string'
          ? errorObj.type
          : undefined,
      errorType: typeof errorObj?.type === 'string' ? errorObj.type : undefined,
      line,
      column,
      reason,
      current: errorObj?.current,
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
    throw new PromptsApiError(
      `Expected JSON from ${path} but got a non-JSON response.`,
      { status: res.status, code: 'invalid_json_response' },
    );
  }
}

export function scopeToPath(scope: Scope): string {
  const kindSegment = scope.kind === 'support_tenant' ? 'support-tenant' : scope.kind;
  return `${kindSegment}/${encodeURIComponent(scope.id)}`;
}

/**
 * Extracts {{var_name}} references from a prompt body and returns any dynamic
 * per-request variables (built-in dynamic system vars + declared `caller` vars)
 * whose values change across requests and therefore invalidate provider prompt
 * cache prefixes.
 */
export function detectDynamicVariablesInBody(
  body: string,
  variables: readonly PromptVariable[],
  systemCatalog: readonly SystemPromptVariableDescriptor[] = SYSTEM_PROMPT_VARIABLES,
): string[] {
  const dynamicSystemNames = new Set(
    systemCatalog.filter((v) => v.dynamicPerRequest).map((v) => v.name),
  );
  const callerNames = new Set(
    variables.filter((v) => v.source === 'caller').map((v) => v.name),
  );

  const found: string[] = [];
  const seen = new Set<string>();
  const pattern = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;
  for (const match of body.matchAll(pattern)) {
    const name = match[1];
    if (!name || seen.has(name)) continue;
    if (dynamicSystemNames.has(name) || callerNames.has(name)) {
      seen.add(name);
      found.push(name);
    }
  }
  return found;
}

// ─── Query keys (include sessionRevision & scope) ─────────────────────────────

export function promptVariablesKey(sessionRevision: number): [string, number] {
  return ['ai-platform/prompts/variables', sessionRevision];
}

export function promptScopeKey(sessionRevision: number, scope: Scope): [string, number, string, string] {
  return ['ai-platform/prompts/scope', sessionRevision, scope.kind, scope.id];
}

export function promptDiffKey(
  sessionRevision: number,
  scope: Scope,
  fromVersion: number | null,
  toVersion: number | null,
): [string, number, string, string, number | null, number | null] {
  return ['ai-platform/prompts/diff', sessionRevision, scope.kind, scope.id, fromVersion, toVersion];
}

// ─── API calls ────────────────────────────────────────────────────────────────

export async function fetchSystemPromptVariables(
  signal?: AbortSignal,
): Promise<PromptVariablesCatalogResponse> {
  return promptsFetch<PromptVariablesCatalogResponse>('/api/ai-platform/prompts/variables', { signal });
}

export async function fetchPromptScopeState(
  scope: Scope,
  signal?: AbortSignal,
): Promise<PromptScopeStateResponse> {
  return promptsFetch<PromptScopeStateResponse>(`/api/ai-platform/prompts/${scopeToPath(scope)}`, {
    signal,
  });
}

export async function fetchPromptVersion(
  scope: Scope,
  version: number,
  signal?: AbortSignal,
): Promise<PromptVersionResponse> {
  return promptsFetch<PromptVersionResponse>(
    `/api/ai-platform/prompts/${scopeToPath(scope)}/versions/${encodeURIComponent(String(version))}`,
    { signal },
  );
}

export async function fetchPromptDiff(
  scope: Scope,
  fromVersion: number,
  toVersion: number,
  signal?: AbortSignal,
): Promise<PromptDiffResponse> {
  const params = new URLSearchParams({
    from: String(fromVersion),
    to: String(toVersion),
  });
  return promptsFetch<PromptDiffResponse>(
    `/api/ai-platform/prompts/${scopeToPath(scope)}/diff?${params.toString()}`,
    { signal },
  );
}

export async function savePromptDraft(
  scope: Scope,
  input: PromptDraftInput,
  signal?: AbortSignal,
): Promise<PromptMutationResponse> {
  return promptsFetch<PromptMutationResponse>(`/api/ai-platform/prompts/${scopeToPath(scope)}/draft`, {
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  });
}

export async function discardPromptDraft(
  scope: Scope,
  revision?: number,
  signal?: AbortSignal,
): Promise<PromptMutationResponse> {
  const init: RequestInit = {
    method: 'DELETE',
    signal,
  };
  if (revision !== undefined) {
    init.body = JSON.stringify({ revision });
  }
  return promptsFetch<PromptMutationResponse>(`/api/ai-platform/prompts/${scopeToPath(scope)}/draft`, init);
}

export async function publishPrompt(
  scope: Scope,
  input: PromptPublishRequest,
  signal?: AbortSignal,
): Promise<PromptMutationResponse> {
  return promptsFetch<PromptMutationResponse>(`/api/ai-platform/prompts/${scopeToPath(scope)}/publish`, {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

export async function restorePromptVersion(
  scope: Scope,
  input: PromptRestoreRequest,
  signal?: AbortSignal,
): Promise<PromptMutationResponse> {
  return promptsFetch<PromptMutationResponse>(`/api/ai-platform/prompts/${scopeToPath(scope)}/restore`, {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

export async function previewPrompt(
  scope: Scope,
  input: PromptPreviewRequest,
  signal?: AbortSignal,
): Promise<PromptPreviewResponse> {
  return promptsFetch<PromptPreviewResponse>(`/api/ai-platform/prompts/${scopeToPath(scope)}/preview`, {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

export async function tryPrompt(
  scope: Scope,
  input: PromptTryRequest,
  signal?: AbortSignal,
): Promise<PromptTryResponse> {
  return promptsFetch<PromptTryResponse>(`/api/ai-platform/prompts/${scopeToPath(scope)}/try`, {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

export async function fetchPromptProfileOptions(signal?: AbortSignal): Promise<ProfileOption[]> {
  const raw = await libApi.apiFetch<
    Array<{ id: number; name: string }> | { profiles?: Array<{ id: number; name: string }> }
  >('/api/profiles', { signal });
  const list = Array.isArray(raw) ? raw : raw.profiles ?? [];
  return list.map((p) => ({ id: p.id, name: p.name }));
}

export async function fetchPromptSupportTenantOptions(
  signal?: AbortSignal,
): Promise<SupportTenantOption[]> {
  const raw = await libApi.apiFetch<{
    tenants?: Array<{ id: number | string; name?: string; slug?: string }>;
  }>('/api/thruline/support/tenants', { signal });
  return (raw.tenants ?? []).map((t) => ({
    id: String(t.id),
    name: t.name ?? t.slug ?? String(t.id),
  }));
}

export async function updatePromptAbSplit(
  scope: Scope,
  input: PromptAbUpdateRequest,
  signal?: AbortSignal,
): Promise<{ head: PromptHead }> {
  return promptsFetch<{ head: PromptHead }>(`/api/ai-platform/prompts/${scopeToPath(scope)}/ab`, {
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  });
}

export async function fetchPromptEvalCases(
  scope: Scope,
  signal?: AbortSignal,
): Promise<{ cases: PromptEvalCase[] }> {
  return promptsFetch<{ cases: PromptEvalCase[] }>(
    `/api/ai-platform/prompts/${scopeToPath(scope)}/eval-cases`,
    { signal },
  );
}

export async function createPromptEvalCase(
  scope: Scope,
  input: PromptEvalCaseInput,
  signal?: AbortSignal,
): Promise<{ case: PromptEvalCase }> {
  return promptsFetch<{ case: PromptEvalCase }>(
    `/api/ai-platform/prompts/${scopeToPath(scope)}/eval-cases`,
    {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    },
  );
}

export async function updatePromptEvalCase(
  scope: Scope,
  caseId: number,
  input: Partial<PromptEvalCaseInput>,
  signal?: AbortSignal,
): Promise<{ case: PromptEvalCase }> {
  return promptsFetch<{ case: PromptEvalCase }>(
    `/api/ai-platform/prompts/${scopeToPath(scope)}/eval-cases/${encodeURIComponent(String(caseId))}`,
    {
      method: 'PUT',
      body: JSON.stringify(input),
      signal,
    },
  );
}

export async function deletePromptEvalCase(
  scope: Scope,
  caseId: number,
  signal?: AbortSignal,
): Promise<{ deleted: boolean }> {
  return promptsFetch<{ deleted: boolean }>(
    `/api/ai-platform/prompts/${scopeToPath(scope)}/eval-cases/${encodeURIComponent(String(caseId))}`,
    {
      method: 'DELETE',
      signal,
    },
  );
}

export async function fetchPromptEvalRuns(
  scope: Scope,
  signal?: AbortSignal,
): Promise<{ runs: PromptEvalRun[] }> {
  return promptsFetch<{ runs: PromptEvalRun[] }>(
    `/api/ai-platform/prompts/${scopeToPath(scope)}/eval-runs`,
    { signal },
  );
}

export async function runPromptEvaluationApi(
  scope: Scope,
  input: PromptEvaluateRequest,
  signal?: AbortSignal,
): Promise<{ run: PromptEvalRun }> {
  return promptsFetch<{ run: PromptEvalRun }>(
    `/api/ai-platform/prompts/${scopeToPath(scope)}/evaluate`,
    {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    },
  );
}
