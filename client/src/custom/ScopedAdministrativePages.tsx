import type { ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useAdministrativeAccess } from './use-administrative-access'
import { UsersPage } from './UsersPage'
import { InvitesPage } from './InvitesPage'
import AnalyticsPage from '@/pages/AnalyticsPage'
import LogsPage from '@/pages/LogsPage'
import { ConfirmButton } from '@/components/confirm-button'
import { apiFetch } from '@/lib/api'

const denied = <p role="alert" className="text-sm text-muted-foreground">Your account does not have permission to open this page.</p>
function Ready({ pending, allowed, children }: { pending: boolean; allowed: boolean; children: ReactNode }) {
  return pending ? <p role="status">Loading permissions…</p> : allowed ? children : denied
}
export function UsersAccessPage() {
  const { can, group, identity, isPending, session } = useAdministrativeAccess()
  return <Ready pending={isPending} allowed={group('manage_users') || group('manage_requests')}>
    <UsersPage key={identity} capabilities={{ viewUsers: can('view_users'), viewRequests: can('view_requests'), roles: session?.role === 'admin' && can('edit_user_roles'), permissions: can('edit_user_permissions'), quotas: can('edit_user_quotas'), sessions: can('revoke_user_sessions'), keys: can('revoke_user_keys'), approve: can('approve_requests'), reject: can('reject_requests') }} />
  </Ready>
}
export function InvitesAccessPage() {
  const { can, group, identity, isPending } = useAdministrativeAccess()
  return <Ready pending={isPending} allowed={group('manage_invites')}><InvitesPage key={identity} capabilities={{ view: can('view_invites'), create: can('create_invites'), revoke: can('revoke_invites') }} /></Ready>
}
export function AnalyticsAccessPage() {
  const { can, identity, isPending } = useAdministrativeAccess()
  return <Ready pending={isPending} allowed={can('view_analytics')}><AnalyticsPage key={identity} /></Ready>
}
function ClearOnlyLogs() {
  const clear = useMutation({ mutationFn: () => apiFetch('/api/logs/clear', { method: 'POST' }) })
  return <div className="space-y-3"><p>Viewing log contents requires View server logs. You can clear retained logs.</p>
    <ConfirmButton onConfirm={() => clear.mutate()} disabled={clear.isPending}>Clear logs</ConfirmButton>
    {clear.isSuccess && <p role="status">Logs cleared.</p>}{clear.isError && <p role="alert">{clear.error.message}</p>}
  </div>
}
export function LogsAccessPage() {
  const { can, identity, isPending } = useAdministrativeAccess()
  return <Ready pending={isPending} allowed={can('view_server_logs') || can('clear_server_logs')}>
    {can('view_server_logs') ? <LogsPage key={identity} canClear={can('clear_server_logs')} /> : <ClearOnlyLogs key={identity} />}
  </Ready>
}
