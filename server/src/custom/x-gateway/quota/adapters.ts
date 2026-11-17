import type { XQuotaWindow } from '@freellmapi/shared/x-quota.js';
import { z } from 'zod';
import { withAccountCredential } from '../../provider-accounts/oauth-lifecycle.js';
import { parseOAuthCredential } from '../../provider-accounts/oauth-credentials.js';
import { buildCursorHeaders, parseOAuthBundle } from '../../provider-accounts/oauth-wire-executors.js';
import { ANTIGRAVITY_IDE_USER_AGENT, parseAntigravityCredential } from '../../provider-accounts/antigravity.js';
import { fetchKiroProfileArn, kiroRegion, resolveDefaultKiroProfileArn } from '../../provider-accounts/kiro-auth.js';
import { fetchGeminiProjectId } from '../../provider-accounts/oauth-providers.js';
import { readSubscriptionJson } from '../../provider-accounts/subscription-http.js';
import { proxyFetch, withKeyProxy } from '../../../lib/proxy.js';
import { type AccountRow, resolveXGatewayAccountProxy } from '../../provider-accounts/store.js';
import { getXGatewayProvider } from '../../provider-accounts/catalog.js';
import { COPILOT_PREFIX } from '../../provider-accounts/http.js';

const endpoints: Record<string, string> = {
  claude: 'https://api.anthropic.com/api/oauth/usage',
  'gemini-cli': 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
  antigravity: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  kiro: 'https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits',
  codex: 'https://chatgpt.com/backend-api/wham/usage',
  'github-copilot': 'https://api.github.com/copilot_internal/user',
  openrouter: 'https://openrouter.ai/api/v1/key',
  deepseek: 'https://api.deepseek.com/user/balance',
  groq: 'https://api.groq.com/openai/v1/models',
  glm: 'https://api.z.ai/api/monitor/usage/quota/limit',
  'glm-cn': 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
  'opencode-go': 'https://opencode.ai/zen/go/v1/usage',
  'opencode-zen': 'https://opencode.ai/zen/v1/usage',
  ollama: 'https://ollama.com/api/usage',
  'vercel-ai-gateway': 'https://ai-gateway.vercel.sh/v1/credits',
  kimi: 'https://api.kimi.com/coding/v1/usages',
  'kimi-coding': 'https://api.kimi.com/coding/v1/usages',
  minimax: 'https://www.minimax.io/v1/api/openplatform/coding_plan/remains',
  'minimax-cn': 'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  cline: 'https://app.cline.bot/api/v1/users/me/plan/usage-limits',
  clinepass: 'https://app.cline.bot/api/v1/users/me/plan/usage-limits',
  synthetic: 'https://api.synthetic.new/v2/quotas',
  cursor: 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
  commandcode: 'https://api.commandcode.ai/alpha/whoami?limits=1',
  'codebuddy-cn': 'https://copilot.tencent.com/v2/billing/meter/get-billing-account',
  codebuddy: 'https://copilot.tencent.com/v2/billing/meter/get-billing-account',
  'grok-cli': 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  'xiaomi-mimo': 'https://aistudio.xiaomimimo.com/open-apis/v1/user/usage',
  zed: 'https://cloud.zed.dev/client/users/me',
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function quotaNumber(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
export function quotaReset(value: unknown, now = Date.now()): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : now + n * 1000;
  } else if (/^(\d+(\.\d+)?(ms|[dhms]))+$/.test(raw)) {
    const units: Record<string, number> = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 };
    ms = now;
    for (const p of raw.matchAll(/(\d+(?:\.\d+)?)(ms|[dhms])/g)) ms += Number(p[1]) * units[p[2]];
  } else ms = Date.parse(raw);
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}
const window = (id: string, limit: number | null, remaining: number | null, resetAt: string | null,
  unit = 'requests', blocking = true): XQuotaWindow => ({ id, limit, remaining, resetAt, unit, blocking, source: 'quota_api' });

export function parseQuotaHeaders(headers: Headers, status = 200, now = Date.now()): XQuotaWindow[] {
  const result: XQuotaWindow[] = [];
  for (const kind of ['requests', 'tokens']) {
    const remaining = quotaNumber(headers.get(`x-ratelimit-remaining-${kind}`) ?? headers.get(`anthropic-ratelimit-${kind}-remaining`));
    const limit = quotaNumber(headers.get(`x-ratelimit-limit-${kind}`) ?? headers.get(`anthropic-ratelimit-${kind}-limit`));
    if (remaining == null && limit == null) continue;
    result.push({ ...window(kind, limit, remaining, quotaReset(headers.get(`x-ratelimit-reset-${kind}`) ?? headers.get(`anthropic-ratelimit-${kind}-reset`), now), kind), source: 'header' });
  }
  // A quota API 429 never reaches this observer; only actual inference does.
  if (status === 429) {
    const resetAt = quotaReset(headers.get('retry-after'), now) ?? new Date(now + 60_000).toISOString();
    result.push({ ...window('rate-limit-cooldown', null, 0, resetAt), source: 'header' });
  }
  return result;
}

