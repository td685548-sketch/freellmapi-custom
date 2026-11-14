/**
 * AI Platform API client — thin wrappers around apiFetch for each endpoint
 * exposed by server/src/custom/ai-platform/router.ts (T026).
 *
 * Scope: T032 (US1) — only overview/flags/retention endpoints.
 * Future US2–US7 endpoints are BLOCKED until the corresponding agent delivers
 * the server-side router.
 */

import { apiFetch } from '@/lib/api';
import type {
  AiPlatformOverviewResponse,
  AiPlatformRetention,
  Pillar,
  PillarFlags,
} from '../../../../shared/ai-platform';

// ─── Wire types (actual DTOs from shared/ai-platform.ts & Agent 1 router) ─────

export type PillarKey = Pillar;
export type PlatformFlags = PillarFlags;
export type PlatformOverview = AiPlatformOverviewResponse;
export type RetentionSettings = AiPlatformRetention;

export interface FlagsEnvelope {
  flags: PlatformFlags;
}

export interface RetentionEnvelope {
  retention: RetentionSettings;
}

// ─── Query key factory ────────────────────────────────────────────────────────
// sessionRevision and scope must be part of every query key so React Query
// never leaks state across logout, session switch, or tenant/scope switch.

export function overviewKey(sessionRevision: number, scope = 'global'): [string, number, string] {
  return ['ai-platform/overview', sessionRevision, scope];
}

export function retentionKey(sessionRevision: number, scope = 'global'): [string, number, string] {
  return ['ai-platform/retention', sessionRevision, scope];
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

/**
 * GET /api/ai-platform/overview
 * Requires: view_ai_platform
 */
export async function fetchOverview(signal: AbortSignal): Promise<PlatformOverview> {
  return apiFetch('/api/ai-platform/overview', { signal }) as Promise<PlatformOverview>;
}

/**
 * PUT /api/ai-platform/flags
 * Requires: edit_ai_flags
 * Throws on 401, 403, 409 (conflict) — caller must NOT show "saved" on error.
 */
export async function putFlags(patch: Partial<PlatformFlags>, signal: AbortSignal): Promise<FlagsEnvelope> {
  return apiFetch('/api/ai-platform/flags', {
    method: 'PUT',
    body: JSON.stringify(patch),
    signal,
  }) as Promise<FlagsEnvelope>;
}

/**
 * GET /api/ai-platform/retention
 * Requires: view_ai_platform
 */
export async function fetchRetention(signal: AbortSignal): Promise<RetentionEnvelope> {
  return apiFetch('/api/ai-platform/retention', { signal }) as Promise<RetentionEnvelope>;
}

/**
 * PUT /api/ai-platform/retention
 * Requires: edit_ai_flags
 */
export async function putRetention(body: RetentionSettings, signal: AbortSignal): Promise<RetentionEnvelope> {
  return apiFetch('/api/ai-platform/retention', {
    method: 'PUT',
    body: JSON.stringify(body),
    signal,
  }) as Promise<RetentionEnvelope>;
}
