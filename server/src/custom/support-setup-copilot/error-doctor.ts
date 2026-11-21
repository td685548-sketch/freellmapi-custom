import type {
  CopilotActionProposal,
  CopilotDiagnosticIssue,
  CopilotErrorCategory,
  CopilotPersonalKeySummary,
  CopilotQuotaUsageSummary,
  CopilotQuotaWindowMetric,
  CopilotUserDiagnosticReport,
  SupportSetupChatResponse,
} from '@freellmapi/shared/support-setup-copilot.js';
import { getDb } from '../../db/index.js';
import type { SessionUser } from '../../services/auth.js';
import { getStarterQuotaConfig } from '../../services/starter-quota.js';
import { getQuotaState, windowsAt } from '../../services/usage-quotas.js';
import { listUserApiKeys } from '../../services/user-keys.js';
import { getUserUsage } from '../../services/user-quotas.js';
import { normalizeRoutingMode } from '../customer-ai/store.js';
import {
  buildCreatePersonalKeyProposal,
  buildOnboardingChecklist,
  buildOpenOnboardingGuideProposal,
  buildSwitchKeyRoutingModeProposal,
  foldVietnameseAscii,
} from './user-actions.js';

const HOUR_MS = 3_600_000;
const HIGH_LATENCY_THRESHOLD_MS = 8_000;

function sqlTimeUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Scrubs any secret-like tokens, credentials, bearer headers, query keys, or upstream URLs
 * so diagnostic summaries can NEVER leak admin provider keys or user secrets.
 */
