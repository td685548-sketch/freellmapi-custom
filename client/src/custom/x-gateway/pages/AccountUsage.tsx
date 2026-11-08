import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import {
  Activity,
  BarChart3,
  Coins,
  Cpu,
  Layers,
  Search,
  Server,
  X,
} from 'lucide-react'
import { useAccounts } from '../api'
import { useXStrings } from '../strings'
import { useSessionRevision } from '../../session-state'
import { mgmtApi } from '../management-api'
import { AccountLoadState } from './Providers'

type TimeRange = '24h' | '7d' | '30d' | 'all'

const fmtTokens = (n: number) => {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

const fmtCost = (tokens: number) => {
  // Blended average cost estimation: ~$0.002 per 1,000 tokens
  const dollars = (tokens / 1_000) * 0.002
  if (!dollars || dollars <= 0) return '$0.00'
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`
  return `$${dollars.toFixed(2)}`
}

export default function AccountUsage() {
  const s = useXStrings()
  const revision = useSessionRevision()
  const query = useAccounts()

  // Filters State
  const [timeRange, setTimeRange] = useState<TimeRange>('7d')
  const [providerSearch, setProviderSearch] = useState('')
  const [chartMetric, setChartMetric] = useState<'requests' | 'tokens'>('tokens')

  // Hourly and Logs Queries
  const hourlyQuery = useQuery({
    queryKey: ['x-hourly-usage', revision],
    queryFn: ({ signal }) => mgmtApi.hourly(signal),
    refetchInterval: 30_000,
    retry: false,
  })

  const logsQuery = useQuery({
    queryKey: ['x-logs-usage', revision],
    queryFn: ({ signal }) => mgmtApi.logs('', signal),
    refetchInterval: 15_000,
    retry: false,
  })

  const rawProviders = query.data?.providers ?? []
  const accounts = useMemo(() => {
    return rawProviders.flatMap(provider =>
      provider.accounts.map(account => ({
        ...account,
        providerName: provider.name,
      }))
    )
  }, [rawProviders])

  // Filter accounts by provider search
  const filteredAccounts = useMemo(() => {
    if (!providerSearch.trim()) return accounts
    const q = providerSearch.toLowerCase()
    return accounts.filter(
      acc =>
        acc.provider.toLowerCase().includes(q) ||
        acc.providerName.toLowerCase().includes(q) ||
        acc.label?.toLowerCase().includes(q)
    )
  }, [accounts, providerSearch])

  // Aggregate metrics
  const totalAccounts = accounts.length
  const totalRequests = accounts.reduce((sum, a) => sum + a.monthlyUsage.requests, 0)
  const totalTokens = accounts.reduce((sum, a) => sum + a.monthlyUsage.tokens, 0)
  const estimatedCost = fmtCost(totalTokens)

  // Chart data calculation
  const hourlyBuckets = hourlyQuery.data?.buckets ?? []
  const chartData = useMemo(() => {
    if (hourlyBuckets.length > 0) {
      return hourlyBuckets.map(b => ({
        time: b.hour.slice(11, 16) || b.hour,
        fullTime: b.hour.replace('T', ' '),
        requests: b.requests,
        tokens: b.inputTokens + b.outputTokens,
      }))
    }
    // Fallback: mock or empty points
    return [
      { time: '00:00', requests: 0, tokens: 0 },
      { time: '06:00', requests: 0, tokens: 0 },
      { time: '12:00', requests: 0, tokens: 0 },
      { time: '18:00', requests: 0, tokens: 0 },
      { time: '23:59', requests: 0, tokens: 0 },
    ]
  }, [hourlyBuckets])

  // Top Models ranking from logs
  const topModels = useMemo(() => {
    const logs = logsQuery.data?.logs ?? []
    const map: Record<string, { model: string; requests: number; tokens: number; errors: number }> = {}

    for (const log of logs) {
      const modelName = log.requestedModel || log.modelId || 'unknown'
      if (!map[modelName]) {
        map[modelName] = { model: modelName, requests: 0, tokens: 0, errors: 0 }
      }
      map[modelName].requests += 1
      map[modelName].tokens += (log.inputTokens || 0) + (log.outputTokens || 0)
      if (log.status === 'error') map[modelName].errors += 1
    }

    const list = Object.values(map)
    list.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests)
    return list.slice(0, 5)
  }, [logsQuery.data?.logs])

  // Top Providers ranking from accounts & logs
  const topProviders = useMemo(() => {
    const map: Record<string, { provider: string; name: string; requests: number; tokens: number; accountsCount: number }> = {}

    for (const acc of accounts) {
      if (!map[acc.provider]) {
        map[acc.provider] = {
          provider: acc.provider,
          name: acc.providerName || acc.provider,
          requests: 0,
          tokens: 0,
          accountsCount: 0,
        }
      }
      map[acc.provider].requests += acc.monthlyUsage.requests
      map[acc.provider].tokens += acc.monthlyUsage.tokens
      map[acc.provider].accountsCount += 1
    }

    const list = Object.values(map)
    list.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests)
    return list.slice(0, 5)
  }, [accounts])

  if (query.isPending) return <AccountLoadState />
  if (query.isError) return <AccountLoadState error retry={() => void query.refetch()} />

  return (
    <>
      <div className="x-page-heading">
        <div>
          <h1>{s.usage}</h1>
          <p>{s.usageHelp}</p>
        </div>
        <span className="x-heading-icon"><BarChart3 size={28} /></span>
      </div>

      {/* Primary KPI Stats Cards */}
      <div className="x-stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        <div className="x-panel" style={{ padding: '1rem', textAlign: 'center' }}>
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{s.totalAccounts}</span>
          <strong style={{ fontSize: '1.4rem', display: 'block', marginTop: '0.25rem' }}>{totalAccounts}</strong>
        </div>
        <div className="x-panel" style={{ padding: '1rem', textAlign: 'center' }}>
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{s.requests}</span>
          <strong style={{ fontSize: '1.4rem', display: 'block', marginTop: '0.25rem' }}>{totalRequests.toLocaleString()}</strong>
        </div>
        <div className="x-panel" style={{ padding: '1rem', textAlign: 'center' }}>
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{s.tokens}</span>
          <strong style={{ fontSize: '1.4rem', display: 'block', marginTop: '0.25rem', color: '#10b981' }}>{fmtTokens(totalTokens)}</strong>
        </div>
        <div className="x-panel" style={{ padding: '1rem', textAlign: 'center' }}>
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
            <Coins size={14} color="#f59e0b" /> Estimated Cost
          </span>
          <strong style={{ fontSize: '1.4rem', display: 'block', marginTop: '0.25rem', color: '#f59e0b' }}>
            {estimatedCost}
          </strong>
        </div>
      </div>

      {/* Visual Analytics Chart & Range Toolbar */}
      <section className="x-panel" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Activity size={20} color="#10b981" />
            <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Traffic & Token Velocity</h2>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            {/* Metric Toggle */}
            <div style={{ display: 'flex', gap: '0.2rem', background: 'var(--bg-subtle, rgba(0,0,0,0.06))', padding: '0.2rem', borderRadius: '6px' }}>
              <button
                type="button"
                onClick={() => setChartMetric('tokens')}
                style={{
                  padding: '0.25rem 0.65rem',
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  border: 'none',
                  background: chartMetric === 'tokens' ? '#10b981' : 'transparent',
                  color: chartMetric === 'tokens' ? '#fff' : 'inherit',
                }}
              >
                Tokens
              </button>
              <button
                type="button"
                onClick={() => setChartMetric('requests')}
                style={{
                  padding: '0.25rem 0.65rem',
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  border: 'none',
                  background: chartMetric === 'requests' ? '#10b981' : 'transparent',
                  color: chartMetric === 'requests' ? '#fff' : 'inherit',
                }}
              >
                Requests
              </button>
            </div>

            {/* Time Range Filter Buttons */}
            <div style={{ display: 'flex', gap: '0.25rem', background: 'var(--bg-subtle, rgba(0,0,0,0.06))', padding: '0.2rem', borderRadius: '6px' }}>
              {(['24h', '7d', '30d', 'all'] as const).map(tr => (
                <button
                  key={tr}
                  type="button"
                  onClick={() => setTimeRange(tr)}
                  style={{
                    padding: '0.25rem 0.65rem',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                    border: 'none',
                    background: timeRange === tr ? 'var(--primary, #3b82f6)' : 'transparent',
                    color: timeRange === tr ? '#fff' : 'inherit',
                  }}
                >
                  {tr.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Chart View */}
        <div style={{ width: '100%', height: 230 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="usageGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={chartMetric === 'tokens' ? '#10b981' : '#3b82f6'} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={chartMetric === 'tokens' ? '#10b981' : '#3b82f6'} stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
              <XAxis dataKey="time" tick={{ fontSize: 11 }} />
              <YAxis
                tick={{ fontSize: 11 }}
                tickFormatter={v => chartMetric === 'tokens' ? fmtTokens(v) : Number(v).toLocaleString()}
                width={45}
              />
              <Tooltip
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                formatter={(val: any) => [
                  chartMetric === 'tokens' ? `${fmtTokens(Number(val) || 0)} tokens` : `${Number(val || 0).toLocaleString()} requests`,
                  chartMetric === 'tokens' ? 'Lượng Token' : 'Lượng Requests',
                ] as [string, string]}
                labelFormatter={label => `Thời gian: ${label}`}
              />
              <Area
                type="monotone"
                dataKey={chartMetric}
                stroke={chartMetric === 'tokens' ? '#10b981' : '#3b82f6'}
                strokeWidth={2}
                fill="url(#usageGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Two Column Section: Top Models & Top Providers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.25rem', marginBottom: '1.5rem' }}>
        {/* Top Models Card */}
        <section className="x-panel" style={{ padding: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <Cpu size={18} color="#3b82f6" />
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Top Models by Consumption</h3>
          </div>
          {topModels.length === 0 ? (
            <p className="x-caption" style={{ margin: 0 }}>Chưa có dữ liệu yêu cầu gần đây.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              {topModels.map(m => (
                <div
                  key={m.model}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.5rem 0.75rem',
                    background: 'var(--bg-subtle, rgba(0,0,0,0.03))',
                    borderRadius: '6px',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>
                    <code style={{ fontSize: '0.85rem' }}>{m.model}</code>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {m.requests.toLocaleString()} requests {m.errors > 0 && <span style={{ color: '#f87171' }}>({m.errors} errors)</span>}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <strong style={{ fontSize: '0.9rem', color: '#10b981' }}>{fmtTokens(m.tokens)}</strong>
                    <div style={{ fontSize: '0.75rem', color: '#f59e0b' }}>{fmtCost(m.tokens)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Top Providers Card */}
        <section className="x-panel" style={{ padding: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <Server size={18} color="#10b981" />
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Top Providers by Volume</h3>
          </div>
          {topProviders.length === 0 ? (
            <p className="x-caption" style={{ margin: 0 }}>Chưa có nhà cung cấp nào được kết nối.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              {topProviders.map(p => (
                <div
                  key={p.provider}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.5rem 0.75rem',
                    background: 'var(--bg-subtle, rgba(0,0,0,0.03))',
                    borderRadius: '6px',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div>
                    <strong style={{ fontSize: '0.9rem' }}>{p.name}</strong>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {p.accountsCount} tài khoản kết nối • {p.requests.toLocaleString()} requests
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <strong style={{ fontSize: '0.9rem', color: '#10b981' }}>{fmtTokens(p.tokens)}</strong>
                    <div style={{ fontSize: '0.75rem', color: '#f59e0b' }}>{fmtCost(p.tokens)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Account Usage Breakdown Table & Provider Search */}
      <section className="x-panel" style={{ padding: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Layers size={18} />
            <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>Chi tiết hạn mức & Sử dụng theo tài khoản</h3>
          </div>

          {/* Search / Filter Provider Input */}
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Search size={14} style={{ position: 'absolute', left: '0.6rem', color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="Tìm kiếm tài khoản / Provider..."
              value={providerSearch}
              onChange={e => setProviderSearch(e.target.value)}
              style={{
                padding: '0.375rem 0.6rem 0.375rem 2rem',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                backgroundColor: 'var(--bg-subtle, rgba(0,0,0,0.03))',
                fontSize: '0.8125rem',
                width: '240px',
              }}
            />
            {providerSearch && (
              <button
                type="button"
                onClick={() => setProviderSearch('')}
                style={{ position: 'absolute', right: '0.5rem', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        <div className="x-table-wrap">
          <table className="x-table">
            <thead>
              <tr>
                <th>{s.accounts}</th>
                <th>{s.providers}</th>
                <th>{s.requests}</th>
                <th>{s.tokens}</th>
                <th>Ước tính chi phí</th>
              </tr>
            </thead>
            <tbody>
              {filteredAccounts.map(account => (
                <tr key={account.id}>
                  <th>
                    <Link to={`/x/providers/${encodeURIComponent(account.provider)}`}>
                      {account.label || account.providerName}
                    </Link>
                  </th>
                  <td>{account.providerName}</td>
                  <td>
                    {account.monthlyUsage.requests.toLocaleString()}
                    <small> / {account.monthlyRequestCap || '∞'}</small>
                  </td>
                  <td>
                    {account.monthlyUsage.tokens.toLocaleString()}
                    <small> / {account.monthlyTokenCap || '∞'}</small>
                  </td>
                  <td>
                    <span style={{ color: '#f59e0b', fontWeight: 500 }}>
                      {fmtCost(account.monthlyUsage.tokens)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filteredAccounts.length && (
            <div className="x-empty">
              <p>{providerSearch ? 'Không tìm thấy tài khoản phù hợp với từ khóa.' : s.noAccounts}</p>
              {!accounts.length && (
                <Link className="x-button" to="/x/providers">
                  {s.addAccount}
                </Link>
              )}
            </div>
          )}
        </div>
      </section>
    </>
  )
}
