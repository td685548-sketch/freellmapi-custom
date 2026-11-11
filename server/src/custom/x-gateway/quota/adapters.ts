import type { XQuotaWindow } from '@freellmapi/shared/x-quota.js';
import { z } from 'zod';
import { withAccountCredential } from '../../provider-accounts/oauth-lifecycle.js';
import { parseOAuthCredential } from '../../provider-accounts/oauth-credentials.js';
import { kiroRegion } from '../../provider-accounts/kiro-auth.js';
import { fetchGeminiProjectId } from '../../provider-accounts/oauth-providers.js';
import { readSubscriptionJson } from '../../provider-accounts/subscription-http.js';
import { proxyFetch, withKeyProxy } from '../../../lib/proxy.js';
import { type AccountRow, resolveXGatewayAccountProxy } from '../../provider-accounts/store.js';
import { getXGatewayProvider } from '../../provider-accounts/catalog.js';
import { COPILOT_PREFIX } from '../../provider-accounts/http.js';

const endpoints: Record<string, string> = {
  claude: 'https://api.anthropic.com/api/oauth/usage',
  'gemini-cli': 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
  kiro: 'https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits',
  codex: 'https://chatgpt.com/backend-api/wham/usage',
  'github-copilot': 'https://api.github.com/copilot_internal/user',
  openrouter: 'https://openrouter.ai/api/v1/key',
  deepseek: 'https://api.deepseek.com/user/balance',
  groq: 'https://api.groq.com/openai/v1/models',
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
  } else if (provider === 'gemini-cli' && Array.isArray(data.buckets)) {
    for (const raw of data.buckets) {
      const item = object(raw); const fraction = quotaNumber(item.remainingFraction);
      if (typeof item.modelId !== 'string' || fraction == null || fraction > 1) continue;
      // Each bucket belongs to a model, not the entire account.
      result.push(window(item.modelId, 100, fraction * 100, quotaReset(item.resetTime), '%', false));
    }
  } else if (provider === 'kiro' && Array.isArray(data.usageBreakdownList)) {
    for (const raw of data.usageBreakdownList) {
      const item = object(raw); const limit = quotaNumber(item.usageLimitWithPrecision ?? item.usageLimit); const used = quotaNumber(item.currentUsageWithPrecision ?? item.currentUsage);
      if (limit == null || used == null || typeof item.resourceType !== 'string') continue;
      let remaining = Math.max(0, limit - used); let total = limit;
      const trial = object(item.freeTrialInfo); const trialLimit = quotaNumber(trial.usageLimitWithPrecision); const trialUsed = quotaNumber(trial.currentUsageWithPrecision);
      if (trial.freeTrialStatus === 'ACTIVE' && trialLimit != null && trialUsed != null) { total += trialLimit; remaining += Math.max(0, trialLimit - trialUsed); }
      result.push(window(item.resourceType, total, remaining, quotaReset(data.nextDateReset ?? data.resetDate), 'credits'));
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
  let secret = structured?.accessToken ?? credential;
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
  let url = endpoints[account.provider];
  let method = 'GET'; let body: string | undefined;
  if (account.provider === 'codex' && structured?.accountId) headers['ChatGPT-Account-ID'] = structured.accountId;
  if (account.provider === 'gemini-cli') {
    const project = structured?.projectId ?? await fetchGeminiProjectId(secret);
    if (!project) throw new Error('Gemini CLI project is unknown; configure Code Assist access before checking quota.');
    method = 'POST'; headers['Content-Type'] = 'application/json'; body = JSON.stringify({ project });
  }
  if (account.provider === 'kiro') {
    const params = new URLSearchParams({ origin: 'AI_EDITOR', resourceType: 'AGENTIC_REQUEST', isEmailRequired: 'true' });
    if (structured?.profileArn) params.set('profileArn', structured.profileArn);
    url = `https://codewhisperer.${kiroRegion(structured?.region)}.amazonaws.com/getUsageLimits?${params}`;
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
