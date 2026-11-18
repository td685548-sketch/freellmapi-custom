import type { Request, Response } from 'express';
import type { ContextAssemblySummary } from '@freellmapi/shared/context-budget.js';
import { getDb } from '../../db/index.js';
import type { RequestTrace } from '../../lib/attempt-trace.js';
import { getRequestTrace } from '../../lib/attempt-trace.js';
import { getClientContext } from '../../lib/client-context.js';
import { noteContextReportOutcome } from './alerts.js';
import { recordCalibrationSample } from './estimate.js';
import { pruneOrphanPolicies } from './policy.js';
import { getRegistry } from './registry.js';

export type ContextReportRecord = ContextAssemblySummary;

export type ContextHeaderFields = Pick<
  ContextAssemblySummary,
  | 'budget'
  | 'window'
  | 'mandatory'
  | 'summary'
  | 'knowledge'
  | 'history'
  | 'histSent'
  | 'histDropped'
  | 'kbSent'
  | 'kbDropped'
  | 'clientDropped'
  | 'refits'
>;

interface ReportRow {
  request_id: number;
  profile_id: number;
  end_user: string | null;
  conversation_key: string | null;
  model_key: string;
  context_window: number | null;
  budget_tokens: number;
  mandatory_tokens: number;
  summary_tokens: number;
  knowledge_tokens: number;
  history_tokens: number;
  estimated_tokens: number;
  heuristic_tokens: number;
  history_sent: number;
  history_dropped: number;
  knowledge_sent: number;
  knowledge_dropped: number;
  summary_used: number;
  client_history_dropped: number;
  refits: number;
  created_at: string;
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPrunedAt = 0;

const registeredResponses = new WeakSet<Response>();

/**
 * Format the `X-FreeLLM-Context` response header value in fixed key order
 * matching `contracts/context-metadata.md` section 1.
 */
export function formatContextHeader(summary: ContextHeaderFields): string {
  const windowValue = summary.window === null ? 'unknown' : String(summary.window);
  return [
    `budget=${summary.budget}`,
    `mandatory=${summary.mandatory}`,
    `summary=${summary.summary}`,
    `knowledge=${summary.knowledge}`,
    `history=${summary.history}`,
    `hist_sent=${summary.histSent}`,
    `hist_dropped=${summary.histDropped}`,
    `kb_sent=${summary.kbSent}`,
    `kb_dropped=${summary.kbDropped}`,
    `client_dropped=${summary.clientDropped}`,
    `refits=${summary.refits}`,
    `window=${windowValue}`,
  ].join(';');
}

/**
 * Capture the active fallback-loop `RequestTrace` onto the request's registry
 * when context budgeting is enabled. No-op when disabled or absent.
 */
export function beginReport(req: Request): void {
  const registry = getRegistry(req);
  if (!registry || !registry.policy.enabled) return;
  if (registry.trace === null) {
    registry.trace = getRequestTrace() ?? null;
  }
}

/**
 * Register a one-shot response `finish` listener that persists the final
 * `ContextAssemblySummary` keyed to `trace.lastRequestRowId` and updates
 * per-platform token calibration when provider usage differs from chars/4.
 */
export function persistReportOnFinish(req: Request, res: Response): void {
  const registry = getRegistry(req);
  if (!registry || !registry.policy.enabled) return;
  if (typeof (res as Partial<Response> | null | undefined)?.once !== 'function') return;
  if (registeredResponses.has(res)) return;
  registeredResponses.add(res);

  const trace = (registry.trace as RequestTrace | null) ?? getRequestTrace() ?? null;
  const endUser = registry.conversation?.endUser ?? getClientContext().endUser ?? null;

  res.once('finish', () => {
    setImmediate(() => {
      if (!registry.fitted || !registry.report) return;
      const requestId = trace?.lastRequestRowId;
      const profileId = registry.policy.profileId;
      if (requestId == null || profileId == null) return;

      const summary = registry.report;
      try {
        const db = getDb();
        db.prepare(
          `INSERT OR REPLACE INTO custom_context_reports (
            request_id, profile_id, end_user, conversation_key, model_key, context_window,
            budget_tokens, mandatory_tokens, summary_tokens, knowledge_tokens, history_tokens,
            estimated_tokens, heuristic_tokens, history_sent, history_dropped,
            knowledge_sent, knowledge_dropped, summary_used, client_history_dropped, refits, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          requestId,
          profileId,
          endUser,
          registry.conversation?.key ?? null,
          summary.modelKey,
          summary.window,
          summary.budget,
          summary.mandatory,
          summary.summary,
          summary.knowledge,
          summary.history,
          summary.estimatedTokens,
          summary.heuristicTokens,
          summary.histSent,
          summary.histDropped,
          summary.kbSent,
          summary.kbDropped,
          summary.summary > 0 ? 1 : 0,
          summary.clientDropped,
          summary.refits,
          summary.createdAt,
        );

        const reqRow = db
          .prepare('SELECT platform, input_tokens FROM requests WHERE id = ?')
          .get(requestId) as { platform: string; input_tokens: number } | undefined;
        if (reqRow && reqRow.input_tokens > 0 && reqRow.input_tokens !== summary.heuristicTokens) {
          const platform = reqRow.platform || summary.modelKey.split(':')[0] || '';
          const baselineTokens = registry.uncalibratedTokens ?? summary.estimatedTokens;
          recordCalibrationSample(platform, reqRow.input_tokens, baselineTokens);
        }

        noteContextReportOutcome(profileId, {
          histDropped: summary.histDropped,
          kbDropped: summary.kbDropped,
          clientDropped: summary.clientDropped,
          budget: summary.budget,
          estimatedTokens: summary.estimatedTokens,
        });
      } catch {
        // Non-fatal: report persistence and calibration must never disrupt completed requests.
      }
    });
  });
}

/**
 * Remove orphan reports (missing `requests` row or deleted `client_profiles`) and
 * orphan profile policies, throttled to run at most once per hour.
 */
export function pruneContextReports(now: number = Date.now()): number {
  if (lastPrunedAt > 0 && now - lastPrunedAt < PRUNE_INTERVAL_MS) {
    return 0;
  }
  lastPrunedAt = now;

  try {
    const db = getDb();
    const info = db
      .prepare(
        `DELETE FROM custom_context_reports
         WHERE request_id NOT IN (SELECT id FROM requests)
            OR profile_id NOT IN (SELECT id FROM client_profiles)`,
      )
      .run();
    pruneOrphanPolicies();
    return info.changes;
  } catch {
    return 0;
  }
}

/**
 * Reset the hourly prune throttle (for unit tests).
 */
export function resetReportPruneState(): void {
  lastPrunedAt = 0;
}

/**
 * Fetch the stored assembly report for `(profileId, requestId)`, or `null` if none exists.
 */
export function getReportForRequest(profileId: number, requestId: number): ContextReportRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM custom_context_reports WHERE request_id = ? AND profile_id = ?')
    .get(requestId, profileId) as ReportRow | undefined;
  if (!row) return null;

  return {
    budget: row.budget_tokens,
    window: row.context_window,
    mandatory: row.mandatory_tokens,
    summary: row.summary_tokens,
    knowledge: row.knowledge_tokens,
    history: row.history_tokens,
    histSent: row.history_sent,
    histDropped: row.history_dropped,
    kbSent: row.knowledge_sent,
    kbDropped: row.knowledge_dropped,
    clientDropped: row.client_history_dropped,
    refits: row.refits,
    estimatedTokens: row.estimated_tokens,
    heuristicTokens: row.heuristic_tokens,
    modelKey: row.model_key,
    createdAt: row.created_at,
  };
}
