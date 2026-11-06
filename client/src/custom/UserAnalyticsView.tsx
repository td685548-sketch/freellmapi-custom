import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, CircleAlert, Clock, Coins, Gauge } from 'lucide-react'
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'

import type { UserAnalytics } from '../../../shared/user-analytics'
export type { UserAnalytics } from '../../../shared/user-analytics'

const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
] as const

const axisStyle = { fontSize: 11, fill: 'var(--muted-foreground)' } as const
const tooltipStyle = { backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 } as const

const fmt = (n: number) => n.toLocaleString()

function Tile({ icon: Icon, label, value, hint }: { icon: typeof Activity; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border bg-card p-4 space-y-1">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

/**
 * One account's usage. `endpoint` is the admin route for a chosen account or the
 * caller's own; both answer `{ analytics }`. Requests count only traffic that came
 * in with a personal `sk-flm-…` key.
 */
export function UserAnalyticsView({ endpoint, queryKey }: { endpoint: string; queryKey: unknown[] }) {
  const [days, setDays] = useState<'7' | '30' | '90'>('30')

  const { data, isLoading, isError, error, refetch } = useQuery<{ analytics: UserAnalytics }>({
    queryKey: [...queryKey, days],
    queryFn: () => apiFetch<{ analytics: UserAnalytics }>(`${endpoint}?days=${days}`),
  })

  const a = data?.analytics
  const range = (
    <SegmentedControl ariaLabel="Time range" value={days} onValueChange={setDays} options={[...RANGES]} />
  )

  if (isLoading) return <p className="text-sm text-muted-foreground" role="status">Loading usage…</p>
  if (isError || !a) {
    return (
      <div className="space-y-3" role="alert">
        <p className="text-sm font-medium text-destructive">{error?.message || 'Could not load usage.'}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
      </div>
    )
  }

  const t = a.totals
  const finished = t.success + t.errors
  const successRate = finished > 0 ? `${((t.success / finished) * 100).toFixed(1)}%` : '—'
  const tokens = t.inputTokens + t.outputTokens
  const daily = a.daily.map(d => ({ ...d, ok: Math.max(0, d.requests - d.errors), label: d.date.slice(5) }))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Requests made with a personal key, last {a.days} days (UTC).
          {a.retainedSince ? ` Oldest retained request: ${a.retainedSince.slice(0, 10)}.` : ''}
        </p>
        {range}
      </div>

      {t.requests === 0 ? (
        <div className="rounded-2xl border bg-card p-8 text-center space-y-1">
          <Activity className="size-8 mx-auto text-muted-foreground opacity-50" />
          <p className="text-sm font-medium">No requests in this window</p>
          <p className="text-xs text-muted-foreground">
            Only traffic sent with a personal sk-flm-… key is attributed to an account.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Tile icon={Activity} label="Requests" value={fmt(t.requests)} hint={t.canceled > 0 ? `${fmt(t.canceled)} canceled` : undefined} />
            <Tile icon={CircleAlert} label="Success rate" value={successRate} hint={`${fmt(t.errors)} errors`} />
            <Tile icon={Coins} label="Tokens" value={fmt(tokens)} hint={`${fmt(t.inputTokens)} in · ${fmt(t.outputTokens)} out`} />
            <Tile icon={Gauge} label="Avg latency" value={t.avgLatencyMs == null ? '—' : `${fmt(t.avgLatencyMs)} ms`} hint="successful requests" />
            <Tile icon={Clock} label="Last request" value={t.lastRequestAt ? t.lastRequestAt.slice(0, 10) : '—'} hint={t.lastRequestAt ? `${t.lastRequestAt.slice(11, 16)} UTC` : undefined} />
          </div>

          <div className="rounded-2xl border bg-card p-4 space-y-3">
            <h3 className="text-sm font-semibold">Requests per day</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={daily} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" />
                <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={{ stroke: 'var(--border)' }} interval="preserveStartEnd" minTickGap={24} />
                <YAxis tick={axisStyle} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 12 }} iconType="rect" />
                <Bar dataKey="ok" name="Succeeded / other" stackId="r" fill="var(--series-a)" maxBarSize={24} />
                <Bar dataKey="errors" name="Errors" stackId="r" fill="var(--destructive)" radius={[3, 3, 0, 0]} maxBarSize={24} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="rounded-2xl border bg-card overflow-hidden">
            <h3 className="text-sm font-semibold px-4 py-3 border-b">Models used</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="px-4 py-2 font-medium">Model</th>
                    <th className="px-4 py-2 font-medium text-right">Requests</th>
                    <th className="px-4 py-2 font-medium text-right">Errors</th>
                    <th className="px-4 py-2 font-medium text-right">Tokens</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {a.models.map(m => (
                    <tr key={`${m.platform}/${m.modelId}`}>
                      <td className="px-4 py-2"><span className="font-medium">{m.modelId}</span> <span className="text-xs text-muted-foreground">{m.platform}</span></td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmt(m.requests)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmt(m.errors)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmt(m.tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default UserAnalyticsView
