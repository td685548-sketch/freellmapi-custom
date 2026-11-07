import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, CircleAlert, Clock, Coins, Gauge } from 'lucide-react'
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'

import type { RequestAnalytics } from '../../../shared/user-analytics'
import { useCustomT } from './i18n/use-custom-t'
export type { RequestAnalytics, UserAnalytics, ProfileAnalytics } from '../../../shared/user-analytics'

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
 * One subject's usage: an account (admin route for a chosen account, or the caller's
 * own) or a client profile. Every endpoint answers `{ analytics }`. `scope` finishes the
 * sentence "Requests made with …"; `header` renders above the numbers once loaded.
 */
export function UserAnalyticsView({
  endpoint,
  queryKey,
  scope = 'a personal key',
  header,
}: {
  endpoint: string
  queryKey: unknown[]
  scope?: string
  header?: (analytics: RequestAnalytics) => ReactNode
}) {
  const tc = useCustomT()
  const [days, setDays] = useState<'7' | '30' | '90'>('30')

  const { data, isLoading, isError, error, refetch } = useQuery<{ analytics: RequestAnalytics }>({
    queryKey: [...queryKey, days],
    queryFn: () => apiFetch<{ analytics: RequestAnalytics }>(`${endpoint}?days=${days}`),
  })

  const a = data?.analytics
  const range = (
    <SegmentedControl ariaLabel="Time range" value={days} onValueChange={setDays} options={RANGES.map(o => ({ ...o, label: tc(o.label) }))} />
  )

  if (isLoading) return <p className="text-sm text-muted-foreground" role="status">{tc('Loading usage…')}</p>
  if (isError || !a) {
    return (
      <div className="space-y-3" role="alert">
        <p className="text-sm font-medium text-destructive">{error?.message || tc('Could not load usage.')}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>{tc('Retry')}</Button>
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
      {header?.(a)}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{tc('Requests made with {scope}, last {days} days (UTC).', { scope: tc(scope), days: a.days })}{a.retainedSince ? tc(' Oldest retained request: {retainedSince}.', { retainedSince: a.retainedSince.slice(0, 10) }) : ''}
        </p>
        {range}
      </div>

      {t.requests === 0 ? (
        <div className="rounded-2xl border bg-card p-8 text-center space-y-1">
          <Activity className="size-8 mx-auto text-muted-foreground opacity-50" />
          <p className="text-sm font-medium">{tc('No requests in this window')}</p>
          <p className="text-xs text-muted-foreground">{tc('Only traffic sent with {scope} is counted here.', { scope: tc(scope) })}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Tile icon={Activity} label={tc('Requests')} value={fmt(t.requests)} hint={t.canceled > 0 ? tc('{canceled} canceled', { canceled: fmt(t.canceled) }) : undefined} />
            <Tile icon={CircleAlert} label={tc('Success rate')} value={successRate} hint={tc('{errors} errors', { errors: fmt(t.errors) })} />
            <Tile icon={Coins} label={tc('Tokens')} value={fmt(tokens)} hint={tc('{input} in · {output} out', { input: fmt(t.inputTokens), output: fmt(t.outputTokens) })} />
            <Tile icon={Gauge} label={tc('Avg latency')} value={t.avgLatencyMs == null ? '—' : `${fmt(t.avgLatencyMs)} ms`} hint={tc('successful requests')} />
            <Tile icon={Clock} label={tc('Last request')} value={t.lastRequestAt ? t.lastRequestAt.slice(0, 10) : '—'} hint={t.lastRequestAt ? `${t.lastRequestAt.slice(11, 16)} UTC` : undefined} />
          </div>

          <div className="rounded-2xl border bg-card p-4 space-y-3">
            <h3 className="text-sm font-semibold">{tc('Requests per day')}</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={daily} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" />
                <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={{ stroke: 'var(--border)' }} interval="preserveStartEnd" minTickGap={24} />
                <YAxis tick={axisStyle} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 12 }} iconType="rect" />
                <Bar dataKey="ok" name={tc('Succeeded / other')} stackId="r" fill="var(--series-a)" maxBarSize={24} />
                <Bar dataKey="errors" name={tc('Errors')} stackId="r" fill="var(--destructive)" radius={[3, 3, 0, 0]} maxBarSize={24} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="rounded-2xl border bg-card overflow-hidden">
            <h3 className="text-sm font-semibold px-4 py-3 border-b">{tc('Models used')}</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="px-4 py-2 font-medium">{tc('Model')}</th>
                    <th className="px-4 py-2 font-medium text-right">{tc('Requests')}</th>
                    <th className="px-4 py-2 font-medium text-right">{tc('Errors')}</th>
                    <th className="px-4 py-2 font-medium text-right">{tc('Tokens')}</th>
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
