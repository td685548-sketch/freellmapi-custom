import { apiFetch } from '@/lib/api'

export interface XRoutingDefaults {
  accountStrategy: 'fallback' | 'round-robin'
  accountStickyLimit: number
  comboRoundRobin: boolean
  comboStickyLimit: number
}

export const settingsApi = {
  routingDefaults: (signal?: AbortSignal) => apiFetch<XRoutingDefaults>('/api/thruline/routing-defaults', { signal }),
  saveRoutingDefaults: (body: Partial<XRoutingDefaults>) =>
    apiFetch<XRoutingDefaults>('/api/thruline/routing-defaults', { method: 'PUT', body: JSON.stringify(body) }),
  changePassword: (currentPassword: string, newPassword: string) =>
    apiFetch<{ success: boolean }>('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
}
