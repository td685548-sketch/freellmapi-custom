import { apiFetch } from '@/lib/api';
import type { QuotaTier, XAccountQuota, XQuotaResponse } from '../../../../shared/x-quota';
export const quotaApi = {
  list: (signal?: AbortSignal) => apiFetch<XQuotaResponse>('/api/thruline/quota', { signal }),
  refreshAll: (force = false) => apiFetch<XQuotaResponse>(`/api/thruline/quota/refresh${force ? '?force=1' : ''}`, { method: 'POST' }),
  refresh: (id: number) => apiFetch<XAccountQuota>(`/api/thruline/quota/${id}/refresh`, { method: 'POST' }),
  tier: (id: number, tier: QuotaTier) => apiFetch<{ ok: true }>(`/api/thruline/quota/${id}/tier`, {
    method: 'PUT', body: JSON.stringify({ tier }),
  }),
};
