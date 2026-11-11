import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
  Plus,
  RotateCcw,
  Save,
  Search,
  Server,
  Sliders,
  X,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useAccounts } from '../api'
import { useXStrings } from '../strings'
import { useSessionRevision } from '../../session-state'
import { useUserSession } from '../../use-session'
import { mgmtApi } from '../management-api'
import { AccountLoadState } from './Providers'
import ProviderTopology, { type TopologyNode } from '../components/ProviderTopology'

type TimeRange = '24h' | '7d' | '30d' | 'all'

export interface ModelPricingRate {
  input: number
  output: number
  cached?: number
  reasoning?: number
  cache_creation?: number
}

export type ProviderPricingMap = Record<string, Record<string, ModelPricingRate>>

interface PricingResponse {
  pricing: ProviderPricingMap
  defaults: ProviderPricingMap
  overrides: ProviderPricingMap
}

const FALLBACK_RATE: ModelPricingRate = {
  input: 1.0,
  output: 3.0,
  cached: 0.5,
  reasoning: 3.0,
}

export function resolveClientModelPricing(
  provider: string | undefined,
  model: string | undefined,
  pricingMap: ProviderPricingMap | undefined,
): ModelPricingRate {
  const normProvider = (provider ?? '').trim().toLowerCase()
  const rawModel = (model ?? '').trim()

  if (rawModel.toLowerCase().includes(':free') || rawModel.toLowerCase().startsWith('cline-free/')) {
    return { input: 0, output: 0, cached: 0, reasoning: 0 }
  }

  if (pricingMap) {
    if (normProvider && rawModel && pricingMap[normProvider]?.[rawModel]) {
      return pricingMap[normProvider][rawModel]
    }
    const slashIdx = rawModel.indexOf('/')
    const stripped = slashIdx >= 0 ? rawModel.slice(slashIdx + 1) : rawModel
    const prefix = slashIdx > 0 ? rawModel.slice(0, slashIdx).toLowerCase() : ''

    if (normProvider && stripped && pricingMap[normProvider]?.[stripped]) {
      return pricingMap[normProvider][stripped]
    }
    if (prefix && stripped && pricingMap[prefix]?.[stripped]) {
      return pricingMap[prefix][stripped]
    }
    for (const models of Object.values(pricingMap)) {
      if (rawModel && models[rawModel]) return models[rawModel]
      if (stripped && models[stripped]) return models[stripped]
    }
    if (normProvider && pricingMap[normProvider]) {
      const entries = Object.values(pricingMap[normProvider])
      if (entries.length > 0) {
        const avgIn = entries.reduce((s, e) => s + e.input, 0) / entries.length
        const avgOut = entries.reduce((s, e) => s + e.output, 0) / entries.length
        return { input: avgIn, output: avgOut }
      }
    }
  }

  return FALLBACK_RATE
}

export function calculateTokenCostDollars(
  provider: string | undefined,
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  pricingMap: ProviderPricingMap | undefined,
): number {
  const rate = resolveClientModelPricing(provider, model, pricingMap)
  const inTok = Math.max(0, Number(inputTokens) || 0)
  const outTok = Math.max(0, Number(outputTokens) || 0)
  return (inTok * rate.input + outTok * rate.output) / 1_000_000
}

export function calculateBlendedTokensCostDollars(
  provider: string | undefined,
  model: string | undefined,
  totalTokens: number,
  pricingMap: ProviderPricingMap | undefined,
): number {
  const tok = Math.max(0, Number(totalTokens) || 0)
  if (tok === 0) return 0
  // Standard 70% input / 30% output blend when only total token count is stored
  const inputTokens = tok * 0.7
  const outputTokens = tok * 0.3
  return calculateTokenCostDollars(provider, model, inputTokens, outputTokens, pricingMap)
}

