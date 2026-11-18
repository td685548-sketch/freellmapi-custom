import crypto from 'node:crypto';
import type { Request } from 'express';
import {
  FLOW_SCHEDULE_LIMITS,
  type AsyncFlowRunInput,
  type AsyncFlowRunResponse,
  type FlowScheduleInput,
  type FlowScheduleKind,
  type FlowScheduleTickResponse,
  type FlowScheduleView,
} from '@freellmapi/shared/ai-platform-tracing-oauth.js';
import { getDb } from '../../../db/index.js';
import { isPillarEnabled } from '../flags.js';
import {
  createRequestTraceCollector,
  runWithTraceCollector,
} from '../tracing/collector.js';
import {
  OrchestratorConflictError,
  OrchestratorError,
  getFlow,
  isFlowGrantedToProfile,
  validateFlowDraftDefinition,
} from './definitions.js';
import {
  recordServerLocalAddress,
  startRun,
  type FlowExecutionResult,
  type OrchestratorEngineDeps,
} from './engine.js';
import { getRunRecord } from './trace.js';

interface FlowScheduleRow {
  id: number;
  flow_id: number;
  enabled: number;
  schedule_kind: FlowScheduleKind;
  interval_seconds: number | null;
  cron_expr: string | null;
  profile_id: number;
  end_user: string | null;
  input_message: string;
  last_run_id: string | null;
  last_run_at: string | null;
  last_status: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  flow_slug?: string | null;
}

interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domWildcard: boolean;
  dowWildcard: boolean;
}

const inFlightAsyncRuns = new Map<string, Promise<FlowExecutionResult>>();
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let tickInProgress = false;

function hasSchedulesTable(): boolean {
  try {
    return Boolean(
      getDb()
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_ai_flow_schedules'")
        .get(),
    );
  } catch {
    return false;
  }
}

function parseCronField(
  rawField: string,
  min: number,
  max: number,
  label: string,
  allowSevenSunday = false,
): { values: Set<number>; isWildcard: boolean } {
  const trimmed = rawField.trim();
  if (!trimmed) {
    throw new OrchestratorError(400, 'invalid_cron', `Invalid cron ${label} field.`);
  }
  const isWildcard = trimmed === '*';
  const values = new Set<number>();
  const effectiveMax = allowSevenSunday ? 7 : max;

  for (const part of trimmed.split(',')) {
    const token = part.trim();
    if (!token) {
      throw new OrchestratorError(400, 'invalid_cron', `Empty token in cron ${label} field.`);
    }

    const slashParts = token.split('/');
    if (slashParts.length > 2) {
      throw new OrchestratorError(400, 'invalid_cron', `Invalid step syntax in cron ${label}.`);
    }
    const rangePart = slashParts[0]!;
    const step =
      slashParts.length === 2
        ? (() => {
            if (!/^\d+$/.test(slashParts[1]!)) {
              throw new OrchestratorError(400, 'invalid_cron', `Invalid step in cron ${label}.`);
            }
            const n = Number(slashParts[1]!);
            if (!Number.isInteger(n) || n <= 0) {
              throw new OrchestratorError(400, 'invalid_cron', `Cron step must be >= 1 in ${label}.`);
            }
            return n;
          })()
        : 1;

    let rangeStart = min;
    let rangeEnd = max;
    if (rangePart !== '*') {
      const dashParts = rangePart.split('-');
      if (dashParts.length === 1) {
        if (!/^\d+$/.test(dashParts[0]!)) {
          throw new OrchestratorError(400, 'invalid_cron', `Invalid number in cron ${label}.`);
        }
        const val = Number(dashParts[0]!);
        if (val < min || val > effectiveMax) {
          throw new OrchestratorError(
            400,
            'invalid_cron',
            `Cron ${label} value ${val} out of range (${min}-${effectiveMax}).`,
          );
        }
        rangeStart = val;
        rangeEnd = slashParts.length === 2 ? max : val;
      } else if (dashParts.length === 2) {
        if (!/^\d+$/.test(dashParts[0]!) || !/^\d+$/.test(dashParts[1]!)) {
          throw new OrchestratorError(400, 'invalid_cron', `Invalid range in cron ${label}.`);
        }
        rangeStart = Number(dashParts[0]!);
        rangeEnd = Number(dashParts[1]!);
        if (rangeStart < min || rangeEnd > effectiveMax || rangeStart > rangeEnd) {
          throw new OrchestratorError(400, 'invalid_cron', `Invalid range bounds in cron ${label}.`);
        }
      } else {
        throw new OrchestratorError(400, 'invalid_cron', `Invalid range syntax in cron ${label}.`);
      }
    }

    for (let v = rangeStart; v <= rangeEnd; v += step) {
      values.add(allowSevenSunday && v === 7 ? 0 : v);
    }
  }

  if (values.size === 0) {
    throw new OrchestratorError(400, 'invalid_cron', `Cron ${label} field matched no values.`);
  }
  return { values, isWildcard };
}

