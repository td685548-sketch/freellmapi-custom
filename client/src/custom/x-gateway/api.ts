import { useQuery, type QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { useSessionRevision } from '../session-state'
import type {
  ProviderAccountAuthMethod,
  ProviderAccountsResponse,
  ProviderAccountAuthStartResponse,
  ProviderAccountAuthResult,
  ProviderAccountPollResponse,
  ProviderAccountTestResponse,
} from '../../../../shared/x-accounts'

const base = '/api/thruline-accounts'
export function useAccounts(enabled = true) {
  const revision = useSessionRevision()
  return useQuery({
    queryKey: ['x-accounts', revision],
    queryFn: ({ signal }) => apiFetch<ProviderAccountsResponse>(base, { signal }),
    enabled, staleTime: 15_000, retry: false,
  })
}

export async function refreshAccounts(client: QueryClient) {
  await client.invalidateQueries({ queryKey: ['x-accounts'] })
}

export interface BatchTestResponse {
  results: Array<{ id: number; label: string; provider: string; ok: boolean; message?: string }>
  summary: { total: number; passed: number; failed: number }
}

export interface ProviderModelsConfigResponse {
  providerId: string
  catalogModels: Array<{ id: string; name: string }>
  disabledModels: string[]
  customModels: Array<{ id: string; name: string }>
  modelAliases: Record<string, string>
}

export interface CustomProviderNode {
  id: string
  name: string
  prefix: string
  type: 'openai-compatible' | 'anthropic-compatible' | 'custom-embedding'
  apiType?: 'chat' | 'responses'
  baseUrl: string
  models?: string[]
}

export interface ValidateNodeResponse {
  ok: boolean
  valid: boolean
  latencyMs: number
  models: string[]
  message?: string
  error?: string
}

export interface ModelPingResponse {
  ok: boolean
  latencyMs: number
  model: string
  message: string
}

export const accountsApi = {
  start: (provider: string, body: { label: string; callbackUrl: string; reconnectId?: number }) =>
    apiFetch<ProviderAccountAuthStartResponse>(`${base}/auth/${encodeURIComponent(provider)}/start`, { method: 'POST', body: JSON.stringify(body) }),
  complete: (attemptId: string, code: string) =>
    apiFetch<ProviderAccountAuthResult>(`${base}/auth/${encodeURIComponent(attemptId)}/complete`, { method: 'POST', body: JSON.stringify({ code }) }),
  poll: (attemptId: string) => apiFetch<ProviderAccountPollResponse>(`${base}/auth/${encodeURIComponent(attemptId)}/poll`, { method: 'POST' }),
  cancel: (attemptId: string) => apiFetch<void>(`${base}/auth/${encodeURIComponent(attemptId)}`, { method: 'DELETE' }),
  edit: (id: number, body: { label?: string; enabled?: boolean; proxyUrl?: string; proxyPoolId?: number | null }) =>
    apiFetch<void>(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id: number) => apiFetch<void>(`${base}/${id}`, { method: 'DELETE' }),
  test: (id: number) => apiFetch<ProviderAccountTestResponse>(`${base}/${id}/test`, { method: 'POST', body: '{}' }),
  testBatch: (body: { providerId?: string; accountIds?: number[] }) =>
    apiFetch<BatchTestResponse>(`${base}/test-batch`, { method: 'POST', body: JSON.stringify(body) }),
  toggleProvider: (providerId: string, enabled: boolean) =>
    apiFetch<{ ok: boolean; providerId: string; enabled: boolean; updated: number }>(
      `${base}/providers/${encodeURIComponent(providerId)}/toggle`,
      { method: 'POST', body: JSON.stringify({ enabled }) },
    ),
  getProviderModels: (providerId: string, signal?: AbortSignal) =>
    apiFetch<ProviderModelsConfigResponse>(`${base}/providers/${encodeURIComponent(providerId)}/models`, { signal }),
  updateProviderModels: (
    providerId: string,
    body: {
      disabledModels?: string[]
      customModels?: Array<{ id: string; name?: string }>
      modelAliases?: Record<string, string>
    },
  ) =>
    apiFetch<ProviderModelsConfigResponse>(`${base}/providers/${encodeURIComponent(providerId)}/models`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  addKey: (provider: string, key: string, label: string, baseUrl?: string, proxyUrl?: string, authMethod?: ProviderAccountAuthMethod, proxyPoolId?: number | null) =>
    apiFetch<{ id: number }>(base, {
      method: 'POST',
      body: JSON.stringify({
        provider,
        key,
        label,
        ...(baseUrl ? { baseUrl } : {}),
        ...(proxyUrl ? { proxyUrl } : {}),
        ...(authMethod ? { authMethod } : {}),
        ...(proxyPoolId !== undefined ? { proxyPoolId } : {}),
      }),
    }),
  addBulkKeys: (body: {
    provider: string
    entries: Array<{ key: string; label?: string }>
    baseUrl?: string
    proxyUrl?: string
    authMethod?: ProviderAccountAuthMethod
    proxyPoolId?: number | null
  }) =>
    apiFetch<{ ids: number[]; count: number }>(`${base}/bulk`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getCustomNodes: (signal?: AbortSignal) =>
    apiFetch<{ ok: boolean; nodes: CustomProviderNode[] }>(`${base}/nodes`, { signal }),
  saveCustomNode: (node: CustomProviderNode) =>
    apiFetch<{ ok: boolean; node: CustomProviderNode }>(`${base}/nodes`, {
      method: 'POST',
      body: JSON.stringify(node),
    }),
  deleteCustomNode: (nodeId: string) =>
    apiFetch<{ ok: boolean; nodeId: string }>(`${base}/nodes/${encodeURIComponent(nodeId)}`, {
      method: 'DELETE',
    }),
  validateCustomNode: (body: { baseUrl: string; apiKey?: string; type?: string; modelId?: string }) =>
    apiFetch<ValidateNodeResponse>(`${base}/nodes/validate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  pingModel: (providerId: string, model: string) =>
    apiFetch<ModelPingResponse>(`${base}/providers/${encodeURIComponent(providerId)}/models/ping`, {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),
}

export function callbackAddress() {
  return new URL(`${import.meta.env.BASE_URL}thruline/accounts/callback`, window.location.origin).href
}

export function trustedLoginUrl(value: string, provider: string) {
  try {
    const url = new URL(value)
    const host = provider === 'openrouter' ? 'openrouter.ai' : provider === 'github-copilot' ? 'github.com' : ''
    return url.protocol === 'https:' && url.hostname === host && !url.username && !url.password && !url.port ? url.href : null
  } catch { return null }
}
