import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

interface ProviderIconsResponse {
  icons: Record<string, string>
}

export interface ProviderIconsState {
  icons: Record<string, string> | null
  failed: boolean
}

/**
 * Fetches all `/providers/*.{png,svg}` logos in a single cached JSON payload
 * instead of firing 70-150 individual image requests on `/thruline/providers`,
 * keeping shared-domain PaaS hosts (e.g. SnapDeploy's 100 req/min/IP limit)
 * well below edge rate-limit thresholds.
 */
export function useProviderIcons(): ProviderIconsState {
  const query = useQuery({
    queryKey: ['provider-icons-bundle'],
    queryFn: ({ signal }) => apiFetch<ProviderIconsResponse>('/api/provider-icons', { signal }),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  return {
    icons: query.data?.icons ?? null,
    failed: query.isError,
  }
}
