export type QuotaTier = 'subscription' | 'cheap' | 'free';
export interface XQuotaWindow {
  id: string;
  limit: number | null;
  remaining: number | null;
  unit: string;
  resetAt: string | null;
  source: 'quota_api' | 'header';
  /** Model-specific and optional credit pools must not disable the whole account. */
  blocking: boolean;
  /** Inference response limits can apply to one model rather than the account. */
  modelId?: string;
}
export interface XAccountQuota {
  accountId: number; provider: string; providerName: string; label: string;
  enabled: boolean; tier: QuotaTier; supported: boolean;
  windows: XQuotaWindow[]; observedAt: string | null; checkedAt: string | null;
  error: string | null; stale: boolean;
  local: { requests: number; tokens: number; requestCap: number; tokenCap: number; resetAt: string };
}
export interface XQuotaResponse { accounts: XAccountQuota[]; freshnessMs: number }
