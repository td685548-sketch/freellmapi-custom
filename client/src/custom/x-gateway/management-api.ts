import { apiFetch } from '@/lib/api'

const base = '/api/x-gateway'

export type ComboStrategy = 'fallback' | 'round-robin' | 'smart' | 'fusion'
export interface ComboEntry { platform: string; modelId: string }
export interface XCombo {
  id: number
  name: string
  entries: ComboEntry[]
  strategy?: ComboStrategy
  description?: string
}
export interface ComboPayload {
  name: string
  entries: ComboEntry[]
  strategy?: ComboStrategy
  description?: string
}
export interface ComboPresetResult {
  created: XCombo[]
  skipped: Array<{ name: string; reason: 'exists' | 'no_models' | 'limit' }>
  createdCount: number
  skippedCount: number
}
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
  createCombo: (body: ComboPayload) =>
    apiFetch<XCombo>(`${base}/combos`, { method: 'POST', body: JSON.stringify(body) }),
  updateCombo: (id: number, body: ComboPayload) =>
    apiFetch<XCombo>(`${base}/combos/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteCombo: (id: number) => apiFetch<{ ok: true }>(`${base}/combos/${id}`, { method: 'DELETE' }),
  generatePresets: () =>
    apiFetch<ComboPresetResult>(`${base}/combos/presets`, { method: 'POST', body: JSON.stringify({}) }),
  logs: (status: string, signal?: AbortSignal) =>
    apiFetch<{ logs: XLog[] }>(`${base}/usage/logs?limit=100${status ? `&status=${status}` : ''}`, { signal }),
  hourly: (signal?: AbortSignal) =>
    apiFetch<{ buckets: XHourlyBucket[] }>(`${base}/usage/hourly?hours=24`, { signal })
}