export const fmtDollars = (dollars: number) => {
  if (!dollars || dollars <= 0) return '$0.00'
  if (dollars < 0.0001) return `$${dollars.toFixed(6)}`
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`
  return `$${dollars.toFixed(2)}`
}

const fmtTokens = (n: number) => {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

export default function AccountUsage() {
  const s = useXStrings()
  const revision = useSessionRevision()
  const session = useUserSession()
  const queryClient = useQueryClient()
  const canEditPricing =
    session.hasPermission('edit_x_settings') || session.hasPermission('manage_x_gateway')
  const query = useAccounts()

  // Filters State
  const [timeRange, setTimeRange] = useState<TimeRange>('7d')
  const [providerSearch, setProviderSearch] = useState('')
  const [breakdownTab, setBreakdownTab] = useState<BreakdownTab>('provider')
  const [chartMetric, setChartMetric] = useState<'requests' | 'tokens'>('tokens')

  // Pricing Modal / Drawer State
  const [showPricingModal, setShowPricingModal] = useState(false)
  const [pricingFilter, setPricingFilter] = useState('')
  const [pricingDraft, setPricingDraft] = useState<ProviderPricingMap | null>(null)
  const [newProvider, setNewProvider] = useState('')
  const [newModel, setNewModel] = useState('')
  const [newInputRate, setNewInputRate] = useState('1.0')
  const [newOutputRate, setNewOutputRate] = useState('3.0')
  const [newCachedRate, setNewCachedRate] = useState('0.5')

  // Hourly, Logs & Pricing Queries
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

  const pricingQuery = useQuery({
    queryKey: ['x-gateway-pricing', revision],
    queryFn: ({ signal }) => apiFetch<PricingResponse>('/api/x-gateway/pricing', { signal }),
    staleTime: 60_000,
    retry: false,
  })

  const breakdownQuery = useQuery({
    queryKey: ['x-usage-breakdown', timeRange, revision],
    queryFn: ({ signal }) =>
      apiFetch<UsageBreakdown>(`/api/x-gateway/usage/breakdown?range=${timeRange}`, { signal }),
    refetchInterval: 30_000,
    retry: false,
  })
  const breakdown = breakdownQuery.data

  const pricingMap = pricingDraft ?? pricingQuery.data?.pricing

  const savePricingMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: (patch: ProviderPricingMap) =>
      apiFetch<PricingResponse>('/api/x-gateway/pricing', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: async () => {
      setPricingDraft(null)
      await queryClient.invalidateQueries({ queryKey: ['x-gateway-pricing'] })
    },
  })

  const resetPricingMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: (params?: { provider?: string; model?: string }) => {
      const qs = new URLSearchParams()
      if (params?.provider) qs.set('provider', params.provider)
      if (params?.model) qs.set('model', params.model)
      const suffix = qs.toString() ? `?${qs.toString()}` : ''
      return apiFetch<PricingResponse>(`/api/x-gateway/pricing${suffix}`, {
        method: 'DELETE',
      })
    },
    onSuccess: async () => {
      setPricingDraft(null)
      await queryClient.invalidateQueries({ queryKey: ['x-gateway-pricing'] })
    },
  })

  const handleRateChange = (
    provider: string,
    model: string,
    field: 'input' | 'output' | 'cached',
    rawVal: string,
  ) => {
    const num = parseFloat(rawVal)
    if (Number.isNaN(num) || num < 0) return
    const base = pricingDraft ?? pricingQuery.data?.pricing ?? {}
    const next: ProviderPricingMap = { ...base }
    next[provider] = { ...(next[provider] ?? {}) }
    const current = next[provider][model] ?? { input: 1.0, output: 3.0, cached: 0.5 }
    next[provider][model] = {
      ...current,
      [field]: num,
    }
    setPricingDraft(next)
  }

  const handleAddCustomModelRate = () => {
    const p = newProvider.trim().toLowerCase()
    const m = newModel.trim()
    if (!p || !m) return
    const inp = Math.max(0, parseFloat(newInputRate) || 0)
    const out = Math.max(0, parseFloat(newOutputRate) || 0)
    const cac = Math.max(0, parseFloat(newCachedRate) || 0)
    const base = pricingDraft ?? pricingQuery.data?.pricing ?? {}
    const next: ProviderPricingMap = { ...base }
    next[p] = {
      ...(next[p] ?? {}),
      [m]: { input: inp, output: out, cached: cac },
    }
    setPricingDraft(next)
    setNewProvider('')
    setNewModel('')
  }

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

  // Aggregate metrics using real per-provider/model pricing
  const totalAccounts = accounts.length
  const totalRequests = accounts.reduce((sum, a) => sum + a.monthlyUsage.requests, 0)
  const totalTokens = accounts.reduce((sum, a) => sum + a.monthlyUsage.tokens, 0)
  const totalCostDollars = useMemo(() => {
    return accounts.reduce(
      (sum, a) => sum + calculateBlendedTokensCostDollars(a.provider, undefined, a.monthlyUsage.tokens, pricingMap),
      0,
    )
  }, [accounts, pricingMap])
  const estimatedCost = fmtDollars(totalCostDollars)

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
    return [
      { time: '00:00', requests: 0, tokens: 0 },
      { time: '06:00', requests: 0, tokens: 0 },
      { time: '12:00', requests: 0, tokens: 0 },
      { time: '18:00', requests: 0, tokens: 0 },
      { time: '23:59', requests: 0, tokens: 0 },
    ]
  }, [hourlyBuckets])

  // Top Models ranking from logs with exact input/output token pricing
  const topModels = useMemo(() => {
    const logs = logsQuery.data?.logs ?? []
    const map: Record<
      string,
      { model: string; provider: string; requests: number; tokens: number; costDollars: number; errors: number }
    > = {}

    for (const log of logs) {
      const modelName = log.requestedModel || log.modelId || 'unknown'
      const inTok = log.inputTokens || 0
      const outTok = log.outputTokens || 0
      if (!map[modelName]) {
        map[modelName] = {
          model: modelName,
          provider: log.platform,
          requests: 0,
          tokens: 0,
          costDollars: 0,
          errors: 0,
        }
      }
      map[modelName].requests += 1
      map[modelName].tokens += inTok + outTok
      map[modelName].costDollars += calculateTokenCostDollars(log.platform, modelName, inTok, outTok, pricingMap)
      if (log.status === 'error') map[modelName].errors += 1
    }

    const list = Object.values(map)
    list.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests)
    return list.slice(0, 5)
  }, [logsQuery.data?.logs, pricingMap])

  // Top Providers ranking from accounts
  const topProviders = useMemo(() => {
    const map: Record<
      string,
      { provider: string; name: string; requests: number; tokens: number; costDollars: number; accountsCount: number }
    > = {}

    for (const acc of accounts) {
      if (!map[acc.provider]) {
        map[acc.provider] = {
          provider: acc.provider,
          name: acc.providerName || acc.provider,
          requests: 0,
          tokens: 0,
          costDollars: 0,
          accountsCount: 0,
        }
      }
      map[acc.provider].requests += acc.monthlyUsage.requests
      map[acc.provider].tokens += acc.monthlyUsage.tokens
      map[acc.provider].costDollars += calculateBlendedTokensCostDollars(
        acc.provider,
        undefined,
        acc.monthlyUsage.tokens,
        pricingMap,
      )
      map[acc.provider].accountsCount += 1
    }

    const list = Object.values(map)
    list.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests)
    return list.slice(0, 5)
  }, [accounts, pricingMap])

  // Flattened pricing rows for Pricing Settings UI
  const pricingRows = useMemo(() => {
    const map = pricingMap ?? {}
    const rows: Array<{
      provider: string
      model: string
      rate: ModelPricingRate
      isOverridden: boolean
    }> = []
    const overrides = pricingQuery.data?.overrides ?? {}
    const q = pricingFilter.trim().toLowerCase()

    for (const provider of Object.keys(map).sort()) {
      const models = map[provider] ?? {}
      for (const model of Object.keys(models).sort()) {
        if (q && !provider.toLowerCase().includes(q) && !model.toLowerCase().includes(q)) {
          continue
        }
        rows.push({
          provider,
          model,
          rate: models[model],
          isOverridden: Boolean(overrides[provider]?.[model]),
        })
      }
    }
    return rows
  }, [pricingMap, pricingQuery.data?.overrides, pricingFilter])

  if (query.isPending) return <AccountLoadState />
  if (query.isError) return <AccountLoadState error retry={() => void query.refetch()} />

  return (
    <>
      <div className="x-page-heading">
        <div>
          <h1>{s.usage}</h1>
          <p>{s.usageHelp}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            type="button"
            className="x-button"
            onClick={() => setShowPricingModal(prev => !prev)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
          >
            <Sliders size={15} />
            Pricing Settings ($/1M tokens)
          </button>
          <span className="x-heading-icon"><BarChart3 size={28} /></span>
        </div>
      </div>

      <ProviderTopology
        nodes={(breakdown?.topology ?? []) as TopologyNode[]}
        loading={breakdownQuery.isPending}
      />

      {/* Pricing Settings Panel / Drawer */}
      {showPricingModal && (
        <section className="x-panel" style={{ padding: '1.25rem', marginBottom: '1.5rem', border: '1px solid var(--primary, #3b82f6)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Coins size={18} color="#f59e0b" />
                Pricing Settings ($ / 1M Tokens)
              </h2>
              <p className="x-caption" style={{ margin: '0.25rem 0 0 0' }}>
                Cấu hình đơn giá Input, Output và Cached ($/1M tokens) theo từng Provider/Model để tính chính xác chi phí trên Usage và Request Logs.
              </p>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              {canEditPricing && (
                <>
                  <button
                    type="button"
                    className="x-button"
                    disabled={resetPricingMutation.isPending}
                    onClick={() => resetPricingMutation.mutate(undefined)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
                  >
                    <RotateCcw size={14} />
                    Reset to Defaults
                  </button>
                  <button
                    type="button"
                    className="x-button x-primary"
                    disabled={!pricingDraft || savePricingMutation.isPending}
                    onClick={() => pricingDraft && savePricingMutation.mutate(pricingDraft)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
                  >
                    <Save size={14} />
                    {savePricingMutation.isPending ? s.saving : 'Save Pricing'}
                  </button>
                </>
              )}
              <button
                type="button"
                className="x-button"
                onClick={() => setShowPricingModal(false)}
                aria-label="Close Pricing Settings"
              >
                <X size={15} />
              </button>
            </div>
          </div>

          {savePricingMutation.isError && (
            <div className="x-error" role="alert" style={{ marginBottom: '0.75rem' }}>
              {savePricingMutation.error.message}
            </div>
          )}
          {savePricingMutation.isSuccess && (
            <p role="status" className="x-test-ok" style={{ marginBottom: '0.75rem' }}>
              Đã lưu bảng giá thành công.
            </p>
          )}

          {/* Add Custom Model Rate Row */}
          {canEditPricing && (
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                flexWrap: 'wrap',
                alignItems: 'flex-end',
                padding: '0.75rem',
                borderRadius: '8px',
                background: 'var(--bg-subtle, rgba(0,0,0,0.04))',
                marginBottom: '1rem',
              }}
            >
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.75rem' }}>
                Provider
                <input
                  type="text"
                  placeholder="e.g. openai"
                  value={newProvider}
                  onChange={e => setNewProvider(e.target.value)}
                  style={{ width: '120px', padding: '0.35rem 0.5rem', borderRadius: '6px', border: '1px solid var(--border)' }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.75rem' }}>
                Model ID
                <input
                  type="text"
                  placeholder="e.g. gpt-4.5-preview"
                  value={newModel}
                  onChange={e => setNewModel(e.target.value)}
                  style={{ width: '180px', padding: '0.35rem 0.5rem', borderRadius: '6px', border: '1px solid var(--border)' }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.75rem' }}>
                Input ($/1M)
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={newInputRate}
                  onChange={e => setNewInputRate(e.target.value)}
                  style={{ width: '95px', padding: '0.35rem 0.5rem', borderRadius: '6px', border: '1px solid var(--border)' }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.75rem' }}>
                Output ($/1M)
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={newOutputRate}
                  onChange={e => setNewOutputRate(e.target.value)}
                  style={{ width: '95px', padding: '0.35rem 0.5rem', borderRadius: '6px', border: '1px solid var(--border)' }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.75rem' }}>
                Cached ($/1M)
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={newCachedRate}
                  onChange={e => setNewCachedRate(e.target.value)}
                  style={{ width: '95px', padding: '0.35rem 0.5rem', borderRadius: '6px', border: '1px solid var(--border)' }}
                />
              </label>
              <button
                type="button"
                className="x-button"
                onClick={handleAddCustomModelRate}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
              >
                <Plus size={14} /> Thêm đơn giá
              </button>
            </div>
          )}

          {/* Filter Input */}
          <div style={{ marginBottom: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
            <input
              type="text"
              placeholder="Tìm nhanh provider hoặc model trong bảng giá..."
              value={pricingFilter}
              onChange={e => setPricingFilter(e.target.value)}
              style={{
                padding: '0.4rem 0.75rem',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                width: '280px',
                fontSize: '0.8125rem',
              }}
            />
            <span className="x-caption">{pricingRows.length} models</span>
          </div>

          <div className="x-table-wrap" style={{ maxHeight: '320px', overflowY: 'auto' }}>
            <table className="x-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Input ($/1M)</th>
                  <th>Output ($/1M)</th>
                  <th>Cached ($/1M)</th>
                  {canEditPricing && <th>Thao tác</th>}
                </tr>
              </thead>
              <tbody>
                {pricingRows.map(({ provider, model, rate, isOverridden }) => (
                  <tr key={`${provider}/${model}`}>
                    <td><strong>{provider}</strong></td>
                    <td>
                      <code>{model}</code>
                      {isOverridden && (
                        <span
                          style={{
                            marginLeft: '0.4rem',
                            fontSize: '0.68rem',
                            padding: '0.1rem 0.35rem',
                            borderRadius: '4px',
                            background: 'rgba(245, 158, 11, 0.15)',
                            color: '#f59e0b',
                          }}
                        >
                          Custom
                        </span>
                      )}
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        disabled={!canEditPricing}
                        value={rate.input}
                        onChange={e => handleRateChange(provider, model, 'input', e.target.value)}
                        style={{ width: '85px', padding: '0.25rem 0.4rem', borderRadius: '4px', border: '1px solid var(--border)' }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        disabled={!canEditPricing}
                        value={rate.output}
                        onChange={e => handleRateChange(provider, model, 'output', e.target.value)}
                        style={{ width: '85px', padding: '0.25rem 0.4rem', borderRadius: '4px', border: '1px solid var(--border)' }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        disabled={!canEditPricing}
                        value={rate.cached ?? 0}
                        onChange={e => handleRateChange(provider, model, 'cached', e.target.value)}
                        style={{ width: '85px', padding: '0.25rem 0.4rem', borderRadius: '4px', border: '1px solid var(--border)' }}
                      />
                    </td>
                    {canEditPricing && (
                      <td>
                        {isOverridden && (
                          <button
                            type="button"
                            className="x-button x-small"
                            onClick={() => resetPricingMutation.mutate({ provider, model })}
                          >
                            Reset
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
                    <div style={{ fontSize: '0.75rem', color: '#f59e0b' }}>{fmtDollars(m.costDollars)}</div>
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
                    <div style={{ fontSize: '0.75rem', color: '#f59e0b' }}>{fmtDollars(p.costDollars)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Breakdown tabs */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.75rem' }}>
        <div role="tablist" style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
          {BREAKDOWN_TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={breakdownTab === tab.id}
              onClick={() => setBreakdownTab(tab.id)}
              style={{
                padding: '0.35rem 0.85rem',
                borderRadius: '6px',
                fontSize: '0.8125rem',
                fontWeight: 500,
                cursor: 'pointer',
                border: '1px solid var(--border)',
                background: breakdownTab === tab.id ? 'var(--primary, #3b82f6)' : 'transparent',
                color: breakdownTab === tab.id ? '#fff' : 'inherit',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '0.25rem', background: 'var(--bg-subtle, rgba(0,0,0,0.06))', padding: '0.2rem', borderRadius: '6px' }}>
          {RANGE_OPTIONS.map(opt => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setTimeRange(opt.id)}
              style={{
                padding: '0.25rem 0.65rem',
                borderRadius: '4px',
                fontSize: '0.75rem',
                fontWeight: 500,
                cursor: 'pointer',
                border: 'none',
                background: timeRange === opt.id ? 'var(--primary, #3b82f6)' : 'transparent',
                color: timeRange === opt.id ? '#fff' : 'inherit',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {breakdownTab !== 'provider' && (
        <BreakdownPanel tab={breakdownTab} data={breakdown} loading={breakdownQuery.isPending} error={breakdownQuery.isError} />
      )}

      {/* Account Usage Breakdown Table & Provider Search */}
      {breakdownTab === 'provider' && (
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
              {filteredAccounts.map(account => {
                const accountCost = calculateBlendedTokensCostDollars(
                  account.provider,
                  undefined,
                  account.monthlyUsage.tokens,
                  pricingMap,
                )
                return (
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
                        {fmtDollars(accountCost)}
                      </span>
                    </td>
                  </tr>
                )
              })}
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
      )}
    </>
  )
}

type BreakdownTab = 'provider' | 'model' | 'client' | 'endpoint'

const BREAKDOWN_TABS: Array<{ id: BreakdownTab; label: string }> = [
  { id: 'provider', label: 'By Provider & Account' },
  { id: 'model', label: 'By Model' },
  { id: 'client', label: 'By Client API Key' },
  { id: 'endpoint', label: 'By Endpoint' },
]

const RANGE_OPTIONS: Array<{ id: TimeRange; label: string }> = [
  { id: '24h', label: '24H' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: 'all', label: 'All / Current Month' },
]

interface BreakdownStats {
  requests: number
  errorCount: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  successRate: number
  avgLatencyMs: number
}

interface UsageBreakdown {
  range: TimeRange
  topology: Array<TopologyNode & { cooldownAccounts: number }>
  byModel: Array<BreakdownStats & { provider: string; model: string; estimatedCostUsd: number }>
  byAccount: Array<{
    id: number; provider: string; providerName: string; label: string; monthlyRequests: number
    monthlyTokens: number; loggedRequests: number
  }>
  byClientKey: Array<BreakdownStats & {
    id: number; name: string; keyPrefix: string; revoked: boolean; sharedOwner: boolean
  }>
  byEndpoint: Array<BreakdownStats & { endpoint: string }>
}

function BreakdownPanel({
  tab,
  data,
  loading,
  error,
}: {
  tab: Exclude<BreakdownTab, 'provider'>
  data: UsageBreakdown | undefined
  loading: boolean
  error: boolean
}) {
  const statCells = (r: BreakdownStats) => (
    <>
      <td>{r.requests.toLocaleString()}</td>
      <td>{fmtTokens(r.promptTokens)}</td>
      <td>{fmtTokens(r.completionTokens)}</td>
      <td>{r.successRate}%</td>
      <td>{r.avgLatencyMs} ms</td>
    </>
  )
  const statHeads = (
    <>
      <th>Requests</th>
      <th>Prompt</th>
      <th>Completion</th>
      <th>Success</th>
      <th>Avg latency</th>
    </>
  )

  let body: React.ReactNode = null
  let empty = true
  if (data) {
    if (tab === 'model') {
      empty = data.byModel.length === 0
      body = (
        <table className="x-table">
          <thead><tr><th>Model</th><th>Provider</th>{statHeads}<th>Errors</th><th>Est. cost</th></tr></thead>
          <tbody>
            {data.byModel.map(r => (
              <tr key={`${r.provider}/${r.model}`}>
                <th>{r.model}</th>
                <td>{r.provider}</td>
                {statCells(r)}
                <td>{r.errorCount}</td>
                <td><span style={{ color: '#f59e0b', fontWeight: 500 }}>{fmtDollars(r.estimatedCostUsd)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )
    } else if (tab === 'client') {
      empty = data.byClientKey.length === 0
      body = (
        <table className="x-table">
          <thead><tr><th>Client key</th><th>Prefix</th>{statHeads}<th>Errors</th></tr></thead>
          <tbody>
            {data.byClientKey.map(r => (
              <tr key={r.id} style={r.revoked ? { opacity: 0.5 } : undefined}>
                <th>
                  {r.name}
                  {r.revoked && <small> (revoked)</small>}
                  {r.sharedOwner && <small title="Keys of the same owner share figures"> (shared owner)</small>}
                </th>
                <td><code>{r.keyPrefix}...</code></td>
                {statCells(r)}
                <td>{r.errorCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )
    } else {
      empty = false
      body = (
        <table className="x-table">
          <thead><tr><th>Endpoint</th>{statHeads}<th>Errors</th></tr></thead>
          <tbody>
            {data.byEndpoint.map(r => (
              <tr key={r.endpoint}>
                <th><code>/x/v1/{r.endpoint}</code></th>
                {statCells(r)}
                <td>{r.errorCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )
    }
  }

  return (
    <section className="x-panel" style={{ padding: '1.25rem' }}>
      <div className="x-table-wrap">
        {body}
        {(loading || error || empty) && (
          <div className="x-empty">
            <p>{loading ? 'Loading...' : error ? 'Could not load usage breakdown.' : 'No usage recorded for this range.'}</p>
          </div>
        )}
      </div>
    </section>
  )
}