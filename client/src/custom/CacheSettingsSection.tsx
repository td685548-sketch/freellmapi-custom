import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { ConfirmButton } from '@/components/confirm-button'
import { useUserSession } from './use-session'
import { useSessionRevision } from './session-state'
import { useCustomT } from './i18n/use-custom-t'

interface Preferences {
  enabled: boolean
  persist: boolean
  ttlSeconds: number
  maxEntries: number
  semanticEnabled?: boolean
  semanticThreshold?: number
  semanticEntries?: number
  semanticHits?: number
  semanticMisses?: number
  semanticSavedTokens?: number
}

const THRESHOLD_PRESETS = [0.88, 0.9, 0.92, 0.94, 0.96, 0.98] as const

export function CacheSettingsSection() {
  const tc = useCustomT()
  const { hasPermission } = useUserSession()
  const revision = useSessionRevision()
  const client = useQueryClient()
  const canView = ['view_cache', 'edit_cache', 'clear_cache'].some(p => hasPermission(p as 'view_cache' | 'edit_cache' | 'clear_cache'))
  const key = ['cache-preferences', revision]
  const query = useQuery({ queryKey: key, queryFn: () => apiFetch<Preferences>('/api/cache/preferences'), enabled: canView, retry: false })
  const invalidate = () => { void client.invalidateQueries({ queryKey: ['cache'] }); void client.invalidateQueries({ queryKey: key }) }
  const update = useMutation({ mutationFn: (body: Partial<Pick<Preferences, 'enabled' | 'persist' | 'semanticEnabled' | 'semanticThreshold'>>) =>
    apiFetch<Preferences>('/api/cache/preferences', { method: 'PUT', body: JSON.stringify(body) }),
    onMutate: async body => {
      await client.cancelQueries({ queryKey: key, exact: true })
      const previous = client.getQueryData<Preferences>(key)
      client.setQueryData<Preferences>(key, current => current ? { ...current, ...body } : current)
      return previous
    },
    onSuccess: data => { client.setQueryData(key, data) },
    onError: (_error, _body, previous) => { if (previous) client.setQueryData(key, previous) },
    onSettled: invalidate,
  })
  const clear = useMutation({ mutationFn: () => apiFetch('/api/cache', { method: 'DELETE' }), onSuccess: invalidate })
  if (!canView) return null
  const busy = update.isPending || clear.isPending
  const activeThreshold = query.data?.semanticThreshold ?? 0.94
  const thresholdOptions = THRESHOLD_PRESETS.some(v => Math.abs(v - activeThreshold) < 0.0001)
    ? [...THRESHOLD_PRESETS]
    : [...THRESHOLD_PRESETS, activeThreshold].sort((a, b) => a - b)

  return (
    <section className="mt-6 space-y-4 border-t pt-5" aria-labelledby="response-cache-title">
      <h3 id="response-cache-title" className="text-sm font-semibold">{tc('AI response cache')}</h3>
      <p className="text-xs text-muted-foreground">{tc('Sets the default for all users. Exact matching requests can reuse a successful response without another provider call. Existing per-request X-FreeLLM-Cache overrides still apply.')}</p>
      {update.isPending && <p role="status" className="text-xs text-muted-foreground">{tc('Saving cache settings…')}</p>}
      {update.isSuccess && <p role="status" className="text-xs text-muted-foreground">{tc('Cache settings saved.')}</p>}
      {(update.isError || clear.isError) && <p role="alert" className="text-xs text-destructive">{(update.error ?? clear.error)?.message}</p>}
      {query.isPending && <p role="status" className="text-xs">{tc('Loading cache settings…')}</p>}
      {query.isError && <div role="alert" className="text-xs">{tc('Could not load cache settings.')}{' '}<Button size="xs" onClick={() => void query.refetch()}>{tc('Retry')}</Button></div>}
      {query.data && <>
        <label className="flex items-center justify-between gap-4 text-sm">{tc('Enable response cache')}<Switch aria-label="Enable response cache" checked={query.data.enabled} disabled={busy || !hasPermission('edit_cache')} onCheckedChange={enabled => update.mutate({ enabled })} />
        </label>
        <label className="flex items-center justify-between gap-4 text-sm">{tc('Persist responses in database')}<Switch aria-label="Persist responses in database" checked={query.data.persist} disabled={busy || !hasPermission('edit_cache')} onCheckedChange={persist => update.mutate({ persist })} />
        </label>
        <label className="flex items-center justify-between gap-4 text-sm">{tc('Enable semantic similarity cache')}<Switch aria-label="Enable semantic similarity cache" checked={Boolean(query.data.semanticEnabled)} disabled={busy || !hasPermission('edit_cache')} onCheckedChange={semanticEnabled => update.mutate({ semanticEnabled })} />
        </label>
        <div className="flex items-center justify-between gap-4 text-sm">
          <label htmlFor="semantic-cache-threshold">{tc('Semantic similarity threshold')}</label>
          <select
            id="semantic-cache-threshold"
            aria-label="Semantic similarity threshold"
            className="rounded border bg-background px-2 py-1 text-xs font-mono"
            value={String(activeThreshold)}
            disabled={busy || !hasPermission('edit_cache') || !query.data.semanticEnabled}
            onChange={e => update.mutate({ semanticThreshold: Number(e.target.value) })}
          >
            {thresholdOptions.map(val => (
              <option key={val} value={String(val)}>
                {val.toFixed(2)}
              </option>
            ))}
          </select>
        </div>
        <p className="text-xs text-muted-foreground">{tc('Matches paraphrased non-streaming prompts within the same profile, end-user, model, and system prompt when embeddings are configured.')}</p>
        {query.data.semanticEnabled && (
          <p className="text-xs font-mono text-muted-foreground">
            {tc('Semantic entries: {entries} · Hits: {hits} · Saved tokens: {tokens}', {
              entries: query.data.semanticEntries ?? 0,
              hits: query.data.semanticHits ?? 0,
              tokens: query.data.semanticSavedTokens ?? 0,
            })}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{query.data.persist
          ? tc('Persistence stores response content in the database without per-entry encryption. Turn this off for memory-only caching.')
          : tc('Memory-only mode: cached responses are lost on restart. Previously persisted entries remain until cleared or expired.')}</p>
        <p className="text-xs text-muted-foreground">{tc('TTL:')}{' '}{query.data.ttlSeconds}{' '}{tc('seconds · Capacity:')}{' '}{query.data.maxEntries}{' '}{tc('entries. Changes save immediately. Disabling caching does not delete stored entries.')}</p>
        {hasPermission('clear_cache') && <ConfirmButton size="sm" variant="outline" disabled={busy} onConfirm={() => clear.mutate()} confirmLabel={tc('Confirm clear cache')}>{tc('Clear cached responses')}</ConfirmButton>}
      </>}
    </section>
  )
}
