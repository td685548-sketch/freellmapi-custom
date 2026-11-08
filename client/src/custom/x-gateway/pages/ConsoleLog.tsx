import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Copy, ScrollText, Search, Terminal, Trash2, X } from 'lucide-react'
import { useSessionRevision } from '../../session-state'
import { mgmtApi, type XLog } from '../management-api'
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
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedLog, setSelectedLog] = useState<XLog | null>(null)
  const [copiedLogJson, setCopiedLogJson] = useState(false)
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

          <div className="x-mgmt-actions" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                className={`x-button ${status === '' ? 'x-primary' : ''}`}
                onClick={() => setStatus('')}
              >
                {s.all}
              </button>
              <button
                className={`x-button ${status === 'success' ? 'x-primary' : ''}`}
                onClick={() => setStatus('success')}
              >
                2xx OK
              </button>
              <button
                className={`x-button ${status === 'error' ? 'x-primary' : ''}`}
                onClick={() => setStatus('error')}
              >
                4xx/5xx Error
              </button>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <Search size={14} style={{ position: 'absolute', left: '0.6rem', color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  placeholder="Lọc Model / Provider..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    padding: '0.375rem 0.6rem 0.375rem 2rem',
                    borderRadius: '6px',
                    border: '1px solid var(--border)',
                    backgroundColor: 'var(--bg-subtle, rgba(0,0,0,0.03))',
                    fontSize: '0.8125rem',
                    width: '210px',
                  }}
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    style={{ position: 'absolute', right: '0.5rem', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              <button className="x-button" onClick={() => { void logs.refetch(); void hourly.refetch() }}>
                {s.refresh}
              </button>
            </div>
          </div>

          {logs.isPending && <p role="status">{s.loading}</p>}
          {logs.isError && (
            <div className="x-error" role="alert">
              {s.loadError}
              <button className="x-button" onClick={() => void logs.refetch()}>{s.retry}</button>
            </div>
          )}

          {logs.data && (() => {
            const query = searchQuery.trim().toLowerCase();
            const filtered = (logs.data.logs || []).filter(l => {
              if (!query) return true;
              return (
                l.platform?.toLowerCase().includes(query) ||
                l.modelId?.toLowerCase().includes(query) ||
                l.requestedModel?.toLowerCase().includes(query) ||
                (l.error && l.error.toLowerCase().includes(query))
              );
            });

            return (
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
                    {filtered.map(l => (
                      <tr
                        key={l.id}
                        onClick={() => setSelectedLog(l)}
                        style={{ cursor: 'pointer' }}
                        title="Bấm để xem chi tiết metadata"
                      >
                        <td>{new Date(l.createdAt).toLocaleString()}</td>
                        <td><strong>{l.platform}</strong></td>
                        <td><code>{l.requestedModel ?? l.modelId}</code></td>
                        <td>
                          <span style={{
                            padding: '0.2rem 0.5rem',
                            borderRadius: '999px',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            background: l.status === 'success' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                            color: l.status === 'success' ? '#10b981' : '#f87171',
                          }}>
                            {l.status === 'success' ? s.success : s.failed}
                          </span>
                        </td>
                        <td>{(l.inputTokens + l.outputTokens).toLocaleString()}</td>
                        <td>{l.latencyMs ?? '–'} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!filtered.length && <div className="x-empty"><p>{s.noLogs}</p></div>}
              </div>
            );
          })()}

          {/* Request Log Detail Drawer / Modal */}
          {selectedLog && (
            <div
              style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.5)',
                zIndex: 1000,
                display: 'flex',
                justifyContent: 'flex-end',
                backdropFilter: 'blur(2px)',
              }}
              onClick={() => setSelectedLog(null)}
            >
              <div
                style={{
                  width: '100%',
                  maxWidth: '520px',
                  height: '100%',
                  backgroundColor: 'var(--card-bg, #1e293b)',
                  color: 'var(--foreground, #f8fafc)',
                  display: 'flex',
                  flexDirection: 'column',
                  boxShadow: '-4px 0 24px rgba(0,0,0,0.3)',
                  borderLeft: '1px solid var(--border-color, #334155)',
                  boxSizing: 'border-box',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* Drawer Header */}
                <div style={{
                  padding: '1.25rem',
                  borderBottom: '1px solid var(--border-color, #334155)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 600 }}>Chi tiết Request #{selectedLog.id}</h3>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted, #94a3b8)' }}>
                      {new Date(selectedLog.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <button
                    className="x-button"
                    onClick={() => setSelectedLog(null)}
                    style={{ padding: '0.35rem', borderRadius: '50%' }}
                  >
                    <X size={18} />
                  </button>
                </div>

                {/* Drawer Body */}
                <div style={{ padding: '1.25rem', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {/* Status & Latency Badges */}
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <span style={{
                      padding: '0.25rem 0.65rem',
                      borderRadius: '999px',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      background: selectedLog.status === 'success' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                      color: selectedLog.status === 'success' ? '#10b981' : '#f87171',
                      border: `1px solid ${selectedLog.status === 'success' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                    }}>
                      {selectedLog.status === 'success' ? '200 OK (Success)' : 'Error / Failed'}
                    </span>
                    <span style={{
                      padding: '0.25rem 0.65rem',
                      borderRadius: '999px',
                      fontSize: '0.75rem',
                      fontWeight: 500,
                      background: 'var(--bg-subtle, rgba(255,255,255,0.06))',
                    }}>
                      Độ trễ: {selectedLog.latencyMs ?? '–'} ms
                    </span>
                  </div>

                  {/* Metadata Grid */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '0.75rem',
                    background: 'var(--bg-subtle, rgba(0,0,0,0.15))',
                    padding: '1rem',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color, #334155)',
                  }}>
                    <div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted, #94a3b8)', display: 'block' }}>Nhà cung cấp (Provider)</span>
                      <strong style={{ fontSize: '0.9rem' }}>{selectedLog.platform}</strong>
                    </div>
                    <div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted, #94a3b8)', display: 'block' }}>Model</span>
                      <code style={{ fontSize: '0.85rem' }}>{selectedLog.requestedModel ?? selectedLog.modelId}</code>
                    </div>
                    <div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted, #94a3b8)', display: 'block' }}>Input Tokens</span>
                      <strong style={{ fontSize: '0.9rem' }}>{selectedLog.inputTokens.toLocaleString()}</strong>
                    </div>
                    <div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted, #94a3b8)', display: 'block' }}>Output Tokens</span>
                      <strong style={{ fontSize: '0.9rem' }}>{selectedLog.outputTokens.toLocaleString()}</strong>
                    </div>
                    <div style={{ gridColumn: 'span 2' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted, #94a3b8)', display: 'block' }}>Tổng Tokens</span>
                      <strong style={{ fontSize: '1rem', color: '#10b981' }}>{(selectedLog.inputTokens + selectedLog.outputTokens).toLocaleString()}</strong>
                    </div>
                  </div>

                  {/* Error Details */}
                  {selectedLog.error && (
                    <div style={{
                      background: 'rgba(239, 68, 68, 0.1)',
                      border: '1px solid rgba(239, 68, 68, 0.3)',
                      borderRadius: '8px',
                      padding: '0.85rem',
                      color: '#f87171',
                      fontSize: '0.825rem',
                    }}>
                      <strong style={{ display: 'block', marginBottom: '0.25rem' }}>Thông báo lỗi (Error Details):</strong>
                      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'monospace' }}>
                        {selectedLog.error}
                      </pre>
                    </div>
                  )}

                  {/* Raw JSON */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Raw JSON Metadata</span>
                      <button
                        className="x-button x-small"
                        onClick={() => {
                          navigator.clipboard.writeText(JSON.stringify(selectedLog, null, 2))
                          setCopiedLogJson(true)
                          setTimeout(() => setCopiedLogJson(false), 2000)
                        }}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem' }}
                      >
                        {copiedLogJson ? <Check size={13} /> : <Copy size={13} />}
                        {copiedLogJson ? 'Đã sao chép!' : 'Copy JSON'}
                      </button>
                    </div>
                    <pre style={{
                      background: '#090d16',
                      color: '#38bdf8',
                      padding: '0.85rem',
                      borderRadius: '8px',
                      fontSize: '0.775rem',
                      lineHeight: '1.4',
                      overflowX: 'auto',
                      maxHeight: '260px',
                      margin: 0,
                    }}>
                      {JSON.stringify(selectedLog, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>
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
