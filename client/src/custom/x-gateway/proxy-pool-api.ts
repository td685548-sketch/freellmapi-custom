import { apiFetch } from '@/lib/api'

const base = '/api/x-gateway/proxy-pool'

export interface XProxyPoolEntry {
  id: number
  name: string
  proxyUrl: string
  enabled: boolean
  boundAccounts: number
  createdAt: string
  updatedAt: string
}

export interface XProxyPoolTestResult {
  ok: boolean
  latencyMs: number
  status?: number
  message?: string
}

export const proxyPoolApi = {
  list: (signal?: AbortSignal) => apiFetch<{ entries: XProxyPoolEntry[] }>(base, { signal }),
  create: (body: { name: string; proxyUrl: string }) =>
    apiFetch<{ entry: XProxyPoolEntry }>(base, { method: 'POST', body: JSON.stringify(body) }),
  update: (id: number, body: { name?: string; proxyUrl?: string; enabled?: boolean }) =>
    apiFetch<{ entry: XProxyPoolEntry }>(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id: number) => apiFetch<{ ok: true }>(`${base}/${id}`, { method: 'DELETE' }),
  test: (id: number) => apiFetch<XProxyPoolTestResult>(`${base}/${id}/test`, { method: 'POST', body: '{}' }),
}