import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Workflow } from 'lucide-react';
import { useCustomT } from '../../i18n/use-custom-t';
import { useAdministrativeAccess } from '../../use-administrative-access';
import { useUserSession } from '../../use-session';
import {
  computeWaterfallBar,
  countSpanNodes,
  fetchTraceDetail,
  fetchTraces,
  formatSpanDuration,
  getWaterfallBarColor,
  purgeTraces,
  type Scope,
  type ScopeKind,
  type TraceRecord,
  type TraceSpanKind,
  type TraceSpanNode,
  type TraceSpanStatus,
  type TraceStatus,
  type TraceSummary,
} from '../tracing-api';
import {
  TRACES_CACHED_SUMMARY,
  TRACES_COLLAPSE_SPAN,
  TRACES_EMPTY,
  TRACES_EXPAND_SPAN,
  TRACES_FILTER_AGENT,
  TRACES_FILTER_ALL_SCOPES,
  TRACES_FILTER_ALL_STATUSES,
  TRACES_FILTER_PROFILE,
  TRACES_FILTER_SCOPE_ID_PLACEHOLDER,
  TRACES_FILTER_SCOPE_KIND,
  TRACES_FILTER_SEARCH_PLACEHOLDER,
  TRACES_FILTER_STATUS,
  TRACES_FILTER_SUPPORT_TENANT,
  TRACES_INSPECTOR_ATTRIBUTES,
  TRACES_INSPECTOR_CLOSE,
  TRACES_INSPECTOR_DURATION,
  TRACES_INSPECTOR_ERROR,
  TRACES_INSPECTOR_HEADING,
  TRACES_INSPECTOR_KIND,
  TRACES_INSPECTOR_MODEL,
  TRACES_INSPECTOR_NO_ATTRIBUTES,
  TRACES_INSPECTOR_OFFSET,
  TRACES_INSPECTOR_SPAN_ID,
  TRACES_INSPECTOR_STATUS,
  TRACES_INSPECTOR_TOKENS,
  TRACES_KIND_CONTEXT_BUDGET,
  TRACES_KIND_MCP_TOOL,
  TRACES_KIND_ORCHESTRATOR_STEP,
  TRACES_KIND_OUTPUT_GUARD,
  TRACES_KIND_PROMPT_RENDER,
  TRACES_KIND_REQUEST,
  TRACES_KIND_RETRIEVAL,
  TRACES_KIND_UPSTREAM_ATTEMPT,
  TRACES_LOADING,
  TRACES_LOADING_DETAIL,
  TRACES_LOAD_ERROR,
  TRACES_LOAD_MORE,
  TRACES_NO_PERMISSION,
  TRACES_PAGE_SUBTITLE,
  TRACES_PAGE_TITLE,
  TRACES_PURGE,
  TRACES_PURGED,
  TRACES_PURGING,
  TRACES_REFRESH,
  TRACES_SELECT_HINT,
  TRACES_SOURCE_LABEL,
  TRACES_SPANS_COUNT,
  TRACES_STATUS_AWAITING_APPROVAL,
  TRACES_STATUS_CANCELLED,
  TRACES_STATUS_ERROR,
  TRACES_STATUS_OK,
  TRACES_STATUS_SKIPPED,
  TRACES_THREAD_LABEL,
  TRACES_TIMELINE_HEADING,
  TRACES_TOKENS_SUMMARY,
} from '../tracing-strings';

const SPAN_KIND_LABELS: Record<TraceSpanKind, string> = {
  request: TRACES_KIND_REQUEST,
  prompt_render: TRACES_KIND_PROMPT_RENDER,
  retrieval: TRACES_KIND_RETRIEVAL,
  context_budget: TRACES_KIND_CONTEXT_BUDGET,
  mcp_tool_call: TRACES_KIND_MCP_TOOL,
  orchestrator_step: TRACES_KIND_ORCHESTRATOR_STEP,
  upstream_attempt: TRACES_KIND_UPSTREAM_ATTEMPT,
  output_guard: TRACES_KIND_OUTPUT_GUARD,
};

