import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { ConfirmButton } from '@/components/confirm-button'
import { useUserSession } from './use-session'
import { useSessionRevision } from './session-state'

interface Preferences { enabled: boolean; persist: boolean; ttlSeconds: number; maxEntries: number }
export function CacheSettingsSection() {
  const { hasPermission } = useUserSession()
  const revision = useSessionRevision()
  const client = useQueryClient()
  const canView = ['view_cache', 'edit_cache', 'clear_cache'].some(p => hasPermission(p as 'view_cache' | 'edit_cache' | 'clear_cache'))
  const key = ['cache-preferences', revision]
  const query = useQuery({ queryKey: key, queryFn: () => apiFetch<Preferences>('/api/cache/preferences'), enabled: canView, retry: false })
  const invalidate = () => { void client.invalidateQueries({ queryKey: ['cache'] }); void client.invalidateQueries({ queryKey: key }) }
  const update = useMutation({ mutationFn: (body: Partial<Pick<Preferences, 'enabled' | 'persist'>>) =>
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
  return (
    <section className="mt-6 space-y-4 border-t pt-5" aria-labelledby="response-cache-title">
      <h3 id="response-cache-title" className="text-sm font-semibold">AI response cache</h3>
      <p className="text-xs text-muted-foreground">Sets the default for all users. Exact matching requests can reuse a successful response without another provider call. Existing per-request X-FreeLLM-Cache overrides still apply.</p>
      {update.isPending && <p role="status" className="text-xs text-muted-foreground">Saving cache settings…</p>}
      {update.isSuccess && <p role="status" className="text-xs text-muted-foreground">Cache settings saved.</p>}
      {(update.isError || clear.isError) && <p role="alert" className="text-xs text-destructive">{(update.error ?? clear.error)?.message}</p>}
      {query.isPending && <p role="status" className="text-xs">Loading cache settings…</p>}
      {query.isError && <div role="alert" className="text-xs">Could not load cache settings. <Button size="xs" onClick={() => void query.refetch()}>Retry</Button></div>}
      {query.data && <>
        <label className="flex items-center justify-between gap-4 text-sm">Enable response cache
          <Switch aria-label="Enable response cache" checked={query.data.enabled} disabled={busy || !hasPermission('edit_cache')} onCheckedChange={enabled => update.mutate({ enabled })} />
        </label>
        <label className="flex items-center justify-between gap-4 text-sm">Persist responses in database
          <Switch aria-label="Persist responses in database" checked={query.data.persist} disabled={busy || !hasPermission('edit_cache')} onCheckedChange={persist => update.mutate({ persist })} />
        </label>
        <p className="text-xs text-muted-foreground">{query.data.persist
          ? 'Persistence stores response content in the database without per-entry encryption. Turn this off for memory-only caching.'
          : 'Memory-only mode: cached responses are lost on restart. Previously persisted entries remain until cleared or expired.'}</p>
        <p className="text-xs text-muted-foreground">TTL: {query.data.ttlSeconds} seconds · Capacity: {query.data.maxEntries} entries. Changes save immediately. Disabling caching does not delete stored entries.</p>
        {hasPermission('clear_cache') && <ConfirmButton size="sm" variant="outline" disabled={busy} onConfirm={() => clear.mutate()} confirmLabel="Confirm clear cache">Clear cached responses</ConfirmButton>}
      </>}
    </section>
  )
}
