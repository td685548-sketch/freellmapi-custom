import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { UserAnalyticsView, type ProfileAnalytics, type RequestAnalytics } from './UserAnalyticsView'
import { QuotaCard } from './QuotaCard'
import { ProfileRestrictionsCard } from './ProfileRestrictionsCard'
import { ProfileIntegrationCard } from './ProfileIntegrationCard'
import { KeyRotationCard } from './KeyRotationCard'
import { RecentRequestsCard } from './RecentRequestsCard'
import { EndUsersCard } from './EndUsersCard'
import { KnowledgeCard } from './KnowledgeCard'
import { ConversationsCard } from './ConversationsCard'
import { ContentFilterCard } from './ContentFilterCard'
import { QuickAnswersCard } from './QuickAnswersCard'
import { useAdministrativeAccess } from './use-administrative-access'

const MAX_RPM = 1000

function QuotaEditor({ profile, canEdit, onSaved }: { profile: ProfileAnalytics; canEdit: boolean; onSaved: () => void }) {
  const [value, setValue] = useState(profile.rpmLimit === null ? '' : String(profile.rpmLimit))
  const save = useMutation({
    mutationFn: (rpmLimit: number | null) =>
      apiFetch(`/api/client-profiles/${profile.profileId}/quota`, { method: 'PUT', body: JSON.stringify({ rpmLimit }) }),
    onSuccess: () => { onSaved(); toast.success('Request limit updated') },
    onError: (err: Error) => toast.error(err.message || 'Failed to update the limit'),
  })
  const trimmed = value.trim()
  const parsed = trimmed === '' ? null : Number(trimmed)
  const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_RPM)
  const unchanged = parsed === profile.rpmLimit

  return (
    <form
      className="rounded-2xl border bg-card p-4 flex flex-wrap items-end gap-3"
      onSubmit={(e) => { e.preventDefault(); if (canEdit && valid && !unchanged) save.mutate(parsed) }}
    >
      <div className="space-y-1">
        <label htmlFor="profile-rpm" className="block text-xs font-medium text-muted-foreground">Requests per minute</label>
        <Input
          id="profile-rpm"
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="No limit"
          disabled={!canEdit}
          className="h-8 w-36 text-xs"
        />
      </div>
      <Button type="submit" size="sm" className="h-8 text-xs" disabled={!canEdit || !valid || unchanged || save.isPending}>
        Save
      </Button>
      <p className="text-xs text-muted-foreground">
        {valid ? (profile.rpmLimit === null ? 'Currently unlimited.' : `Currently ${profile.rpmLimit} per minute.`) : `Enter a whole number from 1 to ${MAX_RPM}, or leave empty for no limit.`}
        {!profile.enabled && ' This profile is disabled: its key is rejected.'}
      </p>
    </form>
  )
}

// /profiles/:id/usage - traffic and request cap of one client profile (`sk-cp-…` key).
export function ProfileUsagePage() {
  const { id } = useParams()
  const queryClient = useQueryClient()
  const { can, identity, isPending } = useAdministrativeAccess()
  const profileId = Number(id)

  if (isPending) return <p role="status">Loading permissions…</p>
  if (!can('view_client_profiles')) {
    return <p role="alert" className="text-sm text-muted-foreground">Your account does not have permission to open this page.</p>
  }
  if (!Number.isInteger(profileId) || profileId <= 0) {
    return <p role="alert" className="text-sm text-muted-foreground">Unknown client profile.</p>
  }

  const queryKey = ['profile-analytics', profileId]
  return (
    <div className="space-y-6" key={identity}>
      <PageHeader
        title="Client profile usage"
        description="Requests, tokens, errors and models for one client key, and its request limit."
        actions={
          <Link to="/keys" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" />
            Keys
          </Link>
        }
      />
      <UserAnalyticsView
        endpoint={`/api/client-profiles/${profileId}/analytics`}
        queryKey={queryKey}
        scope="this client key"
        header={(a: RequestAnalytics) => (
          <>
            <h2 className="text-lg font-semibold">{(a as ProfileAnalytics).name}</h2>
            <ProfileIntegrationCard profileId={profileId} canTest={can('edit_client_profiles')} />
            <KeyRotationCard profileId={profileId} canEdit={can('edit_client_profiles')} />
            <QuotaEditor
              profile={a as ProfileAnalytics}
              canEdit={can('edit_client_profiles')}
              onSaved={() => queryClient.invalidateQueries({ queryKey })}
            />
            <QuotaCard
              endpoint={`/api/client-profiles/${profileId}/usage-quota`}
              queryKey={['profile-quota', profileId]}
              canEdit={can('edit_client_profiles')}
            />
            <ProfileRestrictionsCard profileId={profileId} canEdit={can('edit_client_profiles')} />
          </>
        )}
      />
      <KnowledgeCard profileId={profileId} canEdit={can('edit_client_profiles')} />
      <QuickAnswersCard profileId={profileId} canEdit={can('edit_client_profiles')} />
      <ConversationsCard profileId={profileId} canEdit={can('edit_client_profiles')} />
      <ContentFilterCard profileId={profileId} canEdit={can('edit_client_profiles')} />
      <EndUsersCard profileId={profileId} canEdit={can('edit_client_profiles')} />
      <RecentRequestsCard endpoint={`/api/client-profiles/${profileId}/requests`} />
    </div>
  )
}

export default ProfileUsagePage
