/**
 * AI Platform Orchestrator (Agents, Flows, Runs, Approvals) API client (US7 / T130, T131).
 *
 * Uses shared DTOs from shared/ai-platform-orchestrator.ts directly and calls
 * @/lib/api `apiFetch` for every request.
 */

import { apiFetch } from '@/lib/api';
import type { Scope, ScopeKind, Wire } from '../../../../shared/ai-platform';
import type {
  McpApprovalDecisionInput,
  McpApprovalResponse,
  McpApprovalsResponse,
  McpApprovalStatus,
  McpApprovalView,
} from '../../../../shared/ai-platform-mcp';
import {
  AGENT_SLUG_REGEX,
  DEFAULT_FLOW_LIMITS,
  FLOW_LIMITS,
  FLOW_SLUG_REGEX,
  type AgentInput,
  type AgentPatchInput,
  type AgentView,
  type FlowCreateInput,
  type FlowDefinition,
  type FlowDetailView,
  type FlowDraftInput,
  type FlowKind,
  type FlowLimitsConfig,
  type FlowRunDetailResponse,
  type FlowRunStatus,
  type FlowRunStepView,
  type FlowRunView,
  type FlowStepKind,
  type FlowStepStatus,
  type FlowStopReason,
  type FlowValidationIssue,
  type FlowView,
  type PublishedAgentSnapshot,
  type PublishedFlowDefinition,
} from '../../../../shared/ai-platform-orchestrator';

export type {
  AgentInput,
  AgentPatchInput,
  AgentView,
  FlowCreateInput,
  FlowDefinition,
  FlowDetailView,
  FlowDraftInput,
  FlowKind,
  FlowLimitsConfig,
  FlowRunDetailResponse,
  FlowRunStatus,
  FlowRunStepView,
  FlowRunView,
  FlowStepKind,
  FlowStepStatus,
  FlowStopReason,
  FlowValidationIssue,
  FlowView,
  McpApprovalDecisionInput,
  McpApprovalResponse,
  McpApprovalsResponse,
  McpApprovalStatus,
  McpApprovalView,
  PublishedAgentSnapshot,
  PublishedFlowDefinition,
  Scope,
  ScopeKind,
  Wire,
};

export {
  AGENT_SLUG_REGEX,
  DEFAULT_FLOW_LIMITS,
  FLOW_LIMITS,
  FLOW_SLUG_REGEX,
};

export interface ProfileOption {
  id: number;
  name: string;
}

export interface SupportTenantOption {
  id: string;
  name: string;
}

export interface AgentsListResponse {
  agents: AgentView[];
}

export interface AgentResponse {
  agent: AgentView;
}

export interface FlowsListResponse {
  flows: FlowView[];
}

export interface FlowResponse {
  flow: FlowView;
  grantedProfileIds?: number[];
}

export interface FlowGrantsResponse {
  grantedProfileIds: number[];
  flow?: FlowView;
}

export interface FlowTryRequest {
  message: string;
}

export interface FlowTryResponse {
  run: FlowRunView;
  steps: FlowRunStepView[];
  outputText?: string | null;
  result?: string | null;
}

export interface RunsListQuery {
  flow?: string;
  profile?: string;
  status?: FlowRunStatus | '';
  before?: string;
  limit?: number;
}

export interface RunsListResponse {
  runs: FlowRunView[];
  nextBefore?: string | null;
}

export interface CancelRunResponse {
  ok?: boolean;
  run?: FlowRunView;
}

export interface FlowErrorInfo {
  status?: number;
  code?: string;
  message: string;
  issues: FlowValidationIssue[];
  referencingFlows: string[];
  current?: FlowDetailView;
}

function extractFlowSlugLabel(entry: unknown): string | null {
  if (typeof entry === 'string' && entry.trim()) return entry.trim();
  if (entry && typeof entry === 'object') {
    const rec = entry as { slug?: unknown; name?: unknown; id?: unknown };
    if (typeof rec.slug === 'string' && rec.slug.trim()) return rec.slug.trim();
    if (typeof rec.name === 'string' && rec.name.trim()) return rec.name.trim();
    if (typeof rec.id === 'number') return `#${rec.id}`;
  }
  return null;
}

function parseIssues(raw: unknown): FlowValidationIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: FlowValidationIssue[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const rec = item as { field?: unknown; message?: unknown };
      const message = typeof rec.message === 'string' ? rec.message : '';
      if (message) {
        out.push({
          field: typeof rec.field === 'string' ? rec.field : '',
          message,
        });
      }
    }
  }
  return out;
}

