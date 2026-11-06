import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import type { EndUserOverview, EndUserQuota, EndUserRow } from '../../../shared/end-users'
import { RecentRequestsCard } from './RecentRequestsCard'

const FIELDS: Array<{ field: keyof EndUserQuota; label: string }> = [
  { field: 'dailyRequests', label: 'Requests per day' },
  { field: 'dailyTokens', label: 'Tokens per day' },
  { field: 'monthlyRequests', label: 'Requests per month' },
  { field: 'monthlyTokens', label: 'Tokens per month' },
]
const RANGES = [{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }] as const
const fmt = (n: number) => n.toLocaleString()
const parse = (t: string): number | null | undefined => {
  const v = t.trim()
  if (v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 1_000_000_000_000 ? n : undefined
}

function QuotaEditor({ profileId, quota, canEdit }: { profileId: number; quota: EndUserQuota; canEdit: boolean }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Partial<Record<keyof EndUserQuota, string>>>({})
  const shown = (f: keyof EndUserQuota) => draft[f] ?? (quota[f] === null ? '' : String(quota[f]))
  const parsed = Object.fromEntries(FIELDS.map(({ field }) => [field, parse(shown(field))])) as Record<keyof EndUserQuota, number | null | undefined>
  const valid = FIELDS.every(({ field }) => parsed[field] !== undefined)
  const dirty = FIELDS.some(({ field }) => draft[field] !== undefined && parsed[field] !== quota[field])
  const save = useMutation({
    mutationFn: () => apiFetch(`/api/client-profiles/${profileId}/end-user-quota`, { method: 'PUT', body: JSON.stringify(parsed) }),
    onSuccess: () => { setDraft({}); void queryClient.invalidateQueries({ queryKey: ['end-users', profileId] }); toast.success('Per-user allowance saved') },
    onError: (err: Error) => toast.error(err.message || 'Could not save'),
  })
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (canEdit && valid && dirty) save.mutate() }}>
      <p className="text-xs font-medium text-muted-foreground">Allowance for each end user</p>
      <div className="grid gap-2 sm:grid-cols-4">
        {FIELDS.map(({ field, label }) => (
          <div key={field} className="space-y-1">
            <label htmlFor={`eu-${field}`} className="block text-[11px] text-muted-foreground">{label}</label>
            <Input id={`eu-${field}`} inputMode="numeric" value={shown(field)} disabled={!canEdit} placeholder="No limit"
              onChange={(e) => setDraft(d => ({ ...d, [field]: e.target.value }))} className="h-8 text-xs" />
          </div>
        ))}
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" className="h-8 text-xs" disabled={!valid || !dirty || save.isPending}>Save</Button>
          <span className="text-[11px] text-muted-foreground">
            {valid ? 'Each visitor gets this much on their own; an end user over it gets 429 end_user_quota_exceeded. Empty = no limit.' : 'Use whole numbers from 1, or leave empty.'}
          </span>
        </div>
      )}
    </form>
  )
}

/**
 * The web app's own visitors behind this client key: who uses it, how much and how well, with an
 * allowance each of them gets. Needs the web app's backend to send X-End-User (or the OpenAI `user` field).
 */
export function EndUsersCard({ profileId, canEdit }: { profileId: number; canEdit: boolean }) {
  const [days, setDays] = useState<'7' | '30' | '90'>('30')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const { data, isLoading, isError } = useQuery<{ overview: EndUserOverview }>({
    queryKey: ['end-users', profileId, days],
    queryFn: () => apiFetch(`/api/client-profiles/${profileId}/end-users?days=${days}`),
  })
  const o = data?.overview
  const rows: EndUserRow[] = Array.isArray(o?.endUsers) ? o!.endUsers.filter(r => r.endUser.toLowerCase().includes(search.trim().toLowerCase())) : []

  return (
    <section className="rounded-2xl border bg-card p-4 space-y-4" aria-label="End users">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5"><Users className="size-4" /><h3 className="text-sm font-semibold">End users</h3></div>
        <SegmentedControl ariaLabel="End users range" value={days} onValueChange={setDays} options={[...RANGES]} />
      </div>
      <p className="text-xs text-muted-foreground">
        Your web app&apos;s own visitors. Send their id in the <code>X-End-User</code> header (or the OpenAI <code>user</code> field) from your
        backend: an id of your own, no email needed.
      </p>

      {isLoading ? <p className="text-xs text-muted-foreground" role="status">Loading…</p>
        : isError || !o ? <p className="text-xs text-destructive" role="alert">Could not load the end users.</p>
        : (
          <>
            <QuotaEditor key={JSON.stringify(o.quota)} profileId={profileId} quota={o.quota} canEdit={canEdit} />
            {o.unattributedRequests > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-400">{fmt(o.unattributedRequests)} request(s) in this window named no end user.</p>
            )}
            {o.endUsers.length === 0 ? (
              <p className="text-xs text-muted-foreground">No end user yet in this window.</p>
            ) : (
              <>
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search end user…" aria-label="Search end user" className="h-8 w-60 text-xs" />
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-1.5 pr-3 font-medium">End user</th>
                        <th className="py-1.5 pr-3 text-right font-medium">Requests</th>
                        <th className="py-1.5 pr-3 text-right font-medium">Errors</th>
                        <th className="py-1.5 pr-3 text-right font-medium">Tokens</th>
                        <th className="py-1.5 pr-3 text-right font-medium">Avg latency</th>
                        {o.endUsers[0]?.today && <th className="py-1.5 pr-3 text-right font-medium">Today</th>}
                        <th className="py-1.5 text-right font-medium">Last request</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {rows.map(r => (
                        <tr key={r.endUser} className="cursor-pointer hover:bg-muted/40" onClick={() => setOpen(v => (v === r.endUser ? null : r.endUser))} aria-selected={open === r.endUser}>
                          <td className="py-1.5 pr-3 font-medium break-all">{r.endUser}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(r.requests)}</td>
                          <td className={`py-1.5 pr-3 text-right tabular-nums ${r.errors > 0 ? 'text-destructive' : ''}`}>{fmt(r.errors)}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(r.tokens)}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{r.avgLatencyMs === null ? '—' : `${fmt(r.avgLatencyMs)} ms`}</td>
                          {r.today && <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(r.today.requests)} req · {fmt(r.today.tokens)} tok</td>}
                          <td className="py-1.5 text-right">{r.lastRequestAt ? `${r.lastRequestAt.slice(5, 16)} UTC` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {rows.length === 0 && <p className="text-xs text-muted-foreground">No end user matches.</p>}
              </>
            )}
            {open && (
              <RecentRequestsCard
                endpoint={`/api/client-profiles/${profileId}/requests`}
                query={`&endUser=${encodeURIComponent(open)}`}
                title={`Requests of ${open}`}
              />
            )}
          </>
        )}
    </section>
  )
}
