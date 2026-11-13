import { useState, useRef, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Check,
  CircleCheck,
  Copy,
  Database,
  DollarSign,
  Download,
  ExternalLink,
  Globe,
  KeyRound,
  Lock,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Terminal,
  Trash2,
  Upload,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useUserSession } from '../../use-session'
import { useSessionRevision } from '../../session-state'
import { useXStrings } from '../strings'
import { askConfirm } from '../shell/confirm'

type GatewayStatus = {
  enabled: boolean
  combosCount: number
}

type GatewayProxyStatus = {
  proxyUrl: string
  configured: boolean
}

type XGatewayClientKey = {
  id: number
  userId: number
  name: string
  keyPrefix: string
  rpmLimit: number
  revoked: boolean
  createdAt: string
  lastUsedAt: string | null
  access?: {
    restricted: boolean
    allow: string[]
  }
}

type ProxyTestResult = {
  ok: boolean
  latencyMs: number
  status?: number
  target?: string
  error?: string
}

type MintedXGatewayKey = {
  id: number
  key: string
  keyPrefix: string
  name: string
  createdAt: string
}

type ModelPricingRate = {
  input: number
  output: number
  cached?: number
  reasoning?: number
  cache_creation?: number
}

type ProviderPricingMap = Record<string, Record<string, ModelPricingRate>>

