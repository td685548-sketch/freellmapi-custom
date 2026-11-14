/**
 * AI Platform MCP Client API wrapper (US2 / T052).
 *
 * Uses shared DTOs from shared/ai-platform-mcp.ts (C0) directly.
 * Never duplicates backend schemas or exposes secret fields.
 */

import { apiFetch } from '@/lib/api';
import type {
  McpAllowedOriginsInput,
  McpAllowedOriginsResponse,
  McpApprovalDecisionInput,
  McpApprovalResponse,
  McpApprovalsResponse,
  McpApprovalStatus,
  McpBindingPutInput,
  McpBindingResponse,
  McpCallsResponse,
  McpDeleteServerResponse,
  McpServerInput,
  McpServerPatch,
  McpServerResponse,
  McpServersResponse,
  McpSyncServerResponse,
  McpTestServerResponse,
  McpToolCallStatus,
  McpToolResponse,
  McpToolReviewPatch,
  McpToolsResponse,
  Scope,
} from '../../../../shared/ai-platform-mcp';

export type {
  McpAllowedOriginsInput,
  McpAllowedOriginsResponse,
  McpApprovalDecisionInput,
  McpApprovalResponse,
  McpApprovalsResponse,
  McpApprovalStatus,
  McpApprovalView,
  McpAuthKind,
  McpBindingPutInput,
  McpBindingResponse,
  McpBindingView,
  McpCallsResponse,
  McpCallView,
  McpDeleteServerResponse,
  McpInUseErrorDetails,
  McpServerInput,
  McpServerPatch,
  McpServerResponse,
  McpServersResponse,
  McpServerStatus,
  McpServerView,
  McpSyncServerResponse,
  McpTestServerResponse,
  McpToolCallStatus,
  McpToolEffect,
  McpToolResponse,
  McpToolReviewPatch,
  McpToolsResponse,
  McpToolState,
  McpToolView,
  Scope,
  ScopeKind,
} from '../../../../shared/ai-platform-mcp';

export { MCP_LIMITS, MCP_PROTOCOL_VERSION, MCP_SLUG_REGEX } from '../../../../shared/ai-platform-mcp';

export interface ProfileOption {
  id: number;
  name: string;
}

export interface SupportTenantOption {
  id: string;
  name: string;
}

export interface McpCallsQuery {
  scope?: Scope;
  serverId?: number;
  status?: McpToolCallStatus;
  before?: string;
}

export function scopeToPath(scope: Scope): string {
  const kindSegment = scope.kind === 'support_tenant' ? 'support-tenant' : scope.kind;
  return `${kindSegment}/${encodeURIComponent(scope.id)}`;
}

// ─── Query keys (include sessionRevision & scope/filter) ─────────────────────

export function mcpServersKey(sessionRevision: number): [string, number] {
  return ['ai-platform/mcp/servers', sessionRevision];
}

export function mcpServerToolsKey(sessionRevision: number, serverId: number | null): [string, number, number | null] {
  return ['ai-platform/mcp/tools', sessionRevision, serverId];
}

export function mcpBindingsKey(sessionRevision: number, scope: Scope): [string, number, string, string] {
  return ['ai-platform/mcp/bindings', sessionRevision, scope.kind, scope.id];
}

export function mcpApprovalsKey(sessionRevision: number, status?: McpApprovalStatus | 'all'): [string, number, string] {
  return ['ai-platform/mcp/approvals', sessionRevision, status ?? 'all'];
}

export function mcpCallsKey(sessionRevision: number, query: McpCallsQuery): [string, number, string, number | null, string, string] {
  return [
    'ai-platform/mcp/calls',
    sessionRevision,
    query.scope ? scopeToPath(query.scope) : '',
    query.serverId ?? null,
    query.status ?? '',
    query.before ?? '',
  ];
}

export function mcpAllowedOriginsKey(sessionRevision: number): [string, number] {
  return ['ai-platform/mcp/allowed-internal-hosts', sessionRevision];
}

// ─── Servers ─────────────────────────────────────────────────────────────────

export async function fetchMcpServers(signal?: AbortSignal): Promise<McpServersResponse> {
  return apiFetch<McpServersResponse>('/api/ai-platform/mcp/servers', { signal });
}

