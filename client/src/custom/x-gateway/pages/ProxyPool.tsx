import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Network, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { useUserSession } from '../../use-session'
import { useSessionRevision } from '../../session-state'
import { proxyPoolApi, type XProxyPoolEntry, type XProxyPoolTestResult } from '../proxy-pool-api'
import { usePoolStrings } from '../proxy-pool-strings'

interface Draft { id?: number; name: string; proxyUrl: string }

export default function ProxyPool() {
  const s = usePoolStrings()
  const client = useQueryClient()
  const revision = useSessionRevision()
  const session = useUserSession()
  const canEdit = session.hasPermission('edit_x_settings')
  const query = useQuery({ queryKey: ['x-proxy-pool', revision], queryFn: ({ signal }) => proxyPoolApi.list(signal), retry: false })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [testResult, setTestResult] = useState<(XProxyPoolTestResult & { id: number }) | null>(null)
  const done = async () => {
    setDraft(null)
    await client.invalidateQueries({ queryKey: ['x-proxy-pool'] })
    await client.invalidateQueries({ queryKey: ['x-accounts'] })
  }
  const save = useMutation({
    meta: { silenceToast: true },
    mutationFn: (d: Draft) => d.id
      ? proxyPoolApi.update(d.id, { name: d.name, ...(d.proxyUrl.trim() ? { proxyUrl: d.proxyUrl.trim() } : {}) })
      : proxyPoolApi.create({ name: d.name, proxyUrl: d.proxyUrl.trim() }),
    onSuccess: done,
  })
  const toggle = useMutation({
    meta: { silenceToast: true },
    mutationFn: (entry: XProxyPoolEntry) => proxyPoolApi.update(entry.id, { enabled: !entry.enabled }),
    onSuccess: done,
  })
  const remove = useMutation({ mutationFn: (id: number) => proxyPoolApi.remove(id), onSuccess: done })
  const test = useMutation({
    meta: { silenceToast: true },
    mutationFn: async (id: number) => ({ id, ...await proxyPoolApi.test(id) }),
    onSuccess: result => setTestResult(result),
  })

  return <>
    <div className="x-page-heading"><div><h1>{s.proxies}</h1><p>{s.proxiesHelp}</p></div><span className="x-heading-icon"><Network size={28} /></span></div>
    {query.isPending && <p role="status">{s.loading}</p>}
    {query.isError && <div className="x-error" role="alert">{s.loadError}<button className="x-button" onClick={() => void query.refetch()}>{s.retry}</button></div>}
    {canEdit && !draft && <button className="x-button x-primary" onClick={() => { save.reset(); setDraft({ name: '', proxyUrl: '' }) }}><Plus size={16} />{s.newEntry}</button>}
    {!canEdit && <p className="x-caption">{s.readOnly}</p>}
    {draft && <form className="x-panel x-mgmt-form" onSubmit={e => { e.preventDefault(); save.mutate(draft) }}>
      <h2>{draft.id ? s.editEntry : s.newEntry}</h2>
      <label>{s.entryName}<input value={draft.name} maxLength={64} required onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label>{s.entryUrl}<input value={draft.proxyUrl} maxLength={2048} required={!draft.id} placeholder={draft.id ? s.entryUrlKeep : s.entryUrlPlaceholder} onChange={e => setDraft({ ...draft, proxyUrl: e.target.value })} /></label>
      {save.isError && <div role="alert" className="x-error">{save.error.message}</div>}
      <div className="x-mgmt-actions"><button className="x-button x-primary" disabled={save.isPending || !draft.name.trim() || (!draft.id && !draft.proxyUrl.trim())}>{save.isPending ? s.saving : s.save}</button><button type="button" className="x-button" onClick={() => setDraft(null)}>{s.cancel}</button></div>
    </form>}
    {query.data && !query.data.entries.length && !draft && <div className="x-empty"><p>{s.noEntries}</p></div>}
    <div className="x-mgmt-list">{query.data?.entries.map(entry => <section className="x-panel x-mgmt-card" key={entry.id}>
      <header><h2>{entry.name}</h2><div className="x-mgmt-actions">
        <span className={`x-badge ${entry.enabled ? 'x-green' : ''}`}><span className="x-dot" />{entry.enabled ? s.enabled : s.disabled}</span>
        {canEdit && <>
          <button className="x-switch" role="switch" aria-checked={entry.enabled} aria-label={`${entry.enabled ? s.disabled : s.enabled}: ${entry.name}`} disabled={toggle.isPending} onClick={() => toggle.mutate(entry)}><span /></button>
          <button className="x-button" aria-label={`${s.edit}: ${entry.name}`} onClick={() => { save.reset(); setDraft({ id: entry.id, name: entry.name, proxyUrl: '' }) }}><Pencil size={15} /></button>
          <button className="x-button" aria-label={`${s.remove}: ${entry.name}`} disabled={remove.isPending} onClick={() => { if (window.confirm(s.deleteConfirm)) remove.mutate(entry.id) }}><Trash2 size={15} /></button>
        </>}
      </div></header>
      <p className="x-caption"><code>{entry.proxyUrl}</code></p>
      <p className="x-caption">{entry.boundAccounts} {s.boundAccounts}</p>
      {canEdit && <div className="x-mgmt-actions">
        <button className="x-button x-small" disabled={test.isPending} onClick={() => { setTestResult(null); test.mutate(entry.id) }}><ShieldCheck size={14} />{test.isPending && test.variables === entry.id ? s.testing : s.test}</button>
        {testResult && testResult.id === entry.id && <span className={testResult.ok ? 'x-test-ok' : 'x-error'} role="status">{testResult.ok ? `${s.testOk} · ${testResult.latencyMs} ms` : testResult.message ?? s.testFailed}</span>}
      </div>}
      {test.isError && test.variables === entry.id && <p className="x-error" role="alert">{test.error.message}</p>}
    </section>)}</div>
  </>
}