import { useCustomT } from '../../i18n/use-custom-t';
import type {
  FlowRunStatus,
  FlowRunStepView,
  FlowRunView,
  FlowStepKind,
  FlowStepStatus,
} from '../flows-api';
import {
  FLOWS_REFRESH,
  RUNS_CANCELLING_BTN,
  RUNS_CANCEL_BTN,
  RUNS_COUNTERS,
  RUNS_DRY_RUN_BADGE,
  RUNS_LIVE_POLLING,
  RUNS_TOTAL_TOKENS,
  RUN_STATUS_LABELS,
  TRACE_DURATION_MS,
  TRACE_EMPTY,
  TRACE_ERROR_LABEL,
  TRACE_HEADING,
  TRACE_INPUT_LABEL,
  TRACE_OUTPUT_LABEL,
  TRACE_STEP_APPROVAL,
  TRACE_STEP_GUARD,
  TRACE_STEP_HANDOFF,
  TRACE_STEP_MODEL,
  TRACE_STEP_STATUS_ERROR,
  TRACE_STEP_STATUS_OK,
  TRACE_STEP_STATUS_SKIPPED,
  TRACE_STEP_STOP,
  TRACE_STEP_TOOL,
} from '../flows-strings';

export interface RunTraceProps {
  run: FlowRunView;
  steps: FlowRunStepView[];
  isPolling?: boolean;
  canCancel?: boolean;
  cancelling?: boolean;
  onCancel?: () => void;
  onRefresh?: () => void;
}

const STEP_KIND_LABEL: Record<FlowStepKind, string> = {
  model: TRACE_STEP_MODEL,
  tool: TRACE_STEP_TOOL,
  handoff: TRACE_STEP_HANDOFF,
  approval: TRACE_STEP_APPROVAL,
  guard: TRACE_STEP_GUARD,
  stop: TRACE_STEP_STOP,
};

const STEP_STATUS_LABEL: Record<FlowStepStatus, string> = {
  ok: TRACE_STEP_STATUS_OK,
  error: TRACE_STEP_STATUS_ERROR,
  skipped: TRACE_STEP_STATUS_SKIPPED,
};

function runStatusBadgeClass(status: FlowRunStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
    case 'running':
      return 'bg-blue-500/15 text-blue-700 dark:text-blue-300';
    case 'awaiting_approval':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
    case 'stopped':
    case 'cancelled':
    case 'interrupted':
      return 'bg-muted text-muted-foreground';
    case 'failed':
      return 'bg-destructive/15 text-destructive';
  }
}

function stepStatusBadgeClass(status: FlowStepStatus): string {
  if (status === 'error') return 'bg-destructive/15 text-destructive';
  if (status === 'skipped') return 'bg-muted text-muted-foreground';
  return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
}

