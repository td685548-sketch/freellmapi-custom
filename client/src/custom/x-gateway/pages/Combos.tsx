import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Check, Copy, Eye, Layers, Mic, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { useUserSession } from '../../use-session'
import { useSessionRevision } from '../../session-state'
import { useAccounts } from '../api'
import { mgmtApi, type ComboEntry, type ComboPayload, type ComboStrategy, type XCombo } from '../management-api'
import { useMgmtStrings } from '../management-strings'
import { askConfirm } from '../shell/confirm'

/** Router policy fields live on the server combo but not yet in the shared
 *  management API types (owned by another track), so the console carries them
 *  through local intersections instead of editing that module. */
export type ComboSmartPolicy = 'smart' | 'strict' | 'per-turn' | 'custom'

interface ComboPolicyFields {
  smartPolicy?: ComboSmartPolicy
  sessionSticky?: boolean
  confidenceThreshold?: number
}

type PolicyCombo = XCombo & ComboPolicyFields
type PolicyPayload = ComboPayload & ComboPolicyFields

interface Draft {
  id?: number
  name: string
  entries: ComboEntry[]
  strategy: ComboStrategy
  description: string
  smartPolicy: ComboSmartPolicy
  sessionSticky: boolean
  confidenceThreshold: number
}

const STRATEGIES: ComboStrategy[] = ['fallback', 'round-robin', 'smart', 'fusion']
const SMART_POLICIES: ComboSmartPolicy[] = ['smart', 'strict', 'per-turn', 'custom']
const DEFAULT_CONFIDENCE_THRESHOLD = 0.8

const POLICY_LABELS = {
  en: {
    title: 'Router Policy',
    help: 'Smart combos can keep a conversation on one route so the provider prompt cache stays warm.',
    smart: 'Smart Switch ≥80%',
    strict: 'Strict Lock',
    perTurn: 'Per-Turn',
    custom: 'Custom Threshold',
    threshold: 'Confidence threshold',
    sticky: 'Pin route for the session',
    stickyOn: 'The chosen route is pinned for this conversation and released only when it fails or gets much slower.',
    stickyOff: 'Every turn is ranked independently; no route is pinned.',
    customHelp: 'The pinned route is replaced only when an alternative is better by at least this margin.',
    smartHelp: 'Switch when the pinned route errors or loses 80% of its relative health.',
    strictHelp: 'Never switch away from the pinned route while it still exists.',
    perTurnHelp: 'Re-rank every turn. No session stickiness.',
  },
  vi: {
    title: 'Chính sách Router',
    help: 'Combo Smart có thể ghim một route cho cả phiên để giữ prompt cache của provider luôn ấm.',
    smart: 'Smart Switch ≥80%',
    strict: 'Strict Lock',
    perTurn: 'Per-Turn',
    custom: 'Ngưỡng tùy chỉnh',
    threshold: 'Ngưỡng tin cậy',
    sticky: 'Ghim route cho phiên',
    stickyOn: 'Route đã chọn được ghim cho cuộc hội thoại này và chỉ đổi khi lỗi hoặc chậm đi rõ rệt.',
    stickyOff: 'Mỗi lượt được xếp hạng độc lập; không ghim route.',
    customHelp: 'Route được ghim chỉ bị thay khi route khác tốt hơn ít nhất bằng mức chênh này.',
    smartHelp: 'Chỉ đổi khi route đang ghim lỗi hoặc mất 80% sức khỏe tương đối.',
    strictHelp: 'Không bao giờ đổi khỏi route đã ghim khi route đó vẫn còn.',
    perTurnHelp: 'Xếp hạng lại mỗi lượt. Không ghim phiên.',
  },
} as const

const policyKey = (policy: ComboSmartPolicy): 'smart' | 'strict' | 'perTurn' | 'custom' =>
  policy === 'strict' ? 'strict' : policy === 'per-turn' ? 'perTurn' : policy === 'custom' ? 'custom' : 'smart'

export interface CapacityPool {
  enabled: boolean
  roundRobin: boolean
  models: string[]
}

export interface CapacityAdapterSettings {
  vision: CapacityPool
  audioInput: CapacityPool
}

interface CatalogSyncStatus {
  syncedAt: string | null
  totalProviders: number
  totalModels: number
  customModelsCount: number
  aliasesCount: number
}

