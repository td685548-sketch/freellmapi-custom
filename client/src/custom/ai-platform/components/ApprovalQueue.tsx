import { useCallback, useEffect, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import {
  MCP_LIMITS,
  approveMcpAction,
  fetchMcpApprovals,
  rejectMcpAction,
  type McpApprovalStatus,
  type McpApprovalView,
} from '../mcp-api';
import {
  MCP_ACTION_FORBIDDEN,
  MCP_APPROVALS_HEADING,
  MCP_APPROVALS_US2_NOTE,
  MCP_APPROVAL_APPROVED,
  MCP_APPROVAL_CONFLICT,
  MCP_APPROVAL_EXECUTING,
  MCP_APPROVAL_EXECUTING_NOTICE,
  MCP_APPROVAL_EXPIRED,
  MCP_APPROVAL_FAILED,
  MCP_APPROVAL_PENDING,
  MCP_APPROVAL_REJECTED,
  MCP_APPROVAL_SUCCEEDED,
  MCP_APPROVAL_UNKNOWN,
  MCP_APPROVAL_UNKNOWN_NOTICE,
  MCP_APPROVE,
  MCP_DECISION_NOTE,
  MCP_EXPIRES_AT,
  MCP_FILTER_STATUS,
  MCP_MASKED_ARGS,
  MCP_NO_APPROVALS,
  MCP_PILLAR_DISABLED,
  MCP_REFRESH,
  MCP_REJECT,
  MCP_STATUS_ALL,
} from '../mcp-strings';

interface ApprovalQueueProps {
  canApprove: boolean;
}

const STATUS_LABEL: Record<McpApprovalStatus, string> = {
  pending: MCP_APPROVAL_PENDING,
  approved: MCP_APPROVAL_APPROVED,
  executing: MCP_APPROVAL_EXECUTING,
  succeeded: MCP_APPROVAL_SUCCEEDED,
  failed: MCP_APPROVAL_FAILED,
  unknown: MCP_APPROVAL_UNKNOWN,
  rejected: MCP_APPROVAL_REJECTED,
  expired: MCP_APPROVAL_EXPIRED,
};

export function ApprovalQueue({ canApprove }: ApprovalQueueProps) {
  const tc = useCustomT();
  const [statusFilter, setStatusFilter] = useState<McpApprovalStatus | 'all'>('all');
  const [approvals, setApprovals] = useState<McpApprovalView[]>([]);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [loadedFilter, setLoadedFilter] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [inFlightId, setInFlightId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filterKey = `${statusFilter}:${refreshTick}`;
  const loading = loadedFilter !== filterKey;

  const loadAbortRef = useRef<AbortController | null>(null);
  const actionAbortRef = useRef<AbortController | null>(null);
  const epochRef = useRef(0);
  const mountedRef = useRef(true);

  const loadApprovals = useCallback((filter: McpApprovalStatus | 'all') => {
    epochRef.current += 1;
    const callEpoch = epochRef.current;
    loadAbortRef.current?.abort();
    const ac = new AbortController();
    loadAbortRef.current = ac;

    fetchMcpApprovals(filter === 'all' ? undefined : filter, ac.signal)
      .then((res) => {
        if (!mountedRef.current || callEpoch !== epochRef.current || ac.signal.aborted) return;
        setApprovals(res.approvals);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || callEpoch !== epochRef.current) return;
        if ((err as { name?: string })?.name === 'AbortError') return;
        setError((err as Error)?.message ?? 'Failed to load approvals');
      })
      .finally(() => {
        if (mountedRef.current && callEpoch === epochRef.current) {
          setLoadedFilter(`${filter}:${refreshTick}`);
        }
      });
  }, [refreshTick]);

  useEffect(() => {
    mountedRef.current = true;
    loadApprovals(statusFilter);
    return () => {
      mountedRef.current = false;
      loadAbortRef.current?.abort();
      actionAbortRef.current?.abort();
    };
  }, [statusFilter, loadApprovals]);

  async function handleDecision(id: number, decision: 'approve' | 'reject') {
    if (!canApprove || inFlightId !== null) return;
    actionAbortRef.current?.abort();
    const ac = new AbortController();
    actionAbortRef.current = ac;
    const callEpoch = epochRef.current;
    const note = notes[id]?.trim() || undefined;

    setInFlightId(id);
    setError(null);
    try {
      const res =
        decision === 'approve'
          ? await approveMcpAction(id, { note }, ac.signal)
          : await rejectMcpAction(id, { note }, ac.signal);
      if (!mountedRef.current || callEpoch !== epochRef.current) return;
      setApprovals((prev) => prev.map((a) => (a.id === id ? res.approval : a)));
    } catch (err: unknown) {
      if (!mountedRef.current || callEpoch !== epochRef.current) return;
      if ((err as { name?: string })?.name === 'AbortError') return;
      const status = (err as { status?: number })?.status;
      const code = (err as { code?: string })?.code;
      if (status === 409 && (code === 'already_decided' || code === 'revision_conflict')) {
        setError(tc(MCP_APPROVAL_CONFLICT));
        setRefreshTick((t) => t + 1);
      } else if (status === 409 && code === 'pillar_disabled') {
        setError(tc(MCP_PILLAR_DISABLED));
      } else if (status === 403) {
        setError(tc(MCP_ACTION_FORBIDDEN));
      } else {
        setError((err as Error)?.message ?? 'Approval action failed');
      }
    } finally {
      if (mountedRef.current) {
        setInFlightId(null);
      }
    }
  }

  return (
    <section className="rounded-lg border bg-card p-4 space-y-3" data-testid="mcp-approval-queue">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-medium">{tc(MCP_APPROVALS_HEADING)}</h3>
        <div className="flex items-center gap-2">
          <label className="text-xs flex items-center gap-1.5">
            <span>{tc(MCP_FILTER_STATUS)}</span>
            <select
              data-testid="mcp-approvals-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as McpApprovalStatus | 'all')}
              className="rounded border bg-background px-2 py-1 text-xs"
            >
              <option value="all">{tc(MCP_STATUS_ALL)}</option>
              {(Object.keys(STATUS_LABEL) as McpApprovalStatus[]).map((st) => (
                <option key={st} value={st}>
                  {tc(STATUS_LABEL[st])}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setRefreshTick((t) => t + 1)}
            className="rounded border px-2 py-1 text-xs hover:bg-muted"
          >
            {tc(MCP_REFRESH)}
          </button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{tc(MCP_APPROVALS_US2_NOTE)}</p>

      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : approvals.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tc(MCP_NO_APPROVALS)}</p>
      ) : (
        <div className="space-y-3">
          {approvals.map((item) => {
            const isPending = item.status === 'pending';
            const isBusy = inFlightId === item.id;
            return (
              <div key={item.id} className="rounded border p-3 space-y-2" data-testid={`mcp-approval-${item.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium">
                    {item.serverSlug ? `${item.serverSlug} / ` : ''}
                    {item.exposedName ?? item.toolName ?? `Tool #${item.toolId}`}
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="rounded bg-muted px-2 py-0.5">{tc(STATUS_LABEL[item.status])}</span>
                    <span className="text-muted-foreground">
                      {tc(MCP_EXPIRES_AT)}: {item.expiresAt}
                    </span>
                  </div>
                </div>

                <div className="text-xs">
                  <span className="font-medium text-muted-foreground">{tc(MCP_MASKED_ARGS)}:</span>
                  <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-2 font-mono text-[11px]">
                    {item.argsMasked}
                  </pre>
                </div>

                {item.decisionNote && (
                  <div className="text-xs text-muted-foreground">{item.decisionNote}</div>
                )}

                {item.status === 'unknown' && (
                  <div className="text-xs text-amber-600 dark:text-amber-400">
                    {tc(MCP_APPROVAL_UNKNOWN_NOTICE)}
                  </div>
                )}

                {item.status === 'executing' && (
                  <div className="text-xs text-muted-foreground">
                    {tc(MCP_APPROVAL_EXECUTING_NOTICE)}
                  </div>
                )}

                {isPending && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <input
                      type="text"
                      maxLength={MCP_LIMITS.maxDecisionNoteChars}
                      placeholder={tc(MCP_DECISION_NOTE)}
                      value={notes[item.id] ?? ''}
                      disabled={!canApprove || isBusy}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      className="flex-1 min-w-[180px] rounded border bg-background px-2 py-1 text-xs"
                    />
                    <button
                      type="button"
                      data-testid={`mcp-approve-${item.id}`}
                      disabled={!canApprove || isBusy}
                      onClick={() => handleDecision(item.id, 'approve')}
                      className="rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
                    >
                      {tc(MCP_APPROVE)}
                    </button>
                    <button
                      type="button"
                      data-testid={`mcp-reject-${item.id}`}
                      disabled={!canApprove || isBusy}
                      onClick={() => handleDecision(item.id, 'reject')}
                      className="rounded border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    >
                      {tc(MCP_REJECT)}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
