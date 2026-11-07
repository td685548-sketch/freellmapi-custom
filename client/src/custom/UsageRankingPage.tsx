import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownRight, ArrowUpRight, RefreshCw, RotateCcw, Search } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { SortableHeader } from '@/components/sortable-header'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableFooter, TableHeader, TableRow, TableHead } from '@/components/ui/table'
import { loadStoredSort, nextSort, persistSort, type SortState } from '@/lib/table-sort'
import type { UsageOverview, UsageRow } from '../../../shared/usage-overview'
import { useAdministrativeAccess } from './use-administrative-access'
import { UsageAlertsCard } from './UsageAlertsCard'
import { UsageExportCard } from './UsageExportCard'
import {
  DEFAULT_FILTERS, DEFAULT_SORT, RANKING_COLUMNS, applyFilters, changeOf, loadFilters, rankRows, saveFilters, successRate, tokensOf, totalsOf,
  type KindFilter, type RankingColumn, type RankingFilters,
} from './usage-ranking'

const SORT_KEY = 'usage-ranking.sort'
const FILTER_KEY = 'usage-ranking.filters'
const RANGES = [{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }] as const

const fmt = (n: number) => n.toLocaleString()
const ms = (n: number | null) => (n === null ? '—' : `${fmt(n)} ms`)

function Toggle({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label htmlFor={id} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-3.5 accent-current" />
      {label}
    </label>
  )
}

function useOverview(kind: 'accounts' | 'profiles', days: string, enabled: boolean, fresh: number) {
  return useQuery<{ overview: UsageOverview }>({
    queryKey: ['usage-overview', kind, days, fresh],
    // The server reuses its figures for 30 s; "Refresh" asks it to recompute.
    queryFn: () => apiFetch<{ overview: UsageOverview }>(`/api/usage/${kind}?days=${days}${fresh ? '&fresh=1' : ''}`),
    enabled,
    placeholderData: (previous) => previous,
  })
}

