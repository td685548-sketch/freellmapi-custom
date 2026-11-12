import { apiFetch } from '@/lib/api'

const base = '/api/x-accounts/subscriptions'
import type { SubscriptionAttempt } from '../../../../shared/x-subscriptions'
export type { SubscriptionAttempt } from '../../../../shared/x-subscriptions'

export interface SubscriptionStartBody {
  provider: string
  label: string
  reconnectId?: number
  proxyUrl?: string
  proxyPoolId?: number | null
}

export interface SubscriptionImportBody extends SubscriptionStartBody {
  credential: string
}

export const subscriptionApi = {
  start: (body: SubscriptionStartBody) => apiFetch<SubscriptionAttempt>(`${base}/start`, { method: 'POST', body: JSON.stringify(body) }),
  complete: (id: string, code: string) => apiFetch<{ id: number }>(`${base}/${encodeURIComponent(id)}/complete`, { method: 'POST', body: JSON.stringify({ code }) }),
  poll: (id: string) => apiFetch<{ status: 'pending' | 'saved'; interval?: number }>(`${base}/${encodeURIComponent(id)}/poll`, { method: 'POST', body: '{}' }),
  cancel: (id: string) => apiFetch<void>(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  import: (body: SubscriptionImportBody) => apiFetch<{ id: number }>(`${base}/import`, { method: 'POST', body: JSON.stringify(body) }),
}
