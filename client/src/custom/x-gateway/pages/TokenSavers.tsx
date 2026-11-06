import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Feather, Save, Scissors } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useUserSession } from '../../use-session'
import { useSessionRevision } from '../../session-state'
import { useXStrings } from '../strings'

const levels = ['off', 'lite', 'full', 'ultra'] as const
type Level = typeof levels[number]
type Settings = { caveman: Level; ponytail: Level }

export default function TokenSavers() {
  const s = useXStrings()
  const client = useQueryClient()
  const revision = useSessionRevision()
  const session = useUserSession()
  const query = useQuery({ queryKey: ['x-output-savers', revision], queryFn: ({ signal }) => apiFetch<Settings>('/api/savers', { signal }), retry: false })
  const [draft, setDraft] = useState<Settings | null>(null)
  const canEdit = session.hasPermission('manage_compression')
  const mutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: (value: Settings) => apiFetch<Settings>('/api/savers', { method: 'PUT', body: JSON.stringify(value) }),
    onSuccess: async () => { setDraft(null); await client.invalidateQueries({ queryKey: ['x-output-savers'] }) },
  })
  const value = draft ?? query.data
  return <>
    <div className="x-page-heading"><div><h1>{s.savers}</h1><p>{s.saverHelp}</p></div><span className="x-heading-icon"><Scissors size={28} /></span></div>
    <p className="x-notice">{s.saverScope}</p>
    {query.isPending && <p role="status">{s.loading}</p>}
    {query.isError && <div className="x-error" role="alert">{s.saverError}<button className="x-button" onClick={() => void query.refetch()}>{s.retry}</button></div>}
    {value && <form onSubmit={event => { event.preventDefault(); mutation.mutate(value) }}>
      <div className="x-saver-grid">{(['caveman', 'ponytail'] as const).map(name => <section className="x-panel x-saver" key={name}><span className="x-dialog-icon">{name === 'caveman' ? <Scissors size={24} /> : <Feather size={24} />}</span><h2>{s[name]}</h2><p>{name === 'caveman' ? s.cavemanHelp : s.ponytailHelp}</p><fieldset disabled={!canEdit || mutation.isPending}><legend className="x-sr-only">{s[name]}</legend><div className="x-saver-levels">{levels.map(level => <label key={level} className={value[name] === level ? 'selected' : ''}><input type="radio" name={name} checked={value[name] === level} onChange={() => { setDraft({ ...value, [name]: level }); mutation.reset() }} />{s[level]}</label>)}</div></fieldset></section>)}</div>
      <p className="x-footnote">{s.saverCost}</p>{mutation.isError && <div role="alert" className="x-error">{mutation.error.message}</div>}{mutation.isSuccess && <p role="status" className="x-test-ok">{s.settingsSaved}</p>}
      {canEdit ? <button className="x-button x-primary" disabled={!draft || mutation.isPending}><Save size={16} />{mutation.isPending ? s.saving : s.save}</button> : <p className="x-caption">{s.readOnly}</p>}
    </form>}
  </>
}
