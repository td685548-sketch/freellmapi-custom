import { apiFetch } from '@/lib/api';
import type { QuotaTier, XAccountQuota, XQuotaResponse } from '../../../../shared/x-quota';
export const quotaApi = {
  list: (signal?: AbortSignal) => apiFetch<XQuotaResponse>('/api/x-gateway/quota', { signal }),
  refresh: (id: number) => apiFetch<XAccountQuota>(`/api/x-gateway/quota/${id}/refresh`, { method: 'POST' }),
  tier: (id: number, tier: QuotaTier) => apiFetch<{ ok: true }>(`/api/x-gateway/quota/${id}/tier`, {
    method: 'PUT', body: JSON.stringify({ tier }),
  }),
};