export async function createMcpServer(input: McpServerInput, signal?: AbortSignal): Promise<McpServerResponse> {
  return apiFetch<McpServerResponse>('/api/ai-platform/mcp/servers', {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

export async function updateMcpServer(id: number, patch: McpServerPatch, signal?: AbortSignal): Promise<McpServerResponse> {
  return apiFetch<McpServerResponse>(`/api/ai-platform/mcp/servers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    signal,
  });
}

export async function deleteMcpServer(id: number, opts?: { force?: boolean }, signal?: AbortSignal): Promise<McpDeleteServerResponse> {
  const qs = opts?.force ? '?force=1' : '';
  return apiFetch<McpDeleteServerResponse>(`/api/ai-platform/mcp/servers/${id}${qs}`, {
    method: 'DELETE',
    signal,
  });
}

export async function testMcpServer(id: number, signal?: AbortSignal): Promise<McpTestServerResponse> {
  return apiFetch<McpTestServerResponse>(`/api/ai-platform/mcp/servers/${id}/test`, {
    method: 'POST',
    signal,
  });
}

export async function syncMcpServer(id: number, signal?: AbortSignal): Promise<McpSyncServerResponse> {
  return apiFetch<McpSyncServerResponse>(`/api/ai-platform/mcp/servers/${id}/sync`, {
    method: 'POST',
    signal,
  });
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export async function fetchMcpServerTools(serverId: number, signal?: AbortSignal): Promise<McpToolsResponse> {
  return apiFetch<McpToolsResponse>(`/api/ai-platform/mcp/servers/${serverId}/tools`, { signal });
}

export async function reviewMcpTool(toolId: number, patch: McpToolReviewPatch, signal?: AbortSignal): Promise<McpToolResponse> {
  return apiFetch<McpToolResponse>(`/api/ai-platform/mcp/tools/${toolId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    signal,
  });
}

// ─── Scope Bindings ──────────────────────────────────────────────────────────

export async function fetchMcpBindings(scope: Scope, signal?: AbortSignal): Promise<McpBindingResponse> {
  return apiFetch<McpBindingResponse>(`/api/ai-platform/mcp/bindings/${scopeToPath(scope)}`, { signal });
}

export async function putMcpBindings(scope: Scope, input: McpBindingPutInput, signal?: AbortSignal): Promise<McpBindingResponse> {
  return apiFetch<McpBindingResponse>(`/api/ai-platform/mcp/bindings/${scopeToPath(scope)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  });
}

export async function fetchProfileOptions(signal?: AbortSignal): Promise<ProfileOption[]> {
  const raw = await apiFetch<Array<{ id: number; name: string }> | { profiles?: Array<{ id: number; name: string }> }>(
    '/api/profiles',
    { signal },
  );
  const list = Array.isArray(raw) ? raw : raw.profiles ?? [];
  return list.map((p) => ({ id: p.id, name: p.name }));
}

export async function fetchSupportTenantOptions(signal?: AbortSignal): Promise<SupportTenantOption[]> {
  const raw = await apiFetch<{ tenants?: Array<{ id: number | string; name?: string; slug?: string }> }>(
    '/api/thruline/support/tenants',
    { signal },
  );
  return (raw.tenants ?? []).map((t) => ({
    id: String(t.id),
    name: t.name ?? t.slug ?? String(t.id),
  }));
}

// ─── Approvals ───────────────────────────────────────────────────────────────

export async function fetchMcpApprovals(status?: McpApprovalStatus, signal?: AbortSignal): Promise<McpApprovalsResponse> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiFetch<McpApprovalsResponse>(`/api/ai-platform/approvals${qs}`, { signal });
}

export async function approveMcpAction(id: number, input?: McpApprovalDecisionInput, signal?: AbortSignal): Promise<McpApprovalResponse> {
  return apiFetch<McpApprovalResponse>(`/api/ai-platform/approvals/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
    signal,
  });
}

export async function rejectMcpAction(id: number, input?: McpApprovalDecisionInput, signal?: AbortSignal): Promise<McpApprovalResponse> {
  return apiFetch<McpApprovalResponse>(`/api/ai-platform/approvals/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
    signal,
  });
}

// ─── Call Logs ───────────────────────────────────────────────────────────────

export async function fetchMcpCalls(query: McpCallsQuery, signal?: AbortSignal): Promise<McpCallsResponse> {
  const params = new URLSearchParams();
  if (query.scope) params.set('scope', scopeToPath(query.scope));
  if (query.serverId !== undefined) params.set('server', String(query.serverId));
  if (query.status) params.set('status', query.status);
  if (query.before) params.set('before', query.before);
  const qs = params.toString();
  return apiFetch<McpCallsResponse>(`/api/ai-platform/mcp/calls${qs ? `?${qs}` : ''}`, { signal });
}

// ─── Allowed Internal Origins (Primary Only) ─────────────────────────────────

export async function fetchAllowedInternalOrigins(signal?: AbortSignal): Promise<McpAllowedOriginsResponse> {
  return apiFetch<McpAllowedOriginsResponse>('/api/ai-platform/mcp/allowed-internal-hosts', { signal });
}

export async function putAllowedInternalOrigins(input: McpAllowedOriginsInput, signal?: AbortSignal): Promise<McpAllowedOriginsResponse> {
  return apiFetch<McpAllowedOriginsResponse>('/api/ai-platform/mcp/allowed-internal-hosts', {
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  });
}
