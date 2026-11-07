import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { nextModelSort, sortModelGroups, type ModelSortCol } from '@/lib/model-table-sort'
import type { SortState } from '@/lib/table-sort'
import { buildGroups, groupMatchesQuery, isGroupDepleted, type FallbackEntry, type RateLimitUsageData, type RoutingData, type Row, type TokenUsageData } from '@/lib/routing'
import { GroupHeaderCells, ModelTableHead } from '@/components/model-table'
import { TokenUsageBar } from '@/components/token-usage-bar'
import { PageHeader } from '@/components/page-header'
import { TableSkeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { askToSignIn } from './guest-prompt'

// The Models page as a signed-out visitor sees it: the monthly token budget and the ranked chain, built
// with the same helpers as the admin page, with every switch and link turned into "sign in to use this".
// Figures refresh every minute (the server shares one 30-second copy between all visitors).

const REFRESH_MS = 60_000
const CHUNK = 100

export function GuestModelsPage() {
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortState<ModelSortCol>>(null)
  const [limit, setLimit] = useState(CHUNK)

  const { data: active, isPending: activePending } = useQuery<{ activeProfileId: number | null }>({ queryKey: ['guest', 'profiles-active'], queryFn: () => apiFetch('/api/profiles/active') })
  const activeProfileId = active?.activeProfileId ?? null
  const { data: entries = [], isLoading: entriesLoading } = useQuery<FallbackEntry[]>({
    queryKey: ['guest', 'fallback', activeProfileId],
    queryFn: () => apiFetch(activeProfileId != null ? `/api/fallback?profile=${activeProfileId}` : '/api/fallback'),
    enabled: !activePending,
    refetchInterval: REFRESH_MS,
  })
  const { data: tokenUsage } = useQuery<TokenUsageData>({ queryKey: ['guest', 'token-usage'], queryFn: () => apiFetch('/api/fallback/token-usage'), refetchInterval: REFRESH_MS })
  const { data: routing } = useQuery<RoutingData>({ queryKey: ['guest', 'routing'], queryFn: () => apiFetch('/api/fallback/routing'), refetchInterval: REFRESH_MS })
  const { data: rateLimitUsage } = useQuery<RateLimitUsageData>({ queryKey: ['guest', 'rate-limit-usage'], queryFn: () => apiFetch('/api/fallback/rate-limit-usage'), refetchInterval: REFRESH_MS })

  const rateUsageByModel = useMemo(() => new Map((rateLimitUsage?.rows ?? []).map(r => [r.modelDbId, r])), [rateLimitUsage])
  const scoreById = useMemo(() => new Map((routing?.scores ?? []).map(s => [s.modelDbId, s])), [routing?.scores])
  const rows: Row[] = useMemo(
    () => entries.filter(e => e.keyCount > 0).map(e => ({ ...(scoreById.get(e.modelDbId) ?? {}), ...e })),
    [entries, scoreById],
  )
  const isManual = routing?.strategy === 'priority'
  const ordered = useMemo(() => buildGroups(rows, isManual, rateUsageByModel), [rows, isManual, rateUsageByModel])
  const rankByKey = useMemo(() => new Map(ordered.map((g, i) => [g.key, i + 1])), [ordered])
  const query = search.trim().toLowerCase()
  const visible = useMemo(() => (query ? ordered.filter(g => groupMatchesQuery(g, query)) : ordered), [ordered, query])
  const sorted = useMemo(() => (sort ? sortModelGroups(visible, sort, rankByKey) : visible), [visible, sort, rankByKey])
  const shown = sorted.slice(0, limit)

  return (
    <div className="space-y-6">
      <PageHeader title={t('nav.models')} description="The models this gateway routes chat requests to, ranked, and how much of their monthly token budget is left. Sign in to use them." />
      {tokenUsage && tokenUsage.totalBudget > 0 && <TokenUsageBar data={tokenUsage} />}

      <div className="relative w-full max-w-sm">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input value={search} onChange={(e) => { setSearch(e.target.value); setLimit(CHUNK) }} placeholder={t('models.searchPlaceholder')} aria-label="Search models" className="h-8 pl-8 text-xs" />
      </div>

      {activePending || entriesLoading ? <TableSkeleton rows={8} /> : (
        <>
          <p className="text-xs text-muted-foreground" data-testid="guest-models-count">
            {visible.length} of {ordered.length} models
          </p>
          <div className="rounded-2xl border overflow-x-auto">
            {/* The last column holds the on/off switches: a guest cannot use them, so it is not shown. */}
            <table className="w-full text-sm [&_th:last-child]:hidden [&_td:last-child]:hidden" data-testid="guest-models-table">
              <ModelTableHead sort={sort} onToggle={(col) => setSort(prev => nextModelSort(prev, col))} />
              <tbody
                // Links and switches in the shared row cells lead to admin pages: for a visitor they ask to sign in instead.
                onClickCapture={(e) => {
                  const target = e.target as HTMLElement
                  if (target.closest('a, button, [role="switch"]')) { e.preventDefault(); e.stopPropagation(); askToSignIn() }
                }}
              >
                {shown.map(g => (
                  <tr key={g.key} className={`border-b last:border-0 ${g.members.some(m => m.enabled) ? (isGroupDepleted(g.members, rateUsageByModel) ? 'opacity-60' : '') : 'opacity-50'}`}>
                    <GroupHeaderCells group={g} rank={rankByKey.get(g.key) ?? 0} onToggleGroup={() => askToSignIn()} allRows={rows} rateUsage={rateUsageByModel} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sorted.length > limit && (
            <Button variant="outline" size="sm" onClick={() => setLimit(l => l + CHUNK)}>Show more ({sorted.length - limit} left)</Button>
          )}
        </>
      )}
    </div>
  )
}

export default GuestModelsPage
