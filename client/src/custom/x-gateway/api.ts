import { useQuery, type QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { useSessionRevision } from '../session-state'
import type {
  ProviderAccountsResponse,
  ProviderAccountAuthStartResponse,
  ProviderAccountAuthResult,
  ProviderAccountPollResponse,
  ProviderAccountTestResponse,
} from '../../../../shared/x-accounts'

const base = '/api/x-accounts'
export function useAccounts(enabled = true) {
  const revision = useSessionRevision()
  return useQuery({
    queryKey: ['x-accounts', revision],
    queryFn: ({ signal }) => apiFetch<ProviderAccountsResponse>(base, { signal }),
    enabled, staleTime: 15_000, retry: false,
  })
}

export async function refreshAccounts(client: QueryClient) {
  await Promise.all(['x-accounts', 'keys', 'keys-providers', 'health'].map(key => client.invalidateQueries({ queryKey: [key] })))
}

export const accountsApi = {
  start: (provider: string, body: { label: string; callbackUrl: string; reconnectId?: number }) =>
    apiFetch<ProviderAccountAuthStartResponse>(`${base}/auth/${encodeURIComponent(provider)}/start`, { method: 'POST', body: JSON.stringify(body) }),
  complete: (attemptId: string, code: string) =>
    apiFetch<ProviderAccountAuthResult>(`${base}/auth/${encodeURIComponent(attemptId)}/complete`, { method: 'POST', body: JSON.stringify({ code }) }),
  poll: (attemptId: string) => apiFetch<ProviderAccountPollResponse>(`${base}/auth/${encodeURIComponent(attemptId)}/poll`, { method: 'POST' }),
  cancel: (attemptId: string) => apiFetch<void>(`${base}/auth/${encodeURIComponent(attemptId)}`, { method: 'DELETE' }),
  edit: (id: number, body: { label?: string; enabled?: boolean }) =>
    apiFetch<void>(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id: number) => apiFetch<void>(`${base}/${id}`, { method: 'DELETE' }),
  test: (id: number) => apiFetch<ProviderAccountTestResponse>(`${base}/${id}/test`, { method: 'POST', body: '{}' }),
  addKey: (platform: string, key: string, label: string) => apiFetch('/api/keys', { method: 'POST', body: JSON.stringify({ platform, key, label }) }),
}

export function callbackAddress() {
  return new URL(`${import.meta.env.BASE_URL}x/accounts/callback`, window.location.origin).href
}

export function trustedLoginUrl(value: string, provider: string) {
  try {
    const url = new URL(value)
    const host = provider === 'openrouter' ? 'openrouter.ai' : provider === 'github-copilot' ? 'github.com' : ''
    return url.protocol === 'https:' && url.hostname === host && !url.username && !url.password && !url.port ? url.href : null
  } catch { return null }
}