const SPAN_STATUS_LABELS: Record<TraceSpanStatus, string> = {
  ok: TRACES_STATUS_OK,
  error: TRACES_STATUS_ERROR,
  awaiting_approval: TRACES_STATUS_AWAITING_APPROVAL,
  cancelled: TRACES_STATUS_CANCELLED,
  skipped: TRACES_STATUS_SKIPPED,
};

const TRACE_STATUS_LABELS: Record<TraceStatus, string> = {
  ok: TRACES_STATUS_OK,
  error: TRACES_STATUS_ERROR,
  awaiting_approval: TRACES_STATUS_AWAITING_APPROVAL,
  cancelled: TRACES_STATUS_CANCELLED,
};

function isAbortErr(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

function findSpanById(root: TraceSpanNode, id: string): TraceSpanNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findSpanById(child, id);
    if (found) return found;
  }
  return null;
}

interface WaterfallSpanRowProps {
  node: TraceSpanNode;
  depth: number;
  totalDurationMs: number;
  selectedSpanId: string | null;
  onSelectSpan: (span: TraceSpanNode) => void;
}

function WaterfallSpanRow({
  node,
  depth,
  totalDurationMs,
  selectedSpanId,
  onSelectSpan,
}: WaterfallSpanRowProps) {
  const tc = useCustomT();
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const isSelected = selectedSpanId === node.id;

  const bar = computeWaterfallBar(node.startOffsetMs, node.durationMs, totalDurationMs);
  const barColor = getWaterfallBarColor(node.kind, node.status);
  const spanTokens =
    (node.promptTokens ?? 0) + (node.completionTokens ?? 0);

  return (
    <div className="border-b border-border/40 last:border-b-0">
      <div
        data-testid={`trace-span-row-${node.id}`}
        onClick={() => onSelectSpan(node)}
        style={{ paddingLeft: `${depth * 20 + 12}px` }}
        className={`flex items-center gap-3 pr-3 py-2 cursor-pointer transition-colors ${
          isSelected ? 'bg-primary/10' : 'hover:bg-muted/50'
        }`}
      >
        <button
          type="button"
          data-testid={`trace-span-toggle-${node.id}`}
          onClick={(event) => {
            event.stopPropagation();
            if (hasChildren) {
              setExpanded((prev) => !prev);
            }
          }}
          aria-label={
            hasChildren
              ? expanded
                ? tc(TRACES_COLLAPSE_SPAN)
                : tc(TRACES_EXPAND_SPAN)
              : undefined
          }
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded ${
            hasChildren ? 'hover:bg-muted text-muted-foreground' : 'opacity-0 pointer-events-none'
          }`}
        >
          {hasChildren &&
            (expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />)}
        </button>

        <Workflow className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide shrink-0">
            {tc(SPAN_KIND_LABELS[node.kind])}
          </span>
          <span className="truncate text-xs font-medium">{node.name}</span>
          {node.status !== 'ok' && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium shrink-0 ${
                node.status === 'error'
                  ? 'bg-destructive/15 text-destructive'
                  : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
              }`}
            >
              {tc(SPAN_STATUS_LABELS[node.status])}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground shrink-0">
            {formatSpanDuration(node.durationMs)}
          </span>
          {spanTokens > 0 && (
            <span className="text-[11px] text-muted-foreground shrink-0">
              {tc(TRACES_TOKENS_SUMMARY, { total: spanTokens })}
            </span>
          )}
        </div>

        <div
          className="relative h-4 w-44 min-w-[176px] rounded bg-muted/40 overflow-hidden shrink-0"
          data-testid={`trace-span-track-${node.id}`}
        >
          <div
            data-testid={`trace-span-bar-${node.id}`}
            className="absolute inset-y-0 rounded"
            style={{
              left: `${bar.leftPercent}%`,
              width: `${bar.widthPercent}%`,
              backgroundColor: barColor,
            }}
          />
        </div>
      </div>

      {hasChildren && expanded && (
        <div>
          {node.children.map((child) => (
            <WaterfallSpanRow
              key={child.id}
              node={child}
              depth={depth + 1}
              totalDurationMs={totalDurationMs}
              selectedSpanId={selectedSpanId}
              onSelectSpan={onSelectSpan}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TraceTimelinePage() {
  const tc = useCustomT();
  const { can } = useAdministrativeAccess();
  const { isPrimary } = useUserSession();

  const canView =
    isPrimary || can('view_ai_platform') || can('edit_ai_flags') || can('manage_ai_platform');
  const canPurge = isPrimary || can('edit_ai_flags') || can('manage_ai_platform');

  const [scopeKind, setScopeKind] = useState<'' | ScopeKind>('');
  const [scopeId, setScopeId] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | TraceStatus>('');
  const [searchQuery, setSearchQuery] = useState('');

  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadedList, setLoadedList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [traceDetail, setTraceDetail] = useState<TraceRecord | null>(null);
  const [loadedDetailId, setLoadedDetailId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  const mountedRef = useRef(true);
  const listAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const detailEpochRef = useRef(0);

  const activeScope: Scope | undefined = useMemo(() => {
    if (!scopeKind || !scopeId.trim()) return undefined;
    return { kind: scopeKind, id: scopeId.trim() };
  }, [scopeKind, scopeId]);

  const loadList = useCallback(
    async (appendBefore?: string) => {
      if (!canView) return;
      listAbortRef.current?.abort();
      const ac = new AbortController();
      listAbortRef.current = ac;
      if (appendBefore) setLoadingMore(true);

      try {
        const res = await fetchTraces(
          {
            scope: activeScope,
            status: statusFilter,
            q: searchQuery,
            before: appendBefore,
          },
          ac.signal,
        );
        if (!mountedRef.current || ac.signal.aborted) return;
        setListError(null);
        setNextBefore(res.nextBefore);
        if (appendBefore) {
          setTraces((prev) => [...prev, ...res.traces]);
        } else {
          setTraces(res.traces);
          setSelectedTraceId((prev) => {
            if (prev && res.traces.some((item) => item.traceId === prev)) return prev;
            return res.traces[0]?.traceId ?? null;
          });
        }
      } catch (err) {
        if (!mountedRef.current || isAbortErr(err)) return;
        setListError((err as Error)?.message ?? tc(TRACES_LOAD_ERROR));
      } finally {
        if (mountedRef.current) {
          setLoadedList(true);
          setLoadingMore(false);
        }
      }
    },
    [activeScope, canView, searchQuery, statusFilter, tc],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (canView) {
      queueMicrotask(() => {
        if (mountedRef.current) {
          void loadList();
        }
      });
    }
    return () => {
      mountedRef.current = false;
      listAbortRef.current?.abort();
      detailAbortRef.current?.abort();
    };
  }, [canView, loadList]);

  useEffect(() => {
    if (!canView || !selectedTraceId) return;
    const epoch = ++detailEpochRef.current;
    detailAbortRef.current?.abort();
    const ac = new AbortController();
    detailAbortRef.current = ac;

    fetchTraceDetail(selectedTraceId, activeScope, ac.signal)
      .then((res) => {
        if (!mountedRef.current || ac.signal.aborted || detailEpochRef.current !== epoch) return;
        setDetailError(null);
        setTraceDetail(res.trace);
        setSelectedSpanId((prev) => {
          if (prev && findSpanById(res.trace.rootSpan, prev)) return prev;
          return res.trace.rootSpan.id;
        });
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || isAbortErr(err) || detailEpochRef.current !== epoch) return;
        setDetailError((err as Error)?.message ?? tc(TRACES_LOAD_ERROR));
        setTraceDetail(null);
      })
      .finally(() => {
        if (mountedRef.current && detailEpochRef.current === epoch) {
          setLoadedDetailId(selectedTraceId);
        }
      });
  }, [activeScope, canView, selectedTraceId, tc]);

  const selectedSpan: TraceSpanNode | null = useMemo(() => {
    if (!traceDetail || !selectedSpanId) return null;
    return findSpanById(traceDetail.rootSpan, selectedSpanId);
  }, [traceDetail, selectedSpanId]);

  if (!canView) {
    return (
      <div data-testid="traces-no-permission">
        <p className="text-sm text-muted-foreground">{tc(TRACES_NO_PERMISSION)}</p>
      </div>
    );
  }

  const loadingList = !loadedList;
  const loadingDetail = selectedTraceId !== null && loadedDetailId !== selectedTraceId;
  const activeDetail =
    traceDetail && traceDetail.traceId === selectedTraceId ? traceDetail : null;

  async function handlePurge() {
    if (!canPurge || purging) return;
    setPurging(true);
    setBanner(null);
    try {
      const res = await purgeTraces({ scope: activeScope });
      if (!mountedRef.current) return;
      setBanner({
        kind: 'info',
        text: tc(TRACES_PURGED, { count: res.deleted }),
      });
      setSelectedTraceId(null);
      setTraceDetail(null);
      setSelectedSpanId(null);
      await loadList();
    } catch (err) {
      if (!mountedRef.current || isAbortErr(err)) return;
      setBanner({
        kind: 'error',
        text: (err as Error)?.message ?? tc(TRACES_LOAD_ERROR),
      });
    } finally {
      if (mountedRef.current) setPurging(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="traces-page">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{tc(TRACES_PAGE_TITLE)}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">{tc(TRACES_PAGE_SUBTITLE)}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="traces-refresh-btn"
            onClick={() => void loadList()}
            className="rounded border px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            {tc(TRACES_REFRESH)}
          </button>
          {canPurge && (
            <button
              type="button"
              data-testid="traces-purge-btn"
              disabled={purging}
              onClick={() => void handlePurge()}
              className="rounded border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {purging ? tc(TRACES_PURGING) : tc(TRACES_PURGE)}
            </button>
          )}
        </div>
      </div>

      {banner && (
        <div
          role={banner.kind === 'error' ? 'alert' : 'status'}
          data-testid="traces-banner"
          className={`rounded border px-3 py-2 text-xs ${
            banner.kind === 'error'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          }`}
        >
          {banner.text}
        </div>
      )}

      {/* Filters */}
      <div className="grid gap-3 sm:grid-cols-4 rounded-lg border bg-card p-3">
        <label className="space-y-1 text-xs">
          <span className="font-medium block">{tc(TRACES_FILTER_SCOPE_KIND)}</span>
          <select
            data-testid="traces-filter-scope-kind"
            value={scopeKind}
            onChange={(e) => setScopeKind(e.target.value as '' | ScopeKind)}
            className="w-full rounded border bg-background px-2 py-1.5 text-xs"
          >
            <option value="">{tc(TRACES_FILTER_ALL_SCOPES)}</option>
            <option value="profile">{tc(TRACES_FILTER_PROFILE)}</option>
            <option value="support_tenant">{tc(TRACES_FILTER_SUPPORT_TENANT)}</option>
            <option value="agent">{tc(TRACES_FILTER_AGENT)}</option>
          </select>
        </label>

        <label className="space-y-1 text-xs">
          <span className="font-medium block">ID</span>
          <input
            type="text"
            data-testid="traces-filter-scope-id"
            disabled={!scopeKind}
            placeholder={tc(TRACES_FILTER_SCOPE_ID_PLACEHOLDER)}
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
            className="w-full rounded border bg-background px-2 py-1.5 text-xs font-mono disabled:opacity-50"
          />
        </label>

        <label className="space-y-1 text-xs">
          <span className="font-medium block">{tc(TRACES_FILTER_STATUS)}</span>
          <select
            data-testid="traces-filter-status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as '' | TraceStatus)}
            className="w-full rounded border bg-background px-2 py-1.5 text-xs"
          >
            <option value="">{tc(TRACES_FILTER_ALL_STATUSES)}</option>
            <option value="ok">{tc(TRACES_STATUS_OK)}</option>
            <option value="error">{tc(TRACES_STATUS_ERROR)}</option>
            <option value="awaiting_approval">{tc(TRACES_STATUS_AWAITING_APPROVAL)}</option>
            <option value="cancelled">{tc(TRACES_STATUS_CANCELLED)}</option>
          </select>
        </label>

        <label className="space-y-1 text-xs">
          <span className="font-medium block">Search</span>
          <input
            type="search"
            data-testid="traces-filter-search"
            placeholder={tc(TRACES_FILTER_SEARCH_PLACEHOLDER)}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded border bg-background px-2 py-1.5 text-xs"
          />
        </label>
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        {/* Trace list */}
        <section
          className="lg:col-span-4 rounded-lg border bg-card p-3 space-y-2 max-h-[680px] overflow-y-auto"
          data-testid="traces-list-panel"
        >
          {listError && (
            <div
              role="alert"
              className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {listError}
            </div>
          )}

          {loadingList ? (
            <p className="text-xs text-muted-foreground p-2">{tc(TRACES_LOADING)}</p>
          ) : traces.length === 0 ? (
            <p className="text-xs text-muted-foreground p-2">{tc(TRACES_EMPTY)}</p>
          ) : (
            <div className="space-y-1.5">
              {traces.map((tr) => {
                const active = tr.traceId === selectedTraceId;
                return (
                  <button
                    key={tr.traceId}
                    type="button"
                    data-testid={`trace-list-item-${tr.traceId}`}
                    onClick={() => setSelectedTraceId(tr.traceId)}
                    className={`w-full text-left rounded border p-2.5 space-y-1 transition-colors ${
                      active ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-medium truncate">{tr.traceId}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium shrink-0 ${
                          tr.status === 'error'
                            ? 'bg-destructive/15 text-destructive'
                            : tr.status === 'awaiting_approval'
                              ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                              : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {tc(TRACE_STATUS_LABELS[tr.status])}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="font-mono">{tr.servedModel ?? tr.requestedModel}</span>
                      <span>·</span>
                      <span>{formatSpanDuration(tr.durationMs)}</span>
                      <span>·</span>
                      <span>{tc(TRACES_SPANS_COUNT, { count: tr.spansCount })}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground flex items-center justify-between">
                      <span>
                        {tr.scopeKind}:{tr.scopeId}
                      </span>
                      <span>{tr.traceSource}</span>
                    </div>
                  </button>
                );
              })}

              {nextBefore && (
                <button
                  type="button"
                  data-testid="traces-load-more-btn"
                  disabled={loadingMore}
                  onClick={() => void loadList(nextBefore)}
                  className="w-full rounded border py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                >
                  {tc(TRACES_LOAD_MORE)}
                </button>
              )}
            </div>
          )}
        </section>

        {/* Waterfall Timeline & Span Inspector */}
        <section className="lg:col-span-8 space-y-4">
          {!selectedTraceId ? (
            <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
              {tc(TRACES_SELECT_HINT)}
            </div>
          ) : loadingDetail ? (
            <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
              {tc(TRACES_LOADING_DETAIL)}
            </div>
          ) : detailError ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-xs text-destructive"
            >
              {detailError}
            </div>
          ) : activeDetail ? (
            <>
              <div
                className="rounded-lg border bg-card overflow-hidden"
                data-testid="trace-waterfall-timeline"
              >
                <div className="border-b px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold">{tc(TRACES_TIMELINE_HEADING)}</h3>
                      <span className="font-mono text-xs text-muted-foreground">
                        {activeDetail.traceId}
                      </span>
                      <span className="rounded bg-muted px-2 py-0.5 text-[11px]">
                        {tc(TRACES_SOURCE_LABEL, { source: activeDetail.traceSource })}
                      </span>
                      {activeDetail.threadId && (
                        <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-mono">
                          {tc(TRACES_THREAD_LABEL, { thread: activeDetail.threadId })}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>{formatSpanDuration(activeDetail.durationMs)}</span>
                    {activeDetail.totalTokens > 0 && (
                      <span>{tc(TRACES_TOKENS_SUMMARY, { total: activeDetail.totalTokens })}</span>
                    )}
                    {activeDetail.cachedTokens > 0 && (
                      <span>{tc(TRACES_CACHED_SUMMARY, { cached: activeDetail.cachedTokens })}</span>
                    )}
                    <span data-testid="trace-total-spans">
                      {tc(TRACES_SPANS_COUNT, { count: countSpanNodes(activeDetail.rootSpan) })}
                    </span>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <WaterfallSpanRow
                    node={activeDetail.rootSpan}
                    depth={0}
                    totalDurationMs={Math.max(
                      activeDetail.durationMs,
                      activeDetail.rootSpan.durationMs,
                      1,
                    )}
                    selectedSpanId={selectedSpanId}
                    onSelectSpan={(span) => setSelectedSpanId(span.id)}
                  />
                </div>
              </div>

              {selectedSpan && (
                <div
                  className="rounded-lg border bg-card p-4 space-y-3"
                  data-testid="trace-span-inspector"
                >
                  <div className="flex items-center justify-between gap-2 border-b pb-2">
                    <div>
                      <h4 className="text-sm font-semibold">{tc(TRACES_INSPECTOR_HEADING)}</h4>
                      <div className="font-mono text-xs text-muted-foreground">
                        {selectedSpan.name}
                      </div>
                    </div>
                    <button
                      type="button"
                      data-testid="trace-inspector-close"
                      onClick={() => setSelectedSpanId(null)}
                      className="rounded border px-2.5 py-1 text-xs hover:bg-muted"
                    >
                      {tc(TRACES_INSPECTOR_CLOSE)}
                    </button>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3 text-xs">
                    <div>
                      <span className="text-muted-foreground block">
                        {tc(TRACES_INSPECTOR_SPAN_ID)}
                      </span>
                      <span className="font-mono">{selectedSpan.id}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block">
                        {tc(TRACES_INSPECTOR_KIND)}
                      </span>
                      <span>{tc(SPAN_KIND_LABELS[selectedSpan.kind])}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block">
                        {tc(TRACES_INSPECTOR_STATUS)}
                      </span>
                      <span>{tc(SPAN_STATUS_LABELS[selectedSpan.status])}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block">
                        {tc(TRACES_INSPECTOR_OFFSET)}
                      </span>
                      <span>{formatSpanDuration(selectedSpan.startOffsetMs)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block">
                        {tc(TRACES_INSPECTOR_DURATION)}
                      </span>
                      <span>{formatSpanDuration(selectedSpan.durationMs)}</span>
                    </div>
                    {selectedSpan.model && (
                      <div>
                        <span className="text-muted-foreground block">
                          {tc(TRACES_INSPECTOR_MODEL)}
                        </span>
                        <span className="font-mono">{selectedSpan.model}</span>
                      </div>
                    )}
                    {(selectedSpan.promptTokens !== undefined ||
                      selectedSpan.completionTokens !== undefined) && (
                      <div>
                        <span className="text-muted-foreground block">
                          {tc(TRACES_INSPECTOR_TOKENS)}
                        </span>
                        <span className="font-mono">
                          {selectedSpan.promptTokens ?? 0} / {selectedSpan.completionTokens ?? 0} /{' '}
                          {selectedSpan.cachedTokens ?? 0}
                        </span>
                      </div>
                    )}
                  </div>

                  {selectedSpan.errorSummary && (
                    <div className="space-y-1 text-xs">
                      <span className="font-medium text-destructive block">
                        {tc(TRACES_INSPECTOR_ERROR)}
                      </span>
                      <pre className="rounded bg-destructive/10 p-2 font-mono text-[11px] text-destructive whitespace-pre-wrap">
                        {selectedSpan.errorSummary}
                      </pre>
                    </div>
                  )}

                  <div className="space-y-1.5 text-xs">
                    <span className="font-medium block">{tc(TRACES_INSPECTOR_ATTRIBUTES)}</span>
                    {Object.keys(selectedSpan.attributes).length === 0 ? (
                      <p className="text-muted-foreground">{tc(TRACES_INSPECTOR_NO_ATTRIBUTES)}</p>
                    ) : (
                      <div className="rounded border divide-y">
                        {Object.entries(selectedSpan.attributes).map(([key, value]) => (
                          <div
                            key={key}
                            data-testid={`trace-span-attr-${key}`}
                            className="flex items-center justify-between gap-4 px-2.5 py-1.5 font-mono text-[11px]"
                          >
                            <span className="text-muted-foreground">{key}</span>
                            <span className="break-all text-right">
                              {value === null ? 'null' : String(value)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
