import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

interface SsoMethodsResponse {
  authMode: 'local' | 'oidc' | 'saml' | 'both'
  oidcEnabled: boolean
  oidcLabel: string
  samlEnabled: boolean
  samlLabel: string
}

export function SsoSignIn({
  inviteCode,
  requiresInvite = false,
}: {
  inviteCode?: string
  requiresInvite?: boolean
}) {
  const { locale } = useI18n()
  const { data } = useQuery<SsoMethodsResponse>({
    queryKey: ['sso-auth-methods'],
    queryFn: () => apiFetch('/api/auth/sso/methods'),
    staleTime: 60_000,
    retry: false,
  })
  const [busy, setBusy] = useState<'oidc' | 'saml' | null>(null)
  const [error, setError] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get('auth_error')
    if (raw === 'sso_failed') {
      return locale === 'vi'
        ? 'Đăng nhập SSO thất bại. Vui lòng thử lại hoặc liên hệ quản trị viên.'
        : 'Single sign-on failed. Please try again or contact your administrator.'
    }
    return ''
  })

  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.get('auth_error') === 'sso_failed') {
      url.searchParams.delete('auth_error')
      window.history.replaceState(
        window.history.state,
        '',
        url.pathname + url.search + url.hash,
      )
    }
  }, [])

  if (!data?.oidcEnabled && !data?.samlEnabled && !error) {
    return null
  }

  async function start(kind: 'oidc' | 'saml') {
    setBusy(kind)
    setError('')
    try {
      const { url } = await apiFetch<{ url: string }>(
        `/api/auth/sso/${kind}/start`,
        {
          method: 'POST',
          body: JSON.stringify({ inviteCode: inviteCode?.trim() || undefined }),
        },
      )
      const destination = new URL(url)
      if (!['https:', 'http:'].includes(destination.protocol)) {
        throw new Error('Blocked unsafe SSO redirect URL')
      }
      window.location.assign(destination.href)
    } catch (err) {
      setError((err as Error).message)
      setBusy(null)
    }
  }

  return (
    <div className="mt-3 space-y-2">
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {data?.oidcEnabled && (
        <Button
          type="button"
          variant="outline"
          className="w-full h-10"
          disabled={busy !== null || (requiresInvite && !inviteCode?.trim())}
          onClick={() => void start('oidc')}
        >
          {busy === 'oidc' ? '...' : data.oidcLabel || 'Sign in with OIDC'}
        </Button>
      )}
      {data?.samlEnabled && (
        <Button
          type="button"
          variant="outline"
          className="w-full h-10"
          disabled={busy !== null || (requiresInvite && !inviteCode?.trim())}
          onClick={() => void start('saml')}
        >
          {busy === 'saml' ? '...' : data.samlLabel || 'Sign in with SAML SSO'}
        </Button>
      )}
    </div>
  )
}