export function sanitizeDiagnosticErrorSummary(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  text = text
    // Bearer / Basic auth headers
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]')
    // Common provider & gateway key prefixes (OpenAI, Anthropic, FreeLLMAPI, Google, GitHub, Slack, AWS, HuggingFace, Groq)
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{6,}|pk_[A-Za-z0-9_-]{6,}|AIza[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|hf_[A-Za-z0-9]{10,}|gsk_[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{12,})\b/g,
      '[REDACTED]',
    )
    // JWTs
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,})?\b/g, '[REDACTED]')
    // Explicit key/secret/token/password assignments
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|x-api-key|x-goog-api-key)\s*([:=])\s*['"]?[^\s'",;)]+['"]?/gi,
      '$1$2[REDACTED]',
    )
    // Query-string credentials before URL scrubbing
    .replace(/([?&](?:key|api_key|token|secret)=)[^&\s'")]+/gi, '$1[REDACTED]')
    // Internal or upstream provider URLs
    .replace(/https?:\/\/[^\s'",;)]+/gi, '[upstream-endpoint]')
    // Long hex secrets (>= 32 hex chars)
    .replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED]')
    // Internal admin key label markers if any
    .replace(/\bkey\s*#\d+\b/gi, 'upstream route')
    .trim();

  return text.length > 180 ? `${text.slice(0, 177).trimEnd()}…` : text;
}

export function classifyDiagnosticErrorCategory(errorText: string | null | undefined): CopilotErrorCategory {
  const text = (errorText ?? '').toLowerCase();
  if (!text) return 'other_error';

  // 1. Explicit 403 / guardrail / content filter / policy blocks
  if (
    /\b403\b|forbidden|guardrail|content[_\s-]*filter|prompt[_\s-]*injection|blocked\s+topic|policy[_\s-]*violation/.test(
      text,
    )
  ) {
    return 'quota_guardrail_403';
  }

  // 2. Explicit 429 rate-limit / RPM / cooldown (distinguished from pure quota allowance exhaustion)
  if (
    (/\b429\b|rate[_\s-]*limit|too\s+many\s+requests|cooldown|throttl|\brpm\b|user_rate_limit_exceeded/.test(
      text,
    ) &&
      !/insufficient_quota|quota_exceeded|allowance/.test(text)) ||
    /rate_limit_exceeded|user_rate_limit_exceeded/.test(text)
  ) {
    return 'rate_limit_429';
  }

  // 3. Quota / allowance / billing exhaustion (402 / 403 / 429 insufficient_quota)
  if (/insufficient[_\s-]*quota|quota[_\s-]*exceeded|allowance|\b402\b|billing/.test(text)) {
    return /\b429\b/.test(text) && !/\b403\b/.test(text) ? 'rate_limit_429' : 'quota_guardrail_403';
  }

  // 4. 400 / 413 / 422 bad request, context window overflow, invalid model/payload
  if (
    /\b400\b|\b413\b|\b422\b|bad[_\s-]*request|invalid[_\s-]*request|context[_\s-]*(?:length|window|limit|exceeded)|maximum\s+context|max[_\s-]*tokens|token\s+limit|payload\s+too\s+large|entity\s+too\s+large|flow_requires_client_key|malformed/.test(
      text,
    )
  ) {
    return 'bad_request_400';
  }

  // 5. 5xx / upstream timeout / network reset
  if (
    /\b50[0234]\b|\b5\d\d\b|timeout|timed\s+out|etimedout|econnreset|econnrefused|bad\s+gateway|service\s+unavailable|gateway\s+timeout|overloaded|outage|socket\s+hang\s+up|upstream/.test(
      text,
    )
  ) {
    return 'upstream_5xx_timeout';
  }

  return 'other_error';
}

function buildQuotaMetric(used: number, limit: number | null): CopilotQuotaWindowMetric {
  if (limit === null || limit <= 0) {
    return { used, limit: null, pct: null };
  }
  const pct = Math.min(999, Math.round((used / limit) * 100));
  return { used, limit, pct };
}

function computeUserQuotaSummary(user: SessionUser, now: number): CopilotQuotaUsageSummary {
  const db = getDb();
  const quotaState = getQuotaState('user', user.userId);
  const monthlyUsage = getUserUsage(user.userId);
  const w = windowsAt(now);
  const dayStartSql = `${w.day.slice(1)} 00:00:00`;
  const monthStartSql = `${w.month.slice(1)}-01 00:00:00`;

  const dayFromLogs = db
    .prepare(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
         FROM requests
        WHERE user_id = ? AND status = 'success' AND created_at >= ?`,
    )
    .get(user.userId, dayStartSql) as { requests: number; tokens: number } | undefined;

  const monthFromLogs = db
    .prepare(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
         FROM requests
        WHERE user_id = ? AND status = 'success' AND created_at >= ?`,
    )
    .get(user.userId, monthStartSql) as { requests: number; tokens: number } | undefined;

  const dayRequestsUsed = Math.max(
    quotaState.usage.day.requests,
    Number(dayFromLogs?.requests ?? 0),
  );
  const dayTokensUsed = Math.max(
    quotaState.usage.day.tokens,
    Number(dayFromLogs?.tokens ?? 0),
  );
  const monthRequestsUsed = Math.max(
    quotaState.usage.month.requests,
    monthlyUsage.requests,
    Number(monthFromLogs?.requests ?? 0),
  );
  const monthTokensUsed = Math.max(
    quotaState.usage.month.tokens,
    monthlyUsage.tokens,
    Number(monthFromLogs?.tokens ?? 0),
  );

  // Use explicit per-user quota if tracked; otherwise for members reflect active Starter Quota reference if enabled
  const starterCfg = getStarterQuotaConfig();
  const useStarterFallback =
    !quotaState.tracked && user.role === 'member' && starterCfg.enabled;

  const effectiveQuota = quotaState.tracked
    ? quotaState.quota
    : useStarterFallback
      ? {
          dailyRequests: starterCfg.dailyRequests,
          dailyTokens: starterCfg.dailyTokens,
          monthlyRequests: starterCfg.monthlyRequests,
          monthlyTokens: starterCfg.monthlyTokens,
        }
      : quotaState.quota;

  const tracked =
    quotaState.tracked ||
    Boolean(
      useStarterFallback &&
        (effectiveQuota.dailyRequests !== null ||
          effectiveQuota.dailyTokens !== null ||
          effectiveQuota.monthlyRequests !== null ||
          effectiveQuota.monthlyTokens !== null),
    );

  const dailyRequests = buildQuotaMetric(dayRequestsUsed, effectiveQuota.dailyRequests);
  const dailyTokens = buildQuotaMetric(dayTokensUsed, effectiveQuota.dailyTokens);
  const monthlyRequests = buildQuotaMetric(monthRequestsUsed, effectiveQuota.monthlyRequests);
  const monthlyTokens = buildQuotaMetric(monthTokensUsed, effectiveQuota.monthlyTokens);

  const pcts = [
    dailyRequests.pct,
    dailyTokens.pct,
    monthlyRequests.pct,
    monthlyTokens.pct,
  ].filter((p): p is number => p !== null);

  const highestUsagePct = pcts.length > 0 ? Math.max(...pcts) : null;

  return {
    tracked,
    rpmLimit: monthlyUsage.rpmLimit,
    dailyRequests,
    dailyTokens,
    monthlyRequests,
    monthlyTokens,
    highestUsagePct,
    isNearExhaustion: highestUsagePct !== null && highestUsagePct >= 80,
    isExhausted: highestUsagePct !== null && highestUsagePct >= 100,
    resetsAt: quotaState.resetsAt,
  };
}

interface RawUserRequestRow {
  id: number;
  createdAt: string;
  status: string;
  modelId: string;
  requestedModel: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
}

const ISSUE_COPY: Record<
  CopilotErrorCategory,
  {
    severity: 'critical' | 'warning' | 'info';
    titleEn: string;
    titleVi: string;
    rootCauseEn: string;
    rootCauseVi: string;
    remediationEn: string;
    remediationVi: string;
  }
> = {
  rate_limit_429: {
    severity: 'warning',
    titleEn: 'HTTP 429 Rate-Limit / Burst Throttling',
    titleVi: 'Lỗi HTTP 429 — Chạm trần tốc độ gọi (Rate-Limit)',
    rootCauseEn:
      'Burst traffic exceeded your per-minute RPM limit or hit a temporary upstream model cooldown.',
    rootCauseVi:
      'Tốc độ gửi request dồn dập vượt ngưỡng RPM mỗi phút của khóa hoặc chạm phiên nghỉ (cooldown) tạm thời của model.',
    remediationEn:
      'Slow the client down and honour Retry-After; use model "auto" with ECO or BALANCED routing so load spreads across providers. If the message says "Your plan limit is N requests per minute", an admin can raise that key\'s RPM on Users (/users); if every provider route is cooling down, connect more accounts at Thruline → Providers or add a fallback chain in Combos.',
    remediationVi:
      'Giảm tốc độ gọi và tôn trọng Retry-After; dùng model "auto" với định tuyến ECO hoặc BALANCED để phân tải qua nhiều nhà cung cấp. Nếu thông báo ghi "Your plan limit is N requests per minute", admin có thể nâng RPM của key ở Users (/users); nếu mọi route nhà cung cấp đang nghỉ (cooldown), hãy kết nối thêm tài khoản ở Thruline → Providers hoặc thêm chuỗi dự phòng ở Combos.',
  },
  bad_request_400: {
    severity: 'warning',
    titleEn: 'HTTP 400 Bad Request / Context Window Overflow',
    titleVi: 'Lỗi HTTP 400 — Ngữ cảnh quá dài hoặc sai tham số payload',
    rootCauseEn:
      'One or more requests exceeded the target model context window, sent unsupported parameters, or called a flow-only model with a personal key.',
    rootCauseVi:
      'Request gửi kèm lịch sử hội thoại / file quá giới hạn context window của model, sai định dạng tham số hoặc gọi nhầm mã flow nội bộ.',
    remediationEn:
      'Compact or clear long IDE chat threads, keep model set to "auto", and verify max_tokens stays within model bounds.',
    remediationVi:
      'Thu gọn (/compact) phiên chat dài trên IDE, đặt tên model là "auto" và kiểm tra lại giới hạn max_tokens.',
  },
  quota_guardrail_403: {
    severity: 'critical',
    titleEn: 'HTTP 403 Quota Ceiling or Safety Guardrail Block',
    titleVi: 'Lỗi HTTP 403 — Chạm hạn mức Quota hoặc Tường lửa bảo vệ',
    rootCauseEn:
      'Requests were stopped either because your daily/monthly allowance reached its limit or a prompt guardrail policy blocked restricted input.',
    rootCauseVi:
      'Request bị chặn do hạn mức ngày/tháng đã chạm trần hoặc nội dung prompt vướng bộ lọc bảo vệ (Guardrails).',
    remediationEn:
      'Switch routine coding keys to ECO mode to stretch token allowance by ~35–45%, or redeem a quota voucher / wait for window reset.',
    remediationVi:
      'Chuyển khóa làm việc hàng ngày sang chế độ ECO để tiết kiệm ~35–45% token, hoặc chờ chu kỳ quota tự động làm mới.',
  },
  upstream_5xx_timeout: {
    severity: 'warning',
    titleEn: 'HTTP 5xx / Upstream Provider Timeout',
    titleVi: 'Lỗi HTTP 5xx / Quá thời gian phản hồi (Timeout)',
    rootCauseEn:
      'An upstream AI provider experienced transient overload or slow token generation on a pinned/heavy model.',
    rootCauseVi:
      'Nhà cung cấp AI phía trên đang quá tải tạm thời hoặc bạn đang ghim cố định một model suy luận nặng phản hồi chậm.',
    remediationEn:
      'Use model "auto" with BALANCED routing so the gateway automatically fails over away from slow or unhealthy providers.',
    remediationVi:
      'Dùng model "auto" kèm chế độ BALANCED để cổng tự động chuyển hướng dự phòng sang nhà cung cấp đang khỏe.',
  },
  other_error: {
    severity: 'info',
    titleEn: 'Intermittent Request Failure',
    titleVi: 'Lỗi gián đoạn kết nối rải rác',
    rootCauseEn:
      'A small number of requests ended with a non-standard client or network error.',
    rootCauseVi:
      'Một vài lượt gọi gặp lỗi ngắt kết nối hoặc gián đoạn mạng không xác định.',
    remediationEn:
      'Retry with model "auto" and verify your IDE base URL points to the gateway /v1 endpoint.',
    remediationVi:
      'Thử gọi lại với model "auto" và kiểm tra Base URL trên IDE đã trỏ đúng vào /v1 của hệ thống.',
  },
};

/**
 * Builds a complete, strictly user-scoped diagnostic report for `user.userId`.
 * Never accesses or exposes other users' keys/logs or admin upstream provider keys.
 */
export function buildUserErrorDiagnosticReport(
  user: SessionUser,
  options?: { windowHours?: number; now?: number },
): CopilotUserDiagnosticReport {
  const db = getDb();
  const now = options?.now ?? Date.now();
  const windowHours = Math.max(1, Math.min(168, Math.trunc(options?.windowHours ?? 72)));
  const sinceSql = sqlTimeUtc(now - windowHours * HOUR_MS);

  const rows = db
    .prepare(
      `SELECT
         id,
         created_at AS createdAt,
         status,
         model_id AS modelId,
         requested_model AS requestedModel,
         latency_ms AS latencyMs,
         input_tokens AS inputTokens,
         output_tokens AS outputTokens,
         error
       FROM requests
       WHERE user_id = ? AND created_at >= ?
       ORDER BY id DESC
       LIMIT 100`,
    )
    .all(user.userId, sinceSql) as RawUserRequestRow[];

  const errorBreakdown: Record<CopilotErrorCategory, number> = {
    rate_limit_429: 0,
    bad_request_400: 0,
    quota_guardrail_403: 0,
    upstream_5xx_timeout: 0,
    other_error: 0,
  };

  const categoryMeta = new Map<
    CopilotErrorCategory,
    { latestAt: string | null; sampleError: string | null }
  >();

  let succeeded = 0;
  let failed = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let highLatencyCount = 0;

  for (const r of rows) {
    if (typeof r.latencyMs === 'number' && r.latencyMs > 0) {
      latencySum += r.latencyMs;
      latencyCount += 1;
      if (r.latencyMs >= HIGH_LATENCY_THRESHOLD_MS) {
        highLatencyCount += 1;
      }
    }
    if (r.status === 'success') {
      succeeded += 1;
    } else if (r.status === 'error') {
      failed += 1;
      // Also detect quota exhaustion vs 429 accurately
      const cat = classifyDiagnosticErrorCategory(r.error);
      errorBreakdown[cat] += 1;
      if (!categoryMeta.has(cat)) {
        categoryMeta.set(cat, {
          latestAt: r.createdAt ?? null,
          sampleError: sanitizeDiagnosticErrorSummary(r.error),
        });
      }
    }
  }

  const total = rows.length;
  const completedTotal = succeeded + failed;
  const errorRatePct = completedTotal > 0 ? Math.round((failed / completedTotal) * 100) : 0;
  const avgLatencyMs = latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0;

  const activeKeys: CopilotPersonalKeySummary[] = listUserApiKeys(user.userId)
    .filter((k) => !k.revoked)
    .map((k) => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      rpmLimit: k.rpmLimit,
      routingMode: normalizeRoutingMode(k.routingMode, 'default'),
      assistantId: k.assistantId ?? null,
      assistantName: k.assistantName ?? null,
      lastUsedAt: k.lastUsedAt ?? null,
      createdAt: k.createdAt,
    }));

  const quota = computeUserQuotaSummary(user, now);
  const onboarding = buildOnboardingChecklist(user.userId);

  const issues: CopilotDiagnosticIssue[] = [];

  if (quota.isExhausted || quota.isNearExhaustion) {
    const pct = quota.highestUsagePct ?? 100;
    issues.push({
      category: 'quota_pressure',
      severity: quota.isExhausted ? 'critical' : 'warning',
      count: 1,
      latestAt: new Date(now).toISOString(),
      sampleError: null,
      titleEn: quota.isExhausted
        ? `Quota Allowance Exhausted (${pct}% used)`
        : `Quota Nearing Limit (${pct}% used)`,
      titleVi: quota.isExhausted
        ? `Đã chạm trần hạn mức Quota (${pct}%)`
        : `Hạn mức Quota sắp đầy (đã dùng ${pct}%)`,
      rootCauseEn: quota.isExhausted
        ? `Your account has consumed ${pct}% of an active daily or monthly Starter/User quota window, causing new inference calls to be rejected until reset.`
        : `Your account has already used ${pct}% of its current quota window.`,
      rootCauseVi: quota.isExhausted
        ? `Tài khoản của bạn đã dùng hết ${pct}% hạn mức Starter/User Quota trong chu kỳ hiện tại, khiến các lượt gọi API mới bị từ chối cho tới giờ reset.`
        : `Tài khoản của bạn đã sử dụng tới ${pct}% hạn mức Quota trong chu kỳ hiện tại.`,
      remediationEn:
        'Switch your Personal API Key to ECO mode to conserve remaining allowance, or wait for the quota window reset.',
      remediationVi:
        'Chuyển Personal API Key sang chế độ ECO để tiết kiệm tối đa hạn mức, hoặc chờ đến mốc làm mới chu kỳ.',
    });
  }

  const orderedCategories: CopilotErrorCategory[] = [
    'rate_limit_429',
    'quota_guardrail_403',
    'bad_request_400',
    'upstream_5xx_timeout',
    'other_error',
  ];

  for (const cat of orderedCategories) {
    const count = errorBreakdown[cat];
    if (count <= 0) continue;
    const meta = categoryMeta.get(cat);
    const copy = ISSUE_COPY[cat];
    issues.push({
      category: cat,
      severity: count >= 5 && copy.severity === 'warning' ? 'critical' : copy.severity,
      count,
      latestAt: meta?.latestAt ?? null,
      sampleError: meta?.sampleError ?? null,
      titleEn: copy.titleEn,
      titleVi: copy.titleVi,
      rootCauseEn: copy.rootCauseEn,
      rootCauseVi: copy.rootCauseVi,
      remediationEn: copy.remediationEn,
      remediationVi: copy.remediationVi,
    });
  }

  if (highLatencyCount > 0 || avgLatencyMs >= HIGH_LATENCY_THRESHOLD_MS) {
    issues.push({
      category: 'high_latency',
      severity: 'warning',
      count: Math.max(1, highLatencyCount),
      latestAt: rows[0]?.createdAt ?? null,
      sampleError: null,
      titleEn: `Elevated Response Latency (avg ${(avgLatencyMs / 1000).toFixed(1)}s)`,
      titleVi: `Độ trễ phản hồi cao (trung bình ${(avgLatencyMs / 1000).toFixed(1)}s)`,
      rootCauseEn:
        'Recent requests took longer than 8s on average — often caused by MAX reasoning mode or large uncompacted context.',
      rootCauseVi:
        'Các lượt gọi gần đây mất trung bình trên 8 giây — thường do đang bật chế độ MAX hoặc gửi ngữ cảnh hội thoại quá dài.',
      remediationEn:
        'Switch routine IDE keys to ECO or BALANCED mode for sub-second streaming starts.',
      remediationVi:
        'Chuyển khóa IDE hàng ngày sang chế độ ECO hoặc BALANCED để phản hồi nhanh và mượt hơn.',
    });
  }

  // Recommend the single highest-impact 1-click Human-in-the-Loop remediation action
  let recommendedAction: CopilotActionProposal | null = null;
  const nonEcoKey = activeKeys.find((k) => k.routingMode !== 'eco');
  const nonBalancedKey = activeKeys.find((k) => k.routingMode !== 'balanced');
  const maxKey = activeKeys.find((k) => k.routingMode === 'max');

  if (activeKeys.length === 0) {
    recommendedAction = buildCreatePersonalKeyProposal({
      name: 'Personal IDE Key',
      routingMode: quota.isNearExhaustion ? 'eco' : 'balanced',
    });
  } else if (
    (errorBreakdown.rate_limit_429 > 0 ||
      errorBreakdown.quota_guardrail_403 > 0 ||
      quota.isNearExhaustion ||
      highLatencyCount > 0 ||
      avgLatencyMs >= HIGH_LATENCY_THRESHOLD_MS) &&
    nonEcoKey
  ) {
    recommendedAction = buildSwitchKeyRoutingModeProposal({
      keyId: nonEcoKey.id,
      keyName: nonEcoKey.name,
      keyPrefix: nonEcoKey.keyPrefix,
      fromRoutingMode: nonEcoKey.routingMode,
      routingMode: 'eco',
    });
  } else if (errorBreakdown.upstream_5xx_timeout > 0 && nonBalancedKey) {
    recommendedAction = buildSwitchKeyRoutingModeProposal({
      keyId: nonBalancedKey.id,
      keyName: nonBalancedKey.name,
      keyPrefix: nonBalancedKey.keyPrefix,
      fromRoutingMode: nonBalancedKey.routingMode,
      routingMode: 'balanced',
    });
  } else if (maxKey && total >= 5) {
    recommendedAction = buildSwitchKeyRoutingModeProposal({
      keyId: maxKey.id,
      keyName: maxKey.name,
      keyPrefix: maxKey.keyPrefix,
      fromRoutingMode: maxKey.routingMode,
      routingMode: 'balanced',
    });
  } else if (onboarding.completedCount < 3) {
    recommendedAction = buildOpenOnboardingGuideProposal({ userId: user.userId });
  }

  const overallHealth: CopilotUserDiagnosticReport['overallHealth'] =
    quota.isExhausted ||
    issues.some((i) => i.severity === 'critical') ||
    (completedTotal >= 3 && errorRatePct >= 50)
      ? 'critical'
      : issues.length > 0 || activeKeys.length === 0
        ? 'degraded'
        : 'healthy';

  const headlineEn =
    overallHealth === 'critical'
      ? `Attention needed: ${issues[0]?.titleEn ?? `${failed} failed request(s) detected`}.`
      : overallHealth === 'degraded'
        ? activeKeys.length === 0 && issues.length === 0
          ? 'No active Personal API Key yet — mint one in 1 click to get started.'
          : `${issues.length} issue(s) spotted across ${total} recent request(s) in the last ${windowHours}h.`
        : `All clear! ${activeKeys.length} active key(s), ${succeeded}/${total} recent requests succeeded.`;

  const headlineVi =
    overallHealth === 'critical'
      ? `Cần xử lý ngay: ${issues[0]?.titleVi ?? `Phát hiện ${failed} lượt gọi lỗi`}.`
      : overallHealth === 'degraded'
        ? activeKeys.length === 0 && issues.length === 0
          ? 'Tài khoản chưa có Personal API Key — bạn có thể tạo ngay bằng 1 cú nhấp.'
          : `Phát hiện ${issues.length} vấn đề qua ${total} lượt gọi trong ${windowHours} giờ gần đây.`
        : `Hoạt động ổn định! Có ${activeKeys.length} khóa đang bật, ${succeeded}/${total} lượt gọi thành công.`;

  return {
    generatedAt: new Date(now).toISOString(),
    windowHours,
    overallHealth,
    headlineEn,
    headlineVi,
    recentRequests: {
      total,
      succeeded,
      failed,
      errorRatePct,
      avgLatencyMs,
      highLatencyCount,
    },
    errorBreakdown,
    issues,
    activeKeys,
    quota,
    onboarding,
    recommendedAction,
  };
}

const EXCLUDE_SUPPORT_TENANT_DIAG_RE =
  /\b(?:support\s+tenant|7\s*(?:buoc|steps?)|widget\s+embed|sla\s+routing)\b/i;

const ERROR_DOCTOR_VI_RE =
  /\b(?:sao|tai\s+sao|vi\s+sao)\s+(?:goi\s+|dung\s+|chat\s+|request\s+)?(?:api\s+|key\s+|model\s+)?(?:hay\s+|lai\s+|cu\s+)?(?:bi\s+|gap\s+|bao\s+)?(?:loi|error|cham|lag|tre|timeout|khong\s+duoc|that\s+bai)\b|\b(?:bi\s+loi|gap\s+loi|bao\s+loi|loi\s+api|api\s+(?:bi\s+)?(?:loi|lag|cham|timeout))\b|\bloi\s*(?:429|400|401|403|413|500|502|503|504)\b|\b(?:kiem\s+tra|chan\s+doan|kham(?:\s+benh)?|check|test)\s+(?:suc\s+khoe\s+)?(?:tai\s+khoan|loi(?:\s+api)?|quota|han\s+muc|key)\b|\b(?:tai\s+khoan|api|key)\s+(?:cua\s+(?:minh|toi)\s+)?(?:bi\s+sao|co\s+loi\s+gi|con\s+quota\s+khong|het\s+quota)\b/i;

const ERROR_DOCTOR_EN_RE =
  /\b(?:diagnose|troubleshoot|inspect|doctor)\s+(?:my\s+)?(?:api\s+)?(?:errors?|account|keys?|requests?|quota|issues?|failures?)\b|\bcheck\s+my\s+(?:account(?:\s+health)?|api\s+errors?|quota(?:\s+usage)?)\b|\bwhy\s+(?:are|is|do|did|am\s+i)\s+(?:my\s+)?(?:api|requests?|calls?|completions?|keys?|models?)[\s\w]{0,30}?\b(?:fail(?:ing)?|error(?:ing|s)?|slow|lag(?:ging)?|tim(?:e|ing)\s+out|429|400|403|500|502|503|504|rate[\s-]*limit(?:ed)?|blocked)\b|\b(?:getting|hitting|seeing)\s+(?:http\s+)?(?:429|400|403|500|502|503|504|rate[\s-]*limits?|quota\s+errors?|timeouts?)\b|\berror\s+doctor\b/i;

/**
 * Returns true if the user's message asks to self-diagnose their account, quota,
 * latency, or API errors (in accented VI, unaccented VI, or EN).
 */
export function matchErrorDoctorIntent(rawMessage: string): boolean {
  const trimmed = rawMessage.trim();
  if (!trimmed) return false;
  const folded = foldVietnameseAscii(trimmed);
  if (EXCLUDE_SUPPORT_TENANT_DIAG_RE.test(folded)) return false;
  return ERROR_DOCTOR_VI_RE.test(folded) || ERROR_DOCTOR_EN_RE.test(folded);
}

/**
 * Detects if a message contains Vietnamese (including unaccentedError Doctor / Action phrasings)
 * so replies match the user's actual language even under an English dashboard UI.
 */
export function hasDoctorOrActionVietnameseMarkers(rawMessage: string): boolean {
  const trimmed = rawMessage.trim();
  if (!trimmed) return false;
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(trimmed)) {
    return true;
  }
  const folded = foldVietnameseAscii(trimmed);
  return (
    ERROR_DOCTOR_VI_RE.test(folded) ||
    /\b(?:giup\s+minh|giup\s+toi|tai\s+khoan|tao\s+(?:personal\s*)?(?:api\s*)?key|chuyen\s+key|huong\s+dan\s+(?:nguoi\s+moi|thanh\s+vien)|bi\s+loi|goi\s+api)\b/i.test(
      folded,
    )
  );
}

