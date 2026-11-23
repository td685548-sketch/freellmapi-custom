import { useEffect, useRef, useState } from 'react'
import type { ExternalAuthResult } from '../../../shared/external-auth'
import { apiFetch } from '@/lib/api'
import { getSessionRevision } from './session-state'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { RegistrationKeyNotice } from './RegistrationKeyNotice'

export function ExternalAuthCallback({
  onComplete,
  endpoint = '/api/auth/google/complete',
}: {
  onComplete: () => void
  endpoint?: string
}) {
  const { t } = useI18n()
  const [initialRevision] = useState(getSessionRevision)
  const request = useRef<Promise<ExternalAuthResult> | null>(null)
  const [result, setResult] = useState<ExternalAuthResult | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    // Reuse the promise under React StrictMode: the handoff can only be redeemed once.
    request.current ??= apiFetch<ExternalAuthResult>(
      endpoint,
      { method: 'POST' },
    )
    request.current
      .then((value) => {
        if (!active || getSessionRevision() !== initialRevision) return
        if (value.apiKey) setResult(value)
        else {
          // The session arrives as the httpOnly cookie the server set when
          // redeeming the handoff; the token is never returned in JSON
          // (Phase 2 of the cookie move).
          onComplete()
        }
      })
      .catch((err) => {
        if (active) setError((err as Error).message)
      })
    return () => {
      active = false
    }
  }, [onComplete, initialRevision, endpoint])
  if (result?.apiKey)
    return (
      <RegistrationKeyNotice
        apiKey={result.apiKey}
        onContinue={() => {
          if (getSessionRevision() !== initialRevision) return
          onComplete()
        }}
      />
    )
  if (error)
    return (
      <div className="rounded-3xl border bg-card p-6 space-y-4">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <Button onClick={onComplete}>{t('auth.backToLogin')}</Button>
      </div>
    )
  return <p role="status">{t('auth.completingGoogle')}</p>
}