export function parseCronExpression(rawExpr: string): ParsedCron {
  const trimmed = String(rawExpr ?? '').trim();
  if (!trimmed || trimmed.length > FLOW_SCHEDULE_LIMITS.maxCronChars) {
    throw new OrchestratorError(400, 'invalid_cron', 'Cron expression must be a 5-field UTC schedule.');
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new OrchestratorError(
      400,
      'invalid_cron',
      'Cron expression must have exactly 5 fields: minute hour day-of-month month day-of-week.',
    );
  }

  const minutes = parseCronField(fields[0]!, 0, 59, 'minute');
  const hours = parseCronField(fields[1]!, 0, 23, 'hour');
  const dom = parseCronField(fields[2]!, 1, 31, 'day-of-month');
  const months = parseCronField(fields[3]!, 1, 12, 'month');
  const dow = parseCronField(fields[4]!, 0, 6, 'day-of-week', true);

  return {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: dom.values,
    months: months.values,
    daysOfWeek: dow.values,
    domWildcard: dom.isWildcard,
    dowWildcard: dow.isWildcard,
  };
}

function dayMatchesCron(cron: ParsedCron, utcDate: Date): boolean {
  const domMatch = cron.daysOfMonth.has(utcDate.getUTCDate());
  const dowMatch = cron.daysOfWeek.has(utcDate.getUTCDay());
  if (!cron.domWildcard && !cron.dowWildcard) {
    // Standard Vixie cron semantics: when both DOM and DOW are restricted, match either.
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

export function computeNextCronRunAt(cronExpr: string, fromDate: Date = new Date()): Date {
  const cron = parseCronExpression(cronExpr);
  // Start searching from the next whole UTC minute strictly after `fromDate`.
  const candidate = new Date(fromDate.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  const maxYear = candidate.getUTCFullYear() + 4;
  while (candidate.getUTCFullYear() <= maxYear) {
    const month = candidate.getUTCMonth() + 1;
    if (!cron.months.has(month)) {
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    if (!dayMatchesCron(cron, candidate)) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    if (!cron.hours.has(candidate.getUTCHours())) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }

    if (!cron.minutes.has(candidate.getUTCMinutes())) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
      continue;
    }

    return candidate;
  }

  throw new OrchestratorError(
    400,
    'invalid_cron',
    'Cron expression did not match any date within the next 4 years.',
  );
}

function computeNextScheduleIso(
  scheduleKind: FlowScheduleKind,
  intervalSeconds: number | null,
  cronExpr: string | null,
  now: Date,
): string {
  if (scheduleKind === 'interval') {
    const secs = intervalSeconds ?? 60;
    return new Date(now.getTime() + secs * 1000).toISOString();
  }
  return computeNextCronRunAt(cronExpr ?? '* * * * *', now).toISOString();
}

function toScheduleView(row: FlowScheduleRow, fallbackFlowSlug?: string): FlowScheduleView {
  return {
    id: row.id,
    flowId: row.flow_id,
    flowSlug: row.flow_slug ?? fallbackFlowSlug ?? `flow-${row.flow_id}`,
    enabled: row.enabled === 1,
    scheduleKind: row.schedule_kind,
    intervalSeconds: row.interval_seconds,
    cronExpr: row.cron_expr,
    profileId: row.profile_id,
    endUser: row.end_user,
    inputMessage: row.input_message,
    lastRunId: row.last_run_id,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Starts an asynchronous background flow execution, persisting the initial `running`
 * record in `custom_ai_runs` synchronously before returning `202 { runId, statusUrl }`.
 */
export function triggerAsyncFlowRun(
  flowId: number,
  input: AsyncFlowRunInput,
  opts?: { req?: Request; deps?: OrchestratorEngineDeps },
): AsyncFlowRunResponse {
  if (!isPillarEnabled('orchestrator')) {
    throw new OrchestratorConflictError('pillar_disabled', 'Orchestrator pillar is disabled.');
  }

  const flow = getFlow(flowId);
  const message = String(input.message ?? '').trim();
  if (!message || message.length > FLOW_SCHEDULE_LIMITS.maxMessageChars) {
    throw new OrchestratorError(
      400,
      'invalid_request',
      `message must be between 1 and ${FLOW_SCHEDULE_LIMITS.maxMessageChars} characters.`,
    );
  }

  const profileId = input.profileId ?? 0;
  if (!Number.isInteger(profileId) || profileId < 0) {
    throw new OrchestratorError(400, 'invalid_request', 'profileId must be a non-negative integer.');
  }

  const isDryRun = Boolean(input.isDryRun);
  if (isDryRun) {
    validateFlowDraftDefinition(flow.draft);
  } else {
    if (!flow.enabled) {
      throw new OrchestratorConflictError('flow_disabled', `Flow '${flow.slug}' is disabled.`);
    }
    if (!flow.published || flow.publishedVersion <= 0) {
      throw new OrchestratorConflictError(
        'flow_not_published',
        `Flow '${flow.slug}' must be published before running asynchronously.`,
      );
    }
    if (profileId > 0 && !isFlowGrantedToProfile(flow.id, profileId)) {
      throw new OrchestratorError(
        403,
        'flow_not_granted',
        `Profile #${profileId} is not granted access to flow '${flow.slug}'.`,
      );
    }
  }

  if (opts?.req) {
    recordServerLocalAddress(opts.req);
  }

  const runId = `run_${crypto.randomUUID()}`;
  const traceScope =
    profileId > 0
      ? ({ kind: 'profile', id: String(profileId) } as const)
      : ({ kind: 'agent', id: String(flow.id) } as const);
  const collector = createRequestTraceCollector({
    req: {
      method: 'POST',
      url: `/api/ai-platform/flows/${flow.id}/runs/async`,
      originalUrl: `/api/ai-platform/flows/${flow.id}/runs/async`,
      path: `/api/ai-platform/flows/${flow.id}/runs/async`,
      headers: { 'x-freellm-trace-id': runId },
    } as unknown as Request,
    scope: traceScope,
    endUser: input.endUser ?? null,
    wire: 'openai-chat',
    requestedModel: `flow:${flow.slug}`,
  });

  const executionPromise = runWithTraceCollector(collector, () =>
    startRun({
      runId,
      flowId: flow.id,
      profileId,
      endUser: input.endUser ?? null,
      wire: 'openai-chat',
      messages: [{ role: 'user', content: message }],
      isDryRun,
      stream: false,
      deps: opts?.deps,
    }),
  ).then(
    (result) => {
      collector.finalize({
        status: result.run.status === 'awaiting_approval' ? 'awaiting_approval' : 'ok',
        servedModel: `flow:${flow.slug}`,
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
      });
      return result;
    },
    (err: unknown) => {
      collector.finalize({
        status: 'error',
        errorSummary: err instanceof Error ? err.message : 'Async flow run failed.',
      });
      throw err;
    },
  );

  const tracked = executionPromise
    .catch((err) => {
      const latest = getRunRecord(runId)?.run;
      if (latest) {
        return {
          run: latest,
          outputText: '',
          finishReason: 'stop' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      }
      throw err;
    })
    .finally(() => {
      inFlightAsyncRuns.delete(runId);
    });

  // Prevent unhandled rejection when caller does not await background job.
  void tracked.catch(() => {});
  inFlightAsyncRuns.set(runId, tracked);

  return {
    runId,
    statusUrl: `/api/ai-platform/runs/${runId}`,
    publicStatusUrl: profileId > 0 && !isDryRun ? `/v1/ai/runs/${runId}` : null,
    status: 'running',
  };
}

export async function waitForAsyncFlowRun(runId: string): Promise<FlowExecutionResult | null> {
  const pending = inFlightAsyncRuns.get(runId);
  if (!pending) return null;
  return await pending;
}

export function getFlowSchedule(flowId: number): FlowScheduleView | null {
  const flow = getFlow(flowId);
  if (!hasSchedulesTable()) return null;
  const row = getDb()
    .prepare(
      `SELECT sc.*, f.slug AS flow_slug
         FROM custom_ai_flow_schedules sc
         JOIN custom_ai_flows f ON f.id = sc.flow_id
        WHERE sc.flow_id = ?`,
    )
    .get(flow.id) as FlowScheduleRow | undefined;
  return row ? toScheduleView(row, flow.slug) : null;
}

export function upsertFlowSchedule(
  flowId: number,
  input: FlowScheduleInput,
  now: Date = new Date(),
): FlowScheduleView {
  const flow = getFlow(flowId);
  const message = String(input.inputMessage ?? '').trim();
  if (!message || message.length > FLOW_SCHEDULE_LIMITS.maxMessageChars) {
    throw new OrchestratorError(
      400,
      'invalid_schedule',
      `inputMessage must be between 1 and ${FLOW_SCHEDULE_LIMITS.maxMessageChars} characters.`,
    );
  }

  const scheduleKind = input.scheduleKind;
  if (scheduleKind !== 'interval' && scheduleKind !== 'cron') {
    throw new OrchestratorError(
      400,
      'invalid_schedule',
      "scheduleKind must be 'interval' or 'cron'.",
    );
  }

  let intervalSeconds: number | null = null;
  let cronExpr: string | null = null;

  if (scheduleKind === 'interval') {
    const rawInterval = input.intervalSeconds;
    if (
      typeof rawInterval !== 'number' ||
      !Number.isInteger(rawInterval) ||
      rawInterval < FLOW_SCHEDULE_LIMITS.minIntervalSeconds ||
      rawInterval > FLOW_SCHEDULE_LIMITS.maxIntervalSeconds
    ) {
      throw new OrchestratorError(
        400,
        'invalid_schedule',
        `intervalSeconds must be an integer between ${FLOW_SCHEDULE_LIMITS.minIntervalSeconds} and ${FLOW_SCHEDULE_LIMITS.maxIntervalSeconds}.`,
      );
    }
    intervalSeconds = rawInterval;
  } else {
    const rawCron = String(input.cronExpr ?? '').trim();
    parseCronExpression(rawCron);
    cronExpr = rawCron;
  }

  const profileId = input.profileId ?? 0;
  if (!Number.isInteger(profileId) || profileId < 0) {
    throw new OrchestratorError(400, 'invalid_schedule', 'profileId must be a non-negative integer.');
  }
  if (profileId > 0 && !isFlowGrantedToProfile(flow.id, profileId)) {
    throw new OrchestratorError(
      403,
      'flow_not_granted',
      `Profile #${profileId} is not granted access to flow '${flow.slug}'.`,
    );
  }

  const enabled = Boolean(input.enabled);
  if (enabled && (!flow.published || flow.publishedVersion <= 0)) {
    throw new OrchestratorConflictError(
      'flow_not_published',
      `Flow '${flow.slug}' must be published before enabling a schedule.`,
    );
  }

  const nextRunAt = enabled
    ? computeNextScheduleIso(scheduleKind, intervalSeconds, cronExpr, now)
    : null;
  const nowIso = now.toISOString();
  const db = getDb();

  db.prepare(
    `INSERT INTO custom_ai_flow_schedules (
      flow_id, enabled, schedule_kind, interval_seconds, cron_expr,
      profile_id, end_user, input_message, next_run_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(flow_id) DO UPDATE SET
      enabled = excluded.enabled,
      schedule_kind = excluded.schedule_kind,
      interval_seconds = excluded.interval_seconds,
      cron_expr = excluded.cron_expr,
      profile_id = excluded.profile_id,
      end_user = excluded.end_user,
      input_message = excluded.input_message,
      next_run_at = excluded.next_run_at,
      updated_at = excluded.updated_at`,
  ).run(
    flow.id,
    enabled ? 1 : 0,
    scheduleKind,
    intervalSeconds,
    cronExpr,
    profileId,
    input.endUser ?? null,
    message,
    nextRunAt,
    nowIso,
    nowIso,
  );

  return getFlowSchedule(flow.id)!;
}

export function deleteFlowSchedule(flowId: number): { deleted: boolean } {
  const flow = getFlow(flowId);
  if (!hasSchedulesTable()) return { deleted: false };
  const res = getDb()
    .prepare('DELETE FROM custom_ai_flow_schedules WHERE flow_id = ?')
    .run(flow.id);
  return { deleted: res.changes > 0 };
}

/**
 * Evaluates due enabled schedules once and triggers async flow runs for them.
 * Safe to invoke deterministically in unit/integration tests.
 */
export async function tickFlowSchedules(
  now: Date = new Date(),
  deps?: OrchestratorEngineDeps,
): Promise<FlowScheduleTickResponse> {
  if (!isPillarEnabled('orchestrator') || !hasSchedulesTable() || tickInProgress) {
    return { checked: 0, triggeredRunIds: [] };
  }

  tickInProgress = true;
  try {
    const db = getDb();
    const nowIso = now.toISOString();
    const dueRows = db
      .prepare(
        `SELECT sc.*, f.slug AS flow_slug
           FROM custom_ai_flow_schedules sc
           JOIN custom_ai_flows f ON f.id = sc.flow_id
          WHERE sc.enabled = 1
            AND f.enabled = 1
            AND sc.next_run_at IS NOT NULL
            AND datetime(sc.next_run_at) <= datetime(?)
          ORDER BY sc.next_run_at ASC
          LIMIT 25`,
      )
      .all(nowIso) as FlowScheduleRow[];

    const triggeredRunIds: string[] = [];

    for (const row of dueRows) {
      const nextRunAt = computeNextScheduleIso(
        row.schedule_kind,
        row.interval_seconds,
        row.cron_expr,
        now,
      );

      // Claim due slot optimistically so overlapping ticks never fire the same slot twice.
      const claimed = db
        .prepare(
          `UPDATE custom_ai_flow_schedules
              SET next_run_at = ?,
                  last_run_at = ?,
                  updated_at = ?
            WHERE id = ? AND enabled = 1 AND next_run_at = ?`,
        )
        .run(nextRunAt, nowIso, nowIso, row.id, row.next_run_at);

      if (claimed.changes === 0) continue;

      try {
        const accepted = triggerAsyncFlowRun(
          row.flow_id,
          {
            message: row.input_message,
            profileId: row.profile_id,
            endUser: row.end_user,
            isDryRun: false,
          },
          { deps },
        );
        triggeredRunIds.push(accepted.runId);

        db.prepare(
          `UPDATE custom_ai_flow_schedules
              SET last_run_id = ?,
                  last_status = 'running',
                  updated_at = ?
            WHERE id = ?`,
        ).run(accepted.runId, nowIso, row.id);

        void waitForAsyncFlowRun(accepted.runId)
          .then((result) => {
            const finalStatus = result?.run.status ?? getRunRecord(accepted.runId)?.run.status ?? 'completed';
            try {
              getDb()
                .prepare(
                  `UPDATE custom_ai_flow_schedules
                      SET last_status = ?,
                          updated_at = ?
                    WHERE id = ? AND last_run_id = ?`,
                )
                .run(finalStatus, new Date().toISOString(), row.id, accepted.runId);
            } catch {
              // DB may be closed in ephemeral teardown
            }
          })
          .catch(() => {});
      } catch (err) {
        const errMsg = err instanceof Error ? err.message.slice(0, 120) : 'trigger_failed';
        db.prepare(
          `UPDATE custom_ai_flow_schedules
              SET last_status = ?,
                  updated_at = ?
            WHERE id = ?`,
        ).run(`error:${errMsg}`, nowIso, row.id);
      }
    }

    return {
      checked: dueRows.length,
      triggeredRunIds,
    };
  } finally {
    tickInProgress = false;
  }
}

export function startFlowScheduler(
  intervalMs: number = FLOW_SCHEDULE_LIMITS.defaultTickMs,
  opts?: { allowInTests?: boolean },
): void {
  if (!opts?.allowInTests && (process.env.NODE_ENV === 'test' || process.env.VITEST)) {
    return;
  }
  if (schedulerTimer) return;
  const clampedMs = Math.max(1_000, Math.trunc(intervalMs));
  schedulerTimer = setInterval(() => {
    void tickFlowSchedules().catch(() => {});
  }, clampedMs);
  schedulerTimer.unref?.();
}

export function stopFlowScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

export function isFlowSchedulerRunning(): boolean {
  return schedulerTimer !== null;
}
