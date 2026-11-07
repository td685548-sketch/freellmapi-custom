import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ScrollText } from 'lucide-react'
import { useSessionRevision } from '../../session-state'
import { mgmtApi } from '../management-api'
import { useMgmtStrings } from '../management-strings'

export default function ConsoleLog() {
  const s = useMgmtStrings()
  const revision = useSessionRevision()
  const [status, setStatus] = useState('')
  const logs = useQuery({ queryKey: ['x-logs', revision, status], queryFn: ({ signal }) => mgmtApi.logs(status, signal), refetchInterval: 10_000, retry: false })
  const hourly = useQuery({ queryKey: ['x-hourly', revision], queryFn: ({ signal }) => mgmtApi.hourly(signal), refetchInterval: 30_000, retry: false })
  const buckets = hourly.data?.buckets ?? []
  const max = Math.max(1, ...buckets.map(b => b.requests))
  return <>
    <div className="x-page-heading"><div><h1>{s.logs}</h1><p>{s.logsHelp}</p></div><span className="x-heading-icon"><ScrollText size={28} /></span></div>
    <section className="x-panel x-mgmt-form">
      <h2>{s.hourly} <small>({s.last24h})</small></h2>
      {buckets.length === 0 ? <p className="x-caption">{s.noLogs}</p> : <div className="x-bars" role="img" aria-label={s.hourly}>
        {buckets.map(b => <div key={b.hour} className="x-bar" title={`${b.hour.replace('T', ' ')}:00 — ${b.requests} ${s.requests}, ${b.errors} ${s.errors}`}>
          <span className="x-bar-fill" style={{ height: `${Math.max(4, (b.requests / max) * 100)}%` }}><span className="x-bar-err" style={{ height: `${b.requests ? (b.errors / b.requests) * 100 : 0}%` }} /></span>
          <small>{b.hour.slice(11, 13)}</small>
        </div>)}
      </div>}
    </section>
    <div className="x-mgmt-actions">
      {[['', s.all], ['success', s.success], ['error', s.failed]].map(([value, label]) =>
        <button key={value} className={`x-button ${status === value ? 'x-primary' : ''}`} onClick={() => setStatus(value)}>{label}</button>)}
      <button className="x-button" onClick={() => { void logs.refetch(); void hourly.refetch() }}>{s.refresh}</button>
    </div>
    {logs.isPending && <p role="status">{s.loading}</p>}
    {logs.isError && <div className="x-error" role="alert">{s.loadError}<button className="x-button" onClick={() => void logs.refetch()}>{s.retry}</button></div>}
    {logs.data && <div className="x-panel x-table-wrap"><table className="x-table">
      <thead><tr><th>{s.time}</th><th>{s.provider}</th><th>{s.model}</th><th>{s.status}</th><th>{s.tokens}</th><th>{s.latency}</th></tr></thead>
      <tbody>{logs.data.logs.map(l => <tr key={l.id}>
        <td>{new Date(l.createdAt).toLocaleString()}</td><td>{l.platform}</td>
        <td><code>{l.requestedModel ?? l.modelId}</code></td>
        <td title={l.error ?? undefined}>{l.status === 'success' ? s.success : s.failed}</td>
        <td>{(l.inputTokens + l.outputTokens).toLocaleString()}</td><td>{l.latencyMs ?? '–'} ms</td>
      </tr>)}</tbody></table>
      {!logs.data.logs.length && <div className="x-empty"><p>{s.noLogs}</p></div>}</div>}
  </>
}

