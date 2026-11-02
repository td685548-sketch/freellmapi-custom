import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiKey, Platform } from '../../../shared/types'
import type { ProviderTierRow } from '../../../shared/provider-tiers'
import { AddKeyDialog } from '@/components/keys/add-key-dialog'
import { AddEndpointKeyDialog } from '@/components/keys/add-endpoint-key-dialog'
import { LISTED_PLATFORMS } from '@/components/keys/shared'
import { Button } from '@/components/ui/button'
import { SEARCH_PROVIDERS } from '@/lib/search'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'

type Target = { platform: Platform } | { baseUrl: string }
type Row = Pick<ProviderTierRow, 'providerId' | 'platform' | 'name' | 'linkedKeyCount'>

export function ProviderTierAddKey({ row, canManageKeys }: { row: Row; canManageKeys: boolean }) {
  const { t } = useI18n()
  const client = useQueryClient()
  const [target, setTarget] = useState<Target | null>(null)
  const [open, setOpen] = useState(false)
  const [opening, setOpening] = useState(false)
  const [cycle, setCycle] = useState(0)
  const [error, setError] = useState('')
  if (!canManageKeys) return null

  const supported = row.platform === 'custom' ? row.linkedKeyCount > 0
    : [...LISTED_PLATFORMS, ...SEARCH_PROVIDERS].some(p => p.value === row.platform)
  async function show() {
    if (!supported || opening) return
    setError('')
    setOpening(true)
    try {
      let next: Target
      if (row.platform === 'custom') {
        // The tier DTO deliberately omits endpoint URLs. Resolve only on an
        // authorized click using the original, permission-gated key roster.
        const keys = await apiFetch<ApiKey[]>('/api/keys')
        const scopes = new Set(keys.filter(k => k.platform === 'custom' && k.baseUrl)
          .map(k => k.baseUrl!.trim().replace(/\/+$/, '')))
        let baseUrl: string | undefined
        for (const scope of scopes) {
          // Mirrors server provider-tiers identity; a hostname/name is not unique.
          const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope))
          const hex = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
          if (`custom:${hex.slice(0, 20)}` === row.providerId) { baseUrl = scope; break }
        }
        if (!baseUrl) throw new Error('Endpoint no longer linked')
        next = { baseUrl }
      } else {
        next = { platform: row.platform as Platform }
      }
      setTarget(next)
      setCycle(n => n + 1)
      setOpen(true)
    } catch {
      setError('Could not resolve this endpoint. Refresh tiers and try again, or manage it in Keys.')
    } finally { setOpening(false) }
  }
  function changeOpen(value: boolean) {
    setOpen(value)
    if (!value) void client.invalidateQueries({ queryKey: ['provider-tiers'] })
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <Button size="sm" variant="outline" disabled={!supported || opening}
        aria-label={`${t('keys.addKey')} for ${row.name}`}
        title={supported ? undefined : 'This provider is no longer offered, or its endpoint has no linked key. Manage it in Keys.'}
        onClick={() => void show()}>
        {opening ? t('auth.loading') : t('keys.addKey')}
      </Button>
      {error && <span role="alert" className="max-w-64 text-xs font-normal text-destructive">{error}</span>}
      {/* Keep the provider dialog mounted after close: it owns the optional
          model-scope follow-up. A fresh open gets a fresh form/credential. */}
      {target && 'platform' in target && <AddKeyDialog key={cycle} open={open} onOpenChange={changeOpen} initialPlatform={target.platform} />}
      {target && 'baseUrl' in target && open && <AddEndpointKeyDialog key={cycle} open={open} onOpenChange={changeOpen} baseUrl={target.baseUrl} />}
    </span>
  )
}