export function RunTrace({
  run,
  steps,
  isPolling = false,
  canCancel = false,
  cancelling = false,
  onCancel,
  onRefresh,
}: RunTraceProps) {
  const tc = useCustomT();
  const isActive = run.status === 'running' || run.status === 'awaiting_approval';
  const sortedSteps = [...steps].sort((a, b) => a.seq - b.seq);

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4" data-testid="run-trace">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-medium">{tc(TRACE_HEADING)}</h3>
            <span className="font-mono text-xs text-muted-foreground" data-testid="run-trace-id">
              {run.id}
            </span>
            <span
              data-testid="run-trace-status"
              className={`rounded px-2 py-0.5 text-xs font-medium ${runStatusBadgeClass(run.status)}`}
            >
              {tc(RUN_STATUS_LABELS[run.status])}
            </span>
            {run.stopReason && (
              <span
                data-testid="run-trace-stop-reason"
                className="rounded bg-muted px-2 py-0.5 text-xs font-mono"
              >
                {run.stopReason}
              </span>
            )}
            {run.isDryRun && (
              <span className="rounded bg-purple-500/15 text-purple-700 dark:text-purple-300 px-2 py-0.5 text-xs font-medium">
                {tc(RUNS_DRY_RUN_BADGE)}
              </span>
            )}
            {isPolling && (
              <span
                data-testid="run-trace-polling"
                className="rounded bg-blue-500/10 text-blue-700 dark:text-blue-300 px-2 py-0.5 text-xs"
              >
                {tc(RUNS_LIVE_POLLING)}
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground flex flex-wrap gap-3">
            <span>
              {run.flowSlug} (v{run.flowVersion})
            </span>
            <span>{run.wire}</span>
            <span>
              {tc(RUNS_COUNTERS, {
                steps: run.steps,
                tools: run.toolCalls,
                handoffs: run.handoffs,
              })}
            </span>
            <span>
              {tc(RUNS_TOTAL_TOKENS, {
                total: run.totalTokens,
                prompt: run.promptTokens,
                completion: run.completionTokens,
              })}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {onRefresh && (
            <button
              type="button"
              data-testid="run-trace-refresh-btn"
              onClick={onRefresh}
              className="rounded border px-2.5 py-1 text-xs hover:bg-muted"
            >
              {tc(FLOWS_REFRESH)}
            </button>
          )}
          {isActive && onCancel && (
            <button
              type="button"
              data-testid="run-trace-cancel-btn"
              disabled={!canCancel || cancelling}
              onClick={onCancel}
              className="rounded bg-destructive px-2.5 py-1 text-xs font-medium text-destructive-foreground disabled:opacity-50"
            >
              {cancelling ? tc(RUNS_CANCELLING_BTN) : tc(RUNS_CANCEL_BTN)}
            </button>
          )}
        </div>
      </div>

      {run.error && (
        <div
          data-testid="run-trace-error"
          role="alert"
          className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {run.error}
        </div>
      )}

      {run.finalTextMasked && (
        <div className="text-xs space-y-1" data-testid="run-trace-final-text">
          <span className="font-medium text-muted-foreground">{tc(TRACE_OUTPUT_LABEL)}:</span>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-[11px]">
            {run.finalTextMasked}
          </pre>
        </div>
      )}

      {sortedSteps.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="run-trace-empty">
          {tc(TRACE_EMPTY)}
        </p>
      ) : (
        <ol className="space-y-2.5" data-testid="run-trace-steps">
          {sortedSteps.map((step) => (
            <li
              key={`${step.runId}-${step.seq}`}
              data-testid={`run-step-${step.seq}`}
              className="rounded border p-3 space-y-2 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">#{step.seq}</span>
                  <span
                    data-testid={`run-step-kind-${step.seq}`}
                    className="rounded bg-primary/10 text-primary px-2 py-0.5 font-medium"
                  >
                    {tc(STEP_KIND_LABEL[step.kind])}
                  </span>
                  <span className="rounded bg-muted px-2 py-0.5 font-mono">{step.agentSlug}</span>
                  {step.model && (
                    <span className="text-muted-foreground font-mono">{step.model}</span>
                  )}
                  {step.toolName && (
                    <span className="text-muted-foreground font-mono">{step.toolName}</span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-2 py-0.5 font-medium ${stepStatusBadgeClass(step.status)}`}>
                    {tc(STEP_STATUS_LABEL[step.status])}
                  </span>
                  <span className="text-muted-foreground">
                    {tc(TRACE_DURATION_MS, { ms: step.durationMs })}
                  </span>
                  {(step.promptTokens > 0 || step.completionTokens > 0) && (
                    <span className="text-muted-foreground font-mono">
                      {step.promptTokens}/{step.completionTokens} tok
                    </span>
                  )}
                </div>
              </div>

              {step.inputMasked && (
                <div>
                  <span className="font-medium text-muted-foreground">{tc(TRACE_INPUT_LABEL)}:</span>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-[11px]">
                    {step.inputMasked}
                  </pre>
                </div>
              )}

              {step.outputMasked && (
                <div>
                  <span className="font-medium text-muted-foreground">{tc(TRACE_OUTPUT_LABEL)}:</span>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-[11px]">
                    {step.outputMasked}
                  </pre>
                </div>
              )}

              {step.error && (
                <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-destructive">
                  <span className="font-medium">{tc(TRACE_ERROR_LABEL)}: </span>
                  {step.error}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
