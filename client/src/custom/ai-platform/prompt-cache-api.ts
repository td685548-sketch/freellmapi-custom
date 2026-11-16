/**
 * AI Platform Prompt Cache API client (US5 / T103).
 *
 * Uses shared DTOs directly from shared/ai-platform-prompt-cache.ts
 * and wraps apiFetch (@/lib/api) with session-aware query keys.
 */

import { apiFetch } from '@/lib/api';
import {
  DEFAULT_PROMPT_CACHE_SETTINGS,
  PROMPT_CACHE_LIMITS,
  PROMPT_CACHE_SETTINGS_KEY,
  type PromptCacheCapabilitiesResponse,
  type PromptCacheCapability,
  type PromptCacheCapabilityDeleteInput,
  type PromptCacheCapabilityDeleteResponse,
  type PromptCacheCapabilityInput,
  type PromptCacheCapabilityResponse,
  type PromptCacheCapabilitySource,
  type PromptCacheGroupBy,
  type PromptCacheMode,
  type PromptCacheSettings,
  type PromptCacheSettingsResponse,
  type PromptCacheStatsResponse,
  type PromptCacheStatsRow,
} from '../../../../shared/ai-platform-prompt-cache';

export type {
  PromptCacheCapabilitiesResponse,
  PromptCacheCapability,
  PromptCacheCapabilityDeleteInput,
  PromptCacheCapabilityDeleteResponse,
  PromptCacheCapabilityInput,
  PromptCacheCapabilityResponse,
  PromptCacheCapabilitySource,
  PromptCacheGroupBy,
  PromptCacheMode,
  PromptCacheSettings,
  PromptCacheSettingsResponse,
  PromptCacheStatsResponse,
  PromptCacheStatsRow,
};

export {
  DEFAULT_PROMPT_CACHE_SETTINGS,
  PROMPT_CACHE_LIMITS,
  PROMPT_CACHE_SETTINGS_KEY,
};

// ─── Query keys (include sessionRevision) ─────────────────────────────────────

export function promptCacheSettingsKey(sessionRevision: number): [string, number] {
  return ['ai-platform/prompt-cache/settings', sessionRevision];
}

export function promptCacheCapabilitiesKey(sessionRevision: number): [string, number] {
  return ['ai-platform/prompt-cache/capabilities', sessionRevision];
}

export function promptCacheStatsKey(
  sessionRevision: number,
  days: number,
  groupBy: PromptCacheGroupBy,
): [string, number, number, PromptCacheGroupBy] {
  return ['ai-platform/prompt-cache/stats', sessionRevision, days, groupBy];
}

// ─── API calls ────────────────────────────────────────────────────────────────

export async function fetchPromptCacheSettings(
  signal?: AbortSignal,
): Promise<PromptCacheSettingsResponse> {
  return apiFetch<PromptCacheSettingsResponse>('/api/ai-platform/prompt-cache/settings', {
    signal,
  });
}

export async function putPromptCacheSettings(
  patch: Partial<PromptCacheSettings>,
  signal?: AbortSignal,
): Promise<PromptCacheSettingsResponse> {
  return apiFetch<PromptCacheSettingsResponse>('/api/ai-platform/prompt-cache/settings', {
    method: 'PUT',
    body: JSON.stringify(patch),
    signal,
  });
}

export async function fetchPromptCacheCapabilities(
  signal?: AbortSignal,
): Promise<PromptCacheCapabilitiesResponse> {
  return apiFetch<PromptCacheCapabilitiesResponse>('/api/ai-platform/prompt-cache/capabilities', {
    signal,
  });
}

export async function putPromptCacheCapability(
  input: PromptCacheCapabilityInput,
  signal?: AbortSignal,
): Promise<PromptCacheCapabilityResponse> {
  return apiFetch<PromptCacheCapabilityResponse>('/api/ai-platform/prompt-cache/capabilities', {
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  });
}

export async function deletePromptCacheCapability(
  input: PromptCacheCapabilityDeleteInput,
  signal?: AbortSignal,
): Promise<PromptCacheCapabilityDeleteResponse> {
  return apiFetch<PromptCacheCapabilityDeleteResponse>('/api/ai-platform/prompt-cache/capabilities', {
    method: 'DELETE',
    body: JSON.stringify(input),
    signal,
  });
}

export async function fetchPromptCacheStats(
  opts: { days: number; groupBy: PromptCacheGroupBy },
  signal?: AbortSignal,
): Promise<PromptCacheStatsResponse> {
  const params = new URLSearchParams();
  params.set('days', String(opts.days));
  params.set('groupBy', opts.groupBy);
  return apiFetch<PromptCacheStatsResponse>(
    `/api/ai-platform/prompt-cache/stats?${params.toString()}`,
    { signal },
  );
}
