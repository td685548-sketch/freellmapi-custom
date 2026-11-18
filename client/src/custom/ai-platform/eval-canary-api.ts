/**
 * Spec 034 — Client API bindings for Golden Prompt Evals, Weighted Canary Split,
 * and Real-Time SSE Credential Scrubber.
 */

import { apiFetch } from '@/lib/api';
import type { Scope, ScopeKind } from '../../../../shared/ai-platform';
import {
  EVAL_CANARY_LIMITS,
  PROMPT_VARIANT_HEADER,
  type CredentialScrubSettings,
  type CredentialScrubSettingsInput,
  type CredentialScrubSettingsResponse,
  type EvalAssertion,
  type EvalAssertionResult,
  type EvalAssertionType,
  type EvalCaseComparison,
  type EvalVariantCaseOutcome,
  type EvalVariantSummary,
  type PromptCanaryActionResponse,
  type PromptCanaryConfig,
  type PromptCanaryResponse,
  type PromptCanaryUpdateInput,
  type PromptEvalCase,
  type PromptEvalCaseInput,
  type PromptEvalCaseResponse,
  type PromptEvalCasesListResponse,
  type PromptEvalRun,
  type PromptEvalRunResponse,
  type PromptEvalRunsListResponse,
  type RunPromptEvalRequest,
} from '../../../../shared/ai-platform-eval-canary';

export type {
  CredentialScrubSettings,
  CredentialScrubSettingsInput,
  CredentialScrubSettingsResponse,
  EvalAssertion,
  EvalAssertionResult,
  EvalAssertionType,
  EvalCaseComparison,
  EvalVariantCaseOutcome,
  EvalVariantSummary,
  PromptCanaryActionResponse,
  PromptCanaryConfig,
  PromptCanaryResponse,
  PromptCanaryUpdateInput,
  PromptEvalCase,
  PromptEvalCaseInput,
  PromptEvalCaseResponse,
  PromptEvalCasesListResponse,
  PromptEvalRun,
  PromptEvalRunResponse,
  PromptEvalRunsListResponse,
  RunPromptEvalRequest,
  Scope,
  ScopeKind,
};

export { EVAL_CANARY_LIMITS, PROMPT_VARIANT_HEADER };

export function evalScopeToPath(scope: Scope): string {
  const kindSegment = scope.kind === 'support_tenant' ? 'support-tenant' : scope.kind;
  return `${kindSegment}/${encodeURIComponent(scope.id)}`;
}

export function createDefaultCanaryConfig(scope: Scope): PromptCanaryConfig {
  return {
    scopeKind: scope.kind,
    scopeId: scope.id,
    enabled: false,
    candidateVersion: null,
    trafficPercent: EVAL_CANARY_LIMITS.defaultTrafficPercent,
    publishedImpressions: 0,
    publishedErrors: 0,
    publishedTotalLatencyMs: 0,
    publishedAvgLatencyMs: 0,
    canaryImpressions: 0,
    canaryErrors: 0,
    canaryTotalLatencyMs: 0,
    canaryAvgLatencyMs: 0,
    updatedBy: null,
    updatedAt: null,
  };
}

export function createDefaultCredentialScrubSettings(scope: Scope): CredentialScrubSettings {
  return {
    scopeKind: scope.kind,
    scopeId: scope.id,
    credentialStreamScrubEnabled: false,
    updatedBy: null,
    updatedAt: null,
  };
}

// ─── Prompt Golden Eval API ───────────────────────────────────────────────────

export async function fetchPromptEvalCases(
  scope: Scope,
  signal?: AbortSignal,
): Promise<PromptEvalCase[]> {
  const res = await apiFetch<Partial<PromptEvalCasesListResponse> | undefined>(
    `/api/ai-platform/prompts/${evalScopeToPath(scope)}/evals/cases`,
    { signal },
  );
  return Array.isArray(res?.cases) ? res.cases : [];
}

export async function createPromptEvalCase(
  scope: Scope,
  input: PromptEvalCaseInput,
  signal?: AbortSignal,
): Promise<PromptEvalCase | null> {
  const res = await apiFetch<Partial<PromptEvalCaseResponse> | undefined>(
    `/api/ai-platform/prompts/${evalScopeToPath(scope)}/evals/cases`,
    {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    },
  );
  return res?.evalCase ?? null;
}

