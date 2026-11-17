import { getDb } from '../../db/index.js';
import type {
  AdminAnomalyItem,
  AdminAnomalyRadarReport,
  AssistantCategory,
  CustomerQuotaCoachReport,
  KeyRoutingMode,
  QuotaCoachTip,
} from '@freellmapi/shared/customer-ai.js';
import { ASSISTANT_CATEGORIES } from '@freellmapi/shared/customer-ai.js';
import { normalizeRoutingMode } from './store.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const VALID_CATEGORIES = new Set<string>(ASSISTANT_CATEGORIES);

function sqlTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export function buildCustomerQuotaCoach(
  userId: number,
  windowDays = 14,
  now = Date.now(),
): CustomerQuotaCoachReport {
  const db = getDb();
  const days = Math.max(1, Math.min(90, Math.trunc(windowDays)));
  const since = sqlTime(now - days * DAY_MS);

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(status = 'error'), 0) AS errors,
      COALESCE(SUM(CASE WHEN status = 'success' THEN input_tokens + output_tokens ELSE 0 END), 0) AS tokens
    FROM requests
    WHERE user_id = ? AND created_at >= ?
  `).get(userId, since) as { requests: number; errors: number; tokens: number };

  const keys = db.prepare(`
    SELECT id, name, routing_mode, assistant_id
    FROM user_api_keys
    WHERE user_id = ? AND revoked = 0
    ORDER BY id DESC
  `).all(userId) as Array<{
    id: number;
    name: string;
    routing_mode: string;
    assistant_id: number | null;
  }>;

  const routingBreakdown: Record<KeyRoutingMode, number> = {
    default: 0,
    eco: 0,
    balanced: 0,
    max: 0,
  };
  let firstNonEcoKey: { id: number; name: string; mode: KeyRoutingMode } | null = null;
  let boundCount = 0;

  for (const k of keys) {
    const mode = normalizeRoutingMode(k.routing_mode, 'default');
    routingBreakdown[mode] += 1;
    if (mode !== 'eco' && !firstNonEcoKey) {
      firstNonEcoKey = { id: k.id, name: k.name, mode };
    }
    if (k.assistant_id !== null) boundCount += 1;
  }

  const totalRequests = Number(stats.requests ?? 0);
  const totalTokens = Number(stats.tokens ?? 0);
  const errorCount = Number(stats.errors ?? 0);
  const avgTokensPerRequest = totalRequests > 0 ? Math.round(totalTokens / totalRequests) : 0;
  const errorRatePct = totalRequests > 0 ? Math.round((errorCount / totalRequests) * 100) : 0;

  const tips: QuotaCoachTip[] = [];
  let potentialSavingsPct = 0;

  if (firstNonEcoKey && (totalRequests === 0 || avgTokensPerRequest < 2500)) {
    const savings = firstNonEcoKey.mode === 'max' ? 45 : 35;
    potentialSavingsPct = Math.max(potentialSavingsPct, savings);
    tips.push({
      id: 'switch-to-eco',
      severity: 'saving',
      title: 'Switch routine keys to Eco mode',
      detail: totalRequests > 0
        ? `Your average request uses ${avgTokensPerRequest.toLocaleString('en-US')} tokens. Switching "${firstNonEcoKey.name}" to Eco prioritizes fast lightweight models and can cut quota burn by ~${savings}%.`
        : `Key "${firstNonEcoKey.name}" currently uses ${firstNonEcoKey.mode} routing. Switching it to Eco prioritizes fast lightweight models for daily IDE tasks.`,
      estimatedTokenSavingsPct: savings,
      recommendedMode: 'eco',
      targetKeyId: firstNonEcoKey.id,
      targetKeyName: firstNonEcoKey.name,
    });
  }

  if (routingBreakdown.max > 0 && totalTokens >= 20_000) {
    const maxKey = keys.find(k => normalizeRoutingMode(k.routing_mode, 'default') === 'max');
    potentialSavingsPct = Math.max(potentialSavingsPct, 40);
    tips.push({
      id: 'max-mode-burn',
      severity: 'warning',
      title: 'High token volume on Max Quality key',
      detail: `You consumed ${totalTokens.toLocaleString('en-US')} tokens in the last ${days} days while running ${routingBreakdown.max} key(s) in Max mode. Consider reserving Max for code review and using Balanced/Eco for quick edits.`,
      estimatedTokenSavingsPct: 40,
      recommendedMode: 'balanced',
      targetKeyId: maxKey?.id,
      targetKeyName: maxKey?.name,
    });
  }

  if (totalRequests >= 5 && errorRatePct >= 15) {
    tips.push({
      id: 'high-error-rate',
      severity: 'warning',
      title: 'Elevated failure rate detected',
      detail: `${errorRatePct}% of your recent ${totalRequests} requests failed. Switching to Balanced mode or reviewing request context size can stabilize completion success.`,
      recommendedMode: 'balanced',
    });
  }

  if (keys.length > 0 && boundCount === 0) {
    tips.push({
      id: 'bind-assistant-preset',
      severity: 'info',
      title: 'Attach an AI Assistant preset to your personal key',
      detail: 'Bind a preset such as Fast Pair Programmer or Code Reviewer directly on your personal API key so every IDE call inherits tailored instructions automatically.',
    });
  }

  if (tips.length === 0) {
    tips.push({
      id: 'healthy-setup',
      severity: 'info',
      title: 'Your routing and quota profile looks balanced',
      detail: 'Your personal keys are already configured efficiently. Keep using Eco for lightweight tasks and Max for complex reasoning.',
    });
  }

  const headline = potentialSavingsPct > 0
    ? `You can save up to ~${potentialSavingsPct}% quota with Eco routing.`
    : totalRequests > 0
      ? `${totalRequests} requests analyzed over the last ${days} days.`
      : 'Start chatting or bind a personal key to unlock tailored quota insights.';

  return {
    windowDays: days,
    totalRequests,
    totalTokens,
    avgTokensPerRequest,
    errorRatePct,
    potentialSavingsPct,
    routingBreakdown,
    headline,
    tips,
  };
}

export function buildAdminAnomalyRadar(windowHours = 24, now = Date.now()): AdminAnomalyRadarReport {
  const db = getDb();
  const hours = Math.max(1, Math.min(168, Math.trunc(windowHours)));
  const sinceRecent = sqlTime(now - hours * HOUR_MS);
  const sinceBaseline = sqlTime(now - 7 * DAY_MS);

  const summaryCounts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM custom_ai_assistants) AS totalAssistants,
      (SELECT COUNT(*) FROM custom_ai_assistants WHERE enabled = 1) AS enabledAssistants,
      (SELECT COUNT(*) FROM user_api_keys WHERE revoked = 0 AND assistant_id IS NOT NULL) AS boundPersonalKeys,
      (SELECT COUNT(*) FROM user_api_keys WHERE revoked = 0 AND routing_mode = 'eco') AS ecoPersonalKeys
  `).get() as {
    totalAssistants: number;
    enabledAssistants: number;
    boundPersonalKeys: number;
    ecoPersonalKeys: number;
  };

  const topAssistantsRows = db.prepare(`
    SELECT
      a.id, a.slug, a.name, a.category, a.playground_runs,
      (SELECT COUNT(*) FROM user_api_keys k WHERE k.assistant_id = a.id AND k.revoked = 0) AS bound_keys_count
    FROM custom_ai_assistants a
    ORDER BY (bound_keys_count * 5 + a.playground_runs) DESC, a.id ASC
    LIMIT 6
  `).all() as Array<{
    id: number;
    slug: string;
    name: string;
    category: string;
    playground_runs: number;
    bound_keys_count: number;
  }>;

  const userActivity = db.prepare(`
    SELECT
      u.id AS userId,
      u.email AS email,
      SUM(CASE WHEN r.created_at >= ? THEN 1 ELSE 0 END) AS requests24h,
      COALESCE(SUM(CASE WHEN r.created_at >= ? AND r.status = 'error' THEN 1 ELSE 0 END), 0) AS errors24h,
      COALESCE(SUM(CASE WHEN r.created_at >= ? AND r.status = 'success' THEN r.input_tokens + r.output_tokens ELSE 0 END), 0) AS tokens24h,
      COALESCE(SUM(CASE WHEN r.created_at < ? AND r.status = 'success' THEN r.input_tokens + r.output_tokens ELSE 0 END), 0) AS tokensPrev6d,
      (SELECT COUNT(*) FROM user_api_keys k WHERE k.user_id = u.id AND k.revoked = 0 AND k.routing_mode <> 'eco') AS activeNonEcoKeys
    FROM users u
    JOIN requests r ON r.user_id = u.id
    WHERE r.created_at >= ?
    GROUP BY u.id, u.email
    HAVING requests24h > 0
    ORDER BY tokens24h DESC, requests24h DESC
  `).all(sinceRecent, sinceRecent, sinceRecent, sinceRecent, sinceBaseline) as Array<{
    userId: number;
    email: string;
    requests24h: number;
    errors24h: number;
    tokens24h: number;
    tokensPrev6d: number;
    activeNonEcoKeys: number;
  }>;

  const anomalies: AdminAnomalyItem[] = [];
  for (const row of userActivity) {
    const requests24h = Number(row.requests24h ?? 0);
    const errors24h = Number(row.errors24h ?? 0);
    const tokens24h = Number(row.tokens24h ?? 0);
    const baselineDailyTokens = Math.round(Number(row.tokensPrev6d ?? 0) / 6);
    const errorRatePct = requests24h > 0 ? Math.round((errors24h / requests24h) * 100) : 0;
    const activeNonEcoKeys = Number(row.activeNonEcoKeys ?? 0);

    if (tokens24h >= 50_000 && tokens24h >= Math.max(50_000, baselineDailyTokens * 3)) {
      anomalies.push({
        id: `spike-${row.userId}`,
        kind: 'token_spike',
        severity: 'high',
        userId: row.userId,
        email: row.email,
        requests24h,
        tokens24h,
        baselineDailyTokens,
        errorRatePct,
        activeNonEcoKeys,
        summary: `${tokens24h.toLocaleString('en-US')} tokens in ${hours}h vs ${baselineDailyTokens.toLocaleString('en-US')}/day baseline.`,
        recommendedAction: activeNonEcoKeys > 0 ? 'switch_keys_to_eco' : 'inspect_user',
      });
    } else if (requests24h >= 10 && errorRatePct >= 35) {
      anomalies.push({
        id: `error-loop-${row.userId}`,
        kind: 'high_error_loop',
        severity: errorRatePct >= 50 ? 'high' : 'medium',
        userId: row.userId,
        email: row.email,
        requests24h,
        tokens24h,
        baselineDailyTokens,
        errorRatePct,
        activeNonEcoKeys,
        summary: `${errorRatePct}% error rate across ${requests24h} requests in ${hours}h (possible retry loop).`,
        recommendedAction: 'inspect_user',
      });
    } else if (requests24h >= 20 && activeNonEcoKeys > 0) {
      anomalies.push({
        id: `non-eco-${row.userId}`,
        kind: 'unoptimized_heavy_usage',
        severity: 'low',
        userId: row.userId,
        email: row.email,
        requests24h,
        tokens24h,
        baselineDailyTokens,
        errorRatePct,
        activeNonEcoKeys,
        summary: `${requests24h} requests in ${hours}h while ${activeNonEcoKeys} personal key(s) remain off Eco mode.`,
        recommendedAction: 'switch_keys_to_eco',
      });
    }
  }

  return {
    generatedAt: new Date(now).toISOString(),
    windowHours: hours,
    totalAssistants: Number(summaryCounts.totalAssistants ?? 0),
    enabledAssistants: Number(summaryCounts.enabledAssistants ?? 0),
    boundPersonalKeys: Number(summaryCounts.boundPersonalKeys ?? 0),
    ecoPersonalKeys: Number(summaryCounts.ecoPersonalKeys ?? 0),
    anomalies,
    topAssistants: topAssistantsRows.map(a => ({
      id: a.id,
      slug: a.slug,
      name: a.name,
      category: (VALID_CATEGORIES.has(a.category) ? a.category : 'general') as AssistantCategory,
      boundKeysCount: Number(a.bound_keys_count ?? 0),
      playgroundRuns: Number(a.playground_runs ?? 0),
    })),
  };
}
