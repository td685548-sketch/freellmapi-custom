import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { UsageQuota, UsageQuotaState } from '../../../shared/usage-quota'
import { useCustomT } from './i18n/use-custom-t'

const MAX = 1_000_000_000_000
type Field = keyof UsageQuota

const ROWS: Array<{ field: Field; label: string; window: 'day' | 'month'; metric: 'requests' | 'tokens' }> = [
  { field: 'dailyRequests', label: 'Requests per day', window: 'day', metric: 'requests' },
  { field: 'dailyTokens', label: 'Tokens per day', window: 'day', metric: 'tokens' },
  { field: 'monthlyRequests', label: 'Requests per month', window: 'month', metric: 'requests' },
  { field: 'monthlyTokens', label: 'Tokens per month', window: 'month', metric: 'tokens' },
]

const fmt = (n: number) => n.toLocaleString()
const parse = (text: string): number | null | undefined => {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isInteger(n) && n >= 1 && n <= MAX ? n : undefined
}

function Bar({ used, limit }: { used: number; limit: number }) {
  const pct = Math.min(100, Math.round((used / limit) * 100))
  const tone = used >= limit ? 'bg-destructive' : pct >= 80 ? 'bg-amber-500' : 'bg-foreground/70'
  return (
    <div className="h-1.5 w-full rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

/**
 * Daily / monthly allowances of one account or client key, with how much of each is used.
 * Editors can change the limits (empty = no limit); everyone else sees them read-only, and a
 * read-only viewer is shown nothing at all when no limit is set.
 */
export function QuotaCard({ endpoint, queryKey, canEdit }: { endpoint: string; queryKey: unknown[]; canEdit: boolean }) {
  const tc = useCustomT()
  const queryClient = useQueryClient()
  const { data } = useQuery<UsageQuotaState>({ queryKey, queryFn: () => apiFetch<UsageQuotaState>(endpoint) })
  const [draft, setDraft] = useState<Partial<Record<Field, string>>>({})

  const save = useMutation({
    mutationFn: (body: UsageQuota) => apiFetch<UsageQuotaState>(endpoint, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (state) => {
      queryClient.setQueryData(queryKey, state)
      setDraft({})
      toast.success(tc('Allowances updated'))
    },
    onError: (err: Error) => toast.error(err.message || tc('Failed to update the allowances')),
  })

  if (!data?.quota || !data.usage) return null
  if (!canEdit && !data.tracked) return null

  const shown = (f: Field) => draft[f] ?? (data.quota[f] === null ? '' : String(data.quota[f]))
  const parsed = Object.fromEntries(ROWS.map(r => [r.field, parse(shown(r.field))])) as Record<Field, number | null | undefined>
  const valid = ROWS.every(r => parsed[r.field] !== undefined)
  const dirty = ROWS.some(r => draft[r.field] !== undefined && parsed[r.field] !== data.quota[r.field])

  return (
    <form
      className="rounded-2xl border bg-card p-4 space-y-4"
      onSubmit={(e) => { e.preventDefault(); if (canEdit && valid && dirty) save.mutate(parsed as UsageQuota) }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{tc('Allowances')}</h3>
        <p className="text-xs text-muted-foreground">{tc('Resets')}{' '}{new Date(data.resetsAt.day).toISOString().slice(0, 16).replace('T', ' ')}{' '}{tc('UTC (day) ·')}{' '}{new Date(data.resetsAt.month).toISOString().slice(0, 10)}{' '}{tc('(month)')}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {ROWS.map(({ field, label, window, metric }) => {
          const limit = data.quota[field]
          const used = data.usage[window][metric]
          return (
            <div key={field} className="space-y-1.5">
              <label htmlFor={`quota-${field}`} className="block text-xs font-medium text-muted-foreground">{tc(label)}</label>
              {canEdit ? (
                <Input
                  id={`quota-${field}`}
                  inputMode="numeric"
                  value={shown(field)}
                  onChange={(e) => setDraft(d => ({ ...d, [field]: e.target.value }))}
                  placeholder={tc('No limit')}
                  className="h-8 text-xs"
                />
              ) : (
                <div className="text-sm font-medium tabular-nums">{limit === null ? tc('No limit') : fmt(limit)}</div>
              )}
              {limit !== null && data.tracked && (
                <>
                  <Bar used={used} limit={limit} />
                  <p className="text-xs text-muted-foreground tabular-nums">{fmt(used)}{' '}{tc('of')}{' '}{fmt(limit)}{' '}{tc('used')}</p>
                </>
              )}
            </div>
          )
        })}
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" className="h-8 text-xs" disabled={!valid || !dirty || save.isPending}>{tc('Save allowances')}</Button>
          <p className="text-xs text-muted-foreground">
            {valid ? tc('Leave a field empty for no limit. A request is refused once its window is full; token limits stop the next request.') : tc('Use whole numbers from 1 to {v}.', { v: fmt(MAX) })}
          </p>
        </div>
      )}
    </form>
  )
}
