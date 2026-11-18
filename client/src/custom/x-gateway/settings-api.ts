import { apiFetch } from '@/lib/api'

export interface XRoutingDefaults {
  accountStrategy: 'fallback' | 'round-robin'
  accountStickyLimit: number
  comboRoundRobin: boolean
  comboStickyLimit: number
}

export type SsoAuthMode = 'local' | 'oidc' | 'saml' | 'both'

export interface XSsoConfig {
  authMode: SsoAuthMode
  oidcIssuerUrl: string
  oidcClientId: string
  oidcClientSecretConfigured: boolean
  oidcScopes: string
  oidcLoginLabel: string
  samlEntryPoint: string
  samlIssuer: string
  samlCert: string
  samlLoginLabel: string
  autoProvisionMembers: boolean
  publicBaseUrl: string
}

export interface XSsoUpdateInput {
  authMode?: SsoAuthMode
  oidcIssuerUrl?: string
  oidcClientId?: string
  oidcClientSecret?: string
  clearOidcClientSecret?: boolean
  oidcScopes?: string
  oidcLoginLabel?: string
  samlEntryPoint?: string
  samlIssuer?: string
  samlCert?: string
  samlLoginLabel?: string
  autoProvisionMembers?: boolean
  publicBaseUrl?: string
}

export const settingsApi = {
  routingDefaults: (signal?: AbortSignal) => apiFetch<XRoutingDefaults>('/api/thruline/routing-defaults', { signal }),
  saveRoutingDefaults: (body: Partial<XRoutingDefaults>) =>
    apiFetch<XRoutingDefaults>('/api/thruline/routing-defaults', { method: 'PUT', body: JSON.stringify(body) }),
  ssoConfig: (signal?: AbortSignal) => apiFetch<XSsoConfig>('/api/thruline/sso', { signal }),
  saveSsoConfig: (body: XSsoUpdateInput) =>
    apiFetch<XSsoConfig>('/api/thruline/sso', { method: 'PUT', body: JSON.stringify(body) }),
  changePassword: (currentPassword: string, newPassword: string) =>
    apiFetch<{ success: boolean }>('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
}
