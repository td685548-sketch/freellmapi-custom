import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { UserAnalyticsView } from './UserAnalyticsView'
import { QuotaCard } from './QuotaCard'
import { RecentRequestsCard } from './RecentRequestsCard'
import { useAdministrativeAccess } from './use-administrative-access'

// /users/:id/analytics - one account's usage, for operators who can view accounts.
export function UserAnalyticsPage() {
  const { id } = useParams()
  const { can, identity, isPending } = useAdministrativeAccess()
  const userId = Number(id)

  if (isPending) return <p role="status">Loading permissions…</p>
  if (!can('view_users')) {
    return <p role="alert" className="text-sm text-muted-foreground">Your account does not have permission to open this page.</p>
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    return <p role="alert" className="text-sm text-muted-foreground">Unknown account.</p>
  }

  return (
    <div className="space-y-6" key={identity}>
      <PageHeader
        title="Account usage"
        description="Requests, tokens, errors and models for one account."
        actions={
          <Link to="/users" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" />
            Users
          </Link>
        }
      />
      <QuotaCard
        endpoint={`/api/admin/users/${userId}/usage-quota`}
        queryKey={['admin-user-quota', userId]}
        canEdit={can('edit_user_quotas')}
      />
      <UserAnalyticsView endpoint={`/api/admin/users/${userId}/analytics`} queryKey={['admin-user-analytics', userId]} />
      <RecentRequestsCard endpoint={`/api/admin/users/${userId}/requests`} />
    </div>
  )
}

export default UserAnalyticsPage
