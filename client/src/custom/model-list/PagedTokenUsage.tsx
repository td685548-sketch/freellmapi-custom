import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TokenUsageBar } from '@/components/token-usage-bar'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import type { TokenUsageData } from '@/lib/routing'
import { useModelListStrings } from './strings'

/** The initial view uses totals already calculated by the ranking cache. The
 * full per-model legend is returned only when the operator asks for it. */
export function PagedTokenUsage({ summary, profileId }: {
  summary: { totalBudget: number; totalUsed: number }; profileId: number | null
}) {
  const [expanded, setExpanded] = useState(false)
  const s = useModelListStrings()
  const details = useQuery({
    queryKey: ['fallback', 'token-usage', profileId],
    queryFn: ({ signal }) => apiFetch<TokenUsageData>(`/api/fallback/page/budget?profile=${profileId ?? 'global'}`, { signal }),
    enabled: expanded,
    staleTime: 30_000,
    retry: false,
  })
  const data = expanded && details.data ? details.data : {
    ...summary, models: [{ displayName: s.allModels, platform: 'all', budget: summary.totalBudget, used: summary.totalUsed }],
  }
  return <div className="space-y-2">
    <TokenUsageBar data={data} />
    <Button variant="ghost" size="sm" onClick={() => setExpanded(value => !value)} disabled={details.isFetching}>
      {details.isFetching ? s.loading : expanded ? s.hideBudget : s.budgetDetails}
    </Button>
    {expanded && details.isError && <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
      {s.failed}<Button variant="outline" size="sm" onClick={() => void details.refetch()}>{s.retry}</Button>
    </div>}
  </div>
}
