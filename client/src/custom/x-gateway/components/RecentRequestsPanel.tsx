import { useEffect, useState } from 'react'

export interface RecentRequestItem {
  id: number | string
  provider: string
  model: string
  status: string
  promptTokens: number
  completionTokens: number
  latencyMs: number | null
  errorMessage: string | null
  fromPlayground?: boolean
  timestamp: string
}

const fmtTok = (n: number) => {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return String(v)
}

function formatAgo(iso: string) {
  const ts = new Date(iso).getTime()
  if (Number.isNaN(ts)) return '—'
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function TimeAgo({ timestamp }: { timestamp: string }) {
  // Pure render: the tick lives in the panel, one 30s timer for all rows.
  return <>{formatAgo(timestamp)}</>
}

export default function RecentRequestsPanel({
  requests,
  loading,
  liveConnected,
  onSelectRequest,
}: {
  requests: RecentRequestItem[]
  loading?: boolean
  liveConnected?: boolean
  onSelectRequest?: (req: RecentRequestItem) => void
}) {
  // One shared 30s timer re-renders every row's "x ago" label. Each row used
  // to run its own 1s setInterval, so a 20-row panel kept 20 timers ticking
  // every second; a 30s tick is plenty for labels whose finest unit is
  // seconds ("5s ago" only needs to move once a minute past 60s, and a
  // few-seconds staleness below that is invisible). Same shape as LogsPage's
  // single poller: one clock, many readers.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])
  return (
    <section
      className="x-panel flex h-[340px] sm:h-[460px] min-w-0 flex-col overflow-hidden"
      style={{ padding: '0.85rem 1rem' }}
    >
      <div className="mb-2 flex shrink-0 items-center justify-between gap-2 border-b border-border/60 pb-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Recent Requests
        </span>
        <span
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
          title={liveConnected ? 'Live SSE stream connected' : 'Polling fallback active'}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${liveConnected ? 'bg-emerald-400' : 'bg-amber-400'}`}
          />
          {liveConnected ? 'Live' : 'Polling'}
        </span>
      </div>

      {requests.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {loading ? 'Loading recent requests...' : 'No requests recorded yet.'}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm">
              <tr className="border-b border-border/60 text-left text-[11px] text-muted-foreground">
                <th className="w-3 py-1.5 pr-1 font-semibold" aria-label="Status" />
                <th className="py-1.5 font-semibold">Model</th>
                <th className="py-1.5 text-right font-semibold whitespace-nowrap">In / Out</th>
                <th className="py-1.5 text-right font-semibold whitespace-nowrap">Lat</th>
                <th className="py-1.5 text-right font-semibold">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {requests.slice(0, 20).map((r, idx) => {
                const ok = r.status === 'success' || r.status === 'ok'
                return (
                  <tr
                    key={r.id ?? `${r.timestamp}-${idx}`}
                    onClick={onSelectRequest ? () => onSelectRequest(r) : undefined}
                    className={`transition-colors hover:bg-muted/40 ${onSelectRequest ? 'cursor-pointer' : ''}`}
                    title={r.errorMessage ? `${r.model}: ${r.errorMessage}` : `${r.provider}/${r.model}`}
                  >
                    <td className="py-1.5 pr-1.5 align-top pt-2">
                      <span
                        className={`block h-2 w-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`}
                      />
                    </td>
                    <td className="max-w-[130px] py-1.5 align-top">
                      <div className="flex items-center gap-1">
                        <span className="truncate font-mono text-[11px]" title={r.model}>
                          {r.model || 'unknown'}
                        </span>
                        {r.fromPlayground && (
                          <span className="shrink-0 rounded bg-blue-500/15 px-1 text-[9px] font-medium text-blue-400">
                            PG
                          </span>
                        )}
                      </div>
                      {!ok && r.errorMessage && (
                        <div
                          className="mt-0.5 truncate text-[10px] text-red-400"
                          title={r.errorMessage}
                        >
                          {r.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="py-1.5 text-right align-top whitespace-nowrap tabular-nums">
                      <span className="text-blue-400">{fmtTok(r.promptTokens)}↑</span>{' '}
                      <span className="text-emerald-400">{fmtTok(r.completionTokens)}↓</span>
                    </td>
                    <td className="py-1.5 text-right align-top whitespace-nowrap text-muted-foreground tabular-nums">
                      {r.latencyMs != null ? `${r.latencyMs}ms` : '—'}
                    </td>
                    <td className="py-1.5 text-right align-top whitespace-nowrap text-muted-foreground">
                      <TimeAgo timestamp={r.timestamp} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
