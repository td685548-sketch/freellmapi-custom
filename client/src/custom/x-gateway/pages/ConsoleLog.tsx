import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ScrollText, Terminal, Trash2 } from 'lucide-react'
import { useSessionRevision } from '../../session-state'
import { mgmtApi } from '../management-api'
import { useMgmtStrings } from '../management-strings'
import { useXStrings } from '../strings'

const MAX_TERMINAL_LINES = 1000

const LEVEL_COLORS: Record<string, string> = {
  DEBUG: '#c084fc', // purple-400
  INFO: '#38bdf8',  // sky-400
  WARN: '#facc15',  // yellow-400
  ERROR: '#f87171', // red-400
  LOG: '#4ade80',   // green-400
}

function colorLine(line: string) {
  const match = line.match(/\[(DEBUG|INFO|WARN|ERROR|LOG)\]/i)
  const level = match ? match[1].toUpperCase() : null
  const color = (level && LEVEL_COLORS[level]) ? LEVEL_COLORS[level] : '#4ade80'
  return <span style={{ color }}>{line}</span>
}

export default function ConsoleLog() {
  const s = useMgmtStrings()
  const xs = useXStrings()
  const revision = useSessionRevision()
  const [activeTab, setActiveTab] = useState<'requests' | 'terminal'>('requests')

  // Request logs state
  const [status, setStatus] = useState('')
  const logs = useQuery({
    queryKey: ['x-logs', revision, status],
    queryFn: ({ signal }) => mgmtApi.logs(status, signal),
    refetchInterval: 10_000,
    retry: false,
  })
  const hourly = useQuery({
    queryKey: ['x-hourly', revision],
    queryFn: ({ signal }) => mgmtApi.hourly(signal),
    refetchInterval: 30_000,
    retry: false,
  })
  const buckets = hourly.data?.buckets ?? []
  const max = Math.max(1, ...buckets.map(b => b.requests))

  // Terminal Live Stream state
  const [terminalLogs, setTerminalLogs] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const logContainerRef = useRef<HTMLDivElement | null>(null)
  const autoScrollRef = useRef(true)

  useEffect(() => {
    if (activeTab !== 'terminal') return

    let isMounted = true
    const es = new EventSource('/api/translator/console-logs/stream')

    es.onopen = () => {
      if (isMounted) setConnected(true)
    }

    es.onmessage = (e) => {
      if (!isMounted) return
      try {
        const msg = JSON.parse(e.data) as {
          type: string
          logs?: string[]
          line?: string
          lines?: string[]
        }
        if (msg.type === 'init' && Array.isArray(msg.logs)) {
          setTerminalLogs(msg.logs.slice(-MAX_TERMINAL_LINES))
        } else if (msg.type === 'line' && typeof msg.line === 'string') {
          const l = msg.line
          setTerminalLogs((prev) => {
            const next = [...prev, l]
            return next.length > MAX_TERMINAL_LINES ? next.slice(-MAX_TERMINAL_LINES) : next
          })
        } else if (msg.type === 'lines' && Array.isArray(msg.lines)) {
          const ls = msg.lines
          setTerminalLogs((prev) => {
            const next = [...prev, ...ls]
            return next.length > MAX_TERMINAL_LINES ? next.slice(-MAX_TERMINAL_LINES) : next
          })
        } else if (msg.type === 'clear') {
          setTerminalLogs([])
        }
      } catch {
        // ignore malformed JSON
      }
    }

    es.onerror = () => {
      if (isMounted) setConnected(false)
    }

    return () => {
      isMounted = false
      es.close()
    }
  }, [activeTab])

  // Scroll to bottom on new lines if auto-scroll is enabled
  useEffect(() => {
    if (activeTab === 'terminal' && autoScrollRef.current && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
    }
  }, [terminalLogs, activeTab])

  const handleClearLogs = async () => {
    try {
      await fetch('/api/translator/console-logs', { method: 'DELETE' })
      setTerminalLogs([])
    } catch (err) {
      console.error('Failed to clear console logs:', err)
    }
  }

  const handleScroll = () => {
    if (!logContainerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current
    // If within 40px of bottom, auto-scroll stays enabled
    autoScrollRef.current = scrollHeight - (scrollTop + clientHeight) < 40
  }

  return (
    <>
      <div className="x-page-heading">
        <div>
          <h1>{activeTab === 'requests' ? s.logs : xs.terminalLiveLog}</h1>
          <p>{s.logsHelp}</p>
        </div>
        <span className="x-heading-icon">
          {activeTab === 'requests' ? <ScrollText size={28} /> : <Terminal size={28} />}
        </span>
      </div>

      {/* Tab Switcher */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', borderBottom: '1px solid var(--border-color, #e2e8f0)', paddingBottom: '0.75rem' }}>
        <button
          className={`x-button ${activeTab === 'requests' ? 'x-primary' : ''}`}
          onClick={() => setActiveTab('requests')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <ScrollText size={16} />
          {xs.requestLogs}
        </button>
        <button
          className={`x-button ${activeTab === 'terminal' ? 'x-primary' : ''}`}
          onClick={() => setActiveTab('terminal')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <Terminal size={16} />
          {xs.terminalLiveLog}
          {connected && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', display: 'inline-block' }} />}
        </button>
      </div>

      {activeTab === 'requests' ? (
        <>
          <section className="x-panel x-mgmt-form">
            <h2>{s.hourly} <small>({s.last24h})</small></h2>
            {buckets.length === 0 ? (
              <p className="x-caption">{s.noLogs}</p>
            ) : (
              <div className="x-bars" role="img" aria-label={s.hourly}>
                {buckets.map(b => (
                  <div
                    key={b.hour}
                    className="x-bar"
                    title={`${b.hour.replace('T', ' ')}:00 — ${b.requests} ${s.requests}, ${b.errors} ${s.errors}`}
                  >
                    <span className="x-bar-fill" style={{ height: `${Math.max(4, (b.requests / max) * 100)}%` }}>
                      <span className="x-bar-err" style={{ height: `${b.requests ? (b.errors / b.requests) * 100 : 0}%` }} />
                    </span>
                    <small>{b.hour.slice(11, 13)}</small>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="x-mgmt-actions">
            {([['', s.all], ['success', s.success], ['error', s.failed]] as const).map(([value, label]) => (
              <button
                key={value}
                className={`x-button ${status === value ? 'x-primary' : ''}`}
                onClick={() => setStatus(value)}
              >
                {label}
              </button>
            ))}
            <button className="x-button" onClick={() => { void logs.refetch(); void hourly.refetch() }}>
              {s.refresh}
            </button>
          </div>

          {logs.isPending && <p role="status">{s.loading}</p>}
          {logs.isError && (
            <div className="x-error" role="alert">
              {s.loadError}
              <button className="x-button" onClick={() => void logs.refetch()}>{s.retry}</button>
            </div>
          )}

          {logs.data && (
            <div className="x-panel x-table-wrap">
              <table className="x-table">
                <thead>
                  <tr>
                    <th>{s.time}</th>
                    <th>{s.provider}</th>
                    <th>{s.model}</th>
                    <th>{s.status}</th>
                    <th>{s.tokens}</th>
                    <th>{s.latency}</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.data.logs.map(l => (
                    <tr key={l.id}>
                      <td>{new Date(l.createdAt).toLocaleString()}</td>
                      <td>{l.platform}</td>
                      <td><code>{l.requestedModel ?? l.modelId}</code></td>
                      <td title={l.error ?? undefined}>{l.status === 'success' ? s.success : s.failed}</td>
                      <td>{(l.inputTokens + l.outputTokens).toLocaleString()}</td>
                      <td>{l.latencyMs ?? '–'} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!logs.data.logs.length && <div className="x-empty"><p>{s.noLogs}</p></div>}
            </div>
          )}
        </>
      ) : (
        <section className="x-panel" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {/* Terminal Toolbar */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.75rem 1rem',
            background: 'var(--panel-header-bg, #1e293b)',
            borderBottom: '1px solid var(--border-color, #334155)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', fontSize: '0.8125rem' }}>
              <span style={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: connected ? '#10b981' : '#ef4444',
                boxShadow: connected ? '0 0 8px #10b981' : 'none',
                display: 'inline-block',
              }} />
              <span style={{ color: connected ? '#10b981' : '#ef4444', fontWeight: 500 }}>
                {connected ? xs.liveConnected : xs.disconnected}
              </span>
              <span style={{ color: 'var(--text-muted, #94a3b8)' }}>
                ({terminalLogs.length} lines)
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <button
                className="x-button"
                onClick={handleClearLogs}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8125rem' }}
              >
                <Trash2 size={14} />
                {xs.clearLogs}
              </button>
            </div>
          </div>

          {/* Terminal Output Area */}
          <div
            ref={logContainerRef}
            onScroll={handleScroll}
            style={{
              background: '#090d16',
              color: '#f8fafc',
              padding: '1rem',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              fontSize: '0.8125rem',
              lineHeight: '1.5',
              height: 'calc(100vh - 300px)',
              minHeight: '400px',
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {terminalLogs.length === 0 ? (
              <span style={{ color: '#64748b' }}>No console logs yet. Waiting for incoming activity...</span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {terminalLogs.map((line, i) => (
                  <div key={i}>{colorLine(line)}</div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </>
  )
}