export function parseProviderQuota(provider: string, payload: unknown): XQuotaWindow[] {
  const data = object(payload);
  const result: XQuotaWindow[] = [];
  if (provider === 'claude') {
    for (const [id, raw] of Object.entries(data)) {
      const item = object(raw);
      const used = quotaNumber(item.utilization);
      if (used == null || (!id.startsWith('five_hour') && !id.startsWith('seven_day'))) continue;
      result.push(window(id, 100, Math.max(0, 100 - used), quotaReset(item.resets_at), '%', ['five_hour', 'seven_day'].includes(id)));
    }
    if (Array.isArray(data.limits)) {
      for (const raw of data.limits) {
        const limit = object(raw);
        if (limit.kind !== 'weekly_scoped') continue;
        const pct = quotaNumber(limit.percent);
        const name = String(object(object(limit.scope).model).display_name ?? '').trim().toLowerCase();
        if (!name || pct == null) continue;
        result.push(window(`weekly_${name}`, 100, Math.max(0, 100 - Math.min(100, pct)), quotaReset(limit.resets_at), '%', false));
      }
    }
    const cedar = object(data.cedar_ember);
    if (cedar.eligible && Array.isArray(cedar.grants)) {
      const avail = cedar.grants.reduce((sum: number, g: any) => (
        g && !g.paused && Number(g.resets_left) > 0 ? sum + Number(g.resets_left) : sum
      ), 0);
      result.push(window('reset_grants', null, avail, quotaReset(cedar.weekly_resets_at), 'grants', false));
    }
  } else if (provider === 'codex') {
    const rate = object(data.rate_limit ?? data.rate_limits ?? object(data.rate_limits_by_limit_id).codex);
    for (const id of ['primary_window', 'secondary_window']) {
      const item = object(rate[id]);
      const used = quotaNumber(item.used_percent ?? item.percent_used);
      if (used == null) continue;
      const resetAt = quotaReset(item.reset_at ?? item.resets_at) ??
        (quotaNumber(item.reset_after_seconds) != null ? quotaReset(item.reset_after_seconds) : null);
      result.push(window(id, 100, Math.max(0, 100 - used), resetAt, '%'));
    }
    const resetCredits = object(data.rate_limit_reset_credits);
    const resetCount = quotaNumber(resetCredits.available_count ?? resetCredits.availableCount);
    if (resetCount != null) {
      result.push(window('reset_credits', null, Math.max(0, Math.floor(resetCount)), null, 'credits', false));
    }
  } else if (provider === 'gemini-cli' && Array.isArray(data.buckets)) {
    for (const raw of data.buckets) {
      const item = object(raw); const fraction = quotaNumber(item.remainingFraction);
      if (typeof item.modelId !== 'string' || fraction == null || fraction > 1) continue;
      // Each bucket belongs to a model, not the entire account.
      result.push(window(item.modelId, 100, fraction * 100, quotaReset(item.resetTime), '%', false));
    }
  } else if (provider === 'kiro' && Array.isArray(data.usageBreakdownList)) {
    const defaultReset = quotaReset(data.nextDateReset ?? data.resetDate);
    for (const raw of data.usageBreakdownList) {
      const item = object(raw);
      const limit = quotaNumber(item.usageLimitWithPrecision ?? item.usageLimit);
      const used = quotaNumber(item.currentUsageWithPrecision ?? item.currentUsage) ?? 0;
      if (limit == null || typeof item.resourceType !== 'string') continue;
      const remaining = Math.max(0, limit - used);
      const trial = object(item.freeTrialInfo);
      const trialLimit = quotaNumber(trial.usageLimitWithPrecision ?? trial.usageLimit);
      const trialUsed = quotaNumber(trial.currentUsageWithPrecision ?? trial.currentUsage) ?? 0;
      const trialActive = trial.freeTrialStatus === 'ACTIVE' && trialLimit != null && trialLimit > 0;
      const trialRemaining = trialActive ? Math.max(0, trialLimit - trialUsed) : 0;
      // Do not block the account on main credits while an active free-trial pool still has balance.
      result.push(window(item.resourceType, limit, remaining, defaultReset, 'credits', trialRemaining <= 0));
      if (trialActive) {
        result.push(window(`${item.resourceType}_freetrial`, trialLimit, trialRemaining,
          quotaReset(trial.freeTrialExpiry) ?? defaultReset, 'credits', remaining <= 0));
      }
    }
  } else if ((provider === 'glm' || provider === 'glm-cn') && Array.isArray(object(data.data).limits)) {
    for (const raw of object(data.data).limits as unknown[]) {
      const item = object(raw);
      if (item.type !== 'TOKENS_LIMIT' && item.type !== 'CREDIT_LIMIT') continue;
      const usedPct = quotaNumber(item.percentage);
      if (usedPct == null) continue;
      const id = item.unit === 3 ? `Session (${item.number ?? 5}h)` : item.unit === 6 ? 'Weekly (7d)'
        : item.type === 'TOKENS_LIMIT' ? 'Tokens' : `Limit (${item.number ?? ''})`;
      result.push(window(id, 100, Math.max(0, 100 - usedPct), quotaReset(item.nextResetTime), '%'));
    }
  } else if ((provider === 'opencode-go' || provider === 'opencode-zen') && typeof data.usage === 'object' && data.usage !== null) {
    const usage = object(data.usage);
    for (const [period, label] of [['rolling', 'Rolling'], ['weekly', 'Weekly'], ['monthly', 'Monthly']] as const) {
      const item = object(usage[period]);
      const pct = quotaNumber(item.percent);
      if (pct == null) continue;
      result.push(window(label, 100, Math.max(0, 100 - Math.min(100, pct)), quotaReset(item.resetsAt), '%'));
    }
  } else if (provider === 'ollama' && typeof data.limits === 'object' && data.limits !== null) {
    const limits = object(data.limits);
    for (const [period, label] of [['session', 'Session (5h)'], ['weekly', 'Weekly (7d)'], ['monthly', 'Monthly']] as const) {
      const item = object(limits[period]);
      const ratio = quotaNumber(item.usage);
      if (ratio == null || ratio > 1) continue;
      result.push(window(label, 100, Math.max(0, Math.round((1 - ratio) * 100)), quotaReset(item.resetAt ?? item.resetsAt), '%'));
    }
  } else if (provider === 'vercel-ai-gateway') {
    const balance = quotaNumber(data.balance);
    const used = quotaNumber(data.total_used);
    if (balance != null) {
      const limit = used != null ? balance + used : null;
      result.push(window('credits', limit, balance, null, 'USD'));
    }
  } else if (provider === 'kimi' || provider === 'kimi-coding') {
    const usage = object(data.usage);
    const limit = quotaNumber(usage.limit ?? usage.Limit);
    const used = quotaNumber(usage.used ?? usage.Used) ?? 0;
    const rem = quotaNumber(usage.remaining ?? usage.Remaining);
    if (limit != null && limit > 0) {
      result.push(window('Weekly', limit, rem ?? Math.max(0, limit - used),
        quotaReset(usage.resetTime ?? usage.ResetTime ?? usage.reset_at ?? usage.resetAt), 'requests'));
    }
    if (Array.isArray(data.limits)) {
      for (const raw of data.limits) {
        const detail = object(object(raw).detail);
        const dLimit = quotaNumber(detail.limit ?? detail.Limit);
        const dRem = quotaNumber(detail.remaining ?? detail.Remaining);
        if (dLimit != null && dLimit > 0 && dRem != null) {
          result.push(window('Ratelimit', dLimit, dRem,
            quotaReset(detail.resetTime ?? detail.reset_at ?? detail.resetAt), 'requests'));
        }
      }
    }
  } else if ((provider === 'minimax' || provider === 'minimax-cn') && Array.isArray(data.model_remains ?? data.modelRemains)) {
    const models = (data.model_remains ?? data.modelRemains) as unknown[];
    for (const raw of models) {
      const item = object(raw);
      const name = String(item.model_name ?? item.modelName ?? 'MiniMax').trim() || 'MiniMax';
      const total = quotaNumber(item.current_interval_total_count ?? item.currentIntervalTotalCount);
      const rem = quotaNumber(item.current_interval_usage_count ?? item.currentIntervalUsageCount);
      const pct = quotaNumber(item.current_interval_remaining_percent ?? item.currentIntervalRemainingPercent);
      const resetAt = quotaReset(item.end_time ?? item.endTime);
      if (total != null && total > 0 && rem != null) {
        result.push(window(name, total, Math.min(total, rem), resetAt, 'requests', false));
      } else if (pct != null) {
        result.push(window(name, 100, Math.min(100, pct), resetAt, '%', false));
      }
    }
  } else if (provider === 'github-copilot') {
    const resetAt = quotaReset(data.quota_reset_date ?? data.limited_user_reset_date);
    const snapshots = object(data.quota_snapshots);
    for (const [id, raw] of Object.entries(snapshots)) {
      const item = object(raw);
      const limit = quotaNumber(item.entitlement);
      const remaining = quotaNumber(item.remaining);
      if (item.unlimited === true) continue;
      if (limit != null || remaining != null) result.push(window(id, limit, remaining, resetAt, 'requests', id === 'chat'));
    }
    if (!result.length) for (const [id, raw] of Object.entries(object(data.monthly_quotas))) {
      const total = quotaNumber(raw);
      const used = quotaNumber(object(data.limited_user_quotas)[id]);
      if (total != null && used != null) result.push(window(id, total, Math.max(0, total - used), resetAt, 'requests', id === 'chat'));
    }
  } else if (provider === 'openrouter') {
    const item = object(data.data);
    const limit = quotaNumber(item.limit);
    const remaining = quotaNumber(item.limit_remaining);
    const used = quotaNumber(item.usage);
    if (limit != null || remaining != null) result.push(window('credits', limit, remaining ?? (limit != null && used != null ? Math.max(0, limit - used) : null), null, 'USD'));
  } else if (provider === 'deepseek' && Array.isArray(data.balance_infos)) {
    for (const raw of data.balance_infos) {
      const item = object(raw);
      const amount = quotaNumber(item.total_balance);
      const currency = z.enum(['USD', 'CNY']).safeParse(item.currency);
      if (amount != null && currency.success) result.push(window(`balance-${currency.data}`, null, amount, null, currency.data, false));
    }
    // A single empty currency bucket does not imply an empty whole account.
    if (data.is_available === false) result.push(window('balance-unavailable', null, 0, null));
  } else if (provider === 'antigravity') {
    const groups = Array.isArray(data.groups)
      ? data.groups
      : Array.isArray(object(data.quotaSummary).groups)
        ? (object(data.quotaSummary).groups as unknown[])
        : null;
    if (groups) {
      const families: Array<{ re: RegExp; wk: string; ses: string }> = [
        { re: /argon/i, wk: 'gemini_argon_weekly', ses: 'gemini_argon_session' },
        { re: /gemini/i, wk: 'gemini_weekly', ses: 'gemini_session' },
        { re: /claude|gpt/i, wk: 'claude_gpt_weekly', ses: 'claude_gpt_session' },
      ];
      const seen = new Set<string>();
      for (const rawGrp of groups) {
        const grp = object(rawGrp);
        const disp = String(grp.displayName ?? '');
        const buckets = Array.isArray(grp.buckets) ? grp.buckets : [];
        for (const rawB of buckets) {
          const b = object(rawB);
          const win = String(b.window ?? '').toLowerCase();
          const bTxt = `${String(b.bucketId ?? '')} ${String(b.displayName ?? '')}`.toLowerCase();
          const isWeekly = win === 'weekly' || bTxt.includes('weekly');
          const isSession = win === '5h' || win === 'daily' || bTxt.includes('5h') || bTxt.includes('five hour') || bTxt.includes('daily');
          if (!isWeekly && !isSession) continue;
          if (b.disabled === true && isWeekly) continue;
          const frac = b.disabled === true ? 0 : quotaNumber(b.remainingFraction);
          if (frac == null || frac > 1) continue;
          for (const fam of families) {
            if (!fam.re.test(disp)) continue;
            const id = isWeekly ? fam.wk : fam.ses;
            if (!seen.has(id)) {
              seen.add(id);
              result.push(window(id, 100, Math.round(frac * 100), quotaReset(b.resetTime ?? b.reset_time), '%', false));
            }
            break;
          }
        }
      }
    } else if (Array.isArray(data.buckets)) {
      for (const raw of data.buckets) {
        const item = object(raw);
        const fraction = quotaNumber(item.remainingFraction);
        if (typeof item.modelId !== 'string' || fraction == null || fraction > 1) continue;
        result.push(window(item.modelId, 100, fraction * 100, quotaReset(item.resetTime), '%', false));
      }
    }
  } else if (provider === 'cline' || provider === 'clinepass') {
    const limits = Array.isArray(object(data.data).limits) ? object(data.data).limits as unknown[] : [];
    const labels: Record<string, string> = { five_hour: 'Session (5h)', weekly: 'Weekly (7d)', monthly: 'Monthly' };
    for (const raw of limits) {
      const item = object(raw);
      const label = labels[String(item.type ?? '')];
      const used = quotaNumber(item.percentUsed);
      if (!label || used == null) continue;
      result.push(window(label, 100, Math.max(0, 100 - Math.min(100, used)), quotaReset(item.resetsAt), '%', item.type !== 'monthly'));
    }
  } else if (provider === 'synthetic') {
    const sub = object(data.subscription);
    const total = quotaNumber(sub.limit);
    const used = quotaNumber(sub.requests) ?? 0;
    if (total != null && total > 0) {
      result.push(window('Requests', total, Math.max(0, total - used), quotaReset(sub.renewsAt), 'requests'));
    }
  } else if (provider === 'cursor') {
    const planUsage = object(data.planUsage);
    const resetAt = quotaReset(data.billingCycleEnd ?? data.startOfMonth);
    const limitCents = quotaNumber(planUsage.limit);
    const usedCents = quotaNumber(planUsage.includedSpend ?? planUsage.totalSpend) ?? 0;
    if (limitCents != null && limitCents > 0) {
      const totalUsd = Number((limitCents / 100).toFixed(2));
      const remCents = quotaNumber(planUsage.remaining) ?? Math.max(0, limitCents - usedCents);
      result.push(window('Plan (USD)', totalUsd, Number((remCents / 100).toFixed(2)), resetAt, 'USD'));
    } else if (quotaNumber(planUsage.totalPercentUsed) != null) {
      result.push(window('Included usage', 100, Math.max(0, 100 - quotaNumber(planUsage.totalPercentUsed)!), resetAt, '%'));
    }
    if (quotaNumber(planUsage.autoPercentUsed) != null) {
      result.push(window('Auto models (%)', 100, Math.max(0, 100 - quotaNumber(planUsage.autoPercentUsed)!), resetAt, '%', false));
    }
    const spend = object(data.spendLimitUsage);
    const indLim = quotaNumber(spend.individualLimit);
    if (indLim != null && indLim > 0) {
      const indRem = quotaNumber(spend.individualRemaining) ?? Math.max(0, indLim - (quotaNumber(spend.individualUsed) ?? 0));
      result.push(window('On-demand (USD)', Number((indLim / 100).toFixed(2)), Number((indRem / 100).toFixed(2)), resetAt, 'USD', false));
    }
    if (!result.length) {
      for (const [key, raw] of Object.entries(data)) {
        const b = object(raw);
        const total = quotaNumber(b.maxRequestUsage);
        if (total == null || total <= 0) continue;
        const used = quotaNumber(b.numRequests) ?? 0;
        result.push(window(`${key} requests`, total, Math.max(0, total - used), resetAt, 'requests', false));
      }
    }
  } else if (provider === 'commandcode') {
    const creditsBody = data.creditsBody ? object(data.creditsBody) : data;
    const subsData = object(object(data.subsBody).data);
    const c = object(creditsBody.credits);
    const rem = (quotaNumber(c.monthlyCredits) ?? 0) + (quotaNumber(c.purchasedCredits) ?? 0) + (quotaNumber(c.freeCredits) ?? 0);
    const resetAt = quotaReset(subsData.currentPeriodEnd);
    result.push(window('Credits', null, rem, resetAt, 'USD', false));
    const winLimits = object(creditsBody.windowLimits);
    for (const [k, label] of [['fiveHour', 'Session (5h)'], ['weekly', 'Weekly']] as const) {
      const w = object(winLimits[k]);
      const cap = quotaNumber(w.cap);
      const used = quotaNumber(w.used) ?? 0;
      if (cap != null && cap > 0) {
        result.push(window(label, cap, Math.max(0, cap - used), quotaReset(w.resetAt), 'USD'));
      }
    }
  } else if (provider === 'codebuddy-cn' || provider === 'codebuddy') {
    const accounts = object(object(object(data.data).Response).Data).Accounts;
    if (Array.isArray(accounts)) {
      let idx = 0;
      for (const raw of accounts) {
        const acc = object(raw);
        const ce = quotaReset(acc.CycleEndTime);
        const ceMs = ce ? Date.parse(ce) : NaN;
        const de = quotaReset(acc.DeductionEndTime);
        const deMs = de ? Date.parse(de) : NaN;
        const isRefill = Number.isFinite(ceMs) && Number.isFinite(deMs) && (deMs - ceMs) > 2 * 86_400_000;
        const total = quotaNumber(isRefill ? (acc.CycleCapacitySizePrecise ?? acc.CycleCapacitySize) : (acc.CapacitySizePrecise ?? acc.CapacitySize)) ?? 0;
        const used = quotaNumber(isRefill ? (acc.CycleCapacityUsedPrecise ?? acc.CycleCapacityUsed) : (acc.CapacityUsedPrecise ?? acc.CapacityUsed)) ?? 0;
        if (total > 0) {
          idx += 1;
          const label = isRefill ? (idx === 1 ? 'Monthly' : `Monthly ${idx}`) : `Bonus Pack ${idx}`;
          result.push(window(label, total, Math.max(0, total - used), ce, 'credits', isRefill));
        }
      }
    }
  } else if (provider === 'grok-cli') {
    const cfg = object(data.config ?? data);
    const unwrap = (v: unknown) => quotaNumber(v && typeof v === 'object' && 'val' in (v as any) ? (v as any).val : v);
    const periodEnd = quotaReset(cfg.billingPeriodEnd ?? cfg.billing_period_end ?? object(cfg.currentPeriod).end ?? data.billingPeriodEnd);
    const monthlyLim = unwrap(cfg.monthlyLimit ?? cfg.monthly_limit ?? data.monthlyLimit);
    const incUsed = unwrap(cfg.includedUsed ?? cfg.included_used ?? cfg.totalUsed ?? data.includedUsed);
    if (monthlyLim != null && monthlyLim > 0) {
      result.push(window('Monthly included', monthlyLim, Math.max(0, monthlyLim - (incUsed ?? 0)), periodEnd, 'credits'));
    }
    const odCap = unwrap(cfg.onDemandCap ?? data.onDemandCap);
    const odUsed = unwrap(cfg.onDemandUsed ?? data.onDemandUsed);
    if (odCap != null && odCap > 0) {
      result.push(window('On-demand', odCap, Math.max(0, odCap - (odUsed ?? 0)), periodEnd, 'credits'));
    } else if (odCap === 0 && odUsed != null) {
      result.push(window('On-demand', 1, 0, periodEnd, 'credits'));
    }
    const prepaid = unwrap(cfg.prepaidBalance ?? data.prepaidBalance);
    if (prepaid != null && prepaid > 0) {
      result.push(window('Prepaid', prepaid, prepaid, null, 'credits', false));
    }
    const pct = unwrap(cfg.creditUsagePercent ?? cfg.credit_usage_percent ?? data.creditUsagePercent);
    if (pct != null) {
      result.push(window('Weekly SuperGrok', 100, Math.max(0, 100 - Math.min(100, pct)), periodEnd, '%'));
    }
  } else if (provider === 'xiaomi-mimo') {
    const d = object(data.data);
    const pct = quotaNumber(d.percent);
    if (pct != null) {
      const resetAt = quotaNumber(d.resetAt) != null
        ? quotaReset(d.resetAt)
        : typeof d.resetDate === 'string' && d.resetDate
          ? quotaReset(`${d.resetDate}T00:00:00Z`)
          : null;
      result.push(window('Weekly', 100, Math.min(100, pct), resetAt, '%'));
    }
  } else if (provider === 'zed') {
    const plan = object(data.plan);
    const usage = object(plan.usage);
    const resetAt = quotaReset(object(plan.subscription_period).ended_at ?? object(plan.subscriptionPeriod).endedAt);
    const ep = object(usage.edit_predictions ?? usage.editPredictions);
    const epLimitRaw = ep.limit;
    const epUsed = quotaNumber(ep.used) ?? 0;
    if (epLimitRaw === 'unlimited' || (typeof epLimitRaw === 'object' && (epLimitRaw as any)?.unlimited === true)) {
      result.push(window('Edit Predictions', null, null, resetAt, 'requests', false));
    } else {
      const epLimit = quotaNumber(typeof epLimitRaw === 'object' ? ((epLimitRaw as any)?.limited ?? (epLimitRaw as any)?.Limited) : epLimitRaw);
      if (epLimit != null && epLimit > 0) {
        result.push(window('Edit Predictions', epLimit, Math.max(0, epLimit - epUsed), resetAt, 'requests', false));
      }
    }
    const mr = object(usage.model_requests ?? usage.modelRequests);
    const mrLimitRaw = mr.limit;
    const mrUsed = quotaNumber(mr.used) ?? 0;
    const mrLimit = quotaNumber(typeof mrLimitRaw === 'object' ? ((mrLimitRaw as any)?.limited ?? (mrLimitRaw as any)?.Limited) : mrLimitRaw);
    if (mrLimit != null && mrLimit > 0) {
      result.push(window('Hosted Model Requests', mrLimit, Math.max(0, mrLimit - mrUsed), resetAt, 'requests'));
    }
  }
  return result;
}

