import { useState, useMemo, useEffect } from 'react'
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
  Layers,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Sliders,
  X,
} from 'lucide-react'
import { apiFetch, getToken } from '@/lib/api'
import { useI18n } from '@/i18n'
import { useAccounts } from '../api'
import { useXStrings } from '../strings'
import { useSessionRevision } from '../../session-state'
import { useUserSession } from '../../use-session'
import { mgmtApi } from '../management-api'
import { quotaApi } from '../quota-api'
import { AccountLoadState } from './Providers'
import ProviderTopology, { type ActiveRequestInfo, type TopologyNode } from '../components/ProviderTopology'
import RecentRequestsPanel, { type RecentRequestItem } from '../components/RecentRequestsPanel'
import { ProviderBarChart, TopModelsChart } from '../components/UsageCharts'
import UsageTable, {
  type UsageGroup,
  type UsageViewMode,
  UsageViewModeToggle,
} from '../components/UsageTable'

import {
  calculateBlendedTokensCostDollars,
  calculateTokenCostDollars,
  fmtDollars,
  resolveClientModelPricing,
  type ModelPricingRate,
  type ProviderPricingMap,
} from './account-usage-pricing'

type TimeRange = '24h' | '7d' | '30d' | 'all'

interface PricingResponse {
  pricing: ProviderPricingMap
  defaults: ProviderPricingMap
  overrides: ProviderPricingMap
}

