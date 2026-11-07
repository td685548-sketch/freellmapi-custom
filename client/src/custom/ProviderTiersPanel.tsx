import { useQuery } from '@tanstack/react-query'
import type { ProviderTierRange, ProviderTiersResponse } from '../../../shared/provider-tiers'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useUserSession } from './use-session'
import { useSessionRevision } from './session-state'
import { ProviderTierAddKey } from './ProviderTierAddKey'
import { useCustomT } from './i18n/use-custom-t'

const percent = (value: number | null) => value === null ? '—' : `${Math.round(value * 100)}%`

export function ProviderTiersPanel({ range }: { range: ProviderTierRange }) {
  const tc = useCustomT()
  const { hasPermission, session } = useUserSession()
  const revision = useSessionRevision()
  const allowed = hasPermission('view_analytics')
  const query = useQuery({
    queryKey: ['provider-tiers', revision, range],
    queryFn: ({ signal }) => apiFetch<ProviderTiersResponse>(`/api/analytics/provider-tiers?range=${range}`, { signal }),
    enabled: allowed,
    staleTime: 30_000,
    retry: false,
  })
  if (!allowed) return null

  return (
    <section aria-labelledby="provider-tiers-title" className="rounded-3xl border bg-card p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="provider-tiers-title" className="font-semibold">{tc('Provider tiers')}</h2>
          <p className="text-sm text-muted-foreground">{tc('Measured chat performance ·')}{' '}{range}{' '}{tc('· current linked provider keys')}</p>
        </div>
        <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {query.isFetching ? tc('Refreshing…') : tc('Refresh tiers')}
        </Button>
      </div>
      {query.isPending && <p role="status" className="text-sm text-muted-foreground">{tc('Loading provider tiers…')}</p>}
      {query.isError && <p role="alert" className="text-sm text-destructive">{tc('Could not load provider tiers. Use Refresh tiers to retry.')}</p>}
      {query.data && !query.isError && (query.data.rows.length === 0
        ? <p className="text-sm text-muted-foreground">{tc('No linked providers or retained chat observations yet.')}</p>
        : <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{tc('Provider tiers, linked keys and observed performance')}</caption>
              <thead className="border-b text-xs text-muted-foreground">
                <tr>{['Tier', 'Provider / linked keys', 'Usable keys', 'Samples / models', 'Reliability', 'Speed', 'Intelligence', 'Score'].map(label =>
                  <th key={label} scope="col" className="px-3 py-3 text-left font-medium whitespace-nowrap">{tc(label)}</th>)}
                </tr>
              </thead>
              <tbody>
                {query.data.rows.map(row => (
                  <tr key={row.providerId} className="border-b last:border-0">
                    <td className="px-3 py-3"><Badge variant={row.tier ? 'secondary' : 'outline'}>{row.tier ?? tc('Unranked')}</Badge></td>
                    <th scope="row" className="px-3 py-3 text-left font-medium">
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <span className="break-all">{row.name}</span>
                        <Badge variant="outline" title={tc('Stored upstream provider keys, including disabled or unhealthy keys')}>
                          {row.linkedKeyCount} {row.linkedKeyCount === 1 ? tc('key') : tc('keys')}
                        </Badge>
                        <ProviderTierAddKey key={`${revision}:${row.providerId}:${JSON.stringify(session?.permissions ?? [])}`} row={row} canManageKeys={hasPermission('add_keys')}
                          capabilities={{ view: hasPermission('view_keys'), edit: hasPermission('edit_keys'), import: hasPermission('import_keys'), models: hasPermission('manage_key_models') && hasPermission('test_keys') }} />
                      </span>
                    </th>
                    <td className="px-3 py-3 tabular-nums" title={tc('Enabled with last health healthy/unknown. Does not check quota or cooldown.')}>
                      {row.usableKeyCount} / {row.linkedKeyCount}
                    </td>
                    <td className="px-3 py-3 tabular-nums whitespace-nowrap">{row.samples} / {row.modelCount}</td>
                    <td className="px-3 py-3 tabular-nums">{percent(row.reliability)}</td>
                    <td className="px-3 py-3 tabular-nums">{percent(row.speed)}</td>
                    <td className="px-3 py-3 tabular-nums">{percent(row.intelligence)}</td>
                    <td className="px-3 py-3 tabular-nums font-semibold">{row.score === null ? '—' : row.score.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>)}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{tc('How tiers and key counts work')}</summary>
        <div className="mt-2 space-y-2 max-w-4xl">
          <p>{tc('At least 20 retained chat attempts are required for a tier. S ≥ 0.85; A ≥ 0.75; B ≥ 0.65; C ≥ 0.50; D below 0.50. These are dashboard defaults, not an independent certification.')}</p>
          <p>{tc('Score uses fixed balanced weights: reliability 50%, speed 25%, intelligence 25%. Missing axes show — and are omitted; remaining weights are normalized. Scores with missing axes are less comparable. Low-sample scores are provisional.')}</p>
          <p>{tc('Reliability estimates success from observed successes/failures. Speed uses successful token throughput and first-token timing, weighted by model attempts. Intelligence uses configured model tiers/ranks relative to measured models in this time window; it does not grade answers.')}</p>
          <p>{tc('Linked keys are current installation-wide upstream credentials, including disabled/unhealthy keys; personal member gateway tokens are excluded. Usable keys means enabled and last health healthy/unknown, and does not guarantee available quota or absence of cooldown. Key counts do not affect the score.')}</p>
          <p>{tc('Only retained chat history is included; pruned records, canceled calls and pre-dispatch rejections are excluded. Each custom endpoint is separate. Refresh after changing keys. This table makes no provider calls and does not change routing.')}</p>
        </div>
      </details>
    </section>
  )
}
