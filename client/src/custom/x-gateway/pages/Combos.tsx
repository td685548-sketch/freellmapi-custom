import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Layers, Pencil, Plus, Trash2 } from 'lucide-react'
import { useUserSession } from '../../use-session'
import { useSessionRevision } from '../../session-state'
import { useAccounts } from '../api'
import { mgmtApi, type ComboEntry, type XCombo } from '../management-api'
import { useMgmtStrings } from '../management-strings'

interface Draft { id?: number; name: string; entries: ComboEntry[] }

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
  const done = async () => { setDraft(null); await client.invalidateQueries({ queryKey: ['x-combos'] }) }
  const save = useMutation({
    meta: { silenceToast: true },
    mutationFn: (d: Draft) => d.id ? mgmtApi.updateCombo(d.id, d) : mgmtApi.createCombo(d),
    onSuccess: done,
  })
  const remove = useMutation({ mutationFn: (id: number) => mgmtApi.deleteCombo(id), onSuccess: done })
  const setEntry = (i: number, patch: Partial<ComboEntry>) =>
    setDraft(d => d && { ...d, entries: d.entries.map((e, idx) => idx === i ? { ...e, ...patch } : e) })
  const startNew = () => { save.reset(); setDraft({ name: '', entries: [{ platform: providers[0]?.id ?? '', modelId: '' }] }) }
  const startEdit = (c: XCombo) => { save.reset(); setDraft({ id: c.id, name: c.name, entries: c.entries.map(e => ({ ...e })) }) }

  return <>
    <div className="x-page-heading"><div><h1>{s.combos}</h1><p>{s.combosHelp}</p></div><span className="x-heading-icon"><Layers size={28} /></span></div>
    {query.isPending && <p role="status">{s.loading}</p>}
    {query.isError && <div className="x-error" role="alert">{s.loadError}<button className="x-button" onClick={() => void query.refetch()}>{s.retry}</button></div>}
    {canEdit && !draft && <button className="x-button x-primary" onClick={startNew}><Plus size={16} />{s.newCombo}</button>}
    {!canEdit && <p className="x-caption">{s.readOnly}</p>}
    {draft && <form className="x-panel x-mgmt-form" onSubmit={e => { e.preventDefault(); save.mutate(draft) }}>
      <h2>{draft.id ? s.editCombo : s.newCombo}</h2>
      <label>{s.comboName}<input value={draft.name} maxLength={48} required onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <div className="x-mgmt-steps">{draft.entries.map((entry, i) => <div className="x-mgmt-step" key={i}>
        <span className="x-mgmt-index">{i + 1}</span>
        <select aria-label={s.provider} value={entry.platform} onChange={e => setEntry(i, { platform: e.target.value })}>
          {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input aria-label={s.modelId} placeholder={s.modelId} value={entry.modelId} required onChange={e => setEntry(i, { modelId: e.target.value })} />
        <button type="button" className="x-button" disabled={draft.entries.length < 2} aria-label={s.remove} onClick={() => setDraft({ ...draft, entries: draft.entries.filter((_, idx) => idx !== i) })}><Trash2 size={15} /></button>
      </div>)}</div>
      <button type="button" className="x-button" disabled={draft.entries.length >= 20} onClick={() => setDraft({ ...draft, entries: [...draft.entries, { platform: providers[0]?.id ?? '', modelId: '' }] })}><Plus size={15} />{s.addStep}</button>
      {save.isError && <div role="alert" className="x-error">{save.error.message}</div>}
      <div className="x-mgmt-actions"><button className="x-button x-primary" disabled={save.isPending}>{save.isPending ? s.saving : s.save}</button><button type="button" className="x-button" onClick={() => setDraft(null)}>{s.cancel}</button></div>
    </form>}
    {query.data && !query.data.combos.length && !draft && <div className="x-empty"><p>{s.noCombos}</p></div>}
    <div className="x-mgmt-list">{query.data?.combos.map(c => <section className="x-panel x-mgmt-card" key={c.id}>
      <header><h2>{c.name}</h2>{canEdit && <div className="x-mgmt-actions">
        <button className="x-button" aria-label={s.edit} onClick={() => startEdit(c)}><Pencil size={15} /></button>
        <button className="x-button" aria-label={s.remove} disabled={remove.isPending} onClick={() => { if (window.confirm(s.deleteConfirm)) remove.mutate(c.id) }}><Trash2 size={15} /></button>
      </div>}</header>
      <p className="x-caption">{s.callAs}: <code>combo:{c.name}</code></p>
      <ol>{c.entries.map((e, i) => <li key={i}><strong>{providers.find(p => p.id === e.platform)?.name ?? e.platform}</strong> · <code>{e.modelId}</code></li>)}</ol>
    </section>)}</div>
  </>
}

