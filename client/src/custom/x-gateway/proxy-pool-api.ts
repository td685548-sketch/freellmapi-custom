import { apiFetch } from '@/lib/api'

const base = '/api/thruline/proxy-pool'

export interface XProxyPoolEntry {
  id: number
  name: string
  proxyUrl: string
  enabled: boolean
  boundAccounts: number
  createdAt: string
  updatedAt: string
  webhookEnabled?: boolean
  webhookToken?: string | null
  lastWebhookAt?: number
  lastTestOk?: boolean | null
  lastTestLatency?: number | null
  lastTestMessage?: string | null
  lastTestAt?: string | null
}

export interface XProxyPoolTestResult {
  ok: boolean
  latencyMs: number
  status?: number
  message?: string
}

export interface XProxyPoolConfig {
  noProxy: string[]
  strictProxy: boolean
}

export interface XProxyPoolTestAllResult {
  ok: boolean
  total: number
  healthy: number
  unhealthy: number
  latencyMs: number
  results: Array<XProxyPoolTestResult & { id: number; name: string }>
}

export interface XProxyPoolBatchImportResult {
  ok: boolean
  imported: XProxyPoolEntry[]
  failed: Array<{ line: string; error: string }>
  total: number
  importedCount: number
  failedCount: number
}

export type XProxyPoolRelayProvider = 'cloudflare' | 'vercel' | 'deno' | 'netlify'

export interface XProxyPoolDeployParams {
  provider: XProxyPoolRelayProvider
  apiToken: string
  accountId?: string
  orgDomain?: string
  workerName: string
}

export interface XProxyPoolDeployResult {
  ok: boolean
  provider: XProxyPoolRelayProvider
  orgDomain?: string
  workerName: string
  url: string
  entry: XProxyPoolEntry
}

export const proxyPoolApi = {
  list: (signal?: AbortSignal) => apiFetch<{ entries: XProxyPoolEntry[] }>(base, { signal }),
  create: (body: { name: string; proxyUrl: string }) =>
    apiFetch<{ entry: XProxyPoolEntry }>(base, { method: 'POST', body: JSON.stringify(body) }),
  update: (
    id: number,
    body: {
      name?: string
      proxyUrl?: string
      enabled?: boolean
      webhookEnabled?: boolean
      webhookToken?: string | null
    },
  ) => apiFetch<{ entry: XProxyPoolEntry }>(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  regenerateWebhookToken: (id: number) =>
    apiFetch<{ entry: XProxyPoolEntry }>(`${base}/${id}/regenerate-webhook-token`, {
      method: 'POST',
      body: '{}',
    }),
  remove: (id: number) => apiFetch<{ ok: true }>(`${base}/${id}`, { method: 'DELETE' }),
  test: (id: number) => apiFetch<XProxyPoolTestResult>(`${base}/${id}/test`, { method: 'POST', body: '{}' }),
  testAll: () => apiFetch<XProxyPoolTestAllResult>(`${base}/test-all`, { method: 'POST', body: '{}' }),
  batchImport: (body: { proxies: string }) =>
    apiFetch<XProxyPoolBatchImportResult>(`${base}/batch-import`, { method: 'POST', body: JSON.stringify(body) }),
  bulkAction: (body: { action: 'enable' | 'disable' | 'delete'; ids: number[] }) =>
    apiFetch<{ ok: true; action: string; affected: number; ids: number[] }>(`${base}/bulk-action`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getConfig: (signal?: AbortSignal) => apiFetch<{ config: XProxyPoolConfig }>(`${base}/config`, { signal }),
  saveConfig: (body: { noProxy?: string[] | string; strictProxy?: boolean }) =>
    apiFetch<{ config: XProxyPoolConfig }>(`${base}/config`, { method: 'POST', body: JSON.stringify(body) }),
  deployWorker: (body: XProxyPoolDeployParams) =>
    apiFetch<XProxyPoolDeployResult>(`${base}/deploy-worker`, { method: 'POST', body: JSON.stringify(body) }),
  getRelayTemplate: (signal?: AbortSignal) =>
    apiFetch<Record<XProxyPoolRelayProvider, string>>(`${base}/relay-template`, { signal }),
}
