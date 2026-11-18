import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck, Users } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useSessionRevision } from './session-state'
import { useUserSession } from './use-session'
import { useCustomT } from './i18n/use-custom-t'

export interface StarterQuotaConfig {
  enabled: boolean
  dailyRequests: number | null
  dailyTokens: number | null
  monthlyRequests: number | null
  monthlyTokens: number | null
  rpmLimit: number
}

interface StarterQuotaResponse {
  config: StarterQuotaConfig
  uncappedMembers: number
}

interface StarterQuotaDraft {
  dailyRequests: string
  dailyTokens: string
  monthlyRequests: string
  monthlyTokens: string
  rpmLimit: string
}

function toDraft(cfg: StarterQuotaConfig): StarterQuotaDraft {
  return {
    dailyRequests: cfg.dailyRequests === null ? '' : String(cfg.dailyRequests),
    dailyTokens: cfg.dailyTokens === null ? '' : String(cfg.dailyTokens),
    monthlyRequests: cfg.monthlyRequests === null ? '' : String(cfg.monthlyRequests),
    monthlyTokens: cfg.monthlyTokens === null ? '' : String(cfg.monthlyTokens),
    rpmLimit: String(cfg.rpmLimit),
  }
}

function parseLimitField(raw: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  const n = Number(trimmed)
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000_000_000) return { ok: false }
  return { ok: true, value: n }
}

function parseRpmField(raw: string): { ok: true; value: number } | { ok: false } {
  const trimmed = raw.trim()
  const n = Number(trimmed)
  if (!Number.isInteger(n) || n < 1 || n > 1000) return { ok: false }
  return { ok: true, value: n }
}

