import { apiFetch } from '@/lib/api'

const base = '/api/x-gateway'

export interface ComboEntry { platform: string; modelId: string }
export interface XCombo { id: number; name: string; entries: ComboEntry[] }
export interface XLog {
  id: number; platform: string; modelId: string; status: string
  inputTokens: number; outputTokens: number; latencyMs: number | null
  error: string | null; requestedModel: string | null; createdAt: string
}
export interface XHourlyBucket {
  hour: string; requests: number; success: number; errors: number
  inputTokens: number; outputTokens: number
}

export const mgmtApi = {
  combos: (signal?: AbortSignal) => apiFetch<{ combos: XCombo[] }>(`${base}/combos`, { signal }),
  createCombo: (body: { name: string; entries: ComboEntry[] }) =>
    apiFetch<XCombo>(`${base}/combos`, { method: 'POST', body: JSON.stringify(body) }),
  updateCombo: (id: number, body: { name: string; entries: ComboEntry[] }) =>
    apiFetch<XCombo>(`${base}/combos/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteCombo: (id: number) => apiFetch<{ ok: true }>(`${base}/combos/${id}`, { method: 'DELETE' }),
  logs: (status: string, signal?: AbortSignal) =>
    apiFetch<{ logs: XLog[] }>(`${base}/usage/logs?limit=100${status ? `&status=${status}` : ''}`, { signal }),
  hourly: (signal?: AbortSignal) =>
    apiFetch<{ buckets: XHourlyBucket[] }>(`${base}/usage/hourly?hours=24`, { signal })
}

