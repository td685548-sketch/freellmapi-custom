import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Check, Eye, Layers, Mic, Pencil, Plus, Search, Sparkles, Trash2, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useUserSession } from '../../use-session'
import { useSessionRevision } from '../../session-state'
import { useAccounts } from '../api'
import { mgmtApi, type ComboEntry, type ComboPayload, type ComboStrategy, type XCombo } from '../management-api'
import { useMgmtStrings } from '../management-strings'

interface Draft { id?: number; name: string; entries: ComboEntry[]; strategy: ComboStrategy; description: string }

const STRATEGIES: ComboStrategy[] = ['fallback', 'round-robin', 'smart', 'fusion']

export interface CapacityPool {
  enabled: boolean
  roundRobin: boolean
  models: string[]
}

export interface CapacityAdapterSettings {
  vision: CapacityPool
  audioInput: CapacityPool
}

export default function Combos() {
  const s = useMgmtStrings()
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
    queryFn: ({ signal }) => apiFetch<CapacityAdapterSettings>('/api/x-gateway/capacity-adapter', { signal }),
    retry: false,
  })
  const [newVisionModel, setNewVisionModel] = useState('')
  const [newAudioModel, setNewAudioModel] = useState('')

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
      apiFetch<CapacityAdapterSettings>('/api/x-gateway/capacity-adapter', {
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
  const toPayload = (d: Draft): ComboPayload => ({
    name: d.name,
    entries: d.entries,
    strategy: d.strategy,
    description: d.description.trim() || undefined,
  })
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
    mutationFn: ({ combo, strategy }: { combo: XCombo; strategy: ComboStrategy }) =>
      mgmtApi.updateCombo(combo.id, { name: combo.name, entries: combo.entries, strategy, description: combo.description }),
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
    setDraft({ name: '', entries: [{ platform: providers[0]?.id ?? '', modelId: '' }], strategy: 'fallback', description: '' })
  }
  const startEdit = (c: XCombo) => {
    save.reset()
    setDraft({
      id: c.id,
      name: c.name,
      entries: c.entries.map(e => ({ ...e })),
      strategy: c.strategy ?? 'fallback',
      description: c.description ?? '',
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
      {selected.size > 0 && <button type="button" className="x-button" disabled={bulkRemove.isPending} onClick={() => { if (window.confirm(s.bulkDeleteConfirm)) bulkRemove.mutate([...selected]) }}>
        <Trash2 size={15} />{s.bulkDelete} ({selected.size})
      </button>}
    </div>}
    {bulkRemove.isError && <div className="x-error" role="alert">{bulkRemove.error.message}</div>}
    {changeStrategy.isError && <div className="x-error" role="alert">{changeStrategy.error.message}</div>}
    <div className="x-mgmt-list">{filtered.map(c => {
      const strategy = c.strategy ?? 'fallback'
      return <section className="x-panel x-mgmt-card" key={c.id}>
        <header>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {canEdit && <input type="checkbox" checked={selected.has(c.id)} aria-label={`${s.select} ${c.name}`} onChange={() => toggleSelected(c.id)} />}
            <h2 style={{ margin: 0 }}>{c.name}</h2>
            <span className="x-badge">{strategyLabels[strategy]}</span>
          </div>
          {canEdit && <div className="x-mgmt-actions" style={{ margin: 0 }}>
            <select aria-label={s.strategy} value={strategy} disabled={changeStrategy.isPending} onChange={e => changeStrategy.mutate({ combo: c, strategy: e.target.value as ComboStrategy })}>
              {STRATEGIES.map(option => <option key={option} value={option}>{strategyLabels[option]}</option>)}
            </select>
            <button className="x-button" aria-label={s.edit} onClick={() => startEdit(c)}><Pencil size={15} /></button>
            <button className="x-button" aria-label={s.remove} disabled={remove.isPending} onClick={() => { if (window.confirm(s.deleteConfirm)) remove.mutate(c.id) }}><Trash2 size={15} /></button>
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
  </>
}