export function StarterQuotaDefaultSection() {
  const tc = useCustomT()
  const { hasPermission } = useUserSession()
  const revision = useSessionRevision()
  const queryClient = useQueryClient()

  const canView =
    hasPermission('view_settings') ||
    hasPermission('edit_settings') ||
    hasPermission('view_users') ||
    hasPermission('edit_user_quotas')
  const canEdit = hasPermission('edit_settings') || hasPermission('edit_user_quotas')

  const queryKey = ['starter-quota-settings', revision]
  const { data } = useQuery<StarterQuotaResponse>({
    queryKey,
    queryFn: () => apiFetch<StarterQuotaResponse>('/api/settings/starter-quota'),
    enabled: canView,
    retry: false,
  })

  const [draft, setDraft] = useState<StarterQuotaDraft | null>(null)

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['starter-quota-settings'] })
    void queryClient.invalidateQueries({ queryKey: ['users'] })
    void queryClient.invalidateQueries({ queryKey: ['admin-users-usage'] })
  }

  const updateMutation = useMutation({
    mutationFn: (body: Partial<StarterQuotaConfig>) =>
      apiFetch<StarterQuotaResponse>('/api/settings/starter-quota', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKey, next)
      setDraft(null)
      invalidate()
      toast.success(tc('Starter quota settings saved'))
    },
    onError: (err: Error) => {
      toast.error(err.message || tc('Failed to save starter quota settings'))
    },
  })

  const backfillMutation = useMutation({
    mutationFn: () =>
      apiFetch<StarterQuotaResponse & { updatedCount: number }>('/api/settings/starter-quota/backfill', {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: (res) => {
      queryClient.setQueryData(queryKey, { config: res.config, uncappedMembers: res.uncappedMembers })
      invalidate()
      toast.success(tc('Applied starter quota to {count} member accounts', { count: res.updatedCount }))
    },
    onError: (err: Error) => {
      toast.error(err.message || tc('Failed to apply starter quota to existing members'))
    },
  })

  if (!canView || !data?.config) return null

  const cfg = data.config
  const current = draft ?? toDraft(cfg)

  const parsedDailyReq = parseLimitField(current.dailyRequests)
  const parsedDailyTok = parseLimitField(current.dailyTokens)
  const parsedMonthlyReq = parseLimitField(current.monthlyRequests)
  const parsedMonthlyTok = parseLimitField(current.monthlyTokens)
  const parsedRpm = parseRpmField(current.rpmLimit)

  const valid =
    parsedDailyReq.ok &&
    parsedDailyTok.ok &&
    parsedMonthlyReq.ok &&
    parsedMonthlyTok.ok &&
    parsedRpm.ok

  const dirty =
    valid &&
    (parsedDailyReq.value !== cfg.dailyRequests ||
      parsedDailyTok.value !== cfg.dailyTokens ||
      parsedMonthlyReq.value !== cfg.monthlyRequests ||
      parsedMonthlyTok.value !== cfg.monthlyTokens ||
      parsedRpm.value !== cfg.rpmLimit)

  const hasAnyLimit =
    cfg.dailyRequests !== null ||
    cfg.dailyTokens !== null ||
    cfg.monthlyRequests !== null ||
    cfg.monthlyTokens !== null

  const setField = (field: keyof StarterQuotaDraft, value: string) => {
    setDraft(prev => ({ ...(prev ?? toDraft(cfg)), [field]: value }))
  }

  const handleSave = () => {
    if (!valid) return
    updateMutation.mutate({
      dailyRequests: parsedDailyReq.value,
      dailyTokens: parsedDailyTok.value,
      monthlyRequests: parsedMonthlyReq.value,
      monthlyTokens: parsedMonthlyTok.value,
      rpmLimit: parsedRpm.value,
    })
  }

  return (
    <div className="mt-4 space-y-3 rounded-2xl border bg-card/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <ShieldCheck className="size-4 text-primary" />
            <span>{tc('New Member Starter Quota')}</span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {tc('Automatically cap daily and monthly allowance for every newly registered or approved member account (leave blank for unlimited).')}
          </p>
        </div>
        <label className="inline-flex items-center gap-2 text-xs font-medium">
          <Switch
            size="sm"
            checked={cfg.enabled}
            disabled={!canEdit || updateMutation.isPending}
            onCheckedChange={(enabled) => updateMutation.mutate({ enabled })}
            aria-label={tc('Enable new member starter quota')}
          />
          <span>{cfg.enabled ? tc('Enabled') : tc('Disabled')}</span>
        </label>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-5">
        <label className="space-y-1 text-[11px] text-muted-foreground">
          <span>{tc('Daily requests')}</span>
          <Input
            type="number"
            min={1}
            placeholder={tc('Unlimited')}
            value={current.dailyRequests}
            disabled={!canEdit}
            onChange={(e) => setField('dailyRequests', e.target.value)}
            className="h-8 text-xs tabular-nums"
          />
        </label>
        <label className="space-y-1 text-[11px] text-muted-foreground">
          <span>{tc('Daily tokens')}</span>
          <Input
            type="number"
            min={1}
            placeholder={tc('Unlimited')}
            value={current.dailyTokens}
            disabled={!canEdit}
            onChange={(e) => setField('dailyTokens', e.target.value)}
            className="h-8 text-xs tabular-nums"
          />
        </label>
        <label className="space-y-1 text-[11px] text-muted-foreground">
          <span>{tc('Monthly requests')}</span>
          <Input
            type="number"
            min={1}
            placeholder={tc('Unlimited')}
            value={current.monthlyRequests}
            disabled={!canEdit}
            onChange={(e) => setField('monthlyRequests', e.target.value)}
            className="h-8 text-xs tabular-nums"
          />
        </label>
        <label className="space-y-1 text-[11px] text-muted-foreground">
          <span>{tc('Monthly tokens')}</span>
          <Input
            type="number"
            min={1}
            placeholder={tc('Unlimited')}
            value={current.monthlyTokens}
            disabled={!canEdit}
            onChange={(e) => setField('monthlyTokens', e.target.value)}
            className="h-8 text-xs tabular-nums"
          />
        </label>
        <label className="space-y-1 text-[11px] text-muted-foreground">
          <span>{tc('Rate limit (RPM)')}</span>
          <Input
            type="number"
            min={1}
            max={1000}
            value={current.rpmLimit}
            disabled={!canEdit}
            onChange={(e) => setField('rpmLimit', e.target.value)}
            className="h-8 text-xs tabular-nums"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          {data.uncappedMembers > 0 ? (
            <>
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400">
                <Users className="size-3" />
                {tc('{count} existing members have no usage cap', { count: data.uncappedMembers })}
              </span>
              {canEdit && cfg.enabled && hasAnyLimit && (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={backfillMutation.isPending}
                  onClick={() => backfillMutation.mutate()}
                >
                  {backfillMutation.isPending
                    ? tc('Applying…')
                    : tc('Apply starter quota to {count} uncapped members', { count: data.uncappedMembers })}
                </Button>
              )}
            </>
          ) : (
            <span>{tc('All member accounts currently have an explicit usage quota.')}</span>
          )}
        </div>

        {canEdit && (
          <div className="flex items-center gap-2">
            {draft !== null && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={updateMutation.isPending}
                onClick={() => setDraft(null)}
              >
                {tc('Reset')}
              </Button>
            )}
            <Button
              type="button"
              size="xs"
              disabled={!dirty || !valid || updateMutation.isPending}
              onClick={handleSave}
            >
              {updateMutation.isPending ? tc('Saving…') : tc('Save starter quota')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
