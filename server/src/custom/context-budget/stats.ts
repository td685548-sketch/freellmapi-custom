import type {
  ContextEstimateErrorStats,
  ContextStats,
  ContextStatsByDay,
} from '@freellmapi/shared/context-budget.js';
import { getDb } from '../../db/index.js';

const DAY_MS = 86_400_000;

interface ReportJoinRow {
  budget_tokens: number;
  history_tokens: number;
  knowledge_tokens: number;
  estimated_tokens: number;
  heuristic_tokens: number;
  history_sent: number;
  history_dropped: number;
  knowledge_sent: number;
  knowledge_dropped: number;
  summary_used: number;
  client_history_dropped: number;
  created_at: string;
  actual_input_tokens: number;
}

function sqlTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function percentile(sorted: readonly number[], pct: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function computeEstimateError(rows: readonly ReportJoinRow[]): ContextEstimateErrorStats {
  const errors: number[] = [];
  let within15 = 0;

  for (const row of rows) {
    // Rows where input_tokens equals the chars/4 fallback carry no real provider usage (R4).
    if (
      row.actual_input_tokens <= 0 ||
      row.actual_input_tokens === row.heuristic_tokens ||
      row.estimated_tokens <= 0
    ) {
      continue;
    }
    const errPct = (Math.abs(row.estimated_tokens - row.actual_input_tokens) / row.actual_input_tokens) * 100;
    errors.push(errPct);
    if (errPct <= 15) {
      within15 += 1;
    }
  }

  if (errors.length === 0) {
    return {
      samples: 0,
      p50Pct: null,
      p95Pct: null,
      within15PctRate: null,
    };
  }

  errors.sort((a, b) => a - b);
  return {
    samples: errors.length,
    p50Pct: roundTo(percentile(errors, 50), 2),
    p95Pct: roundTo(percentile(errors, 95), 2),
    within15PctRate: roundTo(within15 / errors.length, 4),
  };
}

function estimateRowSavedTokens(row: ReportJoinRow): number {
  let saved = 0;
  if (row.history_dropped > 0 && row.history_sent > 0) {
    saved += row.history_dropped * (row.history_tokens / row.history_sent);
  }
  if (row.knowledge_dropped > 0 && row.knowledge_sent > 0) {
    saved += row.knowledge_dropped * (row.knowledge_tokens / row.knowledge_sent);
  }
  if (row.client_history_dropped > 0 && row.history_sent > 0) {
    saved += row.client_history_dropped * (row.history_tokens / row.history_sent);
  }
  return saved;
}

/**
 * Aggregate per-profile context assembly statistics over the trailing `days` window
 * by joining `custom_context_reports` with `requests`.
 */
export function getContextStats(
  profileId: number,
  days: number,
  now: number = Date.now(),
): ContextStats {
  const sinceSql = sqlTime(now - days * DAY_MS);
  const sinceDate = sinceSql.slice(0, 10);

  const rows = getDb()
    .prepare(
      `SELECT
         r.budget_tokens,
         r.history_tokens,
         r.knowledge_tokens,
         r.estimated_tokens,
         r.heuristic_tokens,
         r.history_sent,
         r.history_dropped,
         r.knowledge_sent,
         r.knowledge_dropped,
         r.summary_used,
         r.client_history_dropped,
         substr(datetime(r.created_at), 1, 10) AS created_at,
         req.input_tokens AS actual_input_tokens
       FROM custom_context_reports r
       INNER JOIN requests req ON req.id = r.request_id
       WHERE r.profile_id = ?
         AND r.created_at >= ?
         AND datetime(r.created_at) >= datetime(?)
       ORDER BY r.created_at ASC`,
    )
    .all(profileId, sinceDate, sinceSql) as ReportJoinRow[];

  const count = rows.length;
  if (count === 0) {
    return {
      days,
      requests: 0,
      avgInputTokens: 0,
      avgBudgetTokens: 0,
      trimmedRate: 0,
      avgHistoryDropped: 0,
      savedTokens: 0,
      summaryUsedRate: 0,
      estimateError: {
        samples: 0,
        p50Pct: null,
        p95Pct: null,
        within15PctRate: null,
      },
      byDay: [],
    };
  }

  let totalEstimated = 0;
  let totalBudget = 0;
  let trimmedCount = 0;
  let totalHistoryDropped = 0;
  let totalSaved = 0;
  let summaryUsedCount = 0;

  const dayBuckets = new Map<string, { requests: number; totalEstimated: number; trimmed: number }>();

  for (const row of rows) {
    totalEstimated += row.estimated_tokens;
    totalBudget += row.budget_tokens;

    const wasTrimmed =
      row.history_dropped > 0 || row.knowledge_dropped > 0 || row.client_history_dropped > 0;
    if (wasTrimmed) trimmedCount += 1;

    totalHistoryDropped += row.history_dropped + row.client_history_dropped;
    totalSaved += estimateRowSavedTokens(row);
    if (row.summary_used === 1) summaryUsedCount += 1;

    const day = row.created_at;
    let bucket = dayBuckets.get(day);
    if (!bucket) {
      bucket = { requests: 0, totalEstimated: 0, trimmed: 0 };
      dayBuckets.set(day, bucket);
    }
    bucket.requests += 1;
    bucket.totalEstimated += row.estimated_tokens;
    if (wasTrimmed) bucket.trimmed += 1;
  }

  const byDay: ContextStatsByDay[] = Array.from(dayBuckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, bucket]) => ({
      day,
      requests: bucket.requests,
      avgInputTokens: Math.round(bucket.totalEstimated / bucket.requests),
      trimmedRate: roundTo(bucket.trimmed / bucket.requests, 4),
    }));

  return {
    days,
    requests: count,
    avgInputTokens: Math.round(totalEstimated / count),
    avgBudgetTokens: Math.round(totalBudget / count),
    trimmedRate: roundTo(trimmedCount / count, 4),
    avgHistoryDropped: roundTo(totalHistoryDropped / count, 2),
    savedTokens: Math.round(totalSaved),
    summaryUsedRate: roundTo(summaryUsedCount / count, 4),
    estimateError: computeEstimateError(rows),
    byDay,
  };
}
