import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import { useSessionRevision } from '../../session-state';
import { useAdministrativeAccess } from '../../use-administrative-access';
import { useUserSession } from '../../use-session';
import { RunTrace } from '../components/RunTrace';
import {
  FLOW_LIMITS,
  approveFlowAction,
  cancelRun,
  extractFlowErrorInfo,
  fetchFlowApprovals,
  fetchFlowProfileOptions,
  fetchFlows,
  fetchRunDetail,
  fetchRuns,
  rejectFlowAction,
  type FlowRunDetailResponse,
  type FlowRunStatus,
  type FlowRunStepView,
  type FlowRunView,
  type FlowView,
  type McpApprovalView,
  type ProfileOption,
} from '../flows-api';
import {
  FLOWS_FORBIDDEN_ERROR,
  FLOWS_LOADING,
  FLOWS_PILLAR_DISABLED,
  FLOWS_REFRESH,
  FLOWS_SESSION_EXPIRED,
  RUNS_APPROVALS_ACTION_ERROR,
  RUNS_APPROVALS_APPROVE,
  RUNS_APPROVALS_ARGS,
  RUNS_APPROVALS_CONFLICT,
  RUNS_APPROVALS_EMPTY,
  RUNS_APPROVALS_EXPIRES,
  RUNS_APPROVALS_HEADING,
  RUNS_APPROVALS_LOAD_ERROR,
  RUNS_APPROVALS_NOTE_PLACEHOLDER,
  RUNS_APPROVALS_REJECT,
  RUNS_APPROVALS_RUN_REF,
  RUNS_CANCELLED_SUCCESS,
  RUNS_CANCEL_ERROR,
  RUNS_COL_FLOW,
  RUNS_COL_PROFILE,
  RUNS_COL_RUN,
  RUNS_COL_STARTED,
  RUNS_COL_STATUS,
  RUNS_COL_STEPS,
  RUNS_COL_TOKENS,
  RUNS_DETAIL_ERROR,
  RUNS_DRY_RUN_BADGE,
  RUNS_EMPTY,
  RUNS_FILTER_FLOW,
  RUNS_FILTER_FLOW_PLACEHOLDER,
  RUNS_FILTER_PROFILE,
  RUNS_FILTER_PROFILE_PLACEHOLDER,
  RUNS_FILTER_STATUS,
  RUNS_LOAD_ERROR,
  RUNS_NO_PERMISSION,
  RUNS_PAGE_SUBTITLE,
  RUNS_PAGE_TITLE,
  RUNS_SELECT_HINT,
  RUNS_STATUS_ALL,
  RUNS_VIEW_REQUIRED_NOTICE,
  RUN_STATUS_LABELS,
} from '../flows-strings';

export const RUN_POLL_INTERVAL_MS = 2000;

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

