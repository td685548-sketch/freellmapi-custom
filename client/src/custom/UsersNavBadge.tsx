import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { useAdministrativeAccess } from './use-administrative-access'
import type { RegistrationRequest } from '../../../shared/user-access'

const POLL_MS = 30_000

/** Count of registration requests waiting for approval; 0 when the viewer cannot see them.
 *  Shares the ['registration-requests'] cache with the Users page, so approving or
 *  rejecting there updates the badge immediately. */
export function usePendingRequestCount(): number {
  const { can } = useAdministrativeAccess()
  const enabled = can('view_requests')
  const { data } = useQuery<{ requests: RegistrationRequest[] }>({
    queryKey: ['registration-requests'],
    queryFn: () => apiFetch<{ requests: RegistrationRequest[] }>('/api/admin/registration-requests'),
    enabled,
    refetchInterval: enabled ? POLL_MS : false,
  })
  return enabled ? data?.requests.length ?? 0 : 0
}

/** Notification pill shown next to the "Users" nav label while requests are pending. */
export function UsersNavBadge() {
  const count = usePendingRequestCount()
  if (count === 0) return null
  return (
    <span
      role="status"
      aria-label={`${count} pending registration ${count === 1 ? 'request' : 'requests'}`}
      className="ms-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-white"
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