export default function Endpoint() {
  const s = useXStrings()
  const client = useQueryClient()
  const revision = useSessionRevision()
  const session = useUserSession()
  const [copied, setCopied] = useState('')
  const [error, setError] = useState('')
  const [keyName, setKeyName] = useState('')
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null)
  const [proxyInput, setProxyInput] = useState('')
  const [editingAccessKeyId, setEditingAccessKeyId] = useState<number | null>(null)
  const [accessRestricted, setAccessRestricted] = useState(false)
  const [accessAllowInput, setAccessAllowInput] = useState('')
  const [activeCliTab, setActiveCliTab] = useState<'claude-code' | 'codex' | 'cursor-cline' | 'continue' | 'opencode'>('claude-code')
  const canEdit = session.hasPermission('edit_x_settings')

  // Pricing states
  const [pricingEdits, setPricingEdits] = useState<Record<string, Record<string, Partial<ModelPricingRate>>>>({})
  const [selectedProviderFilter, setSelectedProviderFilter] = useState('all')
  const [modelSearchQuery, setModelSearchQuery] = useState('')
  const [showAddModel, setShowAddModel] = useState(false)
  const [newModelProvider, setNewModelProvider] = useState('')
  const [newModelId, setNewModelId] = useState('')
  const [newModelInput, setNewModelInput] = useState('')
  const [newModelOutput, setNewModelOutput] = useState('')
  const [newModelCached, setNewModelCached] = useState('')
  const [newModelReasoning, setNewModelReasoning] = useState('')
  const [pricingSuccessMsg, setPricingSuccessMsg] = useState('')

  // Backup & Restore states
  const [backupSuccessMsg, setBackupSuccessMsg] = useState('')
  const [backupErrorMsg, setBackupErrorMsg] = useState('')
  const [isExporting, setIsExporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const status = useQuery({
    queryKey: ['x-gateway-status', revision],
    queryFn: ({ signal }) => apiFetch<GatewayStatus>('/api/x-gateway/status', { signal }),
    retry: false,
  })
  const proxyStatus = useQuery({
    queryKey: ['x-gateway-proxy', revision],
    queryFn: ({ signal }) => apiFetch<GatewayProxyStatus>('/api/x-gateway/proxy', { signal }),
    retry: false,
  })
  const xKeys = useQuery({
    queryKey: ['x-gateway-client-keys', revision],
    queryFn: ({ signal }) => apiFetch<{ keys: XGatewayClientKey[] }>('/api/x-gateway/keys', { signal }),
    retry: false,
  })
  const pricingQuery = useQuery({
    queryKey: ['x-gateway-pricing', revision],
    queryFn: ({ signal }) =>
      apiFetch<{ pricing: ProviderPricingMap; overrides: ProviderPricingMap; defaults: ProviderPricingMap }>(
        '/api/x-gateway/pricing',
        { signal },
      ),
    retry: false,
  })

  const enabled = status.data?.enabled === true
  const activeProxy = proxyStatus.data?.proxyUrl || ''

  const toggle = useMutation({
    meta: { silenceToast: true },
    mutationFn: (next: boolean) => apiFetch<{ enabled: boolean }>('/api/x-gateway/enabled', { method: 'PUT', body: JSON.stringify({ enabled: next }) }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['x-gateway-status'] }) },
  })

  const saveProxy = useMutation({
    meta: { silenceToast: true },
    mutationFn: (proxyUrl: string) => apiFetch<{ proxyUrl: string; configured: boolean }>('/api/x-gateway/proxy', { method: 'PUT', body: JSON.stringify({ proxyUrl }) }),
    onSuccess: async () => {
      setProxyInput('')
      await client.invalidateQueries({ queryKey: ['x-gateway-proxy'] })
    },
  })

  const createKey = useMutation({
    meta: { silenceToast: true },
    mutationFn: (name: string) => apiFetch<MintedXGatewayKey>('/api/x-gateway/keys', { method: 'POST', body: JSON.stringify({ ...(name.trim() ? { name: name.trim() } : {}) }) }),
    onSuccess: async (created) => {
      setNewlyCreatedKey(created.key)
      setKeyName('')
      await client.invalidateQueries({ queryKey: ['x-gateway-client-keys'] })
    },
  })

  const revokeKey = useMutation({
    meta: { silenceToast: true },
    mutationFn: (id: number) => apiFetch<{ ok: boolean }>(`/api/x-gateway/keys/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['x-gateway-client-keys'] })
    },
  })

  const updateKeyAccess = useMutation({
    meta: { silenceToast: true },
    mutationFn: ({ id, restricted, allow }: { id: number; restricted: boolean; allow: string[] }) =>
      apiFetch<{ ok: boolean }>(`/api/x-gateway/keys/${id}/access`, {
        method: 'PATCH',
        body: JSON.stringify({ restricted, allow }),
      }),
    onSuccess: async () => {
      setEditingAccessKeyId(null)
      await client.invalidateQueries({ queryKey: ['x-gateway-client-keys'] })
    },
  })

  const testProxy = useMutation({
    meta: { silenceToast: true },
    mutationFn: (proxyUrl: string) =>
      apiFetch<ProxyTestResult>('/api/x-gateway/proxy/test', {
        method: 'POST',
        body: JSON.stringify({ proxyUrl }),
      }),
  })

  // Pricing Mutations
  const savePricingMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: (patch: Record<string, Record<string, Partial<ModelPricingRate>>>) =>
      apiFetch<{ pricing: ProviderPricingMap; overrides: ProviderPricingMap }>('/api/x-gateway/pricing', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: async () => {
      setPricingEdits({})
      setPricingSuccessMsg('Pricing changes saved successfully.')
      setTimeout(() => setPricingSuccessMsg(''), 4000)
      await client.invalidateQueries({ queryKey: ['x-gateway-pricing'] })
    },
  })

  const resetPricingMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: ({ provider, model }: { provider?: string; model?: string }) => {
      const params = new URLSearchParams()
      if (provider) params.set('provider', provider)
      if (model) params.set('model', model)
      const qs = params.toString() ? `?${params.toString()}` : ''
      return apiFetch<{ pricing: ProviderPricingMap; overrides: ProviderPricingMap }>(`/api/x-gateway/pricing${qs}`, {
        method: 'DELETE',
      })
    },
    onSuccess: async () => {
      setPricingEdits({})
      setPricingSuccessMsg('Pricing reset successfully.')
      setTimeout(() => setPricingSuccessMsg(''), 4000)
      await client.invalidateQueries({ queryKey: ['x-gateway-pricing'] })
    },
  })

  // Backup & Restore Mutations & Handlers
  const importBackupMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: (payload: unknown) =>
      apiFetch<{ ok: boolean; restored: { combosCount: number; pricingProvidersCount: number; customNodesCount: number } }>(
        '/api/x-gateway/config-backup',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      ),
    onSuccess: async (data) => {
      setBackupErrorMsg('')
      setBackupSuccessMsg(
        `Successfully restored configuration: ${data.restored.combosCount} combos, ${data.restored.pricingProvidersCount} pricing providers, ${data.restored.customNodesCount} custom nodes.`,
      )
      setTimeout(() => setBackupSuccessMsg(''), 6000)
      await client.invalidateQueries({ queryKey: ['x-gateway-status'] })
      await client.invalidateQueries({ queryKey: ['x-gateway-defaults'] })
      await client.invalidateQueries({ queryKey: ['x-gateway-pricing'] })
    },
    onError: (err: Error) => {
      setBackupSuccessMsg('')
      setBackupErrorMsg(err.message || 'Failed to import backup file.')
      setTimeout(() => setBackupErrorMsg(''), 6000)
    },
  })

  const handleExportBackup = async () => {
    try {
      setIsExporting(true)
      const data = await apiFetch<unknown>('/api/x-gateway/config-backup')
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `x-gateway-config-backup-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err: unknown) {
      setBackupErrorMsg(err instanceof Error ? err.message : 'Failed to export backup.')
    } finally {
      setIsExporting(false)
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async (evt) => {
      try {
        const content = evt.target?.result as string
        const parsed = JSON.parse(content)
        await importBackupMutation.mutateAsync(parsed)
      } catch (err: unknown) {
        setBackupErrorMsg(err instanceof Error ? `Invalid JSON file: ${err.message}` : 'Failed to parse JSON file.')
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    }
    reader.readAsText(file)
  }

  const handleRateChange = (provider: string, modelId: string, field: 'input' | 'output' | 'cached' | 'reasoning', valStr: string) => {
    const num = parseFloat(valStr)
    const val = isNaN(num) || num < 0 ? 0 : num
    setPricingEdits(prev => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        [modelId]: {
          ...prev[provider]?.[modelId],
          [field]: val,
        },
      },
    }))
  }

  const handleAddNewModel = (e: FormEvent) => {
    e.preventDefault()
    const p = newModelProvider.trim().toLowerCase()
    const m = newModelId.trim()
    if (!p || !m) return
    const inputNum = parseFloat(newModelInput) || 0
    const outputNum = parseFloat(newModelOutput) || 0
    const cachedNum = newModelCached.trim() ? parseFloat(newModelCached) || 0 : undefined
    const reasoningNum = newModelReasoning.trim() ? parseFloat(newModelReasoning) || 0 : undefined

    setPricingEdits(prev => ({
      ...prev,
      [p]: {
        ...prev[p],
        [m]: {
          input: inputNum,
          output: outputNum,
          ...(cachedNum !== undefined ? { cached: cachedNum } : {}),
          ...(reasoningNum !== undefined ? { reasoning: reasoningNum } : {}),
        },
      },
    }))
    setNewModelProvider('')
    setNewModelId('')
    setNewModelInput('')
    setNewModelOutput('')
    setNewModelCached('')
    setNewModelReasoning('')
    setShowAddModel(false)
  }

  const base = new URL(`${import.meta.env.BASE_URL}thruline/v1`, window.location.origin).href
  const anthropicBase = base.replace(/\/v1$/, '')
  const displayKey = newlyCreatedKey ?? s.placeholderKey
  const example = `curl '${base}/chat/completions' \\\n  -H 'Authorization: Bearer ${displayKey}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'`

  const cliSnippets: Record<typeof activeCliTab, { title: string; code: string }> = {
    'claude-code': {
      title: 'Claude Code (/thruline/v1/messages — Anthropic compatible)',
      code: `export ANTHROPIC_BASE_URL="${anthropicBase}"\nexport ANTHROPIC_API_KEY="${displayKey}"\nclaude`,
    },
    codex: {
      title: 'Codex CLI (/thruline/v1/responses)',
      code: `export OPENAI_BASE_URL="${base}"\nexport OPENAI_API_KEY="${displayKey}"\ncodex`,
    },
    'cursor-cline': {
      title: 'Cursor / Cline / Roo Code',
      code: `Base URL: ${base}\nAPI Key: ${displayKey}\nModel: auto (or combo/your-combo-name)`,
    },
    continue: {
      title: 'Continue.dev (~/.continue/config.json)',
      code: `{\n  "models": [\n    {\n      "title": "X-Gateway Auto",\n      "provider": "openai",\n      "model": "auto",\n      "apiBase": "${base}",\n      "apiKey": "${displayKey}"\n    }\n  ]\n}`,
    },
    opencode: {
      title: 'OpenCode / Custom Agent',
      code: `OPENAI_BASE_URL="${base}"\nOPENAI_API_KEY="${displayKey}"`,
    },
  }

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(text); setError('') }
    catch { setError(s.copyError) }
  }

  function handleCreateKey(e: FormEvent) {
    e.preventDefault()
    createKey.mutate(keyName)
  }

  function handleSaveProxy(e: FormEvent) {
    e.preventDefault()
    saveProxy.mutate(proxyInput.trim())
  }

  const activeClientKeys = (xKeys.data?.keys ?? []).filter(k => !k.revoked)

  // Pricing Data & Statistics Computation
  const pricingData = pricingQuery.data?.pricing ?? {}
  const overridesData = pricingQuery.data?.overrides ?? {}
  const allProviders = Object.keys(pricingData).sort()
  const totalProviders = allProviders.length
  let totalModels = 0
  let totalOverrides = 0
  for (const prov of allProviders) {
    totalModels += Object.keys(pricingData[prov] || {}).length
    totalOverrides += Object.keys(overridesData[prov] || {}).length
  }
  const pendingEditsCount = Object.keys(pricingEdits).reduce(
    (acc, prov) => acc + Object.keys(pricingEdits[prov] || {}).length,
    0,
  )

  const filteredModelsList: Array<{
    provider: string
    modelId: string
    currentRate: ModelPricingRate
    isOverridden: boolean
    hasPendingEdit: boolean
  }> = []

  const providersToShow = selectedProviderFilter === 'all'
    ? allProviders
    : allProviders.filter(p => p === selectedProviderFilter)

  for (const prov of providersToShow) {
    const models = pricingData[prov] || {}
    for (const [mId, defaultRate] of Object.entries(models)) {
      if (modelSearchQuery.trim()) {
        const q = modelSearchQuery.toLowerCase()
        if (!mId.toLowerCase().includes(q) && !prov.toLowerCase().includes(q)) {
          continue
        }
      }
      const editRate = pricingEdits[prov]?.[mId]
      const currentRate: ModelPricingRate = {
        ...defaultRate,
        ...(editRate || {}),
      }
      const isOverridden = Boolean(overridesData[prov]?.[mId])
      const hasPendingEdit = Boolean(editRate)
      filteredModelsList.push({
        provider: prov,
        modelId: mId,
        currentRate,
        isOverridden,
        hasPendingEdit,
      })
    }
  }

  for (const [prov, models] of Object.entries(pricingEdits)) {
    if (selectedProviderFilter !== 'all' && prov !== selectedProviderFilter) continue
    for (const [mId, editRate] of Object.entries(models)) {
      if (!pricingData[prov]?.[mId]) {
        if (modelSearchQuery.trim()) {
          const q = modelSearchQuery.toLowerCase()
          if (!mId.toLowerCase().includes(q) && !prov.toLowerCase().includes(q)) continue
        }
        filteredModelsList.push({
          provider: prov,
          modelId: mId,
          currentRate: {
            input: editRate.input ?? 0,
            output: editRate.output ?? 0,
            cached: editRate.cached,
            reasoning: editRate.reasoning,
          },
          isOverridden: true,
          hasPendingEdit: true,
        })
      }
    }
  }

  return <>
    <div className="x-page-heading"><div><div className="x-eyebrow">{s.openaiCompatible}</div><h1>{s.endpoint}</h1><p>{s.endpointHelp}</p></div><span className="x-heading-icon"><Terminal size={28} /></span></div>
    {status.isError && <div className="x-error" role="alert">{s.gatewayError}<button className="x-button" onClick={() => void status.refetch()}>{s.retry}</button></div>}
    {status.isSuccess && <section className="x-panel x-endpoint-panel"><div className="x-inline"><div><h2>{s.gatewayStatus}</h2><p className="x-muted">{enabled ? s.gatewayOnHelp : s.gatewayOffHelp}</p></div>{canEdit ? <button role="switch" className="x-switch" aria-checked={enabled} aria-label={enabled ? s.disableGateway : s.enableGateway} disabled={toggle.isPending} onClick={() => toggle.mutate(!enabled)}><span /></button> : <span className={`x-badge ${enabled ? 'x-green' : ''}`}><span className="x-dot" />{enabled ? s.gatewayOn : s.gatewayOff}</span>}</div>{toggle.isError && <p className="x-error" role="alert">{toggle.error.message}</p>}{toggle.isSuccess && <p className="x-test-ok" role="status"><Check size={16} />{s.gatewaySaved}</p>}</section>}
    <p className="x-notice">{s.endpointNotice}</p>

    <section className="x-panel x-endpoint-panel">
      <h2>{s.baseUrl}</h2>
      <div className="x-code-line">
        <code>{base}</code>
        <button className="x-icon-button" aria-label={copied === base ? s.copied : s.copy} onClick={() => void copy(base)}>
          {copied === base ? <Check size={18} /> : <Copy size={18} />}
        </button>
      </div>
      <Link className="x-button" to="/agents">{s.personalKey}<ExternalLink size={14} /></Link>
    </section>

    <section className="x-panel x-endpoint-panel">
      <div className="x-section-heading x-inline">
        <div>
          <h2><KeyRound size={18} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />{s.xGatewayKeysTitle}</h2>
          <p className="x-muted">{s.xGatewayKeysHelp}</p>
        </div>
      </div>

      <form className="x-inline" onSubmit={handleCreateKey} style={{ gap: 8, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={keyName}
          maxLength={80}
          placeholder={s.keyNamePlaceholder}
          onChange={e => setKeyName(e.target.value)}
          style={{ flex: '1 1 220px', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)' }}
        />
        <button type="submit" className="x-button x-primary" disabled={createKey.isPending}>
          <Plus size={15} />
          {createKey.isPending ? s.creatingXKey : s.createXKey}
        </button>
      </form>

      {createKey.isError && <p className="x-error" role="alert">{createKey.error.message}</p>}

      {newlyCreatedKey && (
        <div className="x-notice" style={{ display: 'grid', gap: 8 }}>
          <strong>{s.newXKeyNotice}</strong>
          <div className="x-code-line">
            <code>{newlyCreatedKey}</code>
            <button className="x-icon-button" aria-label={copied === newlyCreatedKey ? s.copied : s.copy} onClick={() => void copy(newlyCreatedKey)}>
              {copied === newlyCreatedKey ? <Check size={18} /> : <Copy size={18} />}
            </button>
          </div>
        </div>
      )}

      {activeClientKeys.length > 0 ? (
        <div style={{ display: 'grid', gap: 8 }}>
          {activeClientKeys.map(k => {
            const isRestricted = Boolean(k.access?.restricted)
            const allowList = k.access?.allow ?? []
            const isEditing = editingAccessKeyId === k.id
            return (
              <div key={k.id} style={{ display: 'grid', gap: 8, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <strong>{k.name}</strong>
                    <code>{k.keyPrefix}</code>
                    <span className={`x-badge ${isRestricted ? '' : 'x-green'}`} style={{ fontSize: '0.72rem' }}>
                      {isRestricted ? <Lock size={12} /> : <ShieldCheck size={12} />}
                      {isRestricted ? `${s.accessRestricted} (${allowList.length})` : s.accessAllModels}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      type="button"
                      className="x-button x-small"
                      onClick={() => {
                        if (isEditing) {
                          setEditingAccessKeyId(null)
                        } else {
                          setEditingAccessKeyId(k.id)
                          setAccessRestricted(isRestricted)
                          setAccessAllowInput(allowList.join(', '))
                        }
                      }}
                    >
                      {s.configureKeyAccess}
                    </button>
                    <button
                      type="button"
                      className="x-icon-button x-danger"
                      aria-label={`${s.revokeKey}: ${k.name}`}
                      disabled={revokeKey.isPending}
                      onClick={() => revokeKey.mutate(k.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                {isEditing && (
                  <div style={{ display: 'grid', gap: 8, paddingTop: 8, borderTop: '1px solid var(--x-border)' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={accessRestricted}
                        onChange={e => setAccessRestricted(e.target.checked)}
                      />
                      <span>{s.accessRestricted}</span>
                    </label>
                    {accessRestricted && (
                      <div style={{ display: 'grid', gap: 4 }}>
                        <small className="x-muted">{s.allowedModelsLabel}</small>
                        <input
                          type="text"
                          value={accessAllowInput}
                          placeholder={s.allowedModelsPlaceholder}
                          onChange={e => setAccessAllowInput(e.target.value)}
                          style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--x-border)', background: 'var(--x-surface)', color: 'var(--x-ink)', fontSize: '0.82rem' }}
                        />
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="x-button x-primary x-small"
                        disabled={updateKeyAccess.isPending}
                        onClick={() => {
                          const parsedAllow = accessAllowInput
                            .split(',')
                            .map(item => item.trim())
                            .filter(Boolean)
                          updateKeyAccess.mutate({ id: k.id, restricted: accessRestricted, allow: parsedAllow })
                        }}
                      >
                        {updateKeyAccess.isPending ? s.saving : s.saveAccess}
                      </button>
                      <button type="button" className="x-button x-small" onClick={() => setEditingAccessKeyId(null)}>
                        {s.cancel}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="x-muted">{s.noXKeys}</p>
      )}
      {updateKeyAccess.isError && <p className="x-error" role="alert">{updateKeyAccess.error.message}</p>}
      {updateKeyAccess.isSuccess && <p className="x-test-ok" role="status"><Check size={16} />{s.accessSaved}</p>}
    </section>

    <section className="x-panel x-endpoint-panel">
      <div className="x-section-heading x-inline">
        <div>
          <h2><Globe size={18} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />{s.outboundProxyTitle}</h2>
          <p className="x-muted">{s.outboundProxyHelp}</p>
        </div>
        <span className={`x-badge ${activeProxy ? 'x-green' : ''}`}>
          <span className="x-dot" />
          {activeProxy ? `${s.outboundProxyActive}: ${activeProxy}` : s.outboundProxyDirect}
        </span>
      </div>

      {canEdit && (
        <form className="x-inline" onSubmit={handleSaveProxy} style={{ gap: 8, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={proxyInput}
            placeholder={activeProxy || s.outboundProxyPlaceholder}
            onChange={e => setProxyInput(e.target.value)}
            style={{ flex: '1 1 260px', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)' }}
          />
          <button type="submit" className="x-button x-primary" disabled={saveProxy.isPending || !proxyInput.trim()}>
            {saveProxy.isPending ? s.saving : s.saveProxy}
          </button>
          <button
            type="button"
            className="x-button"
            disabled={testProxy.isPending || (!proxyInput.trim() && !activeProxy)}
            onClick={() => testProxy.mutate(proxyInput.trim())}
          >
            {testProxy.isPending ? s.testingProxy : s.testProxy}
          </button>
          {activeProxy && (
            <button
              type="button"
              className="x-button"
              disabled={saveProxy.isPending}
              onClick={() => saveProxy.mutate('')}
            >
              {s.clearProxy}
            </button>
          )}
        </form>
      )}
      {saveProxy.isError && <p className="x-error" role="alert">{saveProxy.error.message}</p>}
      {saveProxy.isSuccess && <p className="x-test-ok" role="status"><Check size={16} />{s.proxySaved}</p>}
      {testProxy.isError && <p className="x-error" role="alert">{testProxy.error.message}</p>}
      {testProxy.data && (
        <p className={testProxy.data.ok ? 'x-test-ok' : 'x-error'} role="status">
          {testProxy.data.ok
            ? `${s.proxyTestOk} (${testProxy.data.latencyMs}ms)`
            : `${s.proxyTestFailed}: ${testProxy.data.error || 'Unreachable'}`}
        </p>
      )}
    </section>

    {/* Section 1: Custom Pricing Settings */}
    <section className="x-panel x-endpoint-panel">
      <div className="x-section-heading x-inline">
        <div>
          <h2><DollarSign size={18} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />Custom Pricing Settings</h2>
          <p className="x-muted">
            Configure token rates in USD per 1M tokens ($/1M tokens) for cost calculation, usage breakdown, and quota monitoring.
          </p>
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="x-button x-small"
              onClick={() => setShowAddModel(prev => !prev)}
            >
              <Plus size={14} /> {showAddModel ? 'Close Form' : 'Add Model'}
            </button>
            <button
              type="button"
              className="x-button x-primary x-small"
              disabled={savePricingMutation.isPending || pendingEditsCount === 0}
              onClick={() => savePricingMutation.mutate(pricingEdits)}
            >
              <Check size={14} />
              {savePricingMutation.isPending ? 'Saving...' : `Save Pricing (${pendingEditsCount})`}
            </button>
            <button
              type="button"
              className="x-button x-destructive x-small"
              disabled={resetPricingMutation.isPending || (totalOverrides === 0 && pendingEditsCount === 0)}
              onClick={async () => {
                if (await askConfirm('Reset all custom model pricing to default rates? This cannot be undone.')) {
                  resetPricingMutation.mutate({})
                }
              }}
            >
              <RotateCcw size={14} /> Reset All to Defaults
            </button>
          </div>
        )}
      </div>

      {/* Quick Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, margin: '14px 0' }}>
        <div className="x-panel" style={{ padding: '12px 16px', background: 'var(--x-surface-subtle)', borderRadius: 8, border: '1px solid var(--x-border)' }}>
          <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--x-muted)', fontWeight: 600 }}>Total Providers</span>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: 4 }}>{totalProviders}</div>
        </div>
        <div className="x-panel" style={{ padding: '12px 16px', background: 'var(--x-surface-subtle)', borderRadius: 8, border: '1px solid var(--x-border)' }}>
          <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--x-muted)', fontWeight: 600 }}>Total Models</span>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: 4 }}>{totalModels}</div>
        </div>
        <div className="x-panel" style={{ padding: '12px 16px', background: 'var(--x-surface-subtle)', borderRadius: 8, border: '1px solid var(--x-border)' }}>
          <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--x-muted)', fontWeight: 600 }}>Custom Overrides</span>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>{totalOverrides}</span>
            {pendingEditsCount > 0 && (
              <span className="x-badge x-green" style={{ fontSize: '0.75rem' }}>
                +{pendingEditsCount} unsaved
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Add Model Form */}
      {showAddModel && canEdit && (
        <form
          onSubmit={handleAddNewModel}
          style={{
            padding: '14px 16px',
            marginBottom: 16,
            borderRadius: 8,
            border: '1px solid var(--x-border)',
            background: 'var(--x-surface-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <strong>Add New Model Pricing</strong>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            <div>
              <label style={{ fontSize: '0.75rem', display: 'block', marginBottom: 4, color: 'var(--x-muted)' }}>Provider</label>
              <input
                type="text"
                required
                placeholder="e.g. openai"
                value={newModelProvider}
                onChange={e => setNewModelProvider(e.target.value)}
                style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--x-border)', background: 'var(--x-surface)', color: 'var(--x-ink)' }}
              />
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', display: 'block', marginBottom: 4, color: 'var(--x-muted)' }}>Model ID</label>
              <input
                type="text"
                required
                placeholder="e.g. gpt-4.5-preview"
                value={newModelId}
                onChange={e => setNewModelId(e.target.value)}
                style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--x-border)', background: 'var(--x-surface)', color: 'var(--x-ink)' }}
              />
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', display: 'block', marginBottom: 4, color: 'var(--x-muted)' }}>Input ($/1M)</label>
              <input
                type="number"
                step="any"
                min="0"
                required
                placeholder="2.5"
                value={newModelInput}
                onChange={e => setNewModelInput(e.target.value)}
                style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--x-border)', background: 'var(--x-surface)', color: 'var(--x-ink)' }}
              />
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', display: 'block', marginBottom: 4, color: 'var(--x-muted)' }}>Output ($/1M)</label>
              <input
                type="number"
                step="any"
                min="0"
                required
                placeholder="10.0"
                value={newModelOutput}
                onChange={e => setNewModelOutput(e.target.value)}
                style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--x-border)', background: 'var(--x-surface)', color: 'var(--x-ink)' }}
              />
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', display: 'block', marginBottom: 4, color: 'var(--x-muted)' }}>Cached ($/1M)</label>
              <input
                type="number"
                step="any"
                min="0"
                placeholder="optional"
                value={newModelCached}
                onChange={e => setNewModelCached(e.target.value)}
                style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--x-border)', background: 'var(--x-surface)', color: 'var(--x-ink)' }}
              />
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', display: 'block', marginBottom: 4, color: 'var(--x-muted)' }}>Reasoning ($/1M)</label>
              <input
                type="number"
                step="any"
                min="0"
                placeholder="optional"
                value={newModelReasoning}
                onChange={e => setNewModelReasoning(e.target.value)}
                style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--x-border)', background: 'var(--x-surface)', color: 'var(--x-ink)' }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" className="x-button x-small" onClick={() => setShowAddModel(false)}>Cancel</button>
            <button type="submit" className="x-button x-primary x-small">Add to Pricing</button>
          </div>
        </form>
      )}

      {/* Filter and Search controls */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '10px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 200px' }}>
          <Search size={14} className="x-muted" />
          <input
            type="text"
            placeholder="Filter by model ID or provider..."
            value={modelSearchQuery}
            onChange={e => setModelSearchQuery(e.target.value)}
            style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)', fontSize: '0.82rem' }}
          />
        </div>
        <select
          value={selectedProviderFilter}
          onChange={e => setSelectedProviderFilter(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)', fontSize: '0.82rem' }}
        >
          <option value="all">All Providers ({allProviders.length})</option>
          {allProviders.map(p => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      {pricingSuccessMsg && (
        <p className="x-test-ok" role="status" style={{ margin: '8px 0' }}>
          <CircleCheck size={16} /> {pricingSuccessMsg}
        </p>
      )}
      {savePricingMutation.isError && (
        <p className="x-error" role="alert" style={{ margin: '8px 0' }}>
          <AlertCircle size={16} /> {savePricingMutation.error.message}
        </p>
      )}

      {/* Pricing Table */}
      <div style={{ overflowX: 'auto', marginTop: 12 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--x-border)', textAlign: 'left', background: 'var(--x-surface-subtle)' }}>
              <th style={{ padding: '8px 10px' }}>Provider / Model</th>
              <th style={{ padding: '8px 10px', width: '120px' }}>Input ($/1M)</th>
              <th style={{ padding: '8px 10px', width: '120px' }}>Output ($/1M)</th>
              <th style={{ padding: '8px 10px', width: '120px' }}>Cached ($/1M)</th>
              <th style={{ padding: '8px 10px', width: '120px' }}>Reasoning ($/1M)</th>
              <th style={{ padding: '8px 10px', width: '90px', textAlign: 'center' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {filteredModelsList.slice(0, 100).map(({ provider: prov, modelId: mId, currentRate, isOverridden, hasPendingEdit }) => (
              <tr key={`${prov}-${mId}`} style={{ borderBottom: '1px solid var(--x-border)' }}>
                <td style={{ padding: '8px 10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span className="x-badge" style={{ fontSize: '0.72rem', textTransform: 'uppercase' }}>{prov}</span>
                    <strong style={{ fontFamily: 'monospace' }}>{mId}</strong>
                    {(isOverridden || hasPendingEdit) && (
                      <span className="x-badge x-green" style={{ fontSize: '0.7rem' }}>
                        {hasPendingEdit ? 'Unsaved' : 'Custom'}
                      </span>
                    )}
                  </div>
                </td>
                <td style={{ padding: '8px 10px' }}>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    disabled={!canEdit}
                    value={currentRate.input}
                    onChange={e => handleRateChange(prov, mId, 'input', e.target.value)}
                    style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--x-border)', background: 'var(--x-surface)', color: 'var(--x-ink)' }}
                  />
                </td>
                <td style={{ padding: '8px 10px' }}>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    disabled={!canEdit}
                    value={currentRate.output}
                    onChange={e => handleRateChange(prov, mId, 'output', e.target.value)}
                    style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--x-border)', background: 'var(--x-surface)', color: 'var(--x-ink)' }}
                  />
                </td>
                <td style={{ padding: '8px 10px' }}>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    disabled={!canEdit}
                    value={currentRate.cached ?? 0}
                    onChange={e => handleRateChange(prov, mId, 'cached', e.target.value)}
                    style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--x-border)', background: 'var(--x-surface)', color: 'var(--x-ink)' }}
                  />
                </td>
                <td style={{ padding: '8px 10px' }}>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    disabled={!canEdit}
                    value={currentRate.reasoning ?? 0}
                    onChange={e => handleRateChange(prov, mId, 'reasoning', e.target.value)}
                    style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--x-border)', background: 'var(--x-surface)', color: 'var(--x-ink)' }}
                  />
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                  {canEdit && (isOverridden || hasPendingEdit) ? (
                    <button
                      type="button"
                      className="x-icon-button"
                      title="Reset to default"
                      disabled={resetPricingMutation.isPending}
                      onClick={() => {
                        if (hasPendingEdit && !isOverridden) {
                          setPricingEdits(prev => {
                            const next = { ...prev }
                            if (next[prov]) {
                              delete next[prov][mId]
                              if (Object.keys(next[prov]).length === 0) delete next[prov]
                            }
                            return next
                          })
                        } else {
                          resetPricingMutation.mutate({ provider: prov, model: mId })
                        }
                      }}
                    >
                      <RotateCcw size={14} />
                    </button>
                  ) : (
                    <span className="x-muted" style={{ fontSize: '0.75rem' }}>Default</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredModelsList.length === 0 && (
          <p className="x-muted" style={{ textAlign: 'center', padding: '16px 0' }}>No models matching filter.</p>
        )}
      </div>
    </section>

    {/* Section 2: Configuration Backup & Restore (Export / Import JSON) */}
    <section className="x-panel x-endpoint-panel">
      <div className="x-section-heading x-inline">
        <div>
          <h2><Database size={18} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />Configuration Backup & Restore</h2>
          <p className="x-muted">
            Safely export and restore full X-Gateway configurations including savers, combos, capacity adapters, model pricing overrides, and custom compatible nodes. Sensitive API credentials and private keys are never included.
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
        <button
          type="button"
          className="x-button"
          disabled={isExporting}
          onClick={handleExportBackup}
        >
          <Download size={15} />
          {isExporting ? 'Exporting...' : 'Export Config JSON'}
        </button>

        {canEdit && (
          <>
            <input
              type="file"
              ref={fileInputRef}
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <button
              type="button"
              className="x-button x-primary"
              disabled={importBackupMutation.isPending}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={15} />
              {importBackupMutation.isPending ? 'Restoring...' : 'Import Config JSON'}
            </button>
          </>
        )}
      </div>

      {backupSuccessMsg && (
        <p className="x-test-ok" role="status" style={{ marginTop: 12 }}>
          <CircleCheck size={16} />
          {backupSuccessMsg}
        </p>
      )}
      {backupErrorMsg && (
        <p className="x-error" role="alert" style={{ marginTop: 12 }}>
          <AlertCircle size={16} />
          {backupErrorMsg}
        </p>
      )}
    </section>

    <section className="x-panel x-endpoint-panel">
      <div className="x-section-heading">
        <h2>{s.cliSetupTitle}</h2>
        <p className="x-muted">{s.cliSetupHelp}</p>
      </div>
      <div className="x-pills" role="tablist" aria-label={s.cliSetupTitle}>
        {([
          ['claude-code', 'Claude Code'],
          ['codex', 'Codex CLI'],
          ['cursor-cline', 'Cursor / Cline / Roo'],
          ['continue', 'Continue.dev'],
          ['opencode', 'OpenCode'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeCliTab === id}
            className={activeCliTab === id ? 'active' : ''}
            onClick={() => setActiveCliTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="x-section-heading x-inline">
        <strong>{cliSnippets[activeCliTab].title}</strong>
        <button className="x-button x-small" onClick={() => void copy(cliSnippets[activeCliTab].code)}>
          <Copy size={14} />
          {copied === cliSnippets[activeCliTab].code ? s.copied : s.copy}
        </button>
      </div>
      <pre className="x-code-block"><code>{cliSnippets[activeCliTab].code}</code></pre>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <small className="x-muted" style={{ marginRight: 4 }}>{s.supportedEndpointsTitle}:</small>
        {[
          'POST /thruline/v1/chat/completions',
          'POST /thruline/v1/messages',
          'POST /thruline/v1/responses',
          'POST /thruline/v1/completions',
          'POST /thruline/v1/embeddings',
          'POST /thruline/v1/images/generations',
          'POST /thruline/v1/audio/speech',
          'POST /thruline/v1/audio/transcriptions',
          'GET /thruline/v1/models',
        ].map(ep => (
          <code key={ep} style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: 999, background: 'var(--x-surface-subtle)', border: '1px solid var(--x-border)' }}>
            {ep}
          </code>
        ))}
      </div>
    </section>

    <section className="x-panel x-endpoint-panel"><div className="x-section-heading x-inline"><h2>{s.example}</h2><button className="x-button x-small" onClick={() => void copy(example)}><Copy size={14} />{copied === example ? s.copied : s.copy}</button></div><pre className="x-code-block"><code>{example}</code></pre></section>
    {error && <p className="x-error" role="alert">{error}</p>}
  </>
}
