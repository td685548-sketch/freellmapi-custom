import { useState } from 'react'
import { Download } from 'lucide-react'
import { getToken } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCustomT } from './i18n/use-custom-t'

const DAY_MS = 86_400_000
const MAX_RANGE_DAYS = 731
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

type ExportKind = 'accounts' | 'profiles' | 'end-users'

// The export is a file, not JSON, so it goes through fetch directly with the dashboard's bearer token.
export async function downloadUsageCsv(kind: ExportKind, from: string, to: string): Promise<boolean> {
  const token = getToken()
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  const res = await fetch(`${base}/api/usage/export/${kind}.csv?from=${from}&to=${to}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    toast.error(body?.error?.message ?? `HTTP ${res.status}`)
    return false
  }
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = `usage-${kind}-${from}-to-${to}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return true
}

/** Daily figures as CSV over any range of up to two years (kept beyond the request log's 90 days). */
export function UsageExportCard({ canAccounts, canProfiles }: { canAccounts: boolean; canProfiles: boolean }) {
  const tc = useCustomT()
  const [to, setTo] = useState(() => day(Date.now()))
  const [from, setFrom] = useState(() => day(Date.now() - 29 * DAY_MS))
  const [busy, setBusy] = useState<ExportKind | null>(null)
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && span >= 0 && span < MAX_RANGE_DAYS
  const run = async (kind: ExportKind) => {
    setBusy(kind)
    try { await downloadUsageCsv(kind, from, to) } finally { setBusy(null) }
  }
  const kinds: Array<{ kind: ExportKind; label: string; show: boolean }> = [
    { kind: 'accounts', label: 'Accounts', show: canAccounts },
    { kind: 'profiles', label: 'Client keys', show: canProfiles },
    { kind: 'end-users', label: 'End users', show: canProfiles },
  ]
  return (
    <section className="rounded-2xl border bg-card p-4 space-y-3" aria-label="Export usage">
      <div>
        <h3 className="text-sm font-semibold">{tc('Export daily usage (CSV)')}</h3>
        <p className="text-xs text-muted-foreground">{tc('One row per day and account, client key or end user. Finished days are kept for two years (end users 400 days), even after the request log drops them.')}</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-[11px] text-muted-foreground">
          <span className="block">{tc('From')}</span>
          <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-8 w-40 text-xs" aria-label="From day" />
        </label>
        <label className="space-y-1 text-[11px] text-muted-foreground">
          <span className="block">{tc('To')}</span>
          <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="h-8 w-40 text-xs" aria-label="To day" />
        </label>
        {kinds.filter(k => k.show).map(k => (
          <Button key={k.kind} variant="outline" size="sm" className="h-8 text-xs" disabled={!valid || busy !== null} onClick={() => void run(k.kind)}>
            <Download className="size-3.5 mr-1" />{busy === k.kind ? tc('Preparing…') : tc(k.label)}
          </Button>
        ))}
      </div>
      {!valid && <p className="text-xs text-destructive">{tc('Pick a start day before the end day, at most two years apart.')}</p>}
    </section>
  )
}