export function supportsQuota(account: Pick<AccountRow, 'provider' | 'base_url'>): boolean {
  if (!endpoints[account.provider]) return false;
  const official = getXGatewayProvider(account.provider)?.baseUrl?.replace(/\/$/, '');
  return !account.base_url || account.base_url.replace(/\/$/, '') === official;
}

export async function fetchAccountQuota(account: AccountRow): Promise<XQuotaWindow[]> {
  if (!supportsQuota(account)) throw new Error('Quota API unavailable for this provider or custom endpoint.');
  return withKeyProxy(resolveXGatewayAccountProxy(account), () => withAccountCredential(account, async credential => {
  const structured = parseOAuthCredential(credential);
  const bundle = parseOAuthBundle(credential);
  let secret = structured?.accessToken ?? bundle.accessToken ?? credential;
  if (account.provider === 'github-copilot') {
    if (!secret.startsWith(COPILOT_PREFIX)) throw new Error('Reconnect Copilot with GitHub OAuth to read quota.');
    secret = secret.slice(COPILOT_PREFIX.length);
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${secret}`, Accept: 'application/json', 'User-Agent': 'FreeLLMAPI/0.2.1' };
  if (account.provider === 'claude') {
    headers['anthropic-beta'] = 'oauth-2025-04-20';
    headers['anthropic-version'] = '2023-06-01';
  }
  if (account.provider === 'github-copilot') {
    headers.Authorization = `token ${secret}`;
    headers['X-GitHub-Api-Version'] = '2022-11-28';
    headers['Editor-Version'] = 'vscode/1.100.0';
    headers['Editor-Plugin-Version'] = 'copilot-chat/0.26.7';
  }
  if (account.provider === 'cline' || account.provider === 'clinepass') {
    if (account.auth_method !== 'api_key' && !secret.startsWith('workos:')) {
      headers.Authorization = `Bearer workos:${secret}`;
    }
    headers['HTTP-Referer'] = 'https://cline.bot';
    headers['X-Title'] = 'Cline';
  }
  if (account.provider === 'grok-cli') {
    headers['x-xai-token-auth'] = 'xai-grok-cli';
    headers['x-grok-client-mode'] = 'headless';
  }
  if (account.provider === 'xiaomi-mimo') {
    headers['X-Mimo-Source'] = 'mimocode-cli';
  }
  if (account.provider === 'zed') {
    if (!bundle.userId) throw Object.assign(new Error('Zed credential missing userId; reconnect Zed.'), { status: 400 });
    headers.Authorization = `${bundle.userId} ${secret}`;
  }
  const url = endpoints[account.provider];
  let method = 'GET'; let body: string | undefined;
  if (account.provider === 'codex' && structured?.accountId) headers['ChatGPT-Account-ID'] = structured.accountId;
  if ((account.provider === 'kimi' || account.provider === 'kimi-coding') && !structured?.accessToken) {
    delete headers.Authorization;
    headers['x-api-key'] = secret;
    headers['Content-Type'] = 'application/json';
  }
  if (account.provider === 'codebuddy-cn' || account.provider === 'codebuddy') {
    method = 'POST';
    headers['Content-Type'] = 'application/json';
    body = '{}';
  }
  if (account.provider === 'antigravity') {
    let project = parseAntigravityCredential(credential).projectId;
    if (!project) {
      const loadRes = await proxyFetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, 'User-Agent': ANTIGRAVITY_IDE_USER_AGENT },
        body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      }, account.platform, 'unknown');
      if (loadRes.ok) {
        const lj = (await loadRes.json().catch(() => ({}))) as { cloudaicompanionProject?: string | { id?: string } };
        project = typeof lj.cloudaicompanionProject === 'string' ? lj.cloudaicompanionProject : lj.cloudaicompanionProject?.id;
      } else {
        await loadRes.body?.cancel();
      }
    }
    const reqHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, 'User-Agent': ANTIGRAVITY_IDE_USER_AGENT, Accept: 'application/json' };
    const reqBody = JSON.stringify(project ? { project } : {});
    let res = await proxyFetch(url, { method: 'POST', headers: reqHeaders, body: reqBody, signal: AbortSignal.timeout(10_000), redirect: 'error' }, account.platform, 'unknown');
    if (!res.ok) {
      await res.body?.cancel();
      res = await proxyFetch('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', { method: 'POST', headers: reqHeaders, body: reqBody, signal: AbortSignal.timeout(10_000), redirect: 'error' }, account.platform, 'unknown');
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw Object.assign(new Error(`Quota endpoint returned HTTP ${res.status}. Check account authorization or retry later.`), { status: res.status });
    }
    return parseProviderQuota('antigravity', await readSubscriptionJson(res));
  }
  if (account.provider === 'commandcode') {
    const ccHeaders = {
      'User-Agent': 'cli',
      'x-command-code-version': '1.88.5',
      Authorization: `Bearer ${secret}`,
      Accept: 'application/json',
    };
    const whoRes = await proxyFetch('https://api.commandcode.ai/alpha/whoami?limits=1', { headers: ccHeaders, signal: AbortSignal.timeout(10_000), redirect: 'error' }, account.platform, 'unknown');
    if (!whoRes.ok) {
      await whoRes.body?.cancel();
      throw Object.assign(new Error(`Quota endpoint returned HTTP ${whoRes.status}. Check account authorization or retry later.`), { status: whoRes.status });
    }
    const who = (await readSubscriptionJson(whoRes)) as Record<string, any>;
    const orgId = typeof who?.org?.id === 'string' ? who.org.id : '';
    const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
    const [creditsRes, subsRes] = await Promise.all([
      proxyFetch(`https://api.commandcode.ai/alpha/billing/credits${qs}`, { headers: ccHeaders, signal: AbortSignal.timeout(10_000), redirect: 'error' }, account.platform, 'unknown'),
      proxyFetch(`https://api.commandcode.ai/alpha/billing/subscriptions${qs}`, { headers: ccHeaders, signal: AbortSignal.timeout(10_000), redirect: 'error' }, account.platform, 'unknown'),
    ]);
    if (!creditsRes.ok) {
      await creditsRes.body?.cancel();
      await subsRes.body?.cancel();
      throw Object.assign(new Error(`Quota endpoint returned HTTP ${creditsRes.status}.`), { status: creditsRes.status });
    }
    const creditsBody = await readSubscriptionJson(creditsRes);
    const subsBody = subsRes.ok ? await readSubscriptionJson(subsRes) : (await subsRes.body?.cancel(), {});
    return parseProviderQuota('commandcode', { creditsBody, subsBody });
  }
  if (account.provider === 'cursor') {
    const cHeaders = { ...buildCursorHeaders(secret, bundle.machineId), 'content-type': 'application/json', accept: 'application/json' };
    const pRes = await proxyFetch(url, { method: 'POST', headers: cHeaders, body: '{}', signal: AbortSignal.timeout(10_000), redirect: 'error' }, account.platform, 'unknown');
    if (pRes.ok) {
      const parsed = parseProviderQuota('cursor', await readSubscriptionJson(pRes));
      if (parsed.length > 0) return parsed;
    } else {
      await pRes.body?.cancel();
    }
    const bareTok = secret.includes('::') ? secret.split('::')[1] : secret;
    const authRes = await proxyFetch('https://cursor.com/api/usage', { method: 'GET', headers: { Authorization: `Bearer ${bareTok}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000), redirect: 'error' }, account.platform, 'unknown');
    if (!authRes.ok) {
      await authRes.body?.cancel();
      throw Object.assign(new Error(`Quota endpoint returned HTTP ${authRes.status}. Check account authorization or retry later.`), { status: authRes.status });
    }
    return parseProviderQuota('cursor', await readSubscriptionJson(authRes));
  }
  if (account.provider === 'gemini-cli') {
    const project = structured?.projectId ?? await fetchGeminiProjectId(secret);
    if (!project) throw new Error('Gemini CLI project is unknown; configure Code Assist access before checking quota.');
    method = 'POST'; headers['Content-Type'] = 'application/json'; body = JSON.stringify({ project });
  }
  if (account.provider === 'kiro') {
    const region = kiroRegion(structured?.region);
    const authMethod: string | undefined = structured?.authMethod ?? account.auth_method;
    const isApiKey = authMethod === 'api_key';
    if (isApiKey) headers.tokentype = 'API_KEY';
    if (authMethod === 'external_idp') headers.TokenType = 'EXTERNAL_IDP';
    headers['x-amz-user-agent'] = 'aws-sdk-js/1.0.0 KiroIDE';
    headers['user-agent'] = 'aws-sdk-js/1.0.0 KiroIDE';
    const profileArn = isApiKey
      ? (structured?.profileArn || undefined)
      : (structured?.profileArn
        || (structured?.accessToken ? await fetchKiroProfileArn(region, structured.accessToken) : undefined)
        || resolveDefaultKiroProfileArn(structured?.authMethod));
    const getParams = new URLSearchParams({ origin: 'AI_EDITOR', resourceType: 'AGENTIC_REQUEST', isEmailRequired: 'true' });
    if (profileArn) getParams.set('profileArn', profileArn);
    const qParams = new URLSearchParams({ origin: 'AI_EDITOR', resourceType: 'AGENTIC_REQUEST' });
    if (profileArn) qParams.set('profileArn', profileArn);
    const attempts: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [
      { url: `https://codewhisperer.${region}.amazonaws.com/getUsageLimits?${getParams}`, method: 'GET', headers },
      {
        url: `https://codewhisperer.${region}.amazonaws.com/`,
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/x-amz-json-1.0', 'x-amz-target': 'AmazonCodeWhispererService.GetUsageLimits' },
        body: JSON.stringify({ origin: 'AI_EDITOR', resourceType: 'AGENTIC_REQUEST', ...(profileArn ? { profileArn } : {}) }),
      },
      { url: `https://q.${region}.amazonaws.com/getUsageLimits?${qParams}`, method: 'GET', headers },
    ];
    let lastStatus = 0;
    for (const attempt of attempts) {
      const response = await proxyFetch(attempt.url, {
        headers: attempt.headers, method: attempt.method, body: attempt.body, signal: AbortSignal.timeout(10_000), redirect: 'error',
      }, account.platform, 'unknown');
      if (response.ok) return parseProviderQuota('kiro', await readSubscriptionJson(response));
      lastStatus = response.status;
      await response.body?.cancel();
    }
    throw Object.assign(new Error(`Quota endpoint returned HTTP ${lastStatus}. Check account authorization or retry later.`), { status: lastStatus });
  }
    const response = await proxyFetch(url, {
      headers, method, body, signal: AbortSignal.timeout(10_000), redirect: 'error',
    }, account.platform, 'unknown');
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`Quota endpoint returned HTTP ${response.status}. Check account authorization or retry later.`), { status: response.status });
    }
    if (account.provider === 'groq') {
      const windows = parseQuotaHeaders(response.headers);
      await response.body?.cancel();
      return windows;
    }
    return parseProviderQuota(account.provider, await readSubscriptionJson(response));
  }));
}
