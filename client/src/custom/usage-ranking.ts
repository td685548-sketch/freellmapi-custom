import type { UsageRow } from '../../../shared/usage-overview'
import { compareBy, type SortState } from '@/lib/table-sort'

export const RANKING_COLUMNS = [
  'name', 'requests', 'successRate', 'errors', 'tokens', 'allowance', 'avgLatency', 'p95Latency', 'lastRequest', 'rpmLimit',
] as const
export type RankingColumn = typeof RANKING_COLUMNS[number]

export const DEFAULT_SORT: NonNullable<SortState<RankingColumn>> = { column: 'requests', direction: 'desc' }

export type KindFilter = 'all' | 'account' | 'profile'

export interface RankingFilters {
  kind: KindFilter
  search: string
  hideIdle: boolean
  onlyErrors: boolean
  /** Smallest request count to keep; 0 keeps everything. */
  minRequests: number
}

export const DEFAULT_FILTERS: RankingFilters = { kind: 'all', search: '', hideIdle: false, onlyErrors: false, minRequests: 0 }

export const tokensOf = (r: UsageRow): number => r.inputTokens + r.outputTokens

/** Share of finished requests (success + error) that succeeded; null when none finished. */
export function successRate(r: UsageRow): number | null {
  const finished = r.success + r.errors
  return finished > 0 ? r.success / finished : null
}

export function sortValue(r: UsageRow, col: RankingColumn): number | string | null {
  switch (col) {
    case 'name': return r.name.toLowerCase()
    case 'requests': return r.requests
    case 'successRate': return successRate(r)
    case 'errors': return r.errors
    case 'tokens': return tokensOf(r)
    case 'allowance': return r.allowance?.used ?? null
    case 'avgLatency': return r.avgLatencyMs
    case 'p95Latency': return r.p95LatencyMs
    case 'lastRequest': return r.lastRequestAt
    case 'rpmLimit': return r.rpmLimit
  }
}

export function applyFilters(rows: UsageRow[], f: RankingFilters): UsageRow[] {
  const needle = f.search.trim().toLowerCase()
  return rows.filter((r) => {
    if (f.kind !== 'all' && r.kind !== f.kind) return false
    if (needle && !r.name.toLowerCase().includes(needle)) return false
    if (f.hideIdle && r.requests === 0) return false
    if (f.onlyErrors && r.errors === 0) return false
    if (r.requests < f.minRequests) return false
    return true
  })
}

/** Rows ordered by the sort; ties and missing values fall back to the name so the order is stable. Missing values stay last in both directions. */
export function rankRows(rows: UsageRow[], sort: NonNullable<SortState<RankingColumn>>): UsageRow[] {
  const sign = sort.direction === 'asc' ? 1 : -1
  return rows.slice().sort((a, b) => {
    const av = sortValue(a, sort.column)
    const bv = sortValue(b, sort.column)
    if (av === null || bv === null) {
      if (av !== bv) return av === null ? 1 : -1
    } else {
      const c = compareBy(a, b, sort.column, sortValue)
      if (c !== 0) return sign * c
    }
    return a.name.localeCompare(b.name)
  })
}

/** Relative change against the previous window: a fraction (0.25 = +25%), 'new' when it was zero, null when both are zero or unknown. */
export function changeOf(current: number, previous: number | undefined): number | 'new' | null {
  if (previous === undefined) return null
  if (previous === 0) return current > 0 ? 'new' : null
  return (current - previous) / previous
}

export function totalsOf(rows: UsageRow[]) {
  return rows.reduce(
    (t, r) => ({ requests: t.requests + r.requests, errors: t.errors + r.errors, tokens: t.tokens + tokensOf(r) }),
    { requests: 0, errors: 0, tokens: 0 },
  )
}

/** Read filters saved by this browser; anything malformed falls back to the defaults. */
export function loadFilters(storageKey: string): RankingFilters {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<RankingFilters> | null
    if (!raw || typeof raw !== 'object') return DEFAULT_FILTERS
    return {
      kind: raw.kind === 'account' || raw.kind === 'profile' ? raw.kind : 'all',
      search: typeof raw.search === 'string' ? raw.search.slice(0, 100) : '',
      hideIdle: raw.hideIdle === true,
      onlyErrors: raw.onlyErrors === true,
      minRequests: typeof raw.minRequests === 'number' && Number.isFinite(raw.minRequests) && raw.minRequests > 0 ? Math.floor(raw.minRequests) : 0,
    }
  } catch { return DEFAULT_FILTERS }
}

export function saveFilters(storageKey: string, f: RankingFilters): void {
  try { localStorage.setItem(storageKey, JSON.stringify(f)) } catch { /* private mode: the filters still apply this session */ }
}
