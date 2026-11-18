import { apiFetch } from '@/lib/api';
import type { Scope, ScopeKind } from '../../../../shared/ai-platform';
import {
  TRACE_SPAN_KINDS,
  TRACING_LIMITS,
  type TraceAttributeValue,
  type TraceDetailResponse,
  type TraceRecord,
  type TraceSpanKind,
  type TraceSpanNode,
  type TraceSpanStatus,
  type TraceStatus,
  type TraceSummary,
  type TracesDeleteResponse,
  type TracesListResponse,
} from '../../../../shared/ai-platform-tracing-oauth';

export { TRACE_SPAN_KINDS, TRACING_LIMITS };

export type {
  Scope,
  ScopeKind,
  TraceAttributeValue,
  TraceDetailResponse,
  TraceRecord,
  TraceSpanKind,
  TraceSpanNode,
  TraceSpanStatus,
  TraceStatus,
  TraceSummary,
  TracesDeleteResponse,
  TracesListResponse,
};

export interface TracesQuery {
  scope?: Scope;
  status?: TraceStatus | '';
  q?: string;
  threadId?: string;
  before?: string;
  limit?: number;
}

export function formatTraceScopeParam(scope: Scope): string {
  const kindSegment = scope.kind === 'support_tenant' ? 'support-tenant' : scope.kind;
  return `${kindSegment}:${scope.id}`;
}

export async function fetchTraces(
  query: TracesQuery = {},
  signal?: AbortSignal,
): Promise<TracesListResponse> {
  const params = new URLSearchParams();
  if (query.scope && query.scope.id.trim()) {
    params.set('scope', formatTraceScopeParam(query.scope));
  }
  if (query.status) params.set('status', query.status);
  if (query.q && query.q.trim()) params.set('q', query.q.trim());
  if (query.threadId && query.threadId.trim()) params.set('threadId', query.threadId.trim());
  if (query.before) params.set('before', query.before);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return apiFetch<TracesListResponse>(`/api/ai-platform/traces${qs ? `?${qs}` : ''}`, { signal });
}

export async function fetchTraceDetail(
  traceId: string,
  scope?: Scope,
  signal?: AbortSignal,
): Promise<TraceDetailResponse> {
  const params = new URLSearchParams();
  if (scope && scope.id.trim()) {
    params.set('scope', formatTraceScopeParam(scope));
  }
  const qs = params.toString();
  return apiFetch<TraceDetailResponse>(
    `/api/ai-platform/traces/${encodeURIComponent(traceId)}${qs ? `?${qs}` : ''}`,
    { signal },
  );
}

export async function purgeTraces(
  filter?: { scope?: Scope; before?: string },
  signal?: AbortSignal,
): Promise<TracesDeleteResponse> {
  const params = new URLSearchParams();
  if (filter?.scope && filter.scope.id.trim()) {
    params.set('scope', formatTraceScopeParam(filter.scope));
  }
  if (filter?.before) params.set('before', filter.before);
  const qs = params.toString();
  return apiFetch<TracesDeleteResponse>(`/api/ai-platform/traces${qs ? `?${qs}` : ''}`, {
    method: 'DELETE',
    signal,
  });
}

// ── Waterfall Geometry & Display Helpers (AxonHub TraceTimeline parity) ──────

export interface WaterfallBarGeometry {
  leftPercent: number;
  widthPercent: number;
}

export function computeWaterfallBar(
  startOffsetMs: number,
  durationMs: number,
  totalDurationMs: number,
): WaterfallBarGeometry {
  const safeTotal = Math.max(totalDurationMs, 1);
  const leftRatio = Math.max(0, startOffsetMs) / safeTotal;
  const widthRatio = Math.max(0, durationMs) / safeTotal;

  const leftPercent = Math.min(Math.max(leftRatio * 100, 0), 100);
  const maxAvailableWidth = Math.max(100 - leftPercent, 0);

  let widthPercent = Math.min(Math.max(widthRatio * 100, 0), maxAvailableWidth);
  if (durationMs > 0 && widthPercent < 0.8) {
    widthPercent = Math.min(0.8, maxAvailableWidth);
  } else if (durationMs === 0 && maxAvailableWidth >= 0.6) {
    widthPercent = 0.6;
  }

  return {
    leftPercent: Math.round(leftPercent * 100) / 100,
    widthPercent: Math.round(widthPercent * 100) / 100,
  };
}

export function countSpanNodes(node: TraceSpanNode): number {
  return 1 + node.children.reduce((acc, child) => acc + countSpanNodes(child), 0);
}

export function formatSpanDuration(durationMs: number): string {
  const safe = Math.max(0, Math.round(durationMs));
  if (safe < 1000) return `${safe}ms`;
  return `${(safe / 1000).toFixed(2)}s`;
}

const SPAN_KIND_HUES: Record<TraceSpanKind, number> = {
  request: 215,
  prompt_render: 268,
  retrieval: 188,
  context_budget: 42,
  mcp_tool_call: 152,
  orchestrator_step: 292,
  upstream_attempt: 205,
  output_guard: 332,
};

export function getWaterfallBarColor(kind: TraceSpanKind, status: TraceSpanStatus): string {
  if (status === 'error') return 'hsla(0, 76%, 56%, 0.82)';
  if (status === 'awaiting_approval') return 'hsla(38, 92%, 52%, 0.82)';
  if (status === 'cancelled' || status === 'skipped') return 'hsla(220, 12%, 56%, 0.55)';
  const hue = SPAN_KIND_HUES[kind] ?? 215;
  return `hsla(${hue}, 72%, 54%, 0.78)`;
}
