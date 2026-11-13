import { useState, useEffect, useRef, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  CircleCheck,
  Clock,
  Copy,
  Ellipsis,
  KeyRound,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Trash2,
  Unplug,
  X,
} from 'lucide-react'
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { apiFetch } from '@/lib/api'
import type { ProviderAccount, ProviderRoutingStrategy, ProviderThinkingMode } from '../../../../../shared/x-accounts'
import { accountsApi, refreshAccounts, useAccounts, type BatchTestResponse } from '../api'
import { useSessionRevision } from '../../session-state'
import { proxyPoolApi } from '../proxy-pool-api'
import { usePoolStrings } from '../proxy-pool-strings'
import { useXStrings } from '../strings'
import { useXGatewayCopy } from '../copy'
import { ConnectAccountDialog } from '../ConnectAccountDialog'
import { AccountLoadState, ProviderMark } from './Providers'

const BLOCKED_CUSTOM_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
])

export interface AutoPingSchedule {
  enabled: boolean
  mode: 'off' | 'reset' | 'schedule'
  anchor: string
  windowHours: number
  slotsPerDay: number
  timezone: string
  lastPingAt?: string | null
  lastPingStatus?: 'ok' | 'error' | null
}

function CooldownTimer({ until }: { until: string }) {
  const [remaining, setRemaining] = useState('')

  useEffect(() => {
    const update = () => {
      const diff = new Date(until).getTime() - Date.now()
      if (diff <= 0) {
        setRemaining('')
        return
      }
      const secs = Math.floor(diff / 1000)
      if (secs < 60) setRemaining(`${secs}s`)
      else if (secs < 3600) setRemaining(`${Math.floor(secs / 60)}m ${secs % 60}s`)
      else setRemaining(`${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`)
    }
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [until])

  if (!remaining) return null

  return (
    <span
      className="x-cooldown-timer"
      title="HTTP 429 Cooldown countdown active"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        color: '#f97316',
        fontWeight: 600,
        fontSize: '0.8125rem',
        fontFamily: 'monospace',
        background: 'rgba(249, 115, 22, 0.1)',
        padding: '2px 8px',
        borderRadius: '6px',
        border: '1px solid rgba(249, 115, 22, 0.25)',
      }}
    >
      ⏱ {remaining}
    </span>
  )
}

function getScheduleSlots(anchor: string, windowHours: number, slotsPerDay: number): string[] {
  const [hStr, mStr] = anchor.split(':')
  const baseMinutes = (Number(hStr) || 0) * 60 + (Number(mStr) || 0)
  const windowMinutes = Math.round(windowHours * 60)
  const slots: string[] = []

  for (let i = 0; i < Math.min(slotsPerDay, 24); i++) {
    const total = (baseMinutes + i * windowMinutes) % 1440
    const hh = String(Math.floor(total / 60)).padStart(2, '0')
    const mm = String(total % 60).padStart(2, '0')
    slots.push(`${hh}:${mm}`)
  }
  return slots
}