export function extractFlowErrorInfo(err: unknown): FlowErrorInfo {
  if (!err || typeof err !== 'object') {
    return {
      message: typeof err === 'string' && err ? err : 'Request failed',
      issues: [],
      referencingFlows: [],
    };
  }
  const rec = err as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    errors?: unknown;
    issues?: unknown;
    flows?: unknown;
    current?: unknown;
    details?: unknown;
  };
  const details =
    rec.details && typeof rec.details === 'object' ? (rec.details as Record<string, unknown>) : undefined;

  const issues = parseIssues(rec.errors ?? rec.issues ?? details?.errors);

  const rawFlows = Array.isArray(rec.flows)
    ? rec.flows
    : Array.isArray(details?.flows)
      ? details.flows
      : [];
  const referencingFlows = rawFlows
    .map(extractFlowSlugLabel)
    .filter((v): v is string => v !== null);

  const currentCandidate = rec.current ?? details?.current;
  const current =
    currentCandidate && typeof currentCandidate === 'object' && 'flow' in currentCandidate
      ? (currentCandidate as FlowDetailView)
      : undefined;

  return {
    status: typeof rec.status === 'number' ? rec.status : undefined,
    code: typeof rec.code === 'string' ? rec.code : undefined,
    message: typeof rec.message === 'string' && rec.message ? rec.message : 'Request failed',
    issues,
    referencingFlows,
    current,
  };
}

// ─── Query keys (include sessionRevision) ─────────────────────────────────────

export function agentsKey(sessionRevision: number): [string, number] {
  return ['ai-platform/agents', sessionRevision];
}

export function flowsKey(sessionRevision: number): [string, number] {
  return ['ai-platform/flows', sessionRevision];
}

export function flowDetailKey(sessionRevision: number, flowId: number | null): [string, number, number | null] {
  return ['ai-platform/flows/detail', sessionRevision, flowId];
}

export function runsKey(
  sessionRevision: number,
  query: RunsListQuery,
): [string, number, string, string, string, string] {
  return [
    'ai-platform/runs',
    sessionRevision,
    query.flow ?? '',
    query.profile ?? '',
    query.status ?? '',
    query.before ?? '',
  ];
}

export function runDetailKey(sessionRevision: number, runId: string | null): [string, number, string | null] {
  return ['ai-platform/runs/detail', sessionRevision, runId];
}

export function flowApprovalsKey(
  sessionRevision: number,
  status: McpApprovalStatus | 'all',
): [string, number, string] {
  return ['ai-platform/approvals', sessionRevision, status];
}

// ─── Agents API ───────────────────────────────────────────────────────────────

export async function fetchAgents(signal?: AbortSignal): Promise<AgentsListResponse> {
  return apiFetch<AgentsListResponse>('/api/ai-platform/agents', { signal });
}

export async function fetchAgent(id: number, signal?: AbortSignal): Promise<AgentResponse> {
  return apiFetch<AgentResponse>(`/api/ai-platform/agents/${id}`, { signal });
}

