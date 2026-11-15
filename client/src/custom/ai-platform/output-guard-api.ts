/**
 * AI Platform Output Guard API client (US3 / T070).
 *
 * Uses shared DTOs directly from shared/ai-platform-output-guard.ts (C0).
 */

import { apiFetch } from '@/lib/api';
import type { Scope, ScopeKind } from '../../../../shared/ai-platform';
import {
  DEFAULT_GUARD_DETECTORS,
  DEFAULT_GUARD_POLICY_BASE,
  OUTPUT_GUARD_LIMITS,
  type GuardBufferingReason,
  type GuardDetectorId,
  type GuardDetectorsConfig,
  type GuardErrorCode,
  type GuardEvalAction,
  type GuardEventAction,
  type GuardEventExcerptResponse,
  type GuardEventsListResponse,
  type GuardEventView,
  type GuardFailMode,
  type GuardMode,
  type GuardPatternRule,
  type GuardPiiAction,
  type GuardPolicyInput,
  type GuardPolicyResponse,
  type GuardPolicyView,
  type GuardTestRequest,
  type GuardTestResponse,
  type GuardTestTriggeredHit,
} from '../../../../shared/ai-platform-output-guard';

export type {
  GuardBufferingReason,
  GuardDetectorId,
  GuardDetectorsConfig,
  GuardErrorCode,
  GuardEvalAction,
  GuardEventAction,
  GuardEventExcerptResponse,
  GuardEventsListResponse,
  GuardEventView,
  GuardFailMode,
  GuardMode,
  GuardPatternRule,
  GuardPiiAction,
  GuardPolicyInput,
  GuardPolicyResponse,
  GuardPolicyView,
  GuardTestRequest,
  GuardTestResponse,
  GuardTestTriggeredHit,
  Scope,
  ScopeKind,
};

export { DEFAULT_GUARD_DETECTORS, DEFAULT_GUARD_POLICY_BASE, OUTPUT_GUARD_LIMITS };

export interface GuardEventsFilter {
  scope?: Scope;
  detector?: string;
  action?: GuardEventAction | '';
  before?: string;
  limit?: number;
}

export interface ProfileOption {
  id: number;
  name: string;
}

export interface SupportTenantOption {
  id: string;
  name: string;
}

export function createDefaultGuardDetectors(): GuardDetectorsConfig {
  return {
    keywords: { ...DEFAULT_GUARD_DETECTORS.keywords, terms: [...DEFAULT_GUARD_DETECTORS.keywords.terms] },
    patterns: { ...DEFAULT_GUARD_DETECTORS.patterns, rules: [] },
    promptLeak: { ...DEFAULT_GUARD_DETECTORS.promptLeak },
    pii: { ...DEFAULT_GUARD_DETECTORS.pii },
    maxLength: { ...DEFAULT_GUARD_DETECTORS.maxLength },
    moderation: { ...DEFAULT_GUARD_DETECTORS.moderation },
    judge: { ...DEFAULT_GUARD_DETECTORS.judge },
  };
}

export function createDefaultGuardPolicy(scope: Scope): GuardPolicyView {
  return {
    scopeKind: scope.kind,
    scopeId: scope.id,
    mode: DEFAULT_GUARD_POLICY_BASE.mode,
    failMode: DEFAULT_GUARD_POLICY_BASE.failMode,
    detectors: createDefaultGuardDetectors(),
    replacementText: DEFAULT_GUARD_POLICY_BASE.replacementText,
    bypassRoles: [...DEFAULT_GUARD_POLICY_BASE.bypassRoles],
    holdChars: DEFAULT_GUARD_POLICY_BASE.holdChars,
    maxDelayMs: DEFAULT_GUARD_POLICY_BASE.maxDelayMs,
    revision: 0,
    updatedBy: null,
    updatedAt: null,
    bufferingReason: 'none',
  };
}

export function scopeToPath(scope: Scope): string {
  const kindSegment = scope.kind === 'support_tenant' ? 'support-tenant' : scope.kind;
  return `${kindSegment}/${encodeURIComponent(scope.id)}`;
}

// ─── Query keys (include sessionRevision & scope) ─────────────────────────────

export function guardPolicyKey(sessionRevision: number, scope: Scope): [string, number, string, string] {
  return ['ai-platform/output-guard/policy', sessionRevision, scope.kind, scope.id];
}

export function guardEventsKey(
  sessionRevision: number,
  query: GuardEventsFilter,
): [string, number, string, string, string, string] {
  return [
    'ai-platform/output-guard/events',
    sessionRevision,
    query.scope ? scopeToPath(query.scope) : '',
    query.detector ?? '',
    query.action ?? '',
    query.before ?? '',
  ];
}

// ─── API calls ────────────────────────────────────────────────────────────────

export async function fetchGuardPolicy(scope: Scope, signal?: AbortSignal): Promise<GuardPolicyResponse> {
  return apiFetch<GuardPolicyResponse>(`/api/ai-platform/output-guard/${scopeToPath(scope)}`, { signal });
}

export async function putGuardPolicy(
  scope: Scope,
  input: GuardPolicyInput,
  signal?: AbortSignal,
): Promise<GuardPolicyResponse> {
  return apiFetch<GuardPolicyResponse>(`/api/ai-platform/output-guard/${scopeToPath(scope)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  });
}

export async function testGuardPolicy(
  scope: Scope,
  input: GuardTestRequest,
  signal?: AbortSignal,
): Promise<GuardTestResponse> {
  return apiFetch<GuardTestResponse>(`/api/ai-platform/output-guard/${scopeToPath(scope)}/test`, {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

export async function fetchGuardEvents(
  query: GuardEventsFilter,
  signal?: AbortSignal,
): Promise<GuardEventsListResponse> {
  const params = new URLSearchParams();
  if (query.scope && query.scope.id.trim()) params.set('scope', scopeToPath(query.scope));
  if (query.detector?.trim()) params.set('detector', query.detector.trim());
  if (query.action) params.set('action', query.action);
  if (query.before) params.set('before', query.before);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return apiFetch<GuardEventsListResponse>(`/api/ai-platform/output-guard/events${qs ? `?${qs}` : ''}`, { signal });
}

export async function fetchGuardEventExcerpt(
  eventId: number | string,
  signal?: AbortSignal,
): Promise<GuardEventExcerptResponse> {
  return apiFetch<GuardEventExcerptResponse>(
    `/api/ai-platform/output-guard/events/${encodeURIComponent(String(eventId))}/excerpt`,
    { signal },
  );
}

export async function fetchGuardProfileOptions(signal?: AbortSignal): Promise<ProfileOption[]> {
  const raw = await apiFetch<Array<{ id: number; name: string }> | { profiles?: Array<{ id: number; name: string }> }>(
    '/api/profiles',
    { signal },
  );
  const list = Array.isArray(raw) ? raw : raw.profiles ?? [];
  return list.map((p) => ({ id: p.id, name: p.name }));
}

export async function fetchGuardSupportTenantOptions(signal?: AbortSignal): Promise<SupportTenantOption[]> {
  const raw = await apiFetch<{ tenants?: Array<{ id: number | string; name?: string; slug?: string }> }>(
    '/api/thruline/support/tenants',
    { signal },
  );
  return (raw.tenants ?? []).map((t) => ({
    id: String(t.id),
    name: t.name ?? t.slug ?? String(t.id),
  }));
}
