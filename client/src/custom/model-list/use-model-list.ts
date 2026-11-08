import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ModelListPageInfo } from '@freellmapi/shared'
import { apiFetch, type ApiError } from '@/lib/api'
import type { FallbackEntry, RoutingData, RateLimitUsageData } from '@/lib/routing'
import type { ModelSortCol } from '@/lib/model-table-sort'
import type { SortState } from '@/lib/table-sort'

export interface ModelListPage extends ModelListPageInfo {
  entries: FallbackEntry[]
  routing: RoutingData
  rateLimitUsage: RateLimitUsageData
}
export interface ModelListOptions {
  profileId: number | null
  enabled: boolean
  search: string
  vision: boolean
  tools: boolean
  context: number
  sort: SortState<ModelSortCol>
}
type Cursor = { offset: number; snapshot: string } | null

export function useModelList(options: ModelListOptions) {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState(options.search.trim())
  useEffect(() => {
    const timer = setTimeout(() => setSearch(options.search.trim()), 250)
    return () => clearTimeout(timer)
  }, [options.search])
  const selection: Record<string, string> = {
    profile: String(options.profileId ?? 'global'), search,
    vision: options.vision ? '1' : '0', tools: options.tools ? '1' : '0', context: String(options.context),
    ...(options.sort ? { sort: options.sort.column, direction: options.sort.direction } : {}),
  }
  // Keep the established routing prefix so existing strategy controls also
  // invalidate this view. Profile and every selection field identify the cache.
  const queryKey = ['fallback', 'routing', 'page', selection]
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: null as Cursor,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams(selection)
      if (pageParam) {
        params.set('snapshot', pageParam.snapshot)
        params.set('offset', String(pageParam.offset))
      }
      return apiFetch<ModelListPage>(`/api/fallback/page?${params}`, { signal })
    },
    getNextPageParam: last => last.nextOffset === null ? undefined : { offset: last.nextOffset, snapshot: last.snapshot },
    enabled: options.enabled,
    // Keep the toolbar/input mounted during a filter request, but never show
    // another chain's rows. Only retain the first batch of the old selection.
    placeholderData: (previous, previousQuery) => {
      const old = previousQuery?.queryKey[3] as Record<string, string> | undefined
      if (old?.profile !== selection.profile || !previous) return undefined
      return { ...previous, pages: previous.pages.slice(0, 1), pageParams: previous.pageParams.slice(0, 1) }
    },
    staleTime: 30_000,
    // Returning to a chain/filter starts at 20 again; never restore its old
    // multi-page browser cache. Shared ranking work remains cached server-side.
    gcTime: 0,
    refetchInterval: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const pages = query.data?.pages
  const entries = useMemo(() => [...new Map((pages ?? []).flatMap(p => p.entries).map(e => [e.modelDbId, e])).values()], [pages])
  const routing = useMemo(() => pages?.[0] ? {
    ...pages[0].routing,
    scores: [...new Map(pages.flatMap(p => p.routing.scores).map(s => [s.modelDbId, s])).values()],
  } : undefined, [pages])
  const rateLimitUsage = useMemo(() => ({
    generatedAtMs: pages?.[0]?.rateLimitUsage.generatedAtMs ?? 0,
    rows: [...new Map((pages ?? []).flatMap(p => p.rateLimitUsage.rows).map(r => [r.modelDbId, r])).values()],
  }), [pages])
  const ranks = useMemo(() => new Map(Object.entries(Object.assign({}, ...(pages ?? []).map(p => p.ranks))) as Array<[string, number]>), [pages])
  const groupOrder = useMemo(() => new Map((pages ?? []).flatMap(p => p.groupKeys).map((key, i) => [key, i])), [pages])
  const snapshot = pages?.[0]?.snapshot
  const count = (pages ?? []).reduce((sum, p) => sum + Object.keys(p.ranks).length, 0)
  const initialLive = routing && !query.isPlaceholderData ? { routing, rateLimitUsage, tokenSummary: pages![0].tokenSummary } : undefined
  const live = useQuery({
    queryKey: ['fallback', 'routing', 'page-live', selection, snapshot, count],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ ...selection, snapshot: snapshot!, count: String(count) })
      return apiFetch<Pick<ModelListPage, 'routing' | 'rateLimitUsage' | 'tokenSummary'>>(`/api/fallback/page/live?${params}`, { signal })
    },
    enabled: options.enabled && !!snapshot && count > 0 && !query.isPlaceholderData,
    initialData: initialLive,
    initialDataUpdatedAt: query.dataUpdatedAt,
    staleTime: 30_000,
    gcTime: 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const error = (query.error ?? live.error) as ApiError | null
  return {
    ...query, entries, ranks, groupOrder,
    routing: live.data?.routing ?? routing,
    rateLimitUsage: live.data?.rateLimitUsage ?? rateLimitUsage,
    isFetching: query.isFetching || live.isFetching,
    isError: query.isError || live.isError, error,
    refetch: () => query.isError ? query.refetch() : live.refetch(),
    totalGroups: pages?.[0]?.totalGroups ?? 0,
    matchedGroups: pages?.[0]?.matchedGroups ?? 0,
    unconfiguredPlatforms: pages?.[0]?.unconfiguredPlatforms ?? [],
    tokenSummary: live.data?.tokenSummary ?? pages?.[0]?.tokenSummary,
    expired: error?.status === 410,
    loadMore: () => { if (query.hasNextPage && !query.isFetching && !live.isFetching) void query.fetchNextPage({ cancelRefetch: false }) },
    reload: () => queryClient.resetQueries({ queryKey, exact: true }),
  }
}