export function buildErrorDoctorChatResponse(params: {
  user: SessionUser;
  locale: 'vi' | 'en';
  report?: CopilotUserDiagnosticReport;
}): SupportSetupChatResponse {
  const { user, locale } = params;
  const report = params.report ?? buildUserErrorDiagnosticReport(user);

  const lines: string[] = [];

  if (locale === 'vi') {
    lines.push(
      `Mình vừa kiểm tra trực tiếp nhật ký gọi API, khóa cá nhân và hạn mức trên tài khoản của bạn (**${report.windowHours} giờ gần nhất**):`,
    );

    if (report.issues.length > 0) {
      for (const issue of report.issues.slice(0, 3)) {
        const countBadge =
          issue.category === 'quota_pressure' ? '' : ` (${issue.count} lượt)`;
        lines.push(
          `- **${issue.titleVi}${countBadge}**: ${issue.rootCauseVi} → *Cách khắc phục:* ${issue.remediationVi}`,
        );
      }
    } else if (report.recentRequests.total === 0) {
      lines.push(
        '- Hiện chưa ghi nhận lượt gọi lỗi nào gần đây trên tài khoản của bạn (0 lỗi).',
      );
    } else {
      lines.push(
        `- **Đường truyền ổn định**: ${report.recentRequests.succeeded}/${report.recentRequests.total} lượt gọi gần nhất thành công (độ trễ TB ${report.recentRequests.avgLatencyMs}ms, 0 lỗi nghiêm trọng).`,
      );
    }

    if (report.quota.tracked && report.quota.highestUsagePct !== null) {
      lines.push(
        `- **Hạn mức Quota**: Đang ở mức cao nhất **${report.quota.highestUsagePct}%** (giới hạn tốc độ **${report.quota.rpmLimit} RPM**).`,
      );
    } else {
      lines.push(`- **Giới hạn tốc độ**: **${report.quota.rpmLimit} RPM** mỗi phút.`);
    }

    if (report.activeKeys.length > 0) {
      const keyDesc = report.activeKeys
        .slice(0, 3)
        .map(
          (k) =>
            `**${k.name}** (\`${k.keyPrefix}\` · chế độ \`${k.routingMode}\`${k.assistantName ? ` · trợ lý ${k.assistantName}` : ''})`,
        )
        .join(', ');
      lines.push(`- **Personal API Key đang bật (${report.activeKeys.length})**: ${keyDesc}.`);
    } else {
      lines.push(
        '- **Personal API Key**: Tài khoản hiện chưa có khóa cá nhân nào đang bật.',
      );
    }

    if (report.recommendedAction) {
      lines.push(
        '\nMình có đính kèm **Thẻ Chẩn đoán** và **Đề xuất khắc phục 1 chạm** bên dưới — hệ thống chưa tự ý thay đổi gì cho tới khi bạn bấm **Xác nhận & Chạy** nhé!',
      );
    }
  } else {
    lines.push(
      `I just inspected your account's recent inference logs, active Personal API Keys, and quota state (**last ${report.windowHours} hours**):`,
    );

    if (report.issues.length > 0) {
      for (const issue of report.issues.slice(0, 3)) {
        const countBadge =
          issue.category === 'quota_pressure' ? '' : ` (${issue.count}x)`;
        lines.push(
          `- **${issue.titleEn}${countBadge}**: ${issue.rootCauseEn} → *Fix:* ${issue.remediationEn}`,
        );
      }
    } else if (report.recentRequests.total === 0) {
      lines.push('- No recent API errors recorded on your account (0 failures).');
    } else {
      lines.push(
        `- **Healthy traffic**: ${report.recentRequests.succeeded}/${report.recentRequests.total} recent requests succeeded (avg latency ${report.recentRequests.avgLatencyMs}ms).`,
      );
    }

    if (report.quota.tracked && report.quota.highestUsagePct !== null) {
      lines.push(
        `- **Quota Usage**: Peak window usage is **${report.quota.highestUsagePct}%** (**${report.quota.rpmLimit} RPM** rate ceiling).`,
      );
    } else {
      lines.push(`- **Rate Limit Ceiling**: **${report.quota.rpmLimit} RPM**.`);
    }

    if (report.activeKeys.length > 0) {
      const keyDesc = report.activeKeys
        .slice(0, 3)
        .map(
          (k) =>
            `**${k.name}** (\`${k.keyPrefix}\` · mode \`${k.routingMode}\`${k.assistantName ? ` · assistant ${k.assistantName}` : ''})`,
        )
        .join(', ');
      lines.push(`- **Active Personal API Keys (${report.activeKeys.length})**: ${keyDesc}.`);
    } else {
      lines.push('- **Personal API Keys**: You currently have 0 active keys.');
    }

    if (report.recommendedAction) {
      lines.push(
        '\nI attached your **Diagnostic Summary Card** and a **1-click remediation action** below — nothing changes until you click **Confirm & Run**!',
      );
    }
  }

  const suggestedQuickReplies =
    locale === 'vi'
      ? [
          'Tạo Personal API Key mới chế độ Eco',
          'Mở checklist 3 bước cho thành viên mới',
          'Kiểm tra lại sức khỏe tài khoản',
        ]
      : [
          'Create a new Personal API Key in Eco mode',
          'Open 3-step member onboarding checklist',
          'Re-run account diagnostics',
        ];

  return {
    ok: true,
    replyLocale: locale,
    reply: lines.join('\n'),
    intent: 'diagnose_errors',
    missingQuestions: [],
    suggestedQuickReplies,
    proposal: null,
    userDiagnostic: report,
    actionProposal: report.recommendedAction,
    modelUsed: null,
    usedFallback: true,
  };
}