export async function deletePromptEvalCase(
  scope: Scope,
  caseId: number,
  signal?: AbortSignal,
): Promise<void> {
  await apiFetch<unknown>(
    `/api/ai-platform/prompts/${evalScopeToPath(scope)}/evals/cases/${encodeURIComponent(String(caseId))}`,
    {
      method: 'DELETE',
      signal,
    },
  );
}

export async function fetchPromptEvalRuns(
  scope: Scope,
  limit = 5,
  signal?: AbortSignal,
): Promise<PromptEvalRun[]> {
  const res = await apiFetch<Partial<PromptEvalRunsListResponse> | undefined>(
    `/api/ai-platform/prompts/${evalScopeToPath(scope)}/evals/runs?limit=${encodeURIComponent(String(limit))}`,
    { signal },
  );
  return Array.isArray(res?.runs) ? res.runs : [];
}

export async function runPromptEvalSuite(
  scope: Scope,
  input: RunPromptEvalRequest,
  signal?: AbortSignal,
): Promise<PromptEvalRun | null> {
  const res = await apiFetch<Partial<PromptEvalRunResponse> | undefined>(
    `/api/ai-platform/prompts/${evalScopeToPath(scope)}/evals/run`,
    {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    },
  );
  return res?.run ?? null;
}

// ─── Prompt Weighted Canary API ───────────────────────────────────────────────

export async function fetchPromptCanary(
  scope: Scope,
  signal?: AbortSignal,
): Promise<PromptCanaryConfig> {
  const res = await apiFetch<Partial<PromptCanaryResponse> | undefined>(
    `/api/ai-platform/prompts/${evalScopeToPath(scope)}/canary`,
    { signal },
  );
  return res?.canary ?? createDefaultCanaryConfig(scope);
}

export async function putPromptCanary(
  scope: Scope,
  input: PromptCanaryUpdateInput,
  signal?: AbortSignal,
): Promise<PromptCanaryConfig> {
  const res = await apiFetch<Partial<PromptCanaryResponse> | undefined>(
    `/api/ai-platform/prompts/${evalScopeToPath(scope)}/canary`,
    {
      method: 'PUT',
      body: JSON.stringify(input),
      signal,
    },
  );
  return res?.canary ?? createDefaultCanaryConfig(scope);
}

export async function promotePromptCanary(
  scope: Scope,
  revision?: number,
  signal?: AbortSignal,
): Promise<PromptCanaryActionResponse | null> {
  const res = await apiFetch<PromptCanaryActionResponse | undefined>(
    `/api/ai-platform/prompts/${evalScopeToPath(scope)}/canary/promote`,
    {
      method: 'POST',
      body: JSON.stringify(revision !== undefined ? { revision } : {}),
      signal,
    },
  );
  return res ?? null;
}

export async function abortPromptCanary(
  scope: Scope,
  signal?: AbortSignal,
): Promise<PromptCanaryActionResponse | null> {
  const res = await apiFetch<PromptCanaryActionResponse | undefined>(
    `/api/ai-platform/prompts/${evalScopeToPath(scope)}/canary/abort`,
    {
      method: 'POST',
      body: JSON.stringify({}),
      signal,
    },
  );
  return res ?? null;
}

// ─── Credential Stream Scrubber API ───────────────────────────────────────────

export async function fetchCredentialScrubSettings(
  scope: Scope,
  signal?: AbortSignal,
): Promise<CredentialScrubSettings> {
  const res = await apiFetch<Partial<CredentialScrubSettingsResponse> | undefined>(
    `/api/ai-platform/output-guard/${evalScopeToPath(scope)}/credential-scrub`,
    { signal },
  );
  return res?.settings ?? createDefaultCredentialScrubSettings(scope);
}

export async function putCredentialScrubSettings(
  scope: Scope,
  input: CredentialScrubSettingsInput,
  signal?: AbortSignal,
): Promise<CredentialScrubSettings> {
  const res = await apiFetch<Partial<CredentialScrubSettingsResponse> | undefined>(
    `/api/ai-platform/output-guard/${evalScopeToPath(scope)}/credential-scrub`,
    {
      method: 'PUT',
      body: JSON.stringify(input),
      signal,
    },
  );
  return res?.settings ?? {
    ...createDefaultCredentialScrubSettings(scope),
    credentialStreamScrubEnabled: input.credentialStreamScrubEnabled,
  };
}