/** Change against the previous window of the same length, as a small arrow and percentage. */
function Change({ current, previous, invert = false }: { current: number; previous: number | undefined; invert?: boolean }) {
  const c = changeOf(current, previous)
  if (c === null) return null
  if (c === 'new') return <span className="ml-1 text-[10px] text-muted-foreground">new</span>
  if (Math.abs(c) < 0.005) return <span className="ml-1 text-[10px] text-muted-foreground">±0%</span>
  const up = c > 0
  const good = invert ? !up : up
  const Icon = up ? ArrowUpRight : ArrowDownRight
  return (
    <span className={`ml-1 inline-flex items-center text-[10px] ${good ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}
      title={`Previous period: ${previous!.toLocaleString()}`}>
      <Icon className="size-3" aria-hidden="true" />{Math.round(Math.abs(c) * 100)}%
    </span>
  )
}

function AllowanceCell({ allowance }: { allowance: UsageRow['allowance'] | undefined }) {
  if (!allowance) return <span className="text-muted-foreground">—</span>
  const pct = Math.round(allowance.used * 100)
  const tone = allowance.used >= 1 ? 'bg-destructive' : allowance.used >= 0.8 ? 'bg-amber-500' : 'bg-primary'
  return (
    <span className="inline-flex items-center justify-end gap-1.5" title={`${allowance.period === 'day' ? 'Today' : 'This month'}, ${allowance.metric}`}>
      <span className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-muted sm:inline-block" aria-hidden="true">
        <span className={`block h-full ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span className="tabular-nums">{pct}%</span>
      <span className="text-[10px] text-muted-foreground">{allowance.period === 'day' ? 'day' : 'mo'}</span>
    </span>
  )
}

// /usage - one table for every account and client key: rank, sort by any column, filter freely.
export function UsageRankingPage() {
  const { can, isPending } = useAdministrativeAccess()
  const canAccounts = can('view_usage_accounts')
  const canProfiles = can('view_usage_profiles')

  const [days, setDays] = useState<'7' | '30' | '90'>('30')
  const [filters, setFilters] = useState<RankingFilters>(() => loadFilters(FILTER_KEY))
  const [sort, setSort] = useState<NonNullable<SortState<RankingColumn>>>(() => loadStoredSort(SORT_KEY, RANKING_COLUMNS) ?? DEFAULT_SORT)
  useEffect(() => saveFilters(FILTER_KEY, filters), [filters])
  useEffect(() => persistSort(SORT_KEY, sort), [sort])
  const toggleSort = (col: RankingColumn) => setSort((cur) => nextSort(cur, col) ?? DEFAULT_SORT)
  const patch = (p: Partial<RankingFilters>) => setFilters((f) => ({ ...f, ...p }))

  const [fresh, setFresh] = useState(0)
  const accounts = useOverview('accounts', days, canAccounts, fresh)
  const profiles = useOverview('profiles', days, canProfiles, fresh)
  const generatedAt = accounts.data?.overview.generatedAt ?? profiles.data?.overview.generatedAt

  const all: UsageRow[] = useMemo(
    () => [...(accounts.data?.overview.rows ?? []), ...(profiles.data?.overview.rows ?? [])],
    [accounts.data, profiles.data],
  )
  // A saved kind the viewer can no longer see must not hide everything.
  const kind: KindFilter = (filters.kind === 'account' && !canAccounts) || (filters.kind === 'profile' && !canProfiles) ? 'all' : filters.kind
  const shown = useMemo(() => rankRows(applyFilters(all, { ...filters, kind }), sort), [all, filters, kind, sort])
  const totals = totalsOf(shown)

  if (isPending) return <p role="status">Loading permissions…</p>
  if (!canAccounts && !canProfiles) {
    return <p role="alert" className="text-sm text-muted-foreground">Your account does not have permission to open this page.</p>
  }

  const loading = (canAccounts && accounts.isLoading) || (canProfiles && profiles.isLoading)
  const failed = (canAccounts && accounts.isError) || (canProfiles && profiles.isError)
  const kinds: Array<{ value: KindFilter; label: string }> = [
    { value: 'all', label: 'All' },
    ...(canAccounts ? [{ value: 'account' as const, label: 'Accounts' }] : []),
    ...(canProfiles ? [{ value: 'profile' as const, label: 'Client keys' }] : []),
  ]
  const detailLink = (r: UsageRow): string | null =>
    r.kind === 'account' ? (can('view_users') ? `/users/${r.id}/analytics` : null)
      : can('view_client_profiles') ? `/profiles/${r.id}/usage` : null
  const filtered = JSON.stringify({ ...filters, kind }) !== JSON.stringify(DEFAULT_FILTERS)
  const head = (col: RankingColumn, label: string, align: 'left' | 'right' = 'right') => (
    <SortableHeader column={col} label={label} align={align} sort={sort} onToggle={toggleSort} />
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage ranking"
        description="Every account and client key side by side: traffic, errors, tokens and speed. Click a column to rank by it."
        actions={<SegmentedControl ariaLabel="Time range" value={days} onValueChange={setDays} options={[...RANGES]} />}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {kinds.length > 2 && (
          <SegmentedControl ariaLabel="Show" value={kind} onValueChange={(v) => patch({ kind: v })} options={kinds} />
        )}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={filters.search}
            onChange={(e) => patch({ search: e.target.value })}
            placeholder="Search by name…"
            aria-label="Search by name"
            className="h-8 w-56 pl-8 text-xs"
          />
        </div>
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          Min requests
          <Input
            type="number"
            min={0}
            inputMode="numeric"
            value={filters.minRequests || ''}
            onChange={(e) => patch({ minRequests: Math.max(0, Math.floor(Number(e.target.value)) || 0) })}
            className="h-8 w-20 text-xs"
            aria-label="Minimum requests"
          />
        </label>
        <Toggle id="usage-hide-idle" checked={filters.hideIdle} onChange={(hideIdle) => patch({ hideIdle })} label="Hide idle" />
        <Toggle id="usage-only-errors" checked={filters.onlyErrors} onChange={(onlyErrors) => patch({ onlyErrors })} label="Only with errors" />
        <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setFresh(n => n + 1)} disabled={accounts.isFetching || profiles.isFetching}
          title={generatedAt ? `Figures from ${new Date(generatedAt).toLocaleTimeString()}` : undefined}>
          <RefreshCw className="size-3.5 mr-1" />
          Refresh
        </Button>
        {filtered && (
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setFilters(DEFAULT_FILTERS)}>
            <RotateCcw className="size-3.5 mr-1" />
            Reset filters
          </Button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground" role="status">Loading usage…</p>
      ) : failed ? (
        <div className="space-y-3" role="alert">
          <p className="text-sm font-medium text-destructive">Could not load usage.</p>
          <Button variant="outline" size="sm" onClick={() => { void accounts.refetch(); void profiles.refetch() }}>Retry</Button>
        </div>
      ) : shown.length === 0 ? (
        <div className="rounded-2xl border bg-card p-8 text-center space-y-1">
          <p className="text-sm font-medium">{all.length === 0 ? 'Nothing to rank yet' : 'No row matches these filters'}</p>
          <p className="text-xs text-muted-foreground">
            {all.length === 0 ? 'Accounts and client keys appear here once they exist.' : 'Loosen a filter or reset them.'}
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                {head('name', 'Name', 'left')}
                {head('requests', 'Requests')}
                {head('successRate', 'Success')}
                {head('errors', 'Errors')}
                {head('tokens', 'Tokens')}
                {head('allowance', 'Allowance used')}
                {head('avgLatency', 'Avg latency')}
                {head('p95Latency', 'p95 latency')}
                {head('lastRequest', 'Last request')}
                {head('rpmLimit', 'Limit / min')}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r, i) => {
                const link = detailLink(r)
                const rate = successRate(r)
                return (
                  <TableRow key={`${r.kind}-${r.id}`} className={r.requests === 0 ? 'text-muted-foreground' : undefined}>
                    <TableCell className="tabular-nums text-muted-foreground">{i + 1}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 min-w-0">
                        {link ? <Link to={link} className="font-medium hover:underline truncate">{r.name}</Link> : <span className="font-medium truncate">{r.name}</span>}
                        <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {r.kind === 'account' ? (r.role === 'admin' ? 'Admin' : 'Member') : r.enabled ? 'Client key' : 'Client key · off'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums whitespace-nowrap">{fmt(r.requests)}<Change current={r.requests} previous={r.previous?.requests} /></TableCell>
                    <TableCell className="text-right tabular-nums">{rate === null ? '—' : `${(rate * 100).toFixed(1)}%`}</TableCell>
                    <TableCell className={`text-right tabular-nums whitespace-nowrap ${r.errors > 0 ? 'text-destructive' : ''}`}>{fmt(r.errors)}<Change current={r.errors} previous={r.previous?.errors} invert /></TableCell>
                    <TableCell className="text-right tabular-nums whitespace-nowrap">{fmt(tokensOf(r))}<Change current={tokensOf(r)} previous={r.previous?.tokens} /></TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap"><AllowanceCell allowance={r.allowance} /></TableCell>
                    <TableCell className="text-right tabular-nums">{ms(r.avgLatencyMs)}</TableCell>
                    <TableCell className="text-right tabular-nums">{ms(r.p95LatencyMs)}</TableCell>
                    <TableCell className="text-right text-xs">{r.lastRequestAt ? `${r.lastRequestAt.slice(0, 16)} UTC` : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.rpmLimit === null ? '—' : fmt(r.rpmLimit)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell />
                <TableCell className="font-medium">{shown.length} shown{shown.length !== all.length ? ` of ${all.length}` : ''}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(totals.requests)}</TableCell>
                <TableCell />
                <TableCell className="text-right tabular-nums">{fmt(totals.errors)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(totals.tokens)}</TableCell>
                <TableCell colSpan={5} />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
      <UsageExportCard canAccounts={canAccounts} canProfiles={canProfiles} />
      {can('view_settings') && <UsageAlertsCard canEdit={can('edit_settings')} />}
      <p className="text-xs text-muted-foreground">
        Last {days} days (UTC); arrows compare with the {days} days before. Allowance used is the fullest daily or monthly allowance right now. Only traffic sent with a personal key or a client key is attributed; the shared key and dashboard sessions are not counted.
      </p>
    </div>
  )
}

export default UsageRankingPage