export default function ProviderAccounts() {
  const { providerId } = useParams()
  const s = useXStrings()
  const p = usePoolStrings()
  const copy = useXGatewayCopy()
  const revision = useSessionRevision()
  const query = useAccounts()
  const client = useQueryClient()
  const poolQuery = useQuery({ queryKey: ['x-proxy-pool', revision], queryFn: ({ signal }) => proxyPoolApi.list(signal), retry: false, staleTime: 15_000 })
  const poolEntries = poolQuery.data?.entries ?? []

  // Cooldown query
  const cooldownQuery = useQuery({
    queryKey: ['x-account-cooldowns', revision],
    queryFn: ({ signal }) => apiFetch<{ cooldowns: Record<number, string> }>('/api/x-accounts/cooldowns', { signal }),
    refetchInterval: 5_000,
    retry: false,
  })
  const cooldowns = cooldownQuery.data?.cooldowns ?? {}

  const [connect, setConnect] = useState<true | ProviderAccount | null>(null)
  const [edit, setEdit] = useState<ProviderAccount | null>(null)
  const [label, setLabel] = useState('')
  const [proxyUrl, setProxyUrl] = useState('')
  const [poolId, setPoolId] = useState('')
  const [remove, setRemove] = useState<ProviderAccount | null>(null)
  const [tab, setTab] = useState<'accounts' | 'models'>('accounts')
  const [testResult, setTestResult] = useState<{ id: number; ok: boolean; message?: string } | null>(null)
  const [batchSummary, setBatchSummary] = useState<BatchTestResponse['summary'] | null>(null)
  const [customModelId, setCustomModelId] = useState('')
  const [customModelName, setCustomModelName] = useState('')
  const [aliasFrom, setAliasFrom] = useState('')
  const [aliasTo, setAliasTo] = useState('')
  const [modelPingStates, setModelPingStates] = useState<
    Record<string, { loading?: boolean; latencyMs?: number; ok?: boolean; message?: string }>
  >({})

  // Provider config states: Strategy & Sticky Limit
  const [strategy, setStrategy] = useState<ProviderRoutingStrategy>('fallback')
  const [stickyLimit, setStickyLimit] = useState(3)
  const [strategySaved, setStrategySaved] = useState(false)

  // Account Selection & Bulk Actions
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [showBulkDelete, setShowBulkDelete] = useState(false)
  const [showBulkProxy, setShowBulkProxy] = useState(false)
  const [bulkProxyMode, setBulkProxyMode] = useState<'none' | 'one-to-one' | 'pool'>('none')
  const [bulkTargetPoolId, setBulkTargetPoolId] = useState<number | null>(null)
  const [bulkActionSuccess, setBulkActionSuccess] = useState<string | null>(null)

  // Test One-by-One sequential test
  const [oneByOneRunning, setOneByOneRunning] = useState(false)
  const [oneByOneProgress, setOneByOneProgress] = useState<{ current: number; total: number; passed: number; failed: number } | null>(null)
  const [oneByOneStatus, setOneByOneStatus] = useState<Record<number, 'waiting' | 'testing' | 'healthy' | 'error'>>({})
  const stopTestingRef = useRef(false)

  // Provider Custom Configuration (Thinking Level & Outbound Headers)
  const [thinkingMode, setThinkingMode] = useState<ProviderThinkingMode>('auto')
  const [headersList, setHeadersList] = useState<Array<{ key: string; value: string }>>([])
  const [newHeaderKey, setNewHeaderKey] = useState('')
  const [newHeaderVal, setNewHeaderVal] = useState('')
  const [configSaved, setConfigSaved] = useState(false)

  // Tab Models: Fetch live models & Copy Model ID
  const [fetchLiveStatus, setFetchLiveStatus] = useState<string | null>(null)
  const [copiedModelId, setCopiedModelId] = useState<string | null>(null)

  const handlePingModel = async (modelId: string) => {
    if (!providerId) return
    setModelPingStates(prev => ({
      ...prev,
      [modelId]: { loading: true },
    }))
    try {
      const res = await accountsApi.pingModel(providerId, modelId)
      setModelPingStates(prev => ({
        ...prev,
        [modelId]: { loading: false, latencyMs: res.latencyMs, ok: res.ok, message: res.message },
      }))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Ping failed'
      setModelPingStates(prev => ({
        ...prev,
        [modelId]: { loading: false, ok: false, message },
      }))
    }
  }

  const modelConfigQuery = useQuery({
    queryKey: ['x-provider-models', providerId, revision],
    queryFn: ({ signal }) => accountsApi.getProviderModels(providerId!, signal),
    enabled: Boolean(providerId),
    retry: false,
  })

  // Auto-Ping Modal state
  const [autoPingAccount, setAutoPingAccount] = useState<ProviderAccount | null>(null)
  const [pingMode, setPingMode] = useState<'off' | 'reset' | 'schedule'>('off')
  const [pingAnchor, setPingAnchor] = useState('08:00')
  const [pingWindowHours, setPingWindowHours] = useState(5)
  const [pingSlotsPerDay, setPingSlotsPerDay] = useState(3)
  const [pingTestStatus, setPingTestStatus] = useState<string | null>(null)

  // Fetch schedule when modal opens
  useQuery({
    queryKey: ['x-account-autoping', autoPingAccount?.id],
    queryFn: async ({ signal }) => {
      if (!autoPingAccount) return null
      const res = await apiFetch<{ schedule: AutoPingSchedule }>(`/api/x-accounts/${autoPingAccount.id}/auto-ping`, { signal })
      if (res?.schedule) {
        setPingMode(res.schedule.mode || 'off')
        setPingAnchor(res.schedule.anchor || '08:00')
        setPingWindowHours(res.schedule.windowHours || 5)
        setPingSlotsPerDay(res.schedule.slotsPerDay || 3)
      }
      return res
    },
    enabled: Boolean(autoPingAccount),
    retry: false,
  })

  const change = useMutation({
    meta: { silenceToast: true },
    mutationFn: async (action: { type: 'edit' | 'remove' | 'toggle' | 'test'; id: number; label?: string; proxyUrl?: string; proxyPoolId?: number | null; enabled?: boolean }) => {
      if (action.type === 'test') {
        const result = await accountsApi.test(action.id)
        setTestResult({ id: action.id, ok: result.ok, message: result.message })
      } else if (action.type === 'remove') await accountsApi.remove(action.id)
      else await accountsApi.edit(action.id, action.type === 'toggle' ? { enabled: action.enabled } : { label: action.label, ...(action.proxyUrl !== undefined ? { proxyUrl: action.proxyUrl } : {}), ...(action.proxyPoolId !== undefined ? { proxyPoolId: action.proxyPoolId } : {}) })
    },
    onSuccess: async () => { setEdit(null); setRemove(null); await refreshAccounts(client) },
  })

  const saveAutoPingMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: async (accountId: number) => {
      return apiFetch(`/api/x-accounts/${accountId}/auto-ping`, {
        method: 'PUT',
        body: JSON.stringify({
          mode: pingMode,
          anchor: pingAnchor,
          windowHours: Number(pingWindowHours),
          slotsPerDay: Number(pingSlotsPerDay),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        }),
      })
    },
    onSuccess: async () => {
      setAutoPingAccount(null)
      await client.invalidateQueries({ queryKey: ['x-account-cooldowns'] })
      await refreshAccounts(client)
    },
  })

  const runPingMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: async (accountId: number) => {
      setPingTestStatus('pinging')
      return apiFetch<{ ok: boolean; latencyMs: number; message?: string }>(`/api/x-accounts/${accountId}/ping`, { method: 'POST' })
    },
    onSuccess: (res) => {
      setPingTestStatus(res.ok ? `${s.pingSuccess} (${res.latencyMs}ms)` : `${s.pingFailed}: ${res.message || ''}`)
    },
    onError: (err: Error) => {
      setPingTestStatus(`${s.pingFailed}: ${err.message}`)
    },
  })

  const batchTestProvider = useMutation({
    meta: { silenceToast: true },
    mutationFn: (pid: string) => accountsApi.testBatch({ providerId: pid }),
    onSuccess: async (res) => {
      setBatchSummary(res.summary)
      await refreshAccounts(client)
    },
  })

  const toggleAllAccounts = useMutation({
    meta: { silenceToast: true },
    mutationFn: ({ pid, enabled }: { pid: string; enabled: boolean }) => accountsApi.toggleProvider(pid, enabled),
    onSuccess: async () => {
      await refreshAccounts(client)
    },
  })

  const updateProviderModels = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: {
      disabledModels?: string[]
      customModels?: Array<{ id: string; name?: string }>
      modelAliases?: Record<string, string>
      strategy?: ProviderRoutingStrategy
      stickyLimit?: number
      thinkingMode?: ProviderThinkingMode
      customHeaders?: Record<string, string>
    }) => apiFetch(`/api/x-accounts/providers/${encodeURIComponent(providerId!)}/models`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['x-provider-models', providerId] })
      await refreshAccounts(client)
    },
  })

  // Priority reorder mutation
  const reorderPriorityMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: async (accountIds: number[]) => {
      return apiFetch<{ ok: boolean; accountPriorities: number[] }>(
        `/api/x-accounts/providers/${encodeURIComponent(providerId!)}/priority`,
        {
          method: 'PUT',
          body: JSON.stringify({ accountIds }),
        },
      )
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['x-provider-models', providerId] })
      await refreshAccounts(client)
    },
  })

  // Bulk Delete mutation
  const bulkDeleteMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: async (accountIds: number[]) => {
      return apiFetch<{ ok: boolean; deleted: number }>('/api/x-accounts/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({ accountIds }),
      })
    },
    onSuccess: async () => {
      setShowBulkDelete(false)
      setSelectedIds(new Set())
      setBulkActionSuccess(copy.bulkDeleteSuccess)
      setTimeout(() => setBulkActionSuccess(null), 3500)
      await refreshAccounts(client)
    },
  })

  // Bulk Proxy mutation
  const bulkProxyMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: async (vars: { accountIds: number[]; mode: 'none' | 'one-to-one' | 'pool'; proxyPoolId?: number | null }) => {
      return apiFetch<{ ok: boolean; updated: number }>('/api/x-accounts/bulk-proxy', {
        method: 'POST',
        body: JSON.stringify(vars),
      })
    },
    onSuccess: async () => {
      setShowBulkProxy(false)
      setSelectedIds(new Set())
      setBulkActionSuccess(copy.bulkProxySuccess)
      setTimeout(() => setBulkActionSuccess(null), 3500)
      await refreshAccounts(client)
    },
  })

  // Fetch Live Models mutation
  const fetchLiveModelsMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: async () => {
      return apiFetch<{ ok: boolean; providerId: string; models: Array<{ id: string; name?: string }> }>(
        `/api/x-accounts/providers/${encodeURIComponent(providerId!)}/fetch-models`,
        { method: 'POST', body: '{}' },
      )
    },
    onSuccess: async (res) => {
      const fetched = res.models ?? []
      const existingCatalogIds = new Set(models.map(m => m.id))
      const existingCustomMap = new Map(customModelsList.map(cm => [cm.id, cm]))
      for (const m of fetched) {
        if (!existingCatalogIds.has(m.id) && !existingCustomMap.has(m.id)) {
          existingCustomMap.set(m.id, { id: m.id, name: m.name || m.id })
        }
      }
      const mergedCustom = Array.from(existingCustomMap.values())
      await updateProviderModels.mutateAsync({ customModels: mergedCustom })
      setFetchLiveStatus(`${copy.fetchLiveModelsSuccess} (${fetched.length})`)
      setTimeout(() => setFetchLiveStatus(null), 4000)
    },
    onError: (err: Error) => {
      setFetchLiveStatus(`${copy.fetchLiveModelsError}: ${err.message}`)
      setTimeout(() => setFetchLiveStatus(null), 5000)
    },
  })

  // Sync Provider Config state from query/provider
  useEffect(() => {
    const data = modelConfigQuery.data as any
    if (data) {
      if (data.strategy) setStrategy(data.strategy as ProviderRoutingStrategy)
      if (typeof data.stickyLimit === 'number') setStickyLimit(data.stickyLimit)
      if (data.thinkingMode) setThinkingMode(data.thinkingMode as ProviderThinkingMode)
      if (data.customHeaders && typeof data.customHeaders === 'object') {
        const entries = Object.entries(data.customHeaders).map(([k, v]) => ({ key: k, value: String(v) }))
        setHeadersList(entries)
      }
    }
  }, [modelConfigQuery.data])

  if (query.isPending) return <AccountLoadState />
  if (query.isError) return <AccountLoadState error retry={() => void query.refetch()} />
  const provider = query.data.providers.find(item => item.id === providerId)
  if (!provider) return <div className="x-empty"><h1>{s.providerNotFound}</h1><Link className="x-button" to="/x/providers">{s.returnProviders}</Link></div>
  const permissions = query.data.permissions
  const canConnect = permissions.add && ((provider.id !== 'github-copilot' && provider.id !== 'custom') || permissions.manageModels)
  const models = Array.from(new Map(provider.accounts.flatMap(account => account.models).map(model => [model.id, model])).values())
  const count = (value: number) => value.toLocaleString()

  // Sort accounts by priority
  const sortedAccounts = [...provider.accounts].sort((a, b) => {
    const prioA = a.priority ?? 999999
    const prioB = b.priority ?? 999999
    if (prioA !== prioB) return prioA - prioB
    return a.id - b.id
  })

  function editSubmit(event: FormEvent) {
    event.preventDefault()
    if (edit && label.trim()) {
      const nextProxy = proxyUrl.trim()
      const proxyPatch = nextProxy !== (edit.proxyUrl ?? '') ? { proxyUrl: nextProxy } : {}
      const nextPool = poolId === '' ? null : Number(poolId)
      const poolPatch = nextPool !== (edit.proxyPoolId ?? null) ? { proxyPoolId: nextPool } : {}
      change.mutate({ type: 'edit', id: edit.id, label: label.trim(), ...proxyPatch, ...poolPatch })
    }
  }

  // Priority handlers
  const handleMoveUp = (index: number) => {
    if (index <= 0 || reorderPriorityMutation.isPending) return
    const reordered = [...sortedAccounts]
    const temp = reordered[index]
    reordered[index] = reordered[index - 1]
    reordered[index - 1] = temp
    reorderPriorityMutation.mutate(reordered.map(a => a.id))
  }

  const handleMoveDown = (index: number) => {
    if (index >= sortedAccounts.length - 1 || reorderPriorityMutation.isPending) return
    const reordered = [...sortedAccounts]
    const temp = reordered[index]
    reordered[index] = reordered[index + 1]
    reordered[index + 1] = temp
    reorderPriorityMutation.mutate(reordered.map(a => a.id))
  }

  // Account Selection handlers
  const handleToggleAccount = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleToggleSelectAll = () => {
    if (selectedIds.size === sortedAccounts.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(sortedAccounts.map(a => a.id)))
    }
  }

  // Test One-by-One sequential test
  const startOneByOneTest = async () => {
    if (!sortedAccounts.length || oneByOneRunning) return
    stopTestingRef.current = false
    setOneByOneRunning(true)

    const initial: Record<number, 'waiting' | 'testing' | 'healthy' | 'error'> = {}
    for (const a of sortedAccounts) initial[a.id] = 'waiting'
    setOneByOneStatus(initial)
    setOneByOneProgress({ current: 0, total: sortedAccounts.length, passed: 0, failed: 0 })

    let passed = 0
    let failed = 0

    for (let i = 0; i < sortedAccounts.length; i++) {
      if (stopTestingRef.current) break
      const account = sortedAccounts[i]
      setOneByOneStatus(prev => ({ ...prev, [account.id]: 'testing' }))
      setOneByOneProgress({ current: i + 1, total: sortedAccounts.length, passed, failed })

      try {
        const res = await accountsApi.test(account.id)
        if (res.ok) {
          passed++
          setOneByOneStatus(prev => ({ ...prev, [account.id]: 'healthy' }))
        } else {
          failed++
          setOneByOneStatus(prev => ({ ...prev, [account.id]: 'error' }))
        }
      } catch {
        failed++
        setOneByOneStatus(prev => ({ ...prev, [account.id]: 'error' }))
      }
      setOneByOneProgress({ current: i + 1, total: sortedAccounts.length, passed, failed })
    }

    setOneByOneRunning(false)
    await refreshAccounts(client)
  }

  const stopOneByOneTest = () => {
    stopTestingRef.current = true
    setOneByOneRunning(false)
  }

  // Copy Model ID handler
  const handleCopyModelId = (fullModelId: string) => {
    navigator.clipboard.writeText(fullModelId).catch(() => {})
    setCopiedModelId(fullModelId)
    setTimeout(() => setCopiedModelId(null), 2000)
  }

  const previewSlots = getScheduleSlots(pingAnchor, pingWindowHours, pingSlotsPerDay)
  const allAccountsEnabled = provider.accounts.length > 0 && provider.accounts.every(a => a.enabled)
  const disabledSet = new Set(modelConfigQuery.data?.disabledModels ?? [])
  const customModelsList = modelConfigQuery.data?.customModels ?? []
  const modelAliasesMap = modelConfigQuery.data?.modelAliases ?? {}
  const catalogAndCustomModels = (() => {
    const map = new Map<string, { id: string; name: string; isCustom?: boolean }>()
    for (const m of modelConfigQuery.data?.catalogModels ?? models) {
      map.set(m.id, { id: m.id, name: m.name })
    }
    for (const m of models) {
      if (!map.has(m.id)) map.set(m.id, { id: m.id, name: m.name })
    }
    for (const cm of customModelsList) {
      map.set(cm.id, { id: cm.id, name: cm.name || cm.id, isCustom: true })
    }
    return Array.from(map.values())
  })()

  return <>
    <Link to="/x/providers" className="x-back-link"><ArrowLeft size={16} />{s.providers}</Link>
    <div className="x-page-heading">
      <div className="x-provider-title">
        <ProviderMark id={provider.id} name={provider.name} />
        <div>
          <h1>{provider.name}</h1>
          <p>{provider.accounts.length} {s.accounts.toLowerCase()} · {provider.category === 'oauth' && !provider.authMethods.some(m => m === 'oauth_pkce' || m === 'device_code') ? `${s.oauth} / ${s.apiKey}` : provider.authMethods.map(method => method === 'api_key' ? s.apiKey : method === 'cookie' ? s.cookie : method === 'device_code' ? s.device : s.oauth).join(' / ')}</p>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {permissions.test && provider.accounts.length > 0 && (
          oneByOneRunning ? (
            <button type="button" className="x-button x-destructive" onClick={stopOneByOneTest}>
              <Square size={14} /> {copy.stopTest}
            </button>
          ) : (
            <button type="button" className="x-button" onClick={startOneByOneTest}>
              <Play size={14} /> {copy.testOneByOne}
            </button>
          )
        )}
        {permissions.test && provider.accounts.length > 1 && (
          <button
            type="button"
            className="x-button"
            disabled={batchTestProvider.isPending || oneByOneRunning}
            onClick={() => {
              setBatchSummary(null)
              batchTestProvider.mutate(provider.id)
            }}
          >
            <ShieldCheck size={15} />
            {batchTestProvider.isPending ? s.testing : `Batch test (${provider.accounts.length})`}
          </button>
        )}
        {permissions.edit && provider.accounts.length > 1 && (
          <button
            type="button"
            className="x-button"
            disabled={toggleAllAccounts.isPending}
            onClick={() => toggleAllAccounts.mutate({ pid: provider.id, enabled: !allAccountsEnabled })}
          >
            {allAccountsEnabled ? 'Pause all' : 'Enable all'}
          </button>
        )}
        {canConnect && <button className="x-button x-primary" onClick={() => { change.reset(); setConnect(true) }}><Plus size={16} />{s.addAccount}</button>}
      </div>
    </div>

    {/* One-by-One sequential test progress banner */}
    {oneByOneProgress && (
      <div
        className="x-panel"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 14px',
          margin: '8px 0',
          borderRadius: 8,
          background: 'var(--x-surface-subtle)',
          border: '1px solid var(--x-border)',
          fontSize: '0.875rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {oneByOneRunning ? <LoaderCircle size={16} className="x-spin" /> : <CircleCheck size={16} />}
          <span>
            {oneByOneRunning ? copy.testingOneByOne : copy.testCompleted}:{' '}
            <strong>
              {oneByOneProgress.current}/{oneByOneProgress.total}
            </strong>{' '}
            ({oneByOneProgress.passed} {copy.statusHealthy.toLowerCase()},{' '}
            {oneByOneProgress.failed} {copy.statusError.toLowerCase()})
          </span>
        </div>
        {oneByOneRunning && (
          <button type="button" className="x-button x-small x-destructive" onClick={stopOneByOneTest}>
            <Square size={13} /> {copy.stopTest}
          </button>
        )}
      </div>
    )}

    {batchSummary && (
      <p className="x-test-ok" role="status">
        <CircleCheck size={16} />
        Batch check: {batchSummary.passed}/{batchSummary.total} healthy
      </p>
    )}
    {provider.id === 'github-copilot' && <p className="x-notice">{s.copilotNotice}</p>}
    {change.isError && <div className="x-error" role="alert">{change.error.message}</div>}

    <div className="x-tabs" role="tablist" aria-label={provider.name} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = event.key === 'Home' ? 'accounts' : event.key === 'End' ? 'models' : tab === 'accounts' ? 'models' : 'accounts'
      setTab(next)
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next === 'accounts' ? 0 : 1]?.focus()
    }}>
      <button id="x-accounts-tab" role="tab" aria-selected={tab === 'accounts'} aria-controls="x-accounts-panel" tabIndex={tab === 'accounts' ? 0 : -1} className={tab === 'accounts' ? 'selected' : ''} onClick={() => setTab('accounts')}>
        {s.accounts}<span>{provider.accounts.length}</span>
      </button>
      <button id="x-models-tab" role="tab" aria-selected={tab === 'models'} aria-controls="x-models-panel" tabIndex={tab === 'models' ? 0 : -1} className={tab === 'models' ? 'selected' : ''} onClick={() => setTab('models')}>
        {s.models}<span>{models.length}</span>
      </button>
    </div>

    {tab === 'accounts' ? <section id="x-accounts-panel" role="tabpanel" aria-labelledby="x-accounts-tab">
      {/* Routing Strategy bar */}
      <div
        className="x-panel"
        style={{
          padding: '12px 16px',
          marginBottom: 16,
          borderRadius: 10,
          border: '1px solid var(--x-border)',
          background: 'var(--x-surface-subtle)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SlidersHorizontal size={18} />
            <div>
              <strong style={{ fontSize: '0.9375rem' }}>{copy.routingStrategy}</strong>
              <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--x-muted, #888)' }}>
                {strategy === 'round-robin' ? copy.roundRobinHelp : copy.fallbackHelp}
              </p>
            </div>
          </div>
          {permissions.edit && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'inline-flex', borderRadius: 8, padding: 2, background: 'var(--x-surface-hover, rgba(0,0,0,0.06))', border: '1px solid var(--x-border)' }}>
                <button
                  type="button"
                  className={`x-button x-small ${strategy === 'fallback' ? 'x-primary' : ''}`}
                  style={{ borderRadius: 6, padding: '4px 10px', fontSize: '0.8125rem', border: 'none' }}
                  onClick={() => {
                    setStrategy('fallback')
                    updateProviderModels.mutate({ strategy: 'fallback', stickyLimit })
                    setStrategySaved(true)
                    setTimeout(() => setStrategySaved(false), 2500)
                  }}
                >
                  {copy.fallback}
                </button>
                <button
                  type="button"
                  className={`x-button x-small ${strategy === 'round-robin' ? 'x-primary' : ''}`}
                  style={{ borderRadius: 6, padding: '4px 10px', fontSize: '0.8125rem', border: 'none' }}
                  onClick={() => {
                    setStrategy('round-robin')
                    updateProviderModels.mutate({ strategy: 'round-robin', stickyLimit })
                    setStrategySaved(true)
                    setTimeout(() => setStrategySaved(false), 2500)
                  }}
                >
                  {copy.roundRobin}
                </button>
              </div>

              {strategy === 'round-robin' && (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8125rem' }}>
                  <span>{copy.stickyLimit}:</span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={stickyLimit}
                    onChange={e => {
                      const val = Math.max(1, Math.min(100, Number(e.target.value) || 1))
                      setStickyLimit(val)
                    }}
                    onBlur={() => {
                      updateProviderModels.mutate({ strategy, stickyLimit })
                      setStrategySaved(true)
                      setTimeout(() => setStrategySaved(false), 2500)
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        updateProviderModels.mutate({ strategy, stickyLimit })
                        setStrategySaved(true)
                        setTimeout(() => setStrategySaved(false), 2500)
                      }
                    }}
                    style={{
                      width: '58px',
                      padding: '3px 6px',
                      borderRadius: 6,
                      border: '1px solid var(--x-border)',
                      background: 'var(--x-surface)',
                      color: 'var(--x-ink)',
                      textAlign: 'center',
                    }}
                    title={copy.stickyLimitHelp}
                  />
                  <span style={{ color: 'var(--x-muted, #888)' }}>{copy.requestsUnit}</span>
                </div>
              )}

              {strategySaved && (
                <span className="x-test-ok" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.8125rem' }}>
                  <CircleCheck size={14} /> {copy.strategySaved}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Select All & Bulk Actions toolbar */}
      {sortedAccounts.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 12,
            padding: '6px 10px',
            background: selectedIds.size > 0 ? 'rgba(99, 102, 241, 0.08)' : 'transparent',
            borderRadius: 8,
            border: selectedIds.size > 0 ? '1px solid rgba(99, 102, 241, 0.25)' : '1px solid transparent',
            transition: 'all 0.15s ease',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="x-button x-small"
              onClick={handleToggleSelectAll}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              {selectedIds.size === sortedAccounts.length ? <Square size={13} /> : <Check size={13} />}
              {selectedIds.size === sortedAccounts.length ? copy.deselectAll : copy.selectAll}
            </button>
            {selectedIds.size > 0 && (
              <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--x-ink)' }}>
                {selectedIds.size} {copy.selectedAccounts}
              </span>
            )}
          </div>

          {selectedIds.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {permissions.edit && (
                <button
                  type="button"
                  className="x-button x-small"
                  onClick={() => setShowBulkProxy(true)}
                >
                  {copy.bulkProxy}
                </button>
              )}
              {permissions.delete && (
                <button
                  type="button"
                  className="x-button x-small x-destructive"
                  onClick={() => setShowBulkDelete(true)}
                >
                  <Trash2 size={13} />
                  {copy.bulkDelete}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {bulkActionSuccess && (
        <p className="x-test-ok" role="status" style={{ marginBottom: 12 }}>
          <CircleCheck size={16} /> {bulkActionSuccess}
        </p>
      )}

      {!sortedAccounts.length && <div className="x-empty x-panel"><Unplug size={38} /><h2>{s.noAccounts}</h2><p>{s.noAccountsHelp}</p>{canConnect && <button className="x-button x-primary" onClick={() => setConnect(true)}><Plus size={16} />{s.addAccount}</button>}</div>}
      <div className="x-account-list">
        {sortedAccounts.map((account, index) => {
          const cooldownUntil = cooldowns[account.id]
          const isSelected = selectedIds.has(account.id)
          const testStatus = oneByOneStatus[account.id]
          return (
            <article key={account.id} className={`x-account x-panel ${account.enabled ? '' : 'x-account-paused'}`}>
              <div className="x-account-top">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => handleToggleAccount(account.id)}
                  aria-label={`Select account ${account.label}`}
                  style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#6366f1', marginRight: 4 }}
                />

                {/* Account priority badge */}
                <span
                  className="x-badge"
                  title={`Priority #${account.priority ?? index + 1}`}
                  style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: '0.8125rem' }}
                >
                  #{account.priority ?? index + 1}
                </span>

                {/* Priority Move Up / Move Down buttons */}
                {permissions.edit && sortedAccounts.length > 1 && (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                    <button
                      type="button"
                      className="x-icon-button"
                      disabled={index === 0 || reorderPriorityMutation.isPending}
                      title={copy.moveUp}
                      aria-label={`${copy.moveUp} ${account.label}`}
                      onClick={() => handleMoveUp(index)}
                      style={{ padding: 4 }}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      className="x-icon-button"
                      disabled={index === sortedAccounts.length - 1 || reorderPriorityMutation.isPending}
                      title={copy.moveDown}
                      aria-label={`${copy.moveDown} ${account.label}`}
                      onClick={() => handleMoveDown(index)}
                      style={{ padding: 4 }}
                    >
                      <ArrowDown size={14} />
                    </button>
                  </div>
                )}

                <span className="x-account-icon"><KeyRound size={20} /></span>
                <div className="x-account-identity">
                  <h3>{account.label || provider.name}</h3>
                  <p>
                    {account.identity ?? (account.authMethod === 'api_key' ? s.apiKey : account.authMethod === 'cookie' ? s.cookie : s.oauth)}
                    {account.proxyUrl ? ` · Proxy: ${account.proxyUrl}` : ''}
                    {account.proxyPoolName ? ` · ${p.poolBadge}: ${account.proxyPoolName}` : ''}
                  </p>
                </div>

                {/* Visual Cooldown timer badge if account hit HTTP 429 */}
                {cooldownUntil && <CooldownTimer until={cooldownUntil} />}

                {/* One-by-One sequential test status */}
                {testStatus && (
                  <span
                    className={`x-badge ${testStatus === 'healthy' ? 'x-green' : testStatus === 'error' ? 'x-red' : ''}`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    {testStatus === 'testing' && <LoaderCircle size={12} className="x-spin" />}
                    {testStatus === 'healthy' && <CircleCheck size={12} />}
                    {testStatus === 'error' && <AlertTriangle size={12} />}
                    {testStatus === 'waiting' && <Clock size={12} />}
                    {testStatus === 'testing'
                      ? copy.statusTesting
                      : testStatus === 'healthy'
                        ? copy.statusHealthy
                        : testStatus === 'error'
                          ? copy.statusError
                          : copy.statusWaiting}
                  </span>
                )}

                <span className={`x-badge ${!account.enabled ? '' : account.status === 'healthy' ? 'x-green' : account.status === 'error' ? 'x-red' : ''}`}>
                  <span className="x-dot" />
                  {!account.enabled ? s.paused : account.status === 'healthy' ? s.healthy : account.status === 'error' ? s.needsLogin : s.unknown}
                </span>
                {permissions.edit && (
                  <button className="x-switch" role="switch" aria-checked={account.enabled} aria-label={`${account.enabled ? s.disable : s.enable}: ${account.label}`} disabled={change.isPending} onClick={() => change.mutate({ type: 'toggle', id: account.id, enabled: !account.enabled })}>
                    <span />
                  </button>
                )}
              </div>

              <div className="x-account-metrics">
                <div><span>{s.requests}</span><strong>{count(account.monthlyUsage.requests)}<small> / {account.monthlyRequestCap ? count(account.monthlyRequestCap) : '∞'}</small></strong></div>
                <div><span>{s.tokens}</span><strong>{count(account.monthlyUsage.tokens)}<small> / {account.monthlyTokenCap ? count(account.monthlyTokenCap) : '∞'}</small></strong></div>
              </div>

              <div className="x-account-actions">
                {permissions.test && (
                  <button className="x-button x-small" disabled={change.isPending || oneByOneRunning} onClick={() => { setTestResult(null); change.mutate({ type: 'test', id: account.id }) }}>
                    <ShieldCheck size={14} />{change.isPending && change.variables?.type === 'test' && change.variables.id === account.id ? s.testing : s.test}
                  </button>
                )}

                {/* Auto-Ping Schedule Configuration Button */}
                <button
                  type="button"
                  className="x-button x-small"
                  title={s.autoPingHelp}
                  onClick={() => {
                    setPingTestStatus(null)
                    setAutoPingAccount(account)
                  }}
                >
                  <Clock size={14} />{s.autoPing}
                </button>

                {permissions.edit && (provider.id !== 'github-copilot' || permissions.manageModels) && (account.authMethod === 'oauth_pkce' || account.authMethod === 'device_code') && (
                  <button className="x-button x-small" disabled={change.isPending} onClick={() => { change.reset(); setConnect(account) }}>
                    <RefreshCw size={14} />{s.reconnect}
                  </button>
                )}

                <span className="x-spacer" />

                {permissions.edit && (
                  <button className="x-icon-button" aria-label={`${s.edit}: ${account.label}`} onClick={() => { change.reset(); setEdit(account); setLabel(account.label); setProxyUrl(account.proxyUrl ?? ''); setPoolId(account.proxyPoolId != null ? String(account.proxyPoolId) : '') }}>
                    <Pencil size={16} />
                  </button>
                )}

                {permissions.delete && (
                  <button className="x-icon-button x-danger" aria-label={`${s.remove}: ${account.label}`} onClick={() => { change.reset(); setRemove(account) }}>
                    <Trash2 size={16} />
                  </button>
                )}

                {!permissions.edit && !permissions.delete && <span className="x-caption">{s.readOnly}<Ellipsis size={15} /></span>}
              </div>

              {testResult && testResult.id === account.id && (
                <p className={testResult.ok ? 'x-test-ok' : 'x-error'} role="status">
                  {testResult.ok && <CircleCheck size={16} />}{testResult.ok ? s.testOk : (testResult.message ? `${s.testFailed}: ${testResult.message}` : s.testFailed)}
                </p>
              )}
            </article>
          )
        })}
      </div>

      {/* Provider Custom Configuration Card */}
      {permissions.edit && (
        <div
          className="x-panel"
          style={{
            marginTop: 24,
            padding: '16px 20px',
            borderRadius: 10,
            border: '1px solid var(--x-border)',
            background: 'var(--x-surface-subtle)',
          }}
        >
          <div style={{ marginBottom: 14 }}>
            <h3 style={{ margin: '0 0 4px', fontSize: '1rem', fontWeight: 600 }}>{copy.providerConfig}</h3>
            <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--x-muted, #888)' }}>{copy.providerConfigDesc}</p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Thinking Level */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: '0.875rem', fontWeight: 600 }}>{copy.thinkingLevel}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {(['auto', 'low', 'medium', 'high', 'max'] as const).map(lvl => (
                  <button
                    key={lvl}
                    type="button"
                    className={`x-button x-small ${thinkingMode === lvl ? 'x-primary' : ''}`}
                    onClick={() => setThinkingMode(lvl)}
                  >
                    {lvl === 'auto'
                      ? copy.thinkingAuto
                      : lvl === 'low'
                        ? copy.thinkingLow
                        : lvl === 'medium'
                          ? copy.thinkingMedium
                          : lvl === 'high'
                            ? copy.thinkingHigh
                            : copy.thinkingMax}
                  </button>
                ))}
              </div>
            </div>

            {/* Custom Outbound Headers */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                <label style={{ fontSize: '0.875rem', fontWeight: 600 }}>{copy.customHeaders}</label>
                <span style={{ fontSize: '0.75rem', color: 'var(--x-muted, #888)' }}>{copy.customHeadersHelp}</span>
              </div>

              {/* Add header row */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder={copy.headerName}
                  value={newHeaderKey}
                  onChange={e => setNewHeaderKey(e.target.value)}
                  style={{
                    flex: '1 1 180px',
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--x-border)',
                    background: 'var(--x-surface)',
                    color: 'var(--x-ink)',
                    fontSize: '0.8125rem',
                  }}
                />
                <input
                  type="text"
                  placeholder={copy.headerValue}
                  value={newHeaderVal}
                  onChange={e => setNewHeaderVal(e.target.value)}
                  style={{
                    flex: '1 1 200px',
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--x-border)',
                    background: 'var(--x-surface)',
                    color: 'var(--x-ink)',
                    fontSize: '0.8125rem',
                  }}
                />
                <button
                  type="button"
                  className="x-button x-small"
                  disabled={!newHeaderKey.trim()}
                  onClick={() => {
                    const k = newHeaderKey.trim()
                    if (!k) return
                    setHeadersList(prev => [...prev.filter(h => h.key.toLowerCase() !== k.toLowerCase()), { key: k, value: newHeaderVal.trim() }])
                    setNewHeaderKey('')
                    setNewHeaderVal('')
                  }}
                >
                  <Plus size={13} /> {copy.addHeader}
                </button>
              </div>

              {newHeaderKey.trim() && BLOCKED_CUSTOM_HEADERS.has(newHeaderKey.trim().toLowerCase()) && (
                <p className="x-error" role="alert" style={{ margin: 0, fontSize: '0.8125rem' }}>
                  <AlertTriangle size={13} style={{ display: 'inline', marginRight: 4 }} />
                  {copy.headerBlockedWarning}
                </p>
              )}

              {/* Existing headers list */}
              {headersList.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                  {headersList.map((h, i) => {
                    const isBlocked = BLOCKED_CUSTOM_HEADERS.has(h.key.toLowerCase())
                    return (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          padding: '6px 10px',
                          borderRadius: 6,
                          background: isBlocked ? 'rgba(239, 68, 68, 0.08)' : 'var(--x-surface)',
                          border: isBlocked ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid var(--x-border)',
                          fontSize: '0.8125rem',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                          <strong style={{ fontFamily: 'monospace', color: isBlocked ? '#ef4444' : 'inherit' }}>{h.key}</strong>
                          <span style={{ color: 'var(--x-muted, #888)' }}>:</span>
                          <code style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.value}</code>
                          {isBlocked && (
                            <span className="x-badge x-danger" style={{ fontSize: '0.7rem', padding: '1px 5px' }}>
                              Blocked
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="x-icon-button"
                          title="Remove header"
                          onClick={() => setHeadersList(prev => prev.filter((_, idx) => idx !== i))}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Save button and status */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 4 }}>
              <button
                type="button"
                className="x-button x-primary x-small"
                disabled={updateProviderModels.isPending}
                onClick={async () => {
                  const headersObj: Record<string, string> = {}
                  for (const h of headersList) {
                    const k = h.key.trim()
                    if (k && !BLOCKED_CUSTOM_HEADERS.has(k.toLowerCase())) {
                      headersObj[k] = h.value
                    }
                  }
                  await updateProviderModels.mutateAsync({
                    thinkingMode,
                    customHeaders: headersObj,
                  })
                  setConfigSaved(true)
                  setTimeout(() => setConfigSaved(false), 2500)
                }}
              >
                {updateProviderModels.isPending ? copy.saving : copy.saveConfig}
              </button>
              {configSaved && (
                <span className="x-test-ok" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.8125rem' }}>
                  <CircleCheck size={14} /> {copy.configSaved}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="x-info-row" style={{ marginTop: 20 }}><ShieldCheck size={20} /><div><h3>{s.routing}</h3><p>{s.routingHelp}</p><p>{s.sharedPool}</p></div></div>
    </section> : (
      <section id="x-models-panel" role="tabpanel" aria-labelledby="x-models-tab" className="x-panel x-model-list">
        {/* Enable All, Disable All & Fetch Live Models top toolbar */}
        {permissions.edit && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="x-button x-small"
                disabled={updateProviderModels.isPending}
                onClick={() => updateProviderModels.mutate({ disabledModels: [] })}
              >
                <CircleCheck size={14} /> {copy.enableAllModels}
              </button>
              <button
                type="button"
                className="x-button x-small"
                disabled={updateProviderModels.isPending}
                onClick={() => updateProviderModels.mutate({ disabledModels: catalogAndCustomModels.map(m => m.id) })}
              >
                <X size={14} /> {copy.disableAllModels}
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className="x-button x-small"
                disabled={fetchLiveModelsMutation.isPending}
                onClick={() => fetchLiveModelsMutation.mutate()}
              >
                <RefreshCw size={14} className={fetchLiveModelsMutation.isPending ? 'x-spin' : ''} />
                {fetchLiveModelsMutation.isPending ? copy.fetchingLiveModels : copy.fetchLiveModels}
              </button>
              {fetchLiveStatus && (
                <span style={{ fontSize: '0.8125rem', color: fetchLiveStatus.includes(copy.fetchLiveModelsError) ? '#ef4444' : '#10b981' }}>
                  {fetchLiveStatus}
                </span>
              )}
            </div>
          </div>
        )}

        {!permissions.edit ? (
          models.length ? (
            <div style={{ display: 'grid', gap: 8 }}>
              {models.map(model => {
                const providerPrefix = provider.alias || provider.id
                const suffix = thinkingMode && thinkingMode !== 'auto' ? `(${thinkingMode})` : ''
                const fullModelId = `${providerPrefix}/${model.id}${suffix}`
                const isCopied = copiedModelId === fullModelId

                return (
                  <div key={model.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <strong>{model.name}</strong><code>{model.id}</code>
                    </div>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <button
                        type="button"
                        className="x-button x-small"
                        style={{ padding: '3px 8px', fontSize: '0.75rem', height: '26px' }}
                        title={`${copy.copyModelId}: ${fullModelId}`}
                        aria-label={`${copy.copyModelId}: ${fullModelId}`}
                        onClick={() => handleCopyModelId(fullModelId)}
                      >
                        {isCopied ? <Check size={12} style={{ color: '#10b981' }} /> : <Copy size={12} />}
                        {isCopied ? copy.modelIdCopied : copy.copyModelId}
                      </button>

                      {permissions.test && (
                        <>
                          {modelPingStates[model.id]?.loading ? (
                            <span className="x-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <LoaderCircle size={12} className="x-spin" /> Ping...
                            </span>
                          ) : modelPingStates[model.id]?.ok !== undefined ? (
                            modelPingStates[model.id]?.ok ? (
                              <span
                                className="x-badge"
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 4,
                                  color: '#10b981',
                                  background: 'rgba(16, 185, 129, 0.1)',
                                  borderColor: 'rgba(16, 185, 129, 0.3)',
                                }}
                                title={modelPingStates[model.id]?.message || 'Ping successful'}
                              >
                                <Activity size={12} /> {modelPingStates[model.id]?.latencyMs}ms
                              </span>
                            ) : (
                              <span
                                className="x-badge x-danger"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                                title={modelPingStates[model.id]?.message}
                              >
                                <AlertTriangle size={12} /> {modelPingStates[model.id]?.message || 'Error'}
                              </span>
                            )
                          ) : null}
                          <button
                            type="button"
                            className="x-button x-small"
                            style={{ padding: '3px 8px', fontSize: '0.75rem', height: '26px' }}
                            disabled={modelPingStates[model.id]?.loading}
                            onClick={() => handlePingModel(model.id)}
                            aria-label={`Ping model ${model.id}`}
                            title={`Ping ${model.id}`}
                          >
                            <Activity size={12} /> Ping
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : <p className="x-muted">{s.noModels}</p>
        ) : (
          <div style={{ display: 'grid', gap: 16 }}>
            <form
              style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
              onSubmit={e => {
                e.preventDefault()
                const trimmedId = customModelId.trim()
                if (!trimmedId) return
                const nextCustom = [
                  ...customModelsList.filter(cm => cm.id !== trimmedId),
                  { id: trimmedId, name: customModelName.trim() || trimmedId },
                ]
                updateProviderModels.mutate({ customModels: nextCustom })
                setCustomModelId('')
                setCustomModelName('')
              }}
            >
              <input
                type="text"
                placeholder="Custom model ID (e.g. gpt-4.1-mini)"
                value={customModelId}
                onChange={e => setCustomModelId(e.target.value)}
                style={{ flex: '1 1 200px', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)' }}
              />
              <input
                type="text"
                placeholder="Display name (optional)"
                value={customModelName}
                onChange={e => setCustomModelName(e.target.value)}
                style={{ flex: '1 1 180px', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)' }}
              />
              <button type="submit" className="x-button x-small x-primary" disabled={updateProviderModels.isPending || !customModelId.trim()}>
                <Plus size={14} />Add Model
              </button>
            </form>

            <form
              style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
              onSubmit={e => {
                e.preventDefault()
                const from = aliasFrom.trim()
                const to = aliasTo.trim()
                if (!from || !to) return
                updateProviderModels.mutate({
                  modelAliases: { ...modelAliasesMap, [from]: to },
                })
                setAliasFrom('')
                setAliasTo('')
              }}
            >
              <input
                type="text"
                placeholder="Model alias (e.g. sonnet-latest)"
                value={aliasFrom}
                onChange={e => setAliasFrom(e.target.value)}
                style={{ flex: '1 1 180px', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)' }}
              />
              <input
                type="text"
                placeholder="Target model ID"
                value={aliasTo}
                onChange={e => setAliasTo(e.target.value)}
                style={{ flex: '1 1 180px', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)' }}
              />
              <button type="submit" className="x-button x-small" disabled={updateProviderModels.isPending || !aliasFrom.trim() || !aliasTo.trim()}>
                <Plus size={14} />Add Alias
              </button>
            </form>

            {Object.keys(modelAliasesMap).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {Object.entries(modelAliasesMap).map(([alias, target]) => (
                  <span key={alias} className="x-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <code>{alias}</code> → <code>{target}</code>
                    <button
                      type="button"
                      className="x-icon-button"
                      aria-label={`Remove alias ${alias}`}
                      onClick={() => {
                        const nextAliases = { ...modelAliasesMap }
                        delete nextAliases[alias]
                        updateProviderModels.mutate({ modelAliases: nextAliases })
                      }}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {catalogAndCustomModels.length ? (
              <div style={{ display: 'grid', gap: 8 }}>
                {catalogAndCustomModels.map(model => {
                  const isDisabled = disabledSet.has(model.id)
                  const providerPrefix = provider.alias || provider.id
                  const suffix = thinkingMode && thinkingMode !== 'auto' ? `(${thinkingMode})` : ''
                  const fullModelId = `${providerPrefix}/${model.id}${suffix}`
                  const isCopied = copiedModelId === fullModelId

                  return (
                    <div key={model.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', opacity: isDisabled ? 0.55 : 1 }}>
                        <strong>{model.name}</strong>
                        <code>{model.id}</code>
                        {model.isCustom && <span className="x-badge">Custom</span>}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {/* Copy Model ID button */}
                        <button
                          type="button"
                          className="x-button x-small"
                          style={{ padding: '3px 8px', fontSize: '0.75rem', height: '26px' }}
                          title={`${copy.copyModelId}: ${fullModelId}`}
                          aria-label={`${copy.copyModelId}: ${fullModelId}`}
                          onClick={() => handleCopyModelId(fullModelId)}
                        >
                          {isCopied ? <Check size={12} style={{ color: '#10b981' }} /> : <Copy size={12} />}
                          {isCopied ? copy.modelIdCopied : copy.copyModelId}
                        </button>

                        {permissions.test && (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            {modelPingStates[model.id]?.loading ? (
                              <span className="x-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <LoaderCircle size={12} className="x-spin" /> Ping...
                              </span>
                            ) : modelPingStates[model.id]?.ok !== undefined ? (
                              modelPingStates[model.id]?.ok ? (
                                <span
                                  className="x-badge"
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    color: '#10b981',
                                    background: 'rgba(16, 185, 129, 0.1)',
                                    borderColor: 'rgba(16, 185, 129, 0.3)',
                                  }}
                                  title={modelPingStates[model.id]?.message || 'Ping successful'}
                                >
                                  <Activity size={12} /> {modelPingStates[model.id]?.latencyMs}ms
                                </span>
                              ) : (
                                <span
                                  className="x-badge x-danger"
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                                  title={modelPingStates[model.id]?.message}
                                >
                                  <AlertTriangle size={12} /> {modelPingStates[model.id]?.message || 'Error'}
                                </span>
                              )
                            ) : null}
                            <button
                              type="button"
                              className="x-button x-small"
                              style={{ padding: '3px 8px', fontSize: '0.75rem', height: '26px' }}
                              disabled={modelPingStates[model.id]?.loading}
                              onClick={() => handlePingModel(model.id)}
                              aria-label={`Ping model ${model.id}`}
                              title={`Ping ${model.id}`}
                            >
                              <Activity size={12} /> Ping
                            </button>
                          </div>
                        )}
                        <button
                          type="button"
                          role="switch"
                          className="x-switch"
                          aria-checked={!isDisabled}
                          aria-label={`${isDisabled ? s.enable : s.disable} model ${model.id}`}
                          disabled={updateProviderModels.isPending}
                          onClick={() => {
                            const nextDisabled = isDisabled
                              ? Array.from(disabledSet).filter(id => id !== model.id)
                              : [...Array.from(disabledSet), model.id]
                            updateProviderModels.mutate({ disabledModels: nextDisabled })
                          }}
                        >
                          <span />
                        </button>
                        {model.isCustom && (
                          <button
                            type="button"
                            className="x-icon-button x-danger"
                            aria-label={`Delete custom model ${model.id}`}
                            disabled={updateProviderModels.isPending}
                            onClick={() => {
                              const nextCustom = customModelsList.filter(cm => cm.id !== model.id)
                              updateProviderModels.mutate({ customModels: nextCustom })
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="x-muted">{s.noModels}</p>
            )}
          </div>
        )}
      </section>
    )}

    {connect && <ConnectAccountDialog provider={provider} account={connect === true ? undefined : connect} onClose={() => setConnect(null)} />}

    {/* Auto-Ping Schedule Modal */}
    {autoPingAccount && (
      <Dialog open onOpenChange={open => { if (!open && !saveAutoPingMutation.isPending) setAutoPingAccount(null) }}>
        <DialogPopup className="x-console x-dialog" style={{ maxWidth: '500px' }}>
          <DialogTitle>{s.autoPing}</DialogTitle>
          <DialogDescription>{autoPingAccount.label} — {s.autoPingHelp}</DialogDescription>

          <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Mode selection buttons */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
              {(['off', 'reset', 'schedule'] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  className={`x-button ${pingMode === mode ? 'x-primary' : ''}`}
                  onClick={() => setPingMode(mode)}
                  style={{ justifyContent: 'center' }}
                >
                  {mode === 'off' ? s.modeOff : mode === 'reset' ? s.modeReset : s.modeSchedule}
                </button>
              ))}
            </div>

            {pingMode === 'schedule' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8125rem' }}>
                    {s.anchorTime}
                    <input
                      type="time"
                      value={pingAnchor}
                      onChange={e => setPingAnchor(e.target.value)}
                      style={{ padding: '0.375rem', borderRadius: '6px', border: '1px solid var(--border)' }}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8125rem' }}>
                    {s.windowHours}
                    <input
                      type="number"
                      min="0.5"
                      max="24"
                      step="0.5"
                      value={pingWindowHours}
                      onChange={e => setPingWindowHours(Number(e.target.value))}
                      style={{ padding: '0.375rem', borderRadius: '6px', border: '1px solid var(--border)' }}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8125rem' }}>
                    {s.slotsPerDay}
                    <input
                      type="number"
                      min="1"
                      max="24"
                      value={pingSlotsPerDay}
                      onChange={e => setPingSlotsPerDay(Number(e.target.value))}
                      style={{ padding: '0.375rem', borderRadius: '6px', border: '1px solid var(--border)' }}
                    />
                  </label>
                </div>

                {previewSlots.length > 0 && (
                  <div style={{ background: 'var(--bg-subtle, rgba(0,0,0,0.05))', padding: '0.65rem 0.75rem', borderRadius: '8px' }}>
                    <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                      Daily Ping Slots ({Intl.DateTimeFormat().resolvedOptions().timeZone})
                    </p>
                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.875rem', fontWeight: 500 }}>
                      {previewSlots.join('  →  ')}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Test Ping Action */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.5rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
              <button
                type="button"
                className="x-button x-small"
                disabled={runPingMutation.isPending}
                onClick={() => runPingMutation.mutate(autoPingAccount.id)}
              >
                <Send size={14} />{runPingMutation.isPending ? s.testing : s.pingNow}
              </button>
              {pingTestStatus && (
                <span style={{ fontSize: '0.8125rem', color: pingTestStatus.includes(s.pingSuccess) ? '#10b981' : 'inherit' }}>
                  {pingTestStatus}
                </span>
              )}
            </div>

            <div className="x-dialog-actions" style={{ marginTop: '1rem' }}>
              <button type="button" className="x-button" onClick={() => setAutoPingAccount(null)}>{s.cancel}</button>
              <button
                type="button"
                className="x-button x-primary"
                disabled={saveAutoPingMutation.isPending}
                onClick={() => saveAutoPingMutation.mutate(autoPingAccount.id)}
              >
                {saveAutoPingMutation.isPending ? s.saving : s.save}
              </button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    )}

    {/* Bulk Delete Confirmation Dialog */}
    {showBulkDelete && (
      <Dialog open onOpenChange={open => { if (!open && !bulkDeleteMutation.isPending) setShowBulkDelete(false) }}>
        <DialogPopup className="x-console x-dialog">
          <DialogTitle>{copy.bulkDelete}</DialogTitle>
          <DialogDescription>{copy.bulkDeleteConfirm.replace('{count}', String(selectedIds.size))}</DialogDescription>
          {bulkDeleteMutation.isError && <p className="x-error" role="alert">{bulkDeleteMutation.error.message}</p>}
          <div className="x-dialog-actions">
            <button type="button" className="x-button" disabled={bulkDeleteMutation.isPending} onClick={() => setShowBulkDelete(false)}>
              <X size={14} /> {copy.cancel}
            </button>
            <button
              type="button"
              className="x-button x-destructive"
              disabled={bulkDeleteMutation.isPending}
              onClick={() => bulkDeleteMutation.mutate(Array.from(selectedIds))}
            >
              <Trash2 size={16} /> {bulkDeleteMutation.isPending ? copy.bulkDeleting : copy.bulkDelete}
            </button>
          </div>
        </DialogPopup>
      </Dialog>
    )}

    {/* Bulk Apply Proxy Dialog */}
    {showBulkProxy && (
      <Dialog open onOpenChange={open => { if (!open && !bulkProxyMutation.isPending) setShowBulkProxy(false) }}>
        <DialogPopup className="x-console x-dialog" style={{ maxWidth: 500 }}>
          <DialogTitle>{copy.bulkProxyModalTitle}</DialogTitle>
          <DialogDescription>{copy.bulkProxyModalDesc}</DialogDescription>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.875rem' }}>
              <input
                type="radio"
                name="bulkProxyMode"
                value="none"
                checked={bulkProxyMode === 'none'}
                onChange={() => setBulkProxyMode('none')}
              />
              <span>{copy.proxyModeUnbind}</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.875rem' }}>
              <input
                type="radio"
                name="bulkProxyMode"
                value="one-to-one"
                checked={bulkProxyMode === 'one-to-one'}
                onChange={() => setBulkProxyMode('one-to-one')}
              />
              <span>{copy.proxyModeRotate}</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.875rem' }}>
              <input
                type="radio"
                name="bulkProxyMode"
                value="pool"
                checked={bulkProxyMode === 'pool'}
                onChange={() => setBulkProxyMode('pool')}
              />
              <span>{copy.proxyModePool}</span>
            </label>

            {bulkProxyMode === 'pool' && (
              <div style={{ marginLeft: 24, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: '0.8125rem', fontWeight: 500 }}>{copy.selectPool}</label>
                <select
                  value={bulkTargetPoolId ?? ''}
                  onChange={e => setBulkTargetPoolId(e.target.value ? Number(e.target.value) : null)}
                  style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--x-border)', background: 'var(--x-surface)', color: 'var(--x-ink)' }}
                >
                  <option value="">{p.accountPoolNone}</option>
                  {poolEntries.map(entry => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name} {entry.enabled ? '' : ` (${p.disabled})`}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {bulkProxyMutation.isError && <p className="x-error" role="alert" style={{ marginTop: 12 }}>{bulkProxyMutation.error.message}</p>}

          <div className="x-dialog-actions" style={{ marginTop: 20 }}>
            <button type="button" className="x-button" disabled={bulkProxyMutation.isPending} onClick={() => setShowBulkProxy(false)}>
              {copy.cancel}
            </button>
            <button
              type="button"
              className="x-button x-primary"
              disabled={bulkProxyMutation.isPending || (bulkProxyMode === 'pool' && !bulkTargetPoolId)}
              onClick={() =>
                bulkProxyMutation.mutate({
                  accountIds: Array.from(selectedIds),
                  mode: bulkProxyMode,
                  proxyPoolId: bulkProxyMode === 'pool' ? bulkTargetPoolId : null,
                })
              }
            >
              {bulkProxyMutation.isPending ? copy.applying : copy.apply}
            </button>
          </div>
        </DialogPopup>
      </Dialog>
    )}

    {edit && <Dialog open onOpenChange={open => { if (!open && !change.isPending) setEdit(null) }}><DialogPopup className="x-console x-dialog"><DialogTitle>{s.edit}</DialogTitle><DialogDescription>{edit.label}</DialogDescription><form className="x-form" onSubmit={editSubmit}><label>{s.name}<input id="x-account-edit-label" name="label" autoFocus required maxLength={100} value={label} onChange={event => setLabel(event.target.value)} /></label><label>{s.accountProxy}<input id="x-account-edit-proxy" name="proxyUrl" value={proxyUrl} placeholder={s.accountProxyPlaceholder} onChange={event => setProxyUrl(event.target.value)} /></label><label>{p.accountPool}<select id="x-account-edit-pool" name="proxyPoolId" value={poolId} onChange={event => setPoolId(event.target.value)}><option value="">{p.accountPoolNone}</option>{poolEntries.map(entry => <option key={entry.id} value={entry.id}>{entry.name}{entry.enabled ? '' : ` (${p.disabled})`}</option>)}</select></label>{change.isError && <p className="x-error" role="alert">{change.error.message}</p>}<div className="x-dialog-actions"><button type="button" className="x-button" disabled={change.isPending} onClick={() => setEdit(null)}>{s.cancel}</button><button className="x-button x-primary" disabled={change.isPending || !label.trim()}>{change.isPending ? s.saving : s.save}</button></div></form></DialogPopup></Dialog>}
    {remove && <Dialog open onOpenChange={open => { if (!open && !change.isPending) setRemove(null) }}><DialogPopup className="x-console x-dialog"><DialogTitle>{s.removeTitle}</DialogTitle><DialogDescription>{remove.label} — {s.removeHelp}</DialogDescription>{change.isError && <p className="x-error" role="alert">{change.error.message}</p>}<div className="x-dialog-actions"><button className="x-button" disabled={change.isPending} onClick={() => setRemove(null)}><X size={14} />{s.cancel}</button><button className="x-button x-destructive" disabled={change.isPending} onClick={() => change.mutate({ type: 'remove', id: remove.id })}><Trash2 size={16} />{s.remove}</button></div></DialogPopup></Dialog>}
  </>
}