function mergeSteps(existing: FlowRunStepView[], incoming: FlowRunStepView[]): FlowRunStepView[] {
  const bySeq = new Map<number, FlowRunStepView>();
  for (const s of existing) bySeq.set(s.seq, s);
  for (const s of incoming) bySeq.set(s.seq, s);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

const ALL_RUN_STATUSES: FlowRunStatus[] = [
  'running',
  'awaiting_approval',
  'completed',
  'stopped',
  'cancelled',
  'failed',
  'interrupted',
];

export function Runs() {
  const tc = useCustomT();
  const { can, identity } = useAdministrativeAccess();
  const { isPrimary, session } = useUserSession();
  const globalSessionRev = useSessionRevision();

  const canViewRuns = isPrimary || can('view_flow_runs');
  const canCancel = isPrimary || can('cancel_flow_runs');
  const canApprove = isPrimary || can('approve_ai_actions');

  const sessionRevision = useMemo(() => {
    const uid = session?.userId ?? 0;
    let idHash = 0;
    for (let i = 0; i < identity.length; i += 1) {
      idHash = (idHash * 31 + identity.charCodeAt(i)) | 0;
    }
    return uid * 10_000 + Math.abs(idHash % 1000) + globalSessionRev * 1000;
  }, [session?.userId, identity, globalSessionRev]);

  if (!canViewRuns && !canCancel && !canApprove) {
    return (
      <div className="p-6" data-testid="runs-no-permission">
        <p className="text-sm text-muted-foreground">{tc(RUNS_NO_PERMISSION)}</p>
      </div>
    );
  }

  return (
    <RunsContent
      key={sessionRevision}
      canViewRuns={canViewRuns}
      canCancel={canCancel}
      canApprove={canApprove}
    />
  );
}

function RunsContent({
  canViewRuns,
  canCancel,
  canApprove,
}: {
  canViewRuns: boolean;
  canCancel: boolean;
  canApprove: boolean;
}) {
  const tc = useCustomT();

  // Filters
  const [flowFilter, setFlowFilter] = useState('');
  const [profileFilter, setProfileFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<FlowRunStatus | ''>('');
  const [flowsList, setFlowsList] = useState<FlowView[]>([]);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);

  // Runs & detail
  const [runs, setRuns] = useState<FlowRunView[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<FlowRunDetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [actionBanner, setActionBanner] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  // Pending approvals
  const [approvals, setApprovals] = useState<McpApprovalView[]>([]);
  const [loadingApprovals, setLoadingApprovals] = useState(false);
  const [approvalsError, setApprovalsError] = useState<string | null>(null);
  const [approvalNotes, setApprovalNotes] = useState<Record<number, string>>({});
  const [approvalInFlightId, setApprovalInFlightId] = useState<number | null>(null);

  // Lifecycle refs
  const mountedRef = useRef(true);
  const runsEpochRef = useRef(0);
  const detailEpochRef = useRef(0);
  const approvalsEpochRef = useRef(0);
  const runsAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const approvalsAbortRef = useRef<AbortController | null>(null);
  const actionAbortRef = useRef<AbortController | null>(null);
  const lastSeqRef = useRef<number>(0);

  const formatApiError = useCallback(
    (err: unknown, fallback: string): string => {
      const info = extractFlowErrorInfo(err);
      if (info.status === 401) return tc(FLOWS_SESSION_EXPIRED);
      if (info.status === 403) return tc(FLOWS_FORBIDDEN_ERROR);
      if (info.status === 409 && info.code === 'pillar_disabled') return tc(FLOWS_PILLAR_DISABLED);
      return info.message && info.message !== 'Request failed' ? info.message : fallback;
    },
    [tc],
  );

  const loadRuns = useCallback(async () => {
    if (!canViewRuns) return;
    const epoch = ++runsEpochRef.current;
    runsAbortRef.current?.abort();
    const ac = new AbortController();
    runsAbortRef.current = ac;
    setLoadingRuns(true);
    setRunsError(null);

    try {
      const res = await fetchRuns(
        {
          flow: flowFilter.trim() || undefined,
          profile: profileFilter.trim() || undefined,
          status: statusFilter || undefined,
        },
        ac.signal,
      );
      if (!mountedRef.current || ac.signal.aborted || runsEpochRef.current !== epoch) return;
      setRuns(res.runs);
      setSelectedRunId((prev) => {
        if (prev && res.runs.some((r) => r.id === prev)) return prev;
        return res.runs[0]?.id ?? null;
      });
    } catch (err) {
      if (!mountedRef.current || isAbortError(err) || runsEpochRef.current !== epoch) return;
      setRunsError(formatApiError(err, tc(RUNS_LOAD_ERROR)));
    } finally {
      if (mountedRef.current && runsEpochRef.current === epoch) {
        setLoadingRuns(false);
      }
    }
  }, [canViewRuns, flowFilter, profileFilter, statusFilter, formatApiError, tc]);

  const loadRunDetail = useCallback(
    async (runId: string) => {
      if (!canViewRuns) return;
      const epoch = ++detailEpochRef.current;
      detailAbortRef.current?.abort();
      pollAbortRef.current?.abort();
      const ac = new AbortController();
      detailAbortRef.current = ac;
      setLoadingDetail(true);
      setDetailError(null);

      try {
        const res = await fetchRunDetail(runId, undefined, ac.signal);
        if (!mountedRef.current || ac.signal.aborted || detailEpochRef.current !== epoch) return;
        const sorted = [...res.steps].sort((a, b) => a.seq - b.seq);
        lastSeqRef.current = sorted.length > 0 ? sorted[sorted.length - 1].seq : 0;
        setSelectedDetail({ run: res.run, steps: sorted });
        setRuns((prev) => prev.map((r) => (r.id === res.run.id ? res.run : r)));
      } catch (err) {
        if (!mountedRef.current || isAbortError(err) || detailEpochRef.current !== epoch) return;
        setDetailError(formatApiError(err, tc(RUNS_DETAIL_ERROR)));
      } finally {
        if (mountedRef.current && detailEpochRef.current === epoch) {
          setLoadingDetail(false);
        }
      }
    },
    [canViewRuns, formatApiError, tc],
  );

  const loadApprovals = useCallback(
    async (opts?: { preserveError?: boolean }) => {
      if (!canApprove) return;
      const epoch = ++approvalsEpochRef.current;
      approvalsAbortRef.current?.abort();
      const ac = new AbortController();
      approvalsAbortRef.current = ac;
      setLoadingApprovals(true);
      if (!opts?.preserveError) {
        setApprovalsError(null);
      }

      try {
        const res = await fetchFlowApprovals('pending', ac.signal);
        if (!mountedRef.current || ac.signal.aborted || approvalsEpochRef.current !== epoch) return;
        setApprovals(res.approvals);
      } catch (err) {
        if (!mountedRef.current || isAbortError(err) || approvalsEpochRef.current !== epoch) return;
        setApprovalsError(formatApiError(err, tc(RUNS_APPROVALS_LOAD_ERROR)));
      } finally {
        if (mountedRef.current && approvalsEpochRef.current === epoch) {
          setLoadingApprovals(false);
        }
      }
    },
    [canApprove, formatApiError, tc],
  );

  // Initial metadata + approvals load
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    const ac = new AbortController();

    if (canViewRuns) {
      void fetchFlowProfileOptions(ac.signal)
        .then((list) => {
          if (mountedRef.current && !ac.signal.aborted) setProfiles(list);
        })
        .catch(() => {});
      void fetchFlows(ac.signal)
        .then((res) => {
          if (mountedRef.current && !ac.signal.aborted) setFlowsList(res.flows);
        })
        .catch(() => {});
    }

    if (canApprove) {
      queueMicrotask(() => {
        if (!cancelled) void loadApprovals();
      });
    }

    return () => {
      cancelled = true;
      mountedRef.current = false;
      ac.abort();
      runsEpochRef.current += 1;
      detailEpochRef.current += 1;
      approvalsEpochRef.current += 1;
      runsAbortRef.current?.abort();
      detailAbortRef.current?.abort();
      pollAbortRef.current?.abort();
      approvalsAbortRef.current?.abort();
      actionAbortRef.current?.abort();
    };
  }, [canViewRuns, canApprove, loadApprovals]);

  // Load runs whenever filters change
  useEffect(() => {
    if (!canViewRuns) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadRuns();
    });
    return () => {
      cancelled = true;
    };
  }, [canViewRuns, loadRuns]);

  // Load selected run detail when selectedRunId changes
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (!canViewRuns || !selectedRunId) {
        setSelectedDetail(null);
        lastSeqRef.current = 0;
        return;
      }
      void loadRunDetail(selectedRunId);
    });
    return () => {
      cancelled = true;
    };
  }, [canViewRuns, selectedRunId, loadRunDetail]);

  // Live trace polling when run is active ('running' or 'awaiting_approval')
  const activeRunStatus = selectedDetail?.run.status;
  const activeRunId = selectedDetail?.run.id ?? null;
  const isPolling =
    canViewRuns &&
    activeRunId !== null &&
    (activeRunStatus === 'running' || activeRunStatus === 'awaiting_approval');

  useEffect(() => {
    if (!isPolling || !activeRunId) return;

    const timer = setInterval(() => {
      pollAbortRef.current?.abort();
      const ac = new AbortController();
      pollAbortRef.current = ac;
      const targetRunId = activeRunId;
      const afterSeq = lastSeqRef.current;

      void fetchRunDetail(targetRunId, afterSeq, ac.signal)
        .then((res) => {
          if (!mountedRef.current || ac.signal.aborted) return;
          setSelectedDetail((prev) => {
            if (!prev || prev.run.id !== targetRunId) return prev;
            const merged = mergeSteps(prev.steps, res.steps);
            lastSeqRef.current = merged.length > 0 ? merged[merged.length - 1].seq : lastSeqRef.current;
            return { run: res.run, steps: merged };
          });
          setRuns((prev) => prev.map((r) => (r.id === res.run.id ? res.run : r)));
        })
        .catch(() => {
          // Transient poll errors do not clear existing trace; next tick retries.
        });
    }, RUN_POLL_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      pollAbortRef.current?.abort();
    };
  }, [isPolling, activeRunId]);

  async function handleCancelRun() {
    if (!canCancel || !selectedDetail || cancelling) return;
    const runId = selectedDetail.run.id;
    actionAbortRef.current?.abort();
    const ac = new AbortController();
    actionAbortRef.current = ac;
    setCancelling(true);
    setActionBanner(null);

    try {
      const res = await cancelRun(runId, ac.signal);
      if (!mountedRef.current || ac.signal.aborted) return;
      const nextRun: FlowRunView = res.run ?? {
        ...selectedDetail.run,
        status: 'cancelled',
      };
      setSelectedDetail((prev) => (prev && prev.run.id === runId ? { ...prev, run: nextRun } : prev));
      setRuns((prev) => prev.map((r) => (r.id === runId ? nextRun : r)));
      setActionBanner({ kind: 'info', text: tc(RUNS_CANCELLED_SUCCESS) });
      if (canViewRuns) {
        void loadRunDetail(runId);
      }
    } catch (err) {
      if (!mountedRef.current || isAbortError(err)) return;
      setActionBanner({ kind: 'error', text: formatApiError(err, tc(RUNS_CANCEL_ERROR)) });
    } finally {
      if (mountedRef.current) setCancelling(false);
    }
  }

  async function handleApprovalDecision(item: McpApprovalView, decision: 'approve' | 'reject') {
    if (!canApprove || approvalInFlightId !== null) return;
    actionAbortRef.current?.abort();
    const ac = new AbortController();
    actionAbortRef.current = ac;
    setApprovalInFlightId(item.id);
    setApprovalsError(null);
    const note = approvalNotes[item.id]?.trim() || undefined;

    try {
      if (decision === 'approve') {
        await approveFlowAction(item.id, { note }, ac.signal);
      } else {
        await rejectFlowAction(item.id, { note }, ac.signal);
      }
      if (!mountedRef.current || ac.signal.aborted) return;
      setApprovals((prev) => prev.filter((a) => a.id !== item.id));
      if (canViewRuns && item.runId && item.runId === selectedRunId) {
        void loadRunDetail(item.runId);
      }
    } catch (err) {
      if (!mountedRef.current || isAbortError(err)) return;
      const info = extractFlowErrorInfo(err);
      if (
        info.status === 409 &&
        (info.code === 'already_decided' || info.code === 'revision_conflict' || info.code === 'conflict_error')
      ) {
        setApprovalsError(tc(RUNS_APPROVALS_CONFLICT));
        void loadApprovals({ preserveError: true });
      } else {
        setApprovalsError(formatApiError(err, tc(RUNS_APPROVALS_ACTION_ERROR)));
      }
    } finally {
      if (mountedRef.current) setApprovalInFlightId(null);
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl" data-testid="runs-page">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{tc(RUNS_PAGE_TITLE)}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{tc(RUNS_PAGE_SUBTITLE)}</p>
        </div>
        {canViewRuns && (
          <button
            type="button"
            data-testid="runs-refresh-btn"
            onClick={() => void loadRuns()}
            className="rounded border px-3 py-1.5 text-xs hover:bg-muted"
          >
            {tc(FLOWS_REFRESH)}
          </button>
        )}
      </header>

      {!canViewRuns && (
        <div
          data-testid="runs-view-required-notice"
          className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
        >
          {tc(RUNS_VIEW_REQUIRED_NOTICE)}
        </div>
      )}

      {actionBanner && (
        <div
          role={actionBanner.kind === 'error' ? 'alert' : 'status'}
          data-testid="runs-action-banner"
          className={`rounded border px-3 py-2 text-xs ${
            actionBanner.kind === 'error'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          }`}
        >
          {actionBanner.text}
        </div>
      )}

      {/* ─── Pending Approvals Section ─────────────────────────────────────── */}
      {canApprove && (
        <section
          className="rounded-lg border bg-card p-4 space-y-3"
          data-testid="runs-approvals-section"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold">{tc(RUNS_APPROVALS_HEADING)}</h2>
            <button
              type="button"
              data-testid="runs-approvals-refresh-btn"
              onClick={() => void loadApprovals()}
              className="rounded border px-2.5 py-1 text-xs hover:bg-muted"
            >
              {tc(FLOWS_REFRESH)}
            </button>
          </div>

          {approvalsError && (
            <div
              role="alert"
              data-testid="runs-approvals-error"
              className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {approvalsError}
            </div>
          )}

          {loadingApprovals ? (
            <p className="text-sm text-muted-foreground">{tc(FLOWS_LOADING)}</p>
          ) : approvals.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="runs-approvals-empty">
              {tc(RUNS_APPROVALS_EMPTY)}
            </p>
          ) : (
            <div className="space-y-2.5">
              {approvals.map((item) => {
                const isBusy = approvalInFlightId === item.id;
                return (
                  <div
                    key={item.id}
                    data-testid={`runs-approval-${item.id}`}
                    className="rounded border p-3 space-y-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-medium">
                        {item.serverSlug ? `${item.serverSlug} / ` : ''}
                        {item.exposedName ?? item.toolName ?? `Tool #${item.toolId}`}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                        {item.runId && (
                          <span className="font-mono">
                            {tc(RUNS_APPROVALS_RUN_REF, {
                              runId: item.runId,
                              seq: item.stepSeq,
                            })}
                          </span>
                        )}
                        <span>
                          {tc(RUNS_APPROVALS_EXPIRES)}: {item.expiresAt}
                        </span>
                      </div>
                    </div>

                    <div>
                      <span className="font-medium text-muted-foreground">
                        {tc(RUNS_APPROVALS_ARGS)}:
                      </span>
                      <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-2 font-mono text-[11px]">
                        {item.argsMasked}
                      </pre>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <input
                        type="text"
                        maxLength={FLOW_LIMITS.stepLogMaxBytes}
                        placeholder={tc(RUNS_APPROVALS_NOTE_PLACEHOLDER)}
                        data-testid={`runs-approval-note-${item.id}`}
                        value={approvalNotes[item.id] ?? ''}
                        disabled={isBusy}
                        onChange={(e) =>
                          setApprovalNotes((prev) => ({ ...prev, [item.id]: e.target.value }))
                        }
                        className="flex-1 min-w-[180px] rounded border bg-background px-2 py-1 text-xs"
                      />
                      <button
                        type="button"
                        data-testid={`runs-approve-${item.id}`}
                        disabled={isBusy}
                        onClick={() => void handleApprovalDecision(item, 'approve')}
                        className="rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
                      >
                        {tc(RUNS_APPROVALS_APPROVE)}
                      </button>
                      <button
                        type="button"
                        data-testid={`runs-reject-${item.id}`}
                        disabled={isBusy}
                        onClick={() => void handleApprovalDecision(item, 'reject')}
                        className="rounded border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                      >
                        {tc(RUNS_APPROVALS_REJECT)}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* ─── Runs Filters & List ───────────────────────────────────────────── */}
      {canViewRuns && (
        <div className="space-y-6">
          <section className="rounded-lg border bg-card p-4 space-y-4" data-testid="runs-list-section">
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(RUNS_FILTER_FLOW)}</span>
                <input
                  type="text"
                  list="runs-flow-filter-options"
                  data-testid="runs-filter-flow"
                  placeholder={tc(RUNS_FILTER_FLOW_PLACEHOLDER)}
                  value={flowFilter}
                  onChange={(e) => setFlowFilter(e.target.value)}
                  className="rounded border bg-background px-2 py-1.5 text-sm font-mono"
                />
                <datalist id="runs-flow-filter-options">
                  {flowsList.map((f) => (
                    <option key={f.id} value={f.slug} />
                  ))}
                </datalist>
              </label>

              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(RUNS_FILTER_PROFILE)}</span>
                {profiles.length > 0 ? (
                  <select
                    data-testid="runs-filter-profile"
                    value={profileFilter}
                    onChange={(e) => setProfileFilter(e.target.value)}
                    className="rounded border bg-background px-2 py-1.5 text-sm"
                  >
                    <option value="">{tc(RUNS_FILTER_PROFILE_PLACEHOLDER)}</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={String(p.id)}>
                        {p.name} (#{p.id})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    data-testid="runs-filter-profile"
                    placeholder={tc(RUNS_FILTER_PROFILE_PLACEHOLDER)}
                    value={profileFilter}
                    onChange={(e) => setProfileFilter(e.target.value)}
                    className="rounded border bg-background px-2 py-1.5 text-sm font-mono"
                  />
                )}
              </label>

              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(RUNS_FILTER_STATUS)}</span>
                <select
                  data-testid="runs-filter-status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as FlowRunStatus | '')}
                  className="rounded border bg-background px-2 py-1.5 text-sm"
                >
                  <option value="">{tc(RUNS_STATUS_ALL)}</option>
                  {ALL_RUN_STATUSES.map((st) => (
                    <option key={st} value={st}>
                      {tc(RUN_STATUS_LABELS[st])}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {runsError && (
              <div
                role="alert"
                data-testid="runs-load-error"
                className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {runsError}
              </div>
            )}

            {loadingRuns ? (
              <p className="text-sm text-muted-foreground">{tc(FLOWS_LOADING)}</p>
            ) : runs.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="runs-empty">
                {tc(RUNS_EMPTY)}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse" data-testid="runs-table">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3">{tc(RUNS_COL_RUN)}</th>
                      <th className="py-2 pr-3">{tc(RUNS_COL_FLOW)}</th>
                      <th className="py-2 pr-3">{tc(RUNS_COL_PROFILE)}</th>
                      <th className="py-2 pr-3">{tc(RUNS_COL_STATUS)}</th>
                      <th className="py-2 pr-3">{tc(RUNS_COL_STEPS)}</th>
                      <th className="py-2 pr-3">{tc(RUNS_COL_TOKENS)}</th>
                      <th className="py-2">{tc(RUNS_COL_STARTED)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => {
                      const selected = r.id === selectedRunId;
                      return (
                        <tr
                          key={r.id}
                          data-testid={`run-row-${r.id}`}
                          onClick={() => setSelectedRunId(r.id)}
                          className={`border-b last:border-b-0 cursor-pointer ${
                            selected ? 'bg-primary/5' : 'hover:bg-muted/40'
                          }`}
                        >
                          <td className="py-2 pr-3 font-mono text-xs">
                            {r.id}{' '}
                            {r.isDryRun && (
                              <span className="rounded bg-purple-500/15 text-purple-700 dark:text-purple-300 px-1.5 py-0.5 text-[10px]">
                                {tc(RUNS_DRY_RUN_BADGE)}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 font-mono text-xs">
                            {r.flowSlug} v{r.flowVersion}
                          </td>
                          <td className="py-2 pr-3 text-xs">#{r.profileId}</td>
                          <td className="py-2 pr-3 text-xs">
                            <span>{tc(RUN_STATUS_LABELS[r.status])}</span>
                            {r.stopReason && (
                              <span className="ml-1 font-mono text-muted-foreground">
                                ({r.stopReason})
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-xs">{r.steps}</td>
                          <td className="py-2 pr-3 text-xs font-mono">{r.totalTokens}</td>
                          <td className="py-2 text-xs text-muted-foreground">{r.startedAt}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ─── Live Trace Viewer ─────────────────────────────────────────── */}
          {detailError && (
            <div
              role="alert"
              data-testid="runs-detail-error"
              className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {detailError}
            </div>
          )}

          {loadingDetail && !selectedDetail ? (
            <p className="text-sm text-muted-foreground">{tc(FLOWS_LOADING)}</p>
          ) : selectedDetail ? (
            <RunTrace
              run={selectedDetail.run}
              steps={selectedDetail.steps}
              isPolling={isPolling}
              canCancel={canCancel}
              cancelling={cancelling}
              onCancel={() => void handleCancelRun()}
              onRefresh={() => void loadRunDetail(selectedDetail.run.id)}
            />
          ) : (
            <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
              {tc(RUNS_SELECT_HINT)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