const fmtTokens = (n: number) => {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

export default function AccountUsage() {
  const { locale } = useI18n()
  const isVi = locale === 'vi'
  const s = useXStrings()
  const revision = useSessionRevision()
  const session = useUserSession()
  const queryClient = useQueryClient()
  const canEditPricing =
    session.hasPermission('edit_x_settings') || session.hasPermission('manage_x_gateway')
  const canViewQuota = session.hasPermission('view_x_usage')
  const query = useAccounts()

  // Filters State
  const [timeRange, setTimeRange] = useState<TimeRange>('7d')
  const [providerSearch, setProviderSearch] = useState('')
  const [breakdownTab, setBreakdownTab] = useState<BreakdownTab>('provider')
  const [chartMetric, setChartMetric] = useState<'requests' | 'tokens'>('tokens')
  const [tableViewMode, setTableViewMode] = useState<UsageViewMode>('costs')
  const [detailFilterPreset, setDetailFilterPreset] = useState<Partial<DetailFilters> | null>(null)

  // Live SSE State (/api/thruline/usage/stream) with graceful polling fallback
  const [sseState, setSseState] = useState<{
    activeRequests: ActiveRequestInfo[]
    lastProvider: string
    errorProvider: string
    recentRequests: RecentRequestItem[] | null
    connected: boolean
  }>({
    activeRequests: [],
    lastProvider: '',
    errorProvider: '',
    recentRequests: null,
    connected: false,
  })

  useEffect(() => {
    let isMounted = true
    let retry: ReturnType<typeof setTimeout> | undefined
    const abort = new AbortController()
    const streamUrl = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/thruline/usage/stream`

    const onMessage = (raw: string) => {
      try {
        const data = JSON.parse(raw) as {
          activeRequests?: ActiveRequestInfo[]
          lastProvider?: string
          errorProvider?: string | { provider?: string } | null
          recentRequests?: RecentRequestItem[]
        }
        const errProv =
          typeof data.errorProvider === 'string'
            ? data.errorProvider
            : data.errorProvider?.provider ?? ''
        if (!isMounted) return
        setSseState(prev => ({
          activeRequests: Array.isArray(data.activeRequests) ? data.activeRequests : prev.activeRequests,
          lastProvider: typeof data.lastProvider === 'string' ? data.lastProvider : prev.lastProvider,
          errorProvider: errProv,
          recentRequests: Array.isArray(data.recentRequests) ? data.recentRequests : prev.recentRequests,
          connected: true,
        }))
      } catch {
        // ignore malformed SSE heartbeat/payload
      }
    }

    // The stream needs the session token, which EventSource cannot send, so it is read with fetch.
    const connect = async () => {
      let refused = false
      try {
        const token = getToken()
        const response = await fetch(streamUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: abort.signal,
        })
        refused = response.status === 401 || response.status === 403
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        if (isMounted) setSseState(prev => ({ ...prev, connected: true }))
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let end = buffer.indexOf('\n\n')
          while (end !== -1) {
            const event = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            for (const line of event.split('\n')) {
              if (line.startsWith('data: ')) onMessage(line.slice(6))
            }
            end = buffer.indexOf('\n\n')
          }
        }
      } catch {
        // dropped connection; retried below unless refused or unmounted
      }
      if (!isMounted) return
      setSseState(prev => ({ ...prev, connected: false }))
      if (!refused) retry = setTimeout(connect, 3000)
    }

    void connect()

    return () => {
      isMounted = false
      if (retry) clearTimeout(retry)
      abort.abort()
    }
  }, [revision])

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
    queryFn: ({ signal }) => apiFetch<PricingResponse>('/api/thruline/pricing', { signal }),
    staleTime: 60_000,
    retry: false,
  })

  const breakdownQuery = useQuery({
    queryKey: ['x-usage-breakdown', timeRange, revision],
    queryFn: ({ signal }) =>
      apiFetch<UsageBreakdown>(`/api/thruline/usage/breakdown?range=${timeRange}`, { signal }),
    refetchInterval: 30_000,
    retry: false,
  })
  const breakdown = breakdownQuery.data

  const refreshAllQuotas = useMutation({
    meta: { silenceToast: true },
    mutationFn: () => quotaApi.refreshAll(true),
    onSuccess: data => {
      queryClient.setQueryData(['x-quota', revision], data)
    },
  })

  const pricingMap = pricingDraft ?? pricingQuery.data?.pricing

  const savePricingMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: (patch: ProviderPricingMap) =>
      apiFetch<PricingResponse>('/api/thruline/pricing', {
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
      return apiFetch<PricingResponse>(`/api/thruline/pricing${suffix}`, {
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

  const accounts = useMemo(() => {
    const rawProviders = query.data?.providers ?? []
    return rawProviders.flatMap(provider =>
      provider.accounts.map(account => ({
        ...account,
        providerName: provider.name,
      }))
    )
  }, [query.data?.providers])

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
  const chartData = useMemo(() => {
    const hourlyBuckets = hourlyQuery.data?.buckets ?? []
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
  }, [hourlyQuery.data?.buckets])

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

  const effectiveRecentRequests = useMemo<RecentRequestItem[]>(() => {
    return sseState.recentRequests ?? breakdown?.recentRequests ?? []
  }, [sseState.recentRequests, breakdown?.recentRequests])

  const providerChartEntries = useMemo(() => {
    const topo = breakdown?.topology ?? []
    if (topo.length > 0) {
      return topo.map(t => ({
        provider: t.provider,
        name: t.name || t.provider,
        tokens: t.totalTokens,
        requests: t.requests,
      }))
    }
    return topProviders.map(p => ({
      provider: p.provider,
      name: p.name,
      tokens: p.tokens,
      requests: p.requests,
    }))
  }, [breakdown?.topology, topProviders])

  const modelChartEntries = useMemo(() => {
    const byModel = breakdown?.byModel ?? []
    if (byModel.length > 0) {
      return byModel.map(m => ({
        model: m.model,
        tokens: m.totalTokens,
        requests: m.requests,
      }))
    }
    return topModels.map(m => ({
      model: m.model,
      tokens: m.tokens,
      requests: m.requests,
    }))
  }, [breakdown?.byModel, topModels])

  const providerTableGroups = useMemo(() => {
    const grouped: Record<
      string,
      UsageGroup<{
        id: number
        provider: string
        providerName: string
        label: string
        monthlyRequestCap: number | null
        monthlyTokenCap: number | null
        requests: number
        promptTokens: number
        completionTokens: number
        totalTokens: number
        inputCost: number
        outputCost: number
        totalCost: number
      }>
    > = {}

    for (const acc of filteredAccounts) {
      const key = acc.providerName || acc.provider
      const promptTokens = Math.round(acc.monthlyUsage.tokens * 0.7)
      const completionTokens = Math.max(0, acc.monthlyUsage.tokens - promptTokens)
      const totalCost = calculateBlendedTokensCostDollars(acc.provider, undefined, acc.monthlyUsage.tokens, pricingMap)
      const inputCost = totalCost * 0.45
      const outputCost = Math.max(0, totalCost - inputCost)

      if (!grouped[key]) {
        grouped[key] = {
          groupKey: key,
          label: (
            <Link
              to={`/thruline/providers/${encodeURIComponent(acc.provider)}`}
              onClick={e => e.stopPropagation()}
            >
              {key}
            </Link>
          ),
          summary: {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            inputCost: 0,
            outputCost: 0,
            totalCost: 0,
          },
          items: [],
        }
      }

      grouped[key].summary.requests += acc.monthlyUsage.requests
      grouped[key].summary.promptTokens += promptTokens
      grouped[key].summary.completionTokens += completionTokens
      grouped[key].summary.totalTokens += acc.monthlyUsage.tokens
      grouped[key].summary.inputCost += inputCost
      grouped[key].summary.outputCost += outputCost
      grouped[key].summary.totalCost += totalCost

      grouped[key].items.push({
        id: acc.id,
        provider: acc.provider,
        providerName: acc.providerName,
        label: acc.label || acc.providerName,
        monthlyRequestCap: acc.monthlyRequestCap,
        monthlyTokenCap: acc.monthlyTokenCap,
        requests: acc.monthlyUsage.requests,
        promptTokens,
        completionTokens,
        totalTokens: acc.monthlyUsage.tokens,
        inputCost,
        outputCost,
        totalCost,
      })
    }

    return Object.values(grouped).sort((a, b) => b.summary.totalTokens - a.summary.totalTokens)
  }, [filteredAccounts, pricingMap])

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

      <div className="mb-6 grid min-w-0 grid-cols-1 items-stretch gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <ProviderTopology
          nodes={(breakdown?.topology ?? []) as TopologyNode[]}
          loading={breakdownQuery.isPending}
          activeRequests={sseState.activeRequests}
          lastProvider={sseState.lastProvider || effectiveRecentRequests[0]?.provider || ''}
          errorProvider={sseState.errorProvider}
          onInspectRequests={(provider, onlyErrors) => {
            setDetailFilterPreset({
              provider,
              status: onlyErrors ? 'error' : '',
            })
            setBreakdownTab('request-details')
          }}
        />
        <RecentRequestsPanel
          requests={effectiveRecentRequests}
          loading={breakdownQuery.isPending}
          liveConnected={sseState.connected}
          onSelectRequest={req => {
            setDetailFilterPreset({
              provider: req.provider || '',
              model: req.model || '',
              status: req.status === 'error' ? 'error' : '',
            })
            setBreakdownTab('request-details')
          }}
        />
      </div>

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
                {isVi
                  ? 'Cấu hình đơn giá Input, Output và Cached ($/1M tokens) theo từng Provider/Model để tính chính xác chi phí trên Usage và Request Logs.'
                  : 'Configure Input, Output, and Cached rates ($/1M tokens) per Provider/Model for accurate cost calculation across Usage and Request Logs.'}
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
              {isVi ? 'Đã lưu bảng giá thành công.' : 'Pricing table saved successfully.'}
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
                <Plus size={14} /> {isVi ? 'Thêm đơn giá' : 'Add Rate'}
              </button>
            </div>
          )}

          {/* Filter Input */}
          <div style={{ marginBottom: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
            <input
              type="text"
              placeholder={isVi ? 'Tìm nhanh provider hoặc model trong bảng giá...' : 'Filter provider or model in pricing table...'}
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
                  {canEditPricing && <th>{isVi ? 'Thao tác' : 'Actions'}</th>}
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
                    color: timeRange === tr ? 'var(--primary-foreground, #fff)' : 'inherit',
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
                  chartMetric === 'tokens'
                    ? (isVi ? 'Lượng Token' : 'Tokens')
                    : (isVi ? 'Lượng Requests' : 'Requests'),
                ] as [string, string]}
                labelFormatter={label => (isVi ? `Thời gian: ${label}` : `Time: ${label}`)}
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

      {/* Two Column Section: Top Models & Top Providers (Tokens / Requests toggle) */}
      <div className="mb-6 grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <TopModelsChart models={modelChartEntries} />
        <ProviderBarChart providers={providerChartEntries} />
      </div>

      {/* Breakdown tabs + Costs/Tokens toggle + Range */}
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
                color: breakdownTab === tab.id ? 'var(--primary-foreground, #fff)' : 'inherit',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {breakdownTab !== 'request-details' && (
            <UsageViewModeToggle value={tableViewMode} onChange={setTableViewMode} />
          )}
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
                  color: timeRange === opt.id ? 'var(--primary-foreground, #fff)' : 'inherit',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {breakdownTab === 'request-details' && (
        <RequestDetailsPanel presetFilters={detailFilterPreset} />
      )}

      {breakdownTab !== 'provider' && breakdownTab !== 'request-details' && (
        <BreakdownPanel
          tab={breakdownTab}
          data={breakdown}
          loading={breakdownQuery.isPending}
          error={breakdownQuery.isError}
          viewMode={tableViewMode}
          pricingMap={pricingMap}
        />
      )}

      {/* Account Usage Breakdown Table & Provider Search */}
      {breakdownTab === 'provider' && (
      <section className="x-panel" style={{ padding: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Layers size={18} />
            <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>
              {isVi ? 'Chi tiết hạn mức & Sử dụng theo tài khoản' : 'Account Quota & Usage Breakdown'}
            </h3>
          </div>

          {/* Search / Filter Provider Input + Refresh Quotas */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            {canViewQuota && (
              <button
                type="button"
                className="x-button x-small"
                disabled={refreshAllQuotas.isPending}
                onClick={() => refreshAllQuotas.mutate()}
              >
                <RefreshCw size={13} className={refreshAllQuotas.isPending ? 'x-spin' : undefined} />
                {refreshAllQuotas.isPending
                  ? (isVi ? 'Đang đo hạn mức…' : 'Refreshing quotas…')
                  : (isVi ? 'Cập nhật hạn mức' : 'Refresh Quotas')}
              </button>
            )}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <Search size={14} style={{ position: 'absolute', left: '0.6rem', color: 'var(--text-muted)' }} />
              <input
                type="text"
                placeholder={isVi ? 'Tìm kiếm tài khoản / Provider...' : 'Search account / provider...'}
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
        </div>

        <UsageTable
          primaryHeader={s.providers}
          extraHeaders={
            <>
              <th>{s.accounts}</th>
              <th style={{ textAlign: 'right' }}>Cap (Req / Tok)</th>
            </>
          }
          groups={providerTableGroups}
          viewMode={tableViewMode}
          storageKey="thruline-usage:expanded-provider"
          renderSummaryExtraCells={() => (
            <>
              <td className="text-muted-foreground">—</td>
              <td style={{ textAlign: 'right' }} className="text-muted-foreground">—</td>
            </>
          )}
          renderDetailExtraCells={item => (
            <>
              <td>
                <Link to={`/thruline/providers/${encodeURIComponent(item.provider)}`}>
                  {item.label}
                </Link>
              </td>
              <td style={{ textAlign: 'right' }}>
                <small>
                  {item.monthlyRequestCap || '∞'} / {item.monthlyTokenCap ? fmtTokens(item.monthlyTokenCap) : '∞'}
                </small>
              </td>
            </>
          )}
          emptyMessage={
            providerSearch
              ? (isVi ? 'Không tìm thấy tài khoản phù hợp với từ khóa.' : 'No accounts match your search.')
              : s.noAccounts
          }
        />
        {!filteredAccounts.length && !accounts.length && (
          <div style={{ marginTop: '0.75rem', textAlign: 'center' }}>
            <Link className="x-button" to="/thruline/providers">
              {s.addAccount}
            </Link>
          </div>
        )}
      </section>
      )}
    </>
  )
}

type BreakdownTab = 'provider' | 'model' | 'client' | 'endpoint' | 'request-details'

const BREAKDOWN_TABS: Array<{ id: BreakdownTab; label: string }> = [
  { id: 'provider', label: 'By Provider & Account' },
  { id: 'model', label: 'By Model' },
  { id: 'client', label: 'By Client API Key' },
  { id: 'endpoint', label: 'By Endpoint' },
  { id: 'request-details', label: 'Request Details' },
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
  recentRequests?: RecentRequestItem[]
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
  viewMode,
  pricingMap,
}: {
  tab: Exclude<BreakdownTab, 'provider' | 'request-details'>
  data: UsageBreakdown | undefined
  loading: boolean
  error: boolean
  viewMode: UsageViewMode
  pricingMap: ProviderPricingMap | undefined
}) {
  if (loading || error || !data) {
    return (
      <section className="x-panel" style={{ padding: '1.25rem' }}>
        <div className="x-empty">
          <p>{loading ? 'Loading...' : error ? 'Could not load usage breakdown.' : 'No usage recorded for this range.'}</p>
        </div>
      </section>
    )
  }

  if (tab === 'model') {
    type ModelRow = BreakdownStats & {
      provider: string
      model: string
      inputCost: number
      outputCost: number
      totalCost: number
    }
    const grouped: Record<string, UsageGroup<ModelRow>> = {}
    for (const r of data.byModel) {
      const rate = resolveClientModelPricing(r.provider, r.model, pricingMap)
      const inputCost = (r.promptTokens * rate.input) / 1_000_000
      const outputCost = (r.completionTokens * rate.output) / 1_000_000
      const totalCost = r.estimatedCostUsd ?? inputCost + outputCost
      const row: ModelRow = { ...r, inputCost, outputCost, totalCost }
      if (!grouped[r.model]) {
        grouped[r.model] = {
          groupKey: r.model,
          label: <code>{r.model}</code>,
          summary: {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            inputCost: 0,
            outputCost: 0,
            totalCost: 0,
            errors: 0,
          },
          items: [],
        }
      }
      const s = grouped[r.model].summary
      s.requests += r.requests
      s.promptTokens += r.promptTokens
      s.completionTokens += r.completionTokens
      s.totalTokens += r.totalTokens
      s.inputCost += inputCost
      s.outputCost += outputCost
      s.totalCost += totalCost
      s.errors = (s.errors ?? 0) + r.errorCount
      grouped[r.model].items.push(row)
    }

    return (
      <section className="x-panel" style={{ padding: '1.25rem' }}>
        <UsageTable
          primaryHeader="Model"
          extraHeaders={
            <>
              <th>Provider</th>
              <th style={{ textAlign: 'right' }}>Success</th>
              <th style={{ textAlign: 'right' }}>Avg latency</th>
              <th style={{ textAlign: 'right' }}>Errors</th>
            </>
          }
          groups={Object.values(grouped)}
          viewMode={viewMode}
          storageKey="thruline-usage:expanded-model"
          renderSummaryExtraCells={g => (
            <>
              <td className="text-muted-foreground">—</td>
              <td style={{ textAlign: 'right' }} className="text-muted-foreground">—</td>
              <td style={{ textAlign: 'right' }} className="text-muted-foreground">—</td>
              <td style={{ textAlign: 'right' }}>
                {(g.summary.errors ?? 0) > 0 ? (
                  <span className="text-red-400 font-semibold">{g.summary.errors}</span>
                ) : (
                  0
                )}
              </td>
            </>
          )}
          renderDetailExtraCells={r => (
            <>
              <td>{r.provider}</td>
              <td style={{ textAlign: 'right' }}>{r.successRate}%</td>
              <td style={{ textAlign: 'right' }}>{r.avgLatencyMs} ms</td>
              <td style={{ textAlign: 'right' }}>
                {r.errorCount > 0 ? <span className="text-red-400 font-semibold">{r.errorCount}</span> : 0}
              </td>
            </>
          )}
        />
      </section>
    )
  }

  if (tab === 'client') {
    type ClientRow = BreakdownStats & {
      id: number
      name: string
      keyPrefix: string
      revoked: boolean
      sharedOwner: boolean
      inputCost: number
      outputCost: number
      totalCost: number
    }
    const groups: UsageGroup<ClientRow>[] = data.byClientKey.map(r => {
      const inputCost = calculateTokenCostDollars(undefined, undefined, r.promptTokens, 0, pricingMap)
      const outputCost = calculateTokenCostDollars(undefined, undefined, 0, r.completionTokens, pricingMap)
      const row: ClientRow = { ...r, inputCost, outputCost, totalCost: inputCost + outputCost }
      return {
        groupKey: String(r.id),
        label: (
          <span style={r.revoked ? { opacity: 0.5 } : undefined}>
            {r.name}
            {r.revoked && <small> (revoked)</small>}
            {r.sharedOwner && <small title="Keys of the same owner share figures"> (shared owner)</small>}
          </span>
        ),
        summary: {
          requests: r.requests,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          totalTokens: r.totalTokens,
          inputCost,
          outputCost,
          totalCost: inputCost + outputCost,
          errors: r.errorCount,
        },
        items: [row],
      }
    })

    return (
      <section className="x-panel" style={{ padding: '1.25rem' }}>
        <UsageTable
          primaryHeader="Client key"
          extraHeaders={
            <>
              <th>Prefix</th>
              <th style={{ textAlign: 'right' }}>Success</th>
              <th style={{ textAlign: 'right' }}>Avg latency</th>
              <th style={{ textAlign: 'right' }}>Errors</th>
            </>
          }
          groups={groups}
          viewMode={viewMode}
          storageKey="thruline-usage:expanded-client"
          renderSummaryExtraCells={g => (
            <>
              <td><code>{g.items[0]?.keyPrefix}...</code></td>
              <td style={{ textAlign: 'right' }}>{g.items[0]?.successRate ?? 0}%</td>
              <td style={{ textAlign: 'right' }}>{g.items[0]?.avgLatencyMs ?? 0} ms</td>
              <td style={{ textAlign: 'right' }}>{g.summary.errors ?? 0}</td>
            </>
          )}
          renderDetailExtraCells={r => (
            <>
              <td><code>{r.keyPrefix}...</code></td>
              <td style={{ textAlign: 'right' }}>{r.successRate}%</td>
              <td style={{ textAlign: 'right' }}>{r.avgLatencyMs} ms</td>
              <td style={{ textAlign: 'right' }}>{r.errorCount}</td>
            </>
          )}
        />
      </section>
    )
  }

  type EndpointRow = BreakdownStats & {
    endpoint: string
    inputCost: number
    outputCost: number
    totalCost: number
  }
  const endpointGroups: UsageGroup<EndpointRow>[] = data.byEndpoint.map(r => {
    const inputCost = calculateTokenCostDollars(undefined, undefined, r.promptTokens, 0, pricingMap)
    const outputCost = calculateTokenCostDollars(undefined, undefined, 0, r.completionTokens, pricingMap)
    const row: EndpointRow = { ...r, inputCost, outputCost, totalCost: inputCost + outputCost }
    return {
      groupKey: r.endpoint,
      label: <code>/thruline/v1/{r.endpoint}</code>,
      summary: {
        requests: r.requests,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        totalTokens: r.totalTokens,
        inputCost,
        outputCost,
        totalCost: inputCost + outputCost,
        errors: r.errorCount,
      },
      items: [row],
    }
  })

  return (
    <section className="x-panel" style={{ padding: '1.25rem' }}>
      <UsageTable
        primaryHeader="Endpoint"
        extraHeaders={
          <>
            <th style={{ textAlign: 'right' }}>Success</th>
            <th style={{ textAlign: 'right' }}>Avg latency</th>
            <th style={{ textAlign: 'right' }}>Errors</th>
          </>
        }
        groups={endpointGroups}
        viewMode={viewMode}
        storageKey="thruline-usage:expanded-endpoint"
        renderSummaryExtraCells={g => (
          <>
            <td style={{ textAlign: 'right' }}>{g.items[0]?.successRate ?? 0}%</td>
            <td style={{ textAlign: 'right' }}>{g.items[0]?.avgLatencyMs ?? 0} ms</td>
            <td style={{ textAlign: 'right' }}>{g.summary.errors ?? 0}</td>
          </>
        )}
        renderDetailExtraCells={r => (
          <>
            <td style={{ textAlign: 'right' }}>{r.successRate}%</td>
            <td style={{ textAlign: 'right' }}>{r.avgLatencyMs} ms</td>
            <td style={{ textAlign: 'right' }}>{r.errorCount}</td>
          </>
        )}
      />
    </section>
  )
}

interface RequestDetailRow {
  id: number
  provider: string
  accountId: number | null
  accountLabel: string | null
  modelId: string
  requestedModel: string | null
  requestType: string
  endpoint: string
  status: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
  estimatedCost: number
  error: string | null
  createdAt: string
}

interface RequestDetailsResponse {
  page: number
  pageSize: number
  totalCount: number
  totalPages: number
  details: RequestDetailRow[]
  filters: { providers: string[]; models: string[] }
}

interface DetailFilters {
  provider: string
  model: string
  status: '' | 'success' | 'error'
  startDate: string
  endDate: string
}

const EMPTY_DETAIL_FILTERS: DetailFilters = { provider: '', model: '', status: '', startDate: '', endDate: '' }
const DETAIL_PAGE_SIZE = 20

const filterInputStyle = {
  padding: '0.35rem 0.55rem',
  borderRadius: '6px',
  border: '1px solid var(--border)',
  backgroundColor: 'var(--bg-subtle, rgba(0,0,0,0.03))',
  fontSize: '0.8125rem',
} as const

function StatusBadge({ status }: { status: string }) {
  const ok = status === 'success'
  return (
    <span
      style={{
        padding: '0.1rem 0.5rem',
        borderRadius: '999px',
        fontSize: '0.72rem',
        fontWeight: 600,
        color: ok ? '#10b981' : '#ef4444',
        background: ok ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
      }}
    >
      {ok ? 'Success' : 'Error'}
    </span>
  )
}

const fmtDetailTime = (value: string) => {
  const d = new Date(`${value.replace(' ', 'T')}${/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? '' : 'Z'}`)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

function RequestDetailsPanel({ presetFilters }: { presetFilters?: Partial<DetailFilters> | null }) {
  const revision = useSessionRevision()
  const [page, setPage] = useState(1)
  const [filters, setFilters] = useState<DetailFilters>(() => ({
    ...EMPTY_DETAIL_FILTERS,
    ...presetFilters,
  }))
  const [selected, setSelected] = useState<RequestDetailRow | null>(null)

  // A new preset replaces the filters and resets to page 1.
  const [prevPresetFilters, setPrevPresetFilters] = useState(presetFilters)
  if (presetFilters !== prevPresetFilters) {
    setPrevPresetFilters(presetFilters)
    if (presetFilters) {
      setFilters({ ...EMPTY_DETAIL_FILTERS, ...presetFilters })
      setPage(1)
    }
  }

  const detailsQuery = useQuery({
    queryKey: ['x-request-details', page, filters, revision],
    queryFn: ({ signal }) => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(DETAIL_PAGE_SIZE) })
      if (filters.provider) qs.set('provider', filters.provider)
      if (filters.model.trim()) qs.set('model', filters.model.trim())
      if (filters.status) qs.set('status', filters.status)
      if (filters.startDate) qs.set('startDate', filters.startDate)
      if (filters.endDate) qs.set('endDate', filters.endDate)
      return apiFetch<RequestDetailsResponse>(`/api/thruline/usage/request-details?${qs.toString()}`, { signal })
    },
    placeholderData: previous => previous,
    refetchInterval: 30_000,
    retry: false,
  })
  const data = detailsQuery.data

  const update = (patch: Partial<DetailFilters>) => {
    setFilters(prev => ({ ...prev, ...patch }))
    setPage(1)
  }
  const totalPages = data?.totalPages ?? 1

  return (
    <section className="x-panel" style={{ padding: '1.25rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem' }}>
        <select
          aria-label="Provider"
          value={filters.provider}
          onChange={e => update({ provider: e.target.value })}
          style={filterInputStyle}
        >
          <option value="">All providers</option>
          {(data?.filters.providers ?? []).map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <input
          aria-label="Model"
          list="x-request-detail-models"
          placeholder="Model..."
          value={filters.model}
          onChange={e => update({ model: e.target.value })}
          style={{ ...filterInputStyle, width: 190 }}
        />
        <datalist id="x-request-detail-models">
          {(data?.filters.models ?? []).map(m => <option key={m} value={m} />)}
        </datalist>
        <select
          aria-label="Status"
          value={filters.status}
          onChange={e => update({ status: e.target.value as DetailFilters['status'] })}
          style={filterInputStyle}
        >
          <option value="">All</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
        </select>
        <label style={{ fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
          Start Date
          <input type="date" value={filters.startDate} onChange={e => update({ startDate: e.target.value })} style={filterInputStyle} />
        </label>
        <label style={{ fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
          End Date
          <input type="date" value={filters.endDate} onChange={e => update({ endDate: e.target.value })} style={filterInputStyle} />
        </label>
        <button
          type="button"
          className="x-button"
          onClick={() => { setFilters(EMPTY_DETAIL_FILTERS); setPage(1) }}
        >
          Reset Filters
        </button>
      </div>

      <div className="x-table-wrap">
        <table className="x-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Provider &amp; Account</th>
              <th>Model</th>
              <th>Endpoint</th>
              <th>Tokens (in / out)</th>
              <th>Cost</th>
              <th>Latency</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(data?.details ?? []).map(row => (
              <tr
                key={row.id}
                onClick={() => setSelected(row)}
                style={{ cursor: 'pointer' }}
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter') setSelected(row) }}
              >
                <td>{fmtDetailTime(row.createdAt)}</td>
                <td>{row.provider}{row.accountLabel ? <small> / {row.accountLabel}</small> : null}</td>
                <td>
                  {row.requestedModel && row.requestedModel !== row.modelId
                    ? <>{row.requestedModel} <small>&rarr;</small> {row.modelId}</>
                    : row.modelId}
                </td>
                <td><code>{row.endpoint}</code></td>
                <td>{row.inputTokens.toLocaleString()} / {row.outputTokens.toLocaleString()}</td>
                <td><span style={{ color: '#f59e0b', fontWeight: 500 }}>{fmtDollars(row.estimatedCost)}</span></td>
                <td>{row.latencyMs} ms</td>
                <td><StatusBadge status={row.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {(detailsQuery.isPending || detailsQuery.isError || data?.details.length === 0) && (
          <div className="x-empty">
            <p>
              {detailsQuery.isPending
                ? 'Loading...'
                : detailsQuery.isError
                  ? 'Could not load request details.'
                  : 'No requests match these filters.'}
            </p>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.75rem' }}>
        <button type="button" className="x-button" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>
          Prev
        </button>
        <span style={{ fontSize: '0.8125rem' }}>
          Page {data?.page ?? page} of {totalPages}
          {data ? <small> ({data.totalCount.toLocaleString()} requests)</small> : null}
        </span>
        <button type="button" className="x-button" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
          Next
        </button>
      </div>

      {selected && <RequestDetailDrawer row={selected} onClose={() => setSelected(null)} />}
    </section>
  )
}

function RequestDetailDrawer({ row, onClose }: { row: RequestDetailRow; onClose: () => void }) {
  const totalTokens = row.inputTokens + row.outputTokens
  const fact = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.35rem 0', borderBottom: '1px solid var(--border)', fontSize: '0.8125rem' }}>
      <span style={{ opacity: 0.65 }}>{label}</span>
      <span style={{ textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
  )
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Request details"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}
    >
      <aside
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(480px, 100%)', height: '100%', overflowY: 'auto', background: 'var(--bg, #fff)', padding: '1.25rem', boxShadow: '-8px 0 24px rgba(0,0,0,0.25)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Request Details</h3>
          <button type="button" aria-label="Close" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>
            <X size={18} />
          </button>
        </div>

        {fact('Request ID', `#${row.id}`)}
        {fact('Timestamp', fmtDetailTime(row.createdAt))}
        {fact('Provider / Account', `${row.provider}${row.accountLabel ? ` / ${row.accountLabel}` : ''}`)}
        {fact('Requested Model', row.requestedModel ?? 'auto')}
        {fact('Routed Model', row.modelId)}
        {fact('Endpoint', <code>{row.endpoint}</code>)}
        {fact('Latency', `${row.latencyMs} ms`)}
        {fact('Status', <StatusBadge status={row.status} />)}
        {row.error && (
          <div style={{ marginTop: '0.75rem', padding: '0.6rem', borderRadius: '6px', background: 'rgba(239,68,68,0.1)', color: '#ef4444', fontSize: '0.8125rem', wordBreak: 'break-word' }}>
            {row.error}
          </div>
        )}

        <h4 style={{ margin: '1.25rem 0 0.5rem', fontSize: '0.9rem' }}>Tokens &amp; Cost</h4>
        <table className="x-table">
          <tbody>
            <tr><th>Input Tokens</th><td>{row.inputTokens.toLocaleString()}</td></tr>
            <tr><th>Output Tokens</th><td>{row.outputTokens.toLocaleString()}</td></tr>
            <tr><th>Cached Tokens</th><td>{row.cachedTokens.toLocaleString()}</td></tr>
            <tr><th>Reasoning Tokens</th><td>{row.reasoningTokens.toLocaleString()}</td></tr>
            <tr><th>Total Tokens</th><td>{totalTokens.toLocaleString()}</td></tr>
            <tr><th>Total Cost USD</th><td><strong>{fmtDollars(row.estimatedCost)}</strong></td></tr>
          </tbody>
        </table>
      </aside>
    </div>
  )
}
