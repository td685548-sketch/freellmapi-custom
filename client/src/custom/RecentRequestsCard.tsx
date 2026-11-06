import { useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import type { RecentRequest, RecentRequestsPage, RequestAttempt } from '../../../shared/recent-requests'

const PAGE = 25
const tone: Record<string, string> = {
  success: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
  error: 'bg-destructive/10 text-destructive border-destructive/30',
  canceled: 'bg-muted text-muted-foreground border-transparent',
}

function Attempts({ url }: { url: string }) {
  const { data, isLoading, isError } = useQuery<{ attempts: RequestAttempt[] }>({ queryKey: [url], queryFn: () => apiFetch(url) })
  if (isLoading) return <p className="text-xs text-muted-foreground" role="status">Loading attempts…</p>
  if (isError || !Array.isArray(data?.attempts)) return <p className="text-xs text-destructive">Could not load the attempts.</p>
  if (data.attempts.length === 0) return <p className="text-xs text-muted-foreground">No attempt trace was kept for this row (each failed attempt is also listed as its own row).</p>
  return (
    <ol className="space-y-1 text-xs" aria-label="Attempts">
      {data.attempts.map(a => (
        <li key={a.ordinal} className="flex flex-wrap gap-x-2">
          <span className="text-muted-foreground">#{a.ordinal + 1}</span>
          <span className="font-medium">{a.modelId}</span>
          <span className="text-muted-foreground">{a.platform}{a.keyLabel ? ` · ${a.keyLabel}` : ''}</span>
          <span className={a.outcome === 'ok' ? 'text-emerald-600' : 'text-destructive'}>{a.outcome}</span>
          <span className="text-muted-foreground">{a.durationMs.toLocaleString()} ms</span>
          {a.error && <span className="w-full text-muted-foreground break-words">{a.error}</span>}
        </li>
      ))}
    </ol>
  )
}

function Row({ r, base }: { r: RecentRequest; base: string }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="py-2">
      <button type="button" onClick={() => setOpen(o => !o)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left text-xs" aria-expanded={open}>
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <span className="tabular-nums text-muted-foreground">{r.createdAt.slice(5, 16)} UTC</span>
        <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${tone[r.status] ?? tone.canceled}`}>{r.status}</span>
        <span className="font-medium" data-role="model">{r.modelId}</span>
        <span className="text-muted-foreground">{r.platform}</span>
        <span className="tabular-nums text-muted-foreground">{r.latencyMs.toLocaleString()} ms</span>
        {r.status === 'success' && <span className="tabular-nums text-muted-foreground">{r.inputTokens} in / {r.outputTokens} out</span>}
        {r.endUser && <span className="text-muted-foreground">user: {r.endUser}</span>}
        {r.error && <span className="w-full truncate pl-6 text-destructive" title={r.error}>{r.error}</span>}
      </button>
      {open && (
        <div className="mt-2 ml-6 space-y-2 rounded-lg bg-muted/40 p-2">
          {r.error && <p className="text-xs break-words"><strong>Error:</strong> {r.error}</p>}
          {r.requestedModel && <p className="text-xs text-muted-foreground">Asked for {r.requestedModel}{r.ttfbMs !== null ? ` · first token after ${r.ttfbMs} ms` : ''}</p>}
          <Attempts url={`${base}/${r.id}/attempts`} />
        </div>
      )}
    </li>
  )
}

/**
 * The newest requests of one account or client key, newest first: what was asked, what answered, how long
 * it took and, for a failure, why. Click a row for the failover chain behind it.
 */
export function RecentRequestsCard({ endpoint, title = 'Recent requests', query: extra = '' }: { endpoint: string; title?: string; query?: string }) {
  const [filter, setFilter] = useState<'all' | 'error'>('all')
  const query = useInfiniteQuery<RecentRequestsPage>({
    queryKey: [endpoint, filter, extra],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => apiFetch<RecentRequestsPage>(
      `${endpoint}?limit=${PAGE}${filter === 'error' ? '&status=error' : ''}${extra}${pageParam ? `&before=${pageParam}` : ''}`,
    ),
    getNextPageParam: (last) => (last && typeof last.nextBefore === 'number' ? last.nextBefore : undefined),
  })
  const rows = (query.data?.pages ?? []).flatMap(p => (Array.isArray(p?.requests) ? p.requests : []))

  return (
    <section className="rounded-2xl border bg-card p-4 space-y-3" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <SegmentedControl
          ariaLabel="Show"
          value={filter}
          onValueChange={setFilter}
          options={[{ value: 'all', label: 'All' }, { value: 'error', label: 'Errors only' }]}
        />
      </div>
      {query.isLoading ? (
        <p className="text-xs text-muted-foreground" role="status">Loading requests…</p>
      ) : query.isError ? (
        <div className="space-y-2" role="alert">
          <p className="text-xs text-destructive">Could not load the requests.</p>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => query.refetch()}>Retry</Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{filter === 'error' ? 'No failed requests.' : 'No requests yet.'}</p>
      ) : (
        <>
          <ul className="divide-y" aria-label="Requests">
            {rows.map(r => <Row key={r.id} r={r} base={endpoint} />)}
          </ul>
          {query.hasNextPage && (
            <Button variant="outline" size="sm" className="h-8 text-xs" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
              {query.isFetchingNextPage ? 'Loading…' : 'Load older'}
            </Button>
          )}
        </>
      )}
      <p className="text-[11px] text-muted-foreground">Each failed failover attempt is listed as its own row. Older rows disappear as the request log is trimmed.</p>
    </section>
  )
}
