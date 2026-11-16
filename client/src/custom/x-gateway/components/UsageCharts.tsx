import { useMemo, useState } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import { Cpu, Server } from 'lucide-react'

const COLORS = ['#6366f1', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#10b981', '#f97316']

const fmtTokens = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n || 0)
}

const truncate = (s: string, max = 22) => (s && s.length > max ? `${s.slice(0, max)}…` : s || '')

export interface ProviderChartEntry {
  provider: string
  name: string
  tokens: number
  requests: number
}

export interface ModelChartEntry {
  model: string
  tokens: number
  requests: number
}

function MetricToggle({
  value,
  onChange,
}: {
  value: 'tokens' | 'requests'
  onChange: (next: 'tokens' | 'requests') => void
}) {
  return (
    <div className="grid grid-cols-2 items-center gap-1 rounded-lg border border-border bg-black/5 dark:bg-white/5 p-0.5">
      <button
        type="button"
        onClick={() => onChange('tokens')}
        className={`rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors ${
          value === 'tokens' ? 'bg-blue-600 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        Tokens
      </button>
      <button
        type="button"
        onClick={() => onChange('requests')}
        className={`rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors ${
          value === 'requests' ? 'bg-blue-600 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        Requests
      </button>
    </div>
  )
}

export function ProviderBarChart({ providers }: { providers: ProviderChartEntry[] }) {
  const [viewMode, setViewMode] = useState<'tokens' | 'requests'>('tokens')

  const chartData = useMemo(
    () =>
      providers
        .filter(p => p[viewMode] > 0)
        .sort((a, b) => b[viewMode] - a[viewMode])
        .slice(0, 8),
    [providers, viewMode],
  )

  const fmt = viewMode === 'tokens' ? fmtTokens : (n: number) => n.toLocaleString()
  const label = viewMode === 'tokens' ? 'Tokens' : 'Requests'

  return (
    <section className="x-panel flex min-w-0 flex-col gap-3" style={{ padding: '1rem 1.25rem' }}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Server size={16} color="#10b981" />
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>Top Providers by Volume</h3>
        </div>
        <MetricToggle value={viewMode} onChange={setViewMode} />
      </div>

      {chartData.length === 0 ? (
        <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">
          No provider usage yet.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={190}>
          <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.12} vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 10, fill: 'currentColor', fillOpacity: 0.65 }}
              tickLine={false}
              axisLine={false}
              interval={0}
              tickFormatter={(v: string) => (v.length > 12 ? `${v.slice(0, 12)}…` : v)}
            />
            <YAxis
              tick={{ fontSize: 10, fill: 'currentColor', fillOpacity: 0.55 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={fmt}
              width={44}
            />
            <Tooltip
              formatter={(value: unknown) => [fmt(Number(value) || 0), label]}
            />
            <Bar dataKey={viewMode} radius={[4, 4, 0, 0]}>
              {chartData.map((entry, i) => (
                <Cell key={entry.provider} fill={COLORS[i % COLORS.length]} fillOpacity={0.85} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </section>
  )
}

export function TopModelsChart({ models }: { models: ModelChartEntry[] }) {
  const [viewMode, setViewMode] = useState<'tokens' | 'requests'>('tokens')

  const chartData = useMemo(
    () =>
      models
        .map(m => ({ ...m, shortName: truncate(m.model) }))
        .filter(m => m[viewMode] > 0)
        .sort((a, b) => b[viewMode] - a[viewMode])
        .slice(0, 5),
    [models, viewMode],
  )

  const fmt = viewMode === 'tokens' ? fmtTokens : (n: number) => n.toLocaleString()
  const label = viewMode === 'tokens' ? 'Tokens' : 'Requests'

  return (
    <section className="x-panel flex min-w-0 flex-col gap-3" style={{ padding: '1rem 1.25rem' }}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Cpu size={16} color="#3b82f6" />
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>Top Models by Consumption</h3>
        </div>
        <MetricToggle value={viewMode} onChange={setViewMode} />
      </div>

      {chartData.length === 0 ? (
        <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">
          No model usage yet.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={190}>
          <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 24, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.12} horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 10, fill: 'currentColor', fillOpacity: 0.55 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={fmt}
            />
            <YAxis
              type="category"
              dataKey="shortName"
              tick={{ fontSize: 10, fill: 'currentColor', fillOpacity: 0.7 }}
              tickLine={false}
              axisLine={false}
              width={100}
            />
            <Tooltip
              formatter={(value: unknown) => [fmt(Number(value) || 0), label]}
            />
            <Bar dataKey={viewMode} radius={[0, 4, 4, 0]}>
              {chartData.map((entry, i) => (
                <Cell key={entry.model} fill={COLORS[i % COLORS.length]} fillOpacity={0.85} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </section>
  )
}