export default function Combos() {
  const s = useMgmtStrings()
  const { locale } = useI18n()
  const policyLabels = POLICY_LABELS[locale === 'vi' ? 'vi' : 'en']
  const client = useQueryClient()
  const revision = useSessionRevision()
  const session = useUserSession()
  const canEdit = session.hasPermission('edit_x_combos')
  const accounts = useAccounts()
  const providers = accounts.data?.providers ?? []
  const query = useQuery({ queryKey: ['x-combos', revision], queryFn: ({ signal }) => mgmtApi.combos(signal), retry: false })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())

  // Capacity adapter query & state
  const capacityQuery = useQuery({
    queryKey: ['x-capacity-adapter', revision],
    queryFn: ({ signal }) => apiFetch<CapacityAdapterSettings>('/api/thruline/capacity-adapter', { signal }),
    retry: false,
  })
  const [newVisionModel, setNewVisionModel] = useState('')
  const [newAudioModel, setNewAudioModel] = useState('')

  // Model aliases & catalog sync
  const canEditAliases = canEdit || session.hasPermission('manage_key_models')
  const aliasesQuery = useQuery({
    queryKey: ['x-model-aliases', revision],
    queryFn: ({ signal }) => apiFetch<{ aliases: Record<string, string> }>('/api/thruline-accounts/model-aliases', { signal }),
    retry: false,
  })
  const syncQuery = useQuery({
    queryKey: ['x-catalog-sync', revision],
    queryFn: ({ signal }) => apiFetch<CatalogSyncStatus>('/api/thruline-accounts/catalog-sync', { signal }),
    retry: false,
  })
  const [aliasName, setAliasName] = useState('')
  const [aliasProvider, setAliasProvider] = useState('')
  const [aliasModel, setAliasModel] = useState('')
  const [copiedAlias, setCopiedAlias] = useState<string | null>(null)
  const aliases = aliasesQuery.data?.aliases ?? {}
  const aliasProviderModels = useMemo(() => {
    const provider = providers.find(p => p.id === aliasProvider)
    const ids = new Set<string>()
    for (const account of provider?.accounts ?? []) for (const m of account.models) ids.add(m.id)
    return [...ids]
  }, [providers, aliasProvider])
  const aliasNameValid = /^[a-zA-Z0-9_.-]{1,64}$/.test(aliasName.trim())
  const saveAlias = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: { alias: string; model: string }) =>
      apiFetch<{ ok: true }>('/api/thruline-accounts/model-aliases', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      setAliasName('')
      setAliasModel('')
      return client.invalidateQueries({ queryKey: ['x-model-aliases'] })
    },
  })
  const removeAlias = useMutation({
    meta: { silenceToast: true },
    mutationFn: (alias: string) =>
      apiFetch<{ ok: true }>(`/api/thruline-accounts/model-aliases?alias=${encodeURIComponent(alias)}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['x-model-aliases'] }),
  })
  const syncCatalog = useMutation({
    meta: { silenceToast: true },
    mutationFn: () => apiFetch<CatalogSyncStatus>('/api/thruline-accounts/catalog-sync', { method: 'POST' }),
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: ['x-catalog-sync'] }),
      client.invalidateQueries({ queryKey: ['x-model-aliases'] }),
    ]),
  })
  const copyAlias = (alias: string) => {
    void navigator.clipboard?.writeText(alias).then(() => {
      setCopiedAlias(alias)
      window.setTimeout(() => setCopiedAlias(current => (current === alias ? null : current)), 1500)
    }).catch(() => undefined)
  }

  const strategyLabels: Record<ComboStrategy, string> = {
    fallback: s.strategyFallback,
    'round-robin': s.strategyRoundRobin,
    smart: s.strategySmart,
    fusion: s.strategyFusion,
  }

  const combos = useMemo(() => query.data?.combos ?? [], [query.data])
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return combos
    return combos.filter(c =>
      c.name.toLowerCase().includes(needle)
      || (c.description ?? '').toLowerCase().includes(needle)
      || c.entries.some(e => e.modelId.toLowerCase().includes(needle) || e.platform.toLowerCase().includes(needle)),
    )
  }, [combos, search])

  const saveCapacity = useMutation({
    meta: { silenceToast: true },
    mutationFn: (settings: CapacityAdapterSettings) =>
      apiFetch<CapacityAdapterSettings>('/api/thruline/capacity-adapter', {
        method: 'PUT',
        body: JSON.stringify(settings),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['x-capacity-adapter'] })
    },
  })

  const done = async () => {
    setDraft(null)
    setSelected(new Set())
    await client.invalidateQueries({ queryKey: ['x-combos'] })
  }
  const toPayload = (d: Draft): ComboPayload => {
    const payload: PolicyPayload = {
      name: d.name,
      entries: d.entries,
      strategy: d.strategy,
      description: d.description.trim() || undefined,
      smartPolicy: d.strategy === 'smart' ? d.smartPolicy : undefined,
      sessionSticky: d.strategy === 'smart' ? d.sessionSticky : undefined,
      confidenceThreshold: d.strategy === 'smart' ? d.confidenceThreshold : undefined,
    }
    return payload
  }
  const save = useMutation({
    meta: { silenceToast: true },
    mutationFn: (d: Draft) => d.id ? mgmtApi.updateCombo(d.id, toPayload(d)) : mgmtApi.createCombo(toPayload(d)),
    onSuccess: done,
  })
  const remove = useMutation({ mutationFn: (id: number) => mgmtApi.deleteCombo(id), onSuccess: done })
  const bulkRemove = useMutation({
    meta: { silenceToast: true },
    mutationFn: async (ids: number[]) => {
      for (const id of ids) await mgmtApi.deleteCombo(id)
    },
    onSuccess: done,
  })
  const changeStrategy = useMutation({
    meta: { silenceToast: true },
    mutationFn: ({ combo, strategy }: { combo: PolicyCombo; strategy: ComboStrategy }) => {
      const payload: PolicyPayload = {
        name: combo.name,
        entries: combo.entries,
        strategy,
        description: combo.description,
        smartPolicy: combo.smartPolicy,
        sessionSticky: combo.sessionSticky,
        confidenceThreshold: combo.confidenceThreshold,
      }
      return mgmtApi.updateCombo(combo.id, payload)
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['x-combos'] })
    },
  })
  const presets = useMutation({
    meta: { silenceToast: true },
    mutationFn: () => mgmtApi.generatePresets(),
    onSuccess: async () => {
      setSelected(new Set())
      await client.invalidateQueries({ queryKey: ['x-combos'] })
    },
  })

  const setEntry = (i: number, patch: Partial<ComboEntry>) =>
    setDraft(d => d && { ...d, entries: d.entries.map((e, idx) => idx === i ? { ...e, ...patch } : e) })
  const moveEntry = (i: number, delta: number) => setDraft(d => {
    if (!d) return d
    const target = i + delta
    if (target < 0 || target >= d.entries.length) return d
    const entries = [...d.entries]
    const [entry] = entries.splice(i, 1)
    entries.splice(target, 0, entry)
    return { ...d, entries }
  })
  const startNew = () => {
    save.reset()
    setDraft({
      name: '',
      entries: [{ platform: providers[0]?.id ?? '', modelId: '' }],
      strategy: 'fallback',
      description: '',
      smartPolicy: 'smart',
      sessionSticky: true,
      confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    })
  }
  const startEdit = (c: PolicyCombo) => {
    save.reset()
    const smartPolicy = c.smartPolicy ?? 'smart'
    setDraft({
      id: c.id,
      name: c.name,
      entries: c.entries.map(e => ({ ...e })),
      strategy: c.strategy ?? 'fallback',
      description: c.description ?? '',
      smartPolicy,
      sessionSticky: c.sessionSticky ?? smartPolicy !== 'per-turn',
      confidenceThreshold: c.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
    })
  }

  const toggleSelected = (id: number) => setSelected(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const allVisibleSelected = filtered.length > 0 && filtered.every(c => selected.has(c.id))
  const toggleAllVisible = () => setSelected(previous => {
    const next = new Set(previous)
    if (allVisibleSelected) filtered.forEach(c => next.delete(c.id))
    else filtered.forEach(c => next.add(c.id))
    return next
  })

  const capacityData = capacityQuery.data ?? {
    vision: { enabled: true, roundRobin: false, models: ['oc/mimo-v2.6-flash-free'] },
    audioInput: { enabled: false, roundRobin: false, models: [] },
  }

  const handleTogglePool = (poolKey: 'vision' | 'audioInput', enabled: boolean) => {
    saveCapacity.mutate({
      ...capacityData,
      [poolKey]: { ...capacityData[poolKey], enabled },
    })
  }

  const handleToggleStrategy = (poolKey: 'vision' | 'audioInput', roundRobin: boolean) => {
    saveCapacity.mutate({
      ...capacityData,
      [poolKey]: { ...capacityData[poolKey], roundRobin },
    })
  }

  const handleAddModel = (poolKey: 'vision' | 'audioInput', model: string) => {
    const trimmed = model.trim()
    if (!trimmed || capacityData[poolKey].models.includes(trimmed)) return
    saveCapacity.mutate({
      ...capacityData,
      [poolKey]: {
        ...capacityData[poolKey],
        models: [...capacityData[poolKey].models, trimmed],
      },
    })
    if (poolKey === 'vision') setNewVisionModel('')
    else setNewAudioModel('')
  }

  const handleRemoveModel = (poolKey: 'vision' | 'audioInput', model: string) => {
    saveCapacity.mutate({
      ...capacityData,
      [poolKey]: {
        ...capacityData[poolKey],
        models: capacityData[poolKey].models.filter(m => m !== model),
      },
    })
  }

  return <>
    <div className="x-page-heading"><div><h1>{s.combos}</h1><p>{s.combosHelp}</p></div><span className="x-heading-icon"><Layers size={28} /></span></div>
    <div className="x-toolbar">
      <label className="x-search">
        <Search size={15} />
        <input
          type="search"
          value={search}
          aria-label={s.searchCombos}
          placeholder={s.searchCombos}
          onChange={e => setSearch(e.target.value)}
        />
      </label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {canEdit && <button type="button" className="x-button" disabled={presets.isPending} onClick={() => presets.mutate()}>
          <Sparkles size={16} />{presets.isPending ? s.generatingPresets : s.generatePresets}
        </button>}
        {canEdit && !draft && <button type="button" className="x-button x-primary" onClick={startNew}><Plus size={16} />{s.newCombo}</button>}
      </div>
    </div>
    {presets.isError && <div className="x-error" role="alert">{presets.error.message}</div>}
    {presets.data && <p className="x-test-ok" role="status" style={{ fontSize: '0.82rem' }}>
      <Check size={14} />{s.presetsCreated}: {presets.data.createdCount} · {s.presetsSkipped}: {presets.data.skippedCount}
    </p>}
    <p className="x-caption" style={{ marginBottom: 12 }}>{s.presetsHelp}</p>
    {query.isPending && <p role="status">{s.loading}</p>}
    {query.isError && <div className="x-error" role="alert">{s.loadError}<button className="x-button" onClick={() => void query.refetch()}>{s.retry}</button></div>}
    {!canEdit && <p className="x-caption">{s.readOnly}</p>}
    {draft && <form className="x-panel x-mgmt-form" onSubmit={e => { e.preventDefault(); save.mutate(draft) }}>
      <h2>{draft.id ? s.editCombo : s.newCombo}</h2>
      <label>{s.comboName}<input value={draft.name} maxLength={48} required onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label>{s.description}<input value={draft.description} maxLength={200} placeholder={s.descriptionPlaceholder} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
      <label>{s.strategy}<select value={draft.strategy} onChange={e => setDraft({ ...draft, strategy: e.target.value as ComboStrategy })}>
        {STRATEGIES.map(strategy => <option key={strategy} value={strategy}>{strategyLabels[strategy]}</option>)}
      </select></label>
      <p className="x-caption">{s.strategyHelp}</p>
      {draft.strategy === 'smart' && <fieldset className="x-panel" style={{ background: 'var(--x-surface-subtle)', padding: 12, display: 'grid', gap: 8, border: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, padding: '0 4px' }}>{policyLabels.title}</legend>
        <p className="x-caption" style={{ margin: 0 }}>{policyLabels.help}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {SMART_POLICIES.map(policy => <label key={policy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="radio"
              name="comboSmartPolicy"
              checked={draft.smartPolicy === policy}
              onChange={() => setDraft({
                ...draft,
                smartPolicy: policy,
                sessionSticky: policy !== 'per-turn',
                confidenceThreshold: policy === 'smart' ? DEFAULT_CONFIDENCE_THRESHOLD : draft.confidenceThreshold,
              })}
            />
            <span>{policy === 'custom' && draft.confidenceThreshold !== DEFAULT_CONFIDENCE_THRESHOLD
              ? `${policyLabels[policyKey(policy)]} ${Math.round(draft.confidenceThreshold * 100)}%`
              : policyLabels[policyKey(policy)]}</span>
          </label>)}
        </div>
        {draft.smartPolicy === 'custom' && <label style={{ display: 'grid', gap: 4 }}>
          <span>{policyLabels.threshold}: <strong>{Math.round(draft.confidenceThreshold * 100)}%</strong></span>
          <input
            type="range"
            min={50}
            max={95}
            step={1}
            value={Math.round(draft.confidenceThreshold * 100)}
            aria-label={policyLabels.threshold}
            onChange={e => setDraft({ ...draft, confidenceThreshold: Number(e.target.value) / 100 })}
          />
          <span className="x-caption">{policyLabels.customHelp}</span>
        </label>}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: draft.smartPolicy === 'per-turn' ? 'not-allowed' : 'pointer' }}>
          <input
            type="checkbox"
            checked={draft.sessionSticky}
            disabled={draft.smartPolicy === 'per-turn'}
            onChange={e => setDraft({ ...draft, sessionSticky: e.target.checked })}
          />
          <span>{policyLabels.sticky}</span>
        </label>
        <p className="x-caption" style={{ margin: 0 }}>
          {draft.sessionSticky
            ? policyLabels[draft.smartPolicy === 'strict' ? 'strictHelp' : draft.smartPolicy === 'custom' ? 'customHelp' : 'smartHelp']
            : draft.smartPolicy === 'per-turn' ? policyLabels.perTurnHelp : policyLabels.stickyOff}
        </p>
      </fieldset>}
      <div className="x-mgmt-steps">{draft.entries.map((entry, i) => <div className="x-mgmt-step" key={i}>
        <span className="x-mgmt-index">{i + 1}</span>
        <select aria-label={s.provider} value={entry.platform} onChange={e => setEntry(i, { platform: e.target.value })}>
          {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input aria-label={s.modelId} placeholder={s.modelId} value={entry.modelId} required onChange={e => setEntry(i, { modelId: e.target.value })} />
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="x-button" disabled={i === 0} aria-label={s.moveUp} onClick={() => moveEntry(i, -1)}><ArrowUp size={15} /></button>
          <button type="button" className="x-button" disabled={i === draft.entries.length - 1} aria-label={s.moveDown} onClick={() => moveEntry(i, 1)}><ArrowDown size={15} /></button>
          <button type="button" className="x-button" disabled={draft.entries.length < 2} aria-label={s.remove} onClick={() => setDraft({ ...draft, entries: draft.entries.filter((_, idx) => idx !== i) })}><Trash2 size={15} /></button>
        </div>
      </div>)}</div>
      <button type="button" className="x-button" disabled={draft.entries.length >= 20} onClick={() => setDraft({ ...draft, entries: [...draft.entries, { platform: providers[0]?.id ?? '', modelId: '' }] })}><Plus size={15} />{s.addStep}</button>
      {save.isError && <div role="alert" className="x-error">{save.error.message}</div>}
      <div className="x-mgmt-actions"><button className="x-button x-primary" disabled={save.isPending}>{save.isPending ? s.saving : s.save}</button><button type="button" className="x-button" onClick={() => setDraft(null)}>{s.cancel}</button></div>
    </form>}
    {query.data && !combos.length && !draft && <div className="x-empty"><p>{s.noCombos}</p></div>}
    {combos.length > 0 && filtered.length === 0 && !draft && <div className="x-empty"><p>{s.noSearchResults}</p></div>}
    {canEdit && filtered.length > 0 && <div className="x-mgmt-actions" style={{ alignItems: 'center' }}>
      <button type="button" className="x-button" onClick={toggleAllVisible}>{allVisibleSelected ? s.clearSelection : s.selectAll}</button>
      {selected.size > 0 && <button type="button" className="x-button" disabled={bulkRemove.isPending} onClick={async () => { if (await askConfirm(s.bulkDeleteConfirm)) bulkRemove.mutate([...selected]) }}>
        <Trash2 size={15} />{s.bulkDelete} ({selected.size})
      </button>}
    </div>}
    {bulkRemove.isError && <div className="x-error" role="alert">{bulkRemove.error.message}</div>}
    {changeStrategy.isError && <div className="x-error" role="alert">{changeStrategy.error.message}</div>}
    <div className="x-mgmt-list">{filtered.map(raw => {
      const c = raw as PolicyCombo
      const strategy = c.strategy ?? 'fallback'
      const policy = c.smartPolicy ?? 'smart'
      return <section className="x-panel x-mgmt-card" key={c.id}>
        <header>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {canEdit && <input type="checkbox" checked={selected.has(c.id)} aria-label={`${s.select} ${c.name}`} onChange={() => toggleSelected(c.id)} />}
            <h2 style={{ margin: 0 }}>{c.name}</h2>
            <span className="x-badge">{strategyLabels[strategy]}</span>
            {strategy === 'smart' && <span className="x-badge" title={policyLabels[policyKey(policy)]}>
              {policyLabels[policyKey(policy)]}{policy === 'custom' ? ` ${Math.round((c.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD) * 100)}%` : ''}
            </span>}
          </div>
          {canEdit && <div className="x-mgmt-actions" style={{ margin: 0 }}>
            <select aria-label={s.strategy} value={strategy} disabled={changeStrategy.isPending} onChange={e => changeStrategy.mutate({ combo: c, strategy: e.target.value as ComboStrategy })}>
              {STRATEGIES.map(option => <option key={option} value={option}>{strategyLabels[option]}</option>)}
            </select>
            <button className="x-button" aria-label={s.edit} onClick={() => startEdit(c)}><Pencil size={15} /></button>
            <button className="x-button" aria-label={s.remove} disabled={remove.isPending} onClick={async () => { if (await askConfirm(s.deleteConfirm)) remove.mutate(c.id) }}><Trash2 size={15} /></button>
          </div>}
        </header>
        {c.description && <p className="x-caption">{c.description}</p>}
        <p className="x-caption">{s.callAs}: <code>combo:{c.name}</code></p>
        <ol>{c.entries.map((e, i) => <li key={i}><strong>{providers.find(p => p.id === e.platform)?.name ?? e.platform}</strong> · <code>{e.modelId}</code></li>)}</ol>
      </section>
    })}</div>

    {/* Capacity Adapters Section */}
    <section className="x-panel" style={{ marginTop: 24, display: 'grid', gap: 14 }}>
      <div>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Layers size={18} />
          {s.capacityAdapters}
        </h2>
        <p className="x-muted" style={{ fontSize: '0.85rem' }}>{s.capacityHelp}</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
        {/* Vision Pool */}
        <div className="x-panel" style={{ background: 'var(--x-surface-subtle)', padding: 12, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Eye size={16} />
              {s.visionPool}
            </strong>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={capacityData.vision.enabled}
                disabled={!canEdit || saveCapacity.isPending}
                onChange={e => handleTogglePool('vision', e.target.checked)}
              />
              <span>{s.enablePool}</span>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 10, fontSize: '0.8rem' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="radio"
                name="visionStrategy"
                checked={!capacityData.vision.roundRobin}
                disabled={!canEdit || saveCapacity.isPending}
                onChange={() => handleToggleStrategy('vision', false)}
              />
              <span>{s.fallbackStrategy}</span>
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="radio"
                name="visionStrategy"
                checked={capacityData.vision.roundRobin}
                disabled={!canEdit || saveCapacity.isPending}
                onChange={() => handleToggleStrategy('vision', true)}
              />
              <span>{s.roundRobinStrategy}</span>
            </label>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minHeight: 28 }}>
            {capacityData.vision.models.length === 0 ? (
              <span className="x-muted" style={{ fontSize: '0.75rem' }}>{s.noPoolModels}</span>
            ) : (
              capacityData.vision.models.map(m => (
                <span key={m} className="x-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px' }}>
                  <code>{m}</code>
                  {canEdit && (
                    <button
                      type="button"
                      className="x-icon-button"
                      style={{ width: 14, height: 14, padding: 0 }}
                      aria-label={`Remove ${m}`}
                      onClick={() => handleRemoveModel('vision', m)}
                    >
                      <X size={12} />
                    </button>
                  )}
                </span>
              ))
            )}
          </div>

          {canEdit && (
            <form
              onSubmit={(e: FormEvent) => { e.preventDefault(); handleAddModel('vision', newVisionModel) }}
              style={{ display: 'flex', gap: 6 }}
            >
              <input
                type="text"
                value={newVisionModel}
                placeholder={s.addModelToPool}
                onChange={e => setNewVisionModel(e.target.value)}
                style={{ flex: 1, padding: '4px 8px', fontSize: '0.8rem', borderRadius: 6, border: '1px solid var(--x-border)' }}
              />
              <button type="submit" className="x-button" style={{ padding: '4px 8px', fontSize: '0.8rem' }} disabled={!newVisionModel.trim() || saveCapacity.isPending}>
                <Plus size={13} />
              </button>
            </form>
          )}
        </div>

        {/* Audio Pool */}
        <div className="x-panel" style={{ background: 'var(--x-surface-subtle)', padding: 12, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Mic size={16} />
              {s.audioPool}
            </strong>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={capacityData.audioInput.enabled}
                disabled={!canEdit || saveCapacity.isPending}
                onChange={e => handleTogglePool('audioInput', e.target.checked)}
              />
              <span>{s.enablePool}</span>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 10, fontSize: '0.8rem' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="radio"
                name="audioStrategy"
                checked={!capacityData.audioInput.roundRobin}
                disabled={!canEdit || saveCapacity.isPending}
                onChange={() => handleToggleStrategy('audioInput', false)}
              />
              <span>{s.fallbackStrategy}</span>
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="radio"
                name="audioStrategy"
                checked={capacityData.audioInput.roundRobin}
                disabled={!canEdit || saveCapacity.isPending}
                onChange={() => handleToggleStrategy('audioInput', true)}
              />
              <span>{s.roundRobinStrategy}</span>
            </label>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minHeight: 28 }}>
            {capacityData.audioInput.models.length === 0 ? (
              <span className="x-muted" style={{ fontSize: '0.75rem' }}>{s.noPoolModels}</span>
            ) : (
              capacityData.audioInput.models.map(m => (
                <span key={m} className="x-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px' }}>
                  <code>{m}</code>
                  {canEdit && (
                    <button
                      type="button"
                      className="x-icon-button"
                      style={{ width: 14, height: 14, padding: 0 }}
                      aria-label={`Remove ${m}`}
                      onClick={() => handleRemoveModel('audioInput', m)}
                    >
                      <X size={12} />
                    </button>
                  )}
                </span>
              ))
            )}
          </div>

          {canEdit && (
            <form
              onSubmit={(e: FormEvent) => { e.preventDefault(); handleAddModel('audioInput', newAudioModel) }}
              style={{ display: 'flex', gap: 6 }}
            >
              <input
                type="text"
                value={newAudioModel}
                placeholder={s.addModelToPool}
                onChange={e => setNewAudioModel(e.target.value)}
                style={{ flex: 1, padding: '4px 8px', fontSize: '0.8rem', borderRadius: 6, border: '1px solid var(--x-border)' }}
              />
              <button type="submit" className="x-button" style={{ padding: '4px 8px', fontSize: '0.8rem' }} disabled={!newAudioModel.trim() || saveCapacity.isPending}>
                <Plus size={13} />
              </button>
            </form>
          )}
        </div>
      </div>
      {saveCapacity.isSuccess && <p className="x-test-ok" role="status" style={{ fontSize: '0.82rem' }}><Check size={14} />{s.poolSaved}</p>}
    </section>

    {/* Model Aliases & Catalog Sync Section */}
    <section className="x-panel" style={{ marginTop: 24, display: 'grid', gap: 14 }} aria-label="Model Aliases and Catalog Sync">
      <div>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Sparkles size={18} />
          Model Aliases &amp; Catalog Sync
        </h2>
        <p className="x-muted" style={{ fontSize: '0.85rem' }}>
          Give a short name to a <code>provider/model</code> target, then call it by that alias.
        </p>
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {Object.keys(aliases).length === 0 ? (
          <p className="x-muted" style={{ fontSize: '0.82rem' }}>No aliases yet.</p>
        ) : Object.entries(aliases).map(([alias, target]) => (
          <div key={alias} className="x-panel" style={{ background: 'var(--x-surface-subtle)', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><code>{alias}</code> → <code>{target}</code></span>
            <span style={{ display: 'inline-flex', gap: 6 }}>
              <button type="button" className="x-button" aria-label={`Copy alias ${alias}`} onClick={() => copyAlias(alias)}>
                {copiedAlias === alias ? <Check size={14} /> : <Copy size={14} />} {copiedAlias === alias ? 'Copied' : 'Copy'}
              </button>
              {canEditAliases && (
                <button type="button" className="x-button" aria-label={`Delete alias ${alias}`} disabled={removeAlias.isPending} onClick={() => removeAlias.mutate(alias)}>
                  <Trash2 size={14} /> Delete
                </button>
              )}
            </span>
          </div>
        ))}
      </div>

      {canEditAliases && (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            if (!aliasNameValid || !aliasProvider || !aliasModel.trim()) return
            saveAlias.mutate({ alias: aliasName.trim(), model: `${aliasProvider}/${aliasModel.trim()}` })
          }}
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
        >
          <input
            type="text"
            aria-label="Alias Name"
            placeholder="Alias Name (e.g. fast-coder)"
            value={aliasName}
            maxLength={64}
            onChange={e => setAliasName(e.target.value)}
            style={{ padding: '4px 8px', fontSize: '0.85rem', borderRadius: 6, border: '1px solid var(--x-border)' }}
          />
          <select
            aria-label="Provider"
            value={aliasProvider}
            onChange={e => { setAliasProvider(e.target.value); setAliasModel('') }}
            style={{ padding: '4px 8px', fontSize: '0.85rem', borderRadius: 6, border: '1px solid var(--x-border)' }}
          >
            <option value="">Provider…</option>
            {providers.filter(p => p.accounts.length > 0).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input
            type="text"
            aria-label="Model ID"
            placeholder="Model ID"
            list="x-alias-model-options"
            value={aliasModel}
            onChange={e => setAliasModel(e.target.value)}
            style={{ padding: '4px 8px', fontSize: '0.85rem', borderRadius: 6, border: '1px solid var(--x-border)' }}
          />
          <datalist id="x-alias-model-options">
            {aliasProviderModels.map(id => <option key={id} value={id} />)}
          </datalist>
          <button type="submit" className="x-button" disabled={!aliasNameValid || !aliasProvider || !aliasModel.trim() || saveAlias.isPending}>
            <Plus size={14} /> Save Alias
          </button>
        </form>
      )}
      {aliasName.trim() !== '' && !aliasNameValid && (
        <p className="x-muted" role="alert" style={{ fontSize: '0.8rem' }}>Use 1-64 letters, digits, "_", "." or "-".</p>
      )}
      {(saveAlias.isError || removeAlias.isError) && <p role="alert" style={{ fontSize: '0.82rem', color: 'var(--x-danger, #dc2626)' }}>Could not update aliases.</p>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderTop: '1px solid var(--x-border)', paddingTop: 12 }}>
        <div style={{ fontSize: '0.85rem' }}>
          <strong>Catalog Sync</strong>:{' '}
          {syncQuery.data?.syncedAt
            ? <>last synced {new Date(syncQuery.data.syncedAt).toLocaleString()} · {syncQuery.data.totalModels} models · {syncQuery.data.totalProviders} providers</>
            : <span className="x-muted">never synced</span>}
        </div>
        {canEditAliases && (
          <button type="button" className="x-button" disabled={syncCatalog.isPending} onClick={() => syncCatalog.mutate()}>
            <RefreshCw size={14} /> {syncCatalog.isPending ? 'Syncing…' : 'Sync Catalog Now'}
          </button>
        )}
        {syncCatalog.isError && <span role="alert" style={{ fontSize: '0.82rem', color: 'var(--x-danger, #dc2626)' }}>Sync failed.</span>}
      </div>
    </section>
  </>
}