export async function createAgent(input: AgentInput, signal?: AbortSignal): Promise<AgentResponse> {
  return apiFetch<AgentResponse>('/api/ai-platform/agents', {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

export async function updateAgent(
  id: number,
  patch: AgentPatchInput,
  signal?: AbortSignal,
): Promise<AgentResponse> {
  return apiFetch<AgentResponse>(`/api/ai-platform/agents/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    signal,
  });
}

export async function deleteAgent(id: number, signal?: AbortSignal): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/api/ai-platform/agents/${id}`, {
    method: 'DELETE',
    signal,
  });
}

// ─── Flows API ────────────────────────────────────────────────────────────────

export async function fetchFlows(signal?: AbortSignal): Promise<FlowsListResponse> {
  return apiFetch<FlowsListResponse>('/api/ai-platform/flows', { signal });
}

export async function fetchFlowDetail(id: number, signal?: AbortSignal): Promise<FlowDetailView> {
  return apiFetch<FlowDetailView>(`/api/ai-platform/flows/${id}`, { signal });
}

export async function createFlow(input: FlowCreateInput, signal?: AbortSignal): Promise<FlowResponse> {
  return apiFetch<FlowResponse>('/api/ai-platform/flows', {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

export async function updateFlowDraft(
  id: number,
  input: FlowDraftInput,
  signal?: AbortSignal,
): Promise<FlowResponse> {
  return apiFetch<FlowResponse>(`/api/ai-platform/flows/${id}/draft`, {
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  });
}

export async function publishFlow(
  id: number,
  revision: number,
  signal?: AbortSignal,
): Promise<FlowResponse> {
  return apiFetch<FlowResponse>(`/api/ai-platform/flows/${id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ revision }),
    signal,
  });
}

export async function setFlowGrants(
  id: number,
  profileIds: number[],
  signal?: AbortSignal,
): Promise<FlowGrantsResponse> {
  return apiFetch<FlowGrantsResponse>(`/api/ai-platform/flows/${id}/grants`, {
    method: 'PUT',
    body: JSON.stringify({ profileIds }),
    signal,
  });
}

export async function tryFlow(
  id: number,
  input: FlowTryRequest,
  signal?: AbortSignal,
): Promise<FlowTryResponse> {
  return apiFetch<FlowTryResponse>(`/api/ai-platform/flows/${id}/try`, {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

export async function deleteFlow(id: number, signal?: AbortSignal): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/api/ai-platform/flows/${id}`, {
    method: 'DELETE',
    signal,
  });
}

// ─── Runs API ─────────────────────────────────────────────────────────────────

export async function fetchRuns(query?: RunsListQuery, signal?: AbortSignal): Promise<RunsListResponse> {
  const params = new URLSearchParams();
  if (query?.flow?.trim()) params.set('flow', query.flow.trim());
  if (query?.profile?.trim()) params.set('profile', query.profile.trim());
  if (query?.status) params.set('status', query.status);
  if (query?.before) params.set('before', query.before);
  if (query?.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return apiFetch<RunsListResponse>(`/api/ai-platform/runs${qs ? `?${qs}` : ''}`, { signal });
}

export async function fetchRunDetail(
  runId: string,
  afterSeq?: number,
  signal?: AbortSignal,
): Promise<FlowRunDetailResponse> {
  const qs = afterSeq !== undefined ? `?after=${encodeURIComponent(String(afterSeq))}` : '';
  return apiFetch<FlowRunDetailResponse>(`/api/ai-platform/runs/${encodeURIComponent(runId)}${qs}`, {
    signal,
  });
}

export async function cancelRun(runId: string, signal?: AbortSignal): Promise<CancelRunResponse> {
  return apiFetch<CancelRunResponse>(`/api/ai-platform/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    signal,
  });
}

// ─── Approvals API ────────────────────────────────────────────────────────────

export async function fetchFlowApprovals(
  status: McpApprovalStatus | 'all' = 'pending',
  signal?: AbortSignal,
): Promise<McpApprovalsResponse> {
  const qs = status === 'all' ? '' : `?status=${encodeURIComponent(status)}`;
  return apiFetch<McpApprovalsResponse>(`/api/ai-platform/approvals${qs}`, { signal });
}

export async function approveFlowAction(
  id: number,
  input?: McpApprovalDecisionInput,
  signal?: AbortSignal,
): Promise<McpApprovalResponse> {
  return apiFetch<McpApprovalResponse>(`/api/ai-platform/approvals/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
    signal,
  });
}

export async function rejectFlowAction(
  id: number,
  input?: McpApprovalDecisionInput,
  signal?: AbortSignal,
): Promise<McpApprovalResponse> {
  return apiFetch<McpApprovalResponse>(`/api/ai-platform/approvals/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
    signal,
  });
}

// ─── Helper option lookups ────────────────────────────────────────────────────

export async function fetchFlowProfileOptions(signal?: AbortSignal): Promise<ProfileOption[]> {
  const raw = await apiFetch<
    Array<{ id: number; name: string }> | { profiles?: Array<{ id: number; name: string }> }
  >('/api/profiles', { signal });
  const list = Array.isArray(raw) ? raw : raw.profiles ?? [];
  return list.map((p) => ({ id: p.id, name: p.name }));
}

export async function fetchFlowSupportTenantOptions(
  signal?: AbortSignal,
): Promise<SupportTenantOption[]> {
  const raw = await apiFetch<{
    tenants?: Array<{ id: number | string; name?: string; slug?: string }>;
  }>('/api/thruline/support/tenants', { signal });
  return (raw.tenants ?? []).map((t) => ({
    id: String(t.id),
    name: t.name ?? t.slug ?? String(t.id),
  }));
}

export async function fetchFlowModelOptions(signal?: AbortSignal): Promise<string[]> {
  const raw = await apiFetch<
    Array<{ modelId?: unknown }> | { models?: Array<{ modelId?: unknown }> }
  >('/api/models', { signal });
  const list = Array.isArray(raw) ? raw : raw.models ?? [];
  const ids = new Set<string>(['auto', 'fusion']);
  for (const item of list) {
    if (item && typeof item.modelId === 'string' && item.modelId.trim()) {
      ids.add(item.modelId.trim());
    }
  }
  return [...ids];
}
