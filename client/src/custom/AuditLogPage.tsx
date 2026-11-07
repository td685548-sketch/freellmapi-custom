import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAdministrativeAccess } from './use-administrative-access'

interface AuditEntry {
  id: number
  createdAt: string
  actorId: number | null
  actorEmail: string | null
  ip: string | null
  method: string
  path: string
  route: string
  area: string
  targetId: number | null
  status: number
  summary: unknown
}
interface AuditPage { entries: AuditEntry[]; areas: string[] }

const PAGE = 50
const METHOD: Record<string, string> = { POST: 'Created / ran', PUT: 'Changed', PATCH: 'Changed', DELETE: 'Deleted' }
const AREA: Record<string, string> = {
  'client-profiles': 'Client keys', 'admin/users': 'Accounts', keys: 'Provider keys', invites: 'Invites', profiles: 'Routing profiles',
  'settings/usage-alerts': 'Alerts', 'settings/usage-report': 'Weekly report', settings: 'Settings', 'admin/registration-requests': 'Access requests',
  'user/keys': 'Own personal keys', models: 'Models', fallback: 'Fallback', backups: 'Backups', cache: 'Cache', 'x-gateway': 'X Gateway',
}
const areaLabel = (a: string) => AREA[a] ?? a

/** /audit — who changed what on the dashboard, newest first. */
export function AuditLogPage() {
  const { can, isPending } = useAdministrativeAccess()
  const allowed = can('view_audit_log')
  const [area, setArea] = useState('')
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const params = (before?: number) => {
    const p = new URLSearchParams({ limit: String(PAGE) })
    if (area) p.set('area', area)
    if (q) p.set('q', q)
    if (before) p.set('before', String(before))
    return p.toString()
  }
  const log = useInfiniteQuery<AuditPage>({
    queryKey: ['audit', area, q],
    queryFn: ({ pageParam }) => apiFetch(`/api/audit?${params(pageParam as number | undefined)}`),
    initialPageParam: undefined,
    getNextPageParam: (last) => (last.entries.length === PAGE ? last.entries[last.entries.length - 1]!.id : undefined),
    enabled: allowed,
  })

  if (isPending) return <p role="status">Loading permissions…</p>
  if (!allowed) return <p role="alert" className="text-sm text-muted-foreground">Your account does not have permission to open this page.</p>

  const entries = log.data?.pages.flatMap(p => p.entries) ?? []
  const areas = log.data?.pages[0]?.areas ?? []
  return (
    <div className="space-y-6">
      <PageHeader title="Change history" description="Every change made on the dashboard: who, when, and what was sent (secrets hidden). Kept 180 days." />
      <div className="flex flex-wrap items-center gap-2">
        <select value={area} onChange={(e) => setArea(e.target.value)} aria-label="Area" className="h-8 rounded-lg border bg-background px-2 text-xs">
          <option value="">All areas</option>
          {[...new Set([...areas, area].filter(Boolean))].map(a => <option key={a} value={a}>{areaLabel(a)}</option>)}
        </select>
        <form className="relative" onSubmit={(e) => { e.preventDefault(); setQ(text.trim()) }}>
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search email, path or values…" aria-label="Search the history" className="h-8 w-64 pl-8 text-xs" />
        </form>
      </div>

      {log.isLoading ? <p role="status" className="text-sm text-muted-foreground">Loading…</p>
        : log.isError ? <p role="alert" className="text-sm text-destructive">Could not load the history.</p>
          : entries.length === 0 ? <p className="text-sm text-muted-foreground">No changes recorded{q || area ? ' for this filter' : ' yet'}.</p>
            : (
              <ul className="divide-y rounded-2xl border bg-card" aria-label="Changes">
                {entries.map(e => (
                  <li key={e.id} className="px-4 py-2.5 text-xs">
                    <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                      <span className="tabular-nums text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</span>
                      <span className="font-medium">{e.actorEmail ?? 'unknown'}</span>
                      <span>{METHOD[e.method] ?? e.method}</span>
                      <span className="rounded-full border px-1.5 py-0.5 text-[10px]">{areaLabel(e.area)}{e.targetId !== null ? ` #${e.targetId}` : ''}</span>
                      <code className="truncate text-muted-foreground">{e.method} {e.route}</code>
                    </button>
                    {open === e.id && (
                      <div className="mt-2 space-y-1 text-muted-foreground">
                        <p>Path <code>{e.path}</code> · answered {e.status}{e.ip ? ` · from ${e.ip}` : ''}</p>
                        {e.summary !== null && <pre className="max-h-64 overflow-auto rounded-lg bg-muted/50 p-2 text-[11px]">{JSON.stringify(e.summary, null, 2)}</pre>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
      {log.hasNextPage && <Button variant="outline" size="sm" onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>Load older</Button>}
    </div>
  )
}

export default AuditLogPage
