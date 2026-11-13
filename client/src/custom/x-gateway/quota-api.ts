import { apiFetch } from '@/lib/api';
import type { QuotaTier, XAccountQuota, XQuotaResponse } from '../../../../shared/x-quota';

export interface CodexResetCreditItem {
  status: string;
  grantedAt: string | null;
  expiresAt: string | null;
}

export interface CodexResetCreditsResponse {
  availableCount: number;
  credits: CodexResetCreditItem[];
}

export interface CodexResetConsumeResponse {
  ok: boolean;
  code: string | null;
  reset: boolean;
  windows_reset: number;
  redeemRequestId?: string;
  quota?: XAccountQuota | null;
}

export const quotaApi = {
  list: (signal?: AbortSignal) => apiFetch<XQuotaResponse>('/api/thruline/quota', { signal }),
  refreshAll: (force = false) => apiFetch<XQuotaResponse>(`/api/thruline/quota/refresh${force ? '?force=1' : ''}`, { method: 'POST' }),
  refresh: (id: number) => apiFetch<XAccountQuota>(`/api/thruline/quota/${id}/refresh`, { method: 'POST' }),
  tier: (id: number, tier: QuotaTier) => apiFetch<{ ok: true }>(`/api/thruline/quota/${id}/tier`, {
    method: 'PUT', body: JSON.stringify({ tier }),
  }),
  codexResetCredits: (id: number) =>
    apiFetch<CodexResetCreditsResponse>(`/api/thruline/quota/${id}/codex-reset-credits`),
  useCodexResetCredit: (id: number) =>
    apiFetch<CodexResetConsumeResponse>(`/api/thruline/quota/${id}/codex-reset-credits`, { method: 'POST' }),
};
