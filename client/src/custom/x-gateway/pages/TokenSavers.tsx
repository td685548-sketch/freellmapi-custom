import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { Activity, Cpu, Feather, FileCode2, Save, Scissors, Sparkles, TrendingDown } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useUserSession } from '../../use-session'
import { useSessionRevision } from '../../session-state'
import { useXStrings } from '../strings'

const levels = ['off', 'lite', 'full', 'ultra'] as const
type Level = typeof levels[number]
type Settings = { caveman: Level; ponytail: Level }

interface RtkResponse {
  enabled: boolean
  stats: {
    totalCompressions: number
    bytesBefore: number
    bytesAfter: number
    tokensSavedEst: number
    filterHits: Record<string, number>
  }
}

interface PxpipeResponse {
  enabled: boolean
  minChars: number
}

interface PxpipeTimelineEntry {
  date: string
  tokensSavedEst: number
  originalTokens: number
  compressedTokens: number
}

interface PxpipeWindowStats {
  requests: number
  compressed: number
  bypassed: number
  tokensBeforeEst: number
  tokensAfterEst: number
  tokensSavedEst: number
  savedPct: number
  imagesGenerated: number
  avgCompressionMs: number
  errors: number
}

interface PxpipeStatsResponse {
  windows: Record<string, PxpipeWindowStats>
  timeline: PxpipeTimelineEntry[]
  recentLogs: Array<unknown>
  config: {
    enabled: boolean
    minChars: number
  }
}

const fmtTokens = (n: number) => {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

export default function TokenSavers() {
  const s = useXStrings()
  const client = useQueryClient()
  const revision = useSessionRevision()
  const session = useUserSession()
  const canEdit = session.hasPermission('manage_compression')

  // Existing output savers query
  const query = useQuery({
    queryKey: ['x-output-savers', revision],
    queryFn: ({ signal }) => apiFetch<Settings>('/api/savers', { signal }),
    retry: false,
  })

  // RTK status query
  const rtkQuery = useQuery({
    queryKey: ['x-rtk-settings', revision],
    queryFn: ({ signal }) => apiFetch<RtkResponse>('/api/savers/rtk', { signal }),
    retry: false,
  })

  // pxpipe settings query
  const pxpipeQuery = useQuery({
    queryKey: ['x-pxpipe-settings', revision],
    queryFn: ({ signal }) => apiFetch<PxpipeResponse>('/api/savers/pxpipe', { signal }),
    retry: false,
  })

  // pxpipe stats query
  const statsQuery = useQuery({
    queryKey: ['x-pxpipe-stats', revision],
    queryFn: ({ signal }) => apiFetch<PxpipeStatsResponse>('/api/savers/pxpipe/stats', { signal }),
    refetchInterval: 15_000,
    retry: false,
  })

  const [draft, setDraft] = useState<Settings | null>(null)
  const [selectedWindow, setSelectedWindow] = useState<'today' | 'last7d' | 'last30d' | 'all'>('last7d')
  const [pxpipeMinCharsDraft, setPxpipeMinCharsDraft] = useState<number | null>(null)

  const mutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: (value: Settings) => apiFetch<Settings>('/api/savers', { method: 'PUT', body: JSON.stringify(value) }),
    onSuccess: async () => {
      setDraft(null)
      await client.invalidateQueries({ queryKey: ['x-output-savers'] })
    },
  })

  const rtkMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: (enabled: boolean) => apiFetch<{ enabled: boolean }>('/api/savers/rtk', { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['x-rtk-settings'] })
    },
  })

  const pxpipeMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: (params: { enabled?: boolean; minChars?: number }) =>
      apiFetch<PxpipeResponse>('/api/savers/pxpipe', { method: 'PUT', body: JSON.stringify(params) }),
    onSuccess: async () => {
      setPxpipeMinCharsDraft(null)
      await client.invalidateQueries({ queryKey: ['x-pxpipe-settings'] })
      await client.invalidateQueries({ queryKey: ['x-pxpipe-stats'] })
    },
  })

  const value = draft ?? query.data
  const rtkData = rtkQuery.data
  const pxpipeData = pxpipeQuery.data
  const statsData = statsQuery.data

  const currentWindowStats = statsData?.windows?.[selectedWindow]
  const timeline = statsData?.timeline ?? []
  const hasTimelineData = timeline.some(d => d.tokensSavedEst > 0)

  return (
    <>
      <div className="x-page-heading">
        <div>
          <h1>{s.savers}</h1>
          <p>{s.saverHelp}</p>
        </div>
        <span className="x-heading-icon"><Scissors size={28} /></span>
      </div>

      <p className="x-notice">{s.saverScope}</p>

      {query.isPending && <p role="status">{s.loading}</p>}
      {query.isError && (
        <div className="x-error" role="alert">
          {s.saverError}
          <button className="x-button" onClick={() => void query.refetch()}>{s.retry}</button>
        </div>
      )}

      {/* Output Savers (Caveman & Ponytail) */}
      {value && (
        <form onSubmit={event => { event.preventDefault(); mutation.mutate(value) }}>
          <div className="x-saver-grid">
            {(['caveman', 'ponytail'] as const).map(name => (
              <section className="x-panel x-saver" key={name}>
                <span className="x-dialog-icon">
                  {name === 'caveman' ? <Scissors size={24} /> : <Feather size={24} />}
                </span>
                <h2>{s[name]}</h2>
                <p>{name === 'caveman' ? s.cavemanHelp : s.ponytailHelp}</p>
                <fieldset disabled={!canEdit || mutation.isPending}>
                  <legend className="x-sr-only">{s[name]}</legend>
                  <div className="x-saver-levels">
                    {levels.map(level => (
                      <label key={level} className={value[name] === level ? 'selected' : ''}>
                        <input
                          type="radio"
                          name={name}
                          checked={value[name] === level}
                          onChange={() => {
                            setDraft({ ...value, [name]: level })
                            mutation.reset()
                          }}
                        />
                        {s[level]}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </section>
            ))}
          </div>

          <p className="x-footnote">{s.saverCost}</p>
          {mutation.isError && <div role="alert" className="x-error">{mutation.error.message}</div>}
          {mutation.isSuccess && <p role="status" className="x-test-ok">{s.settingsSaved}</p>}

          {canEdit ? (
            <button className="x-button x-primary" disabled={!draft || mutation.isPending}>
              <Save size={16} />{mutation.isPending ? s.saving : s.save}
            </button>
          ) : (
            <p className="x-caption">{s.readOnly}</p>
          )}
        </form>
      )}

      {/* Advanced Token Compression Suite: RTK & pxpipe */}
      <div style={{ marginTop: '2.5rem' }}>
        <div className="x-page-heading" style={{ marginBottom: '1rem' }}>
          <div>
            <h2>Token Compression Suite</h2>
            <p>Runtime Tool-Result Compressor & Prompt Density Pipeline (RTK + pxpipe)</p>
          </div>
          <span className="x-heading-icon"><Sparkles size={24} /></span>
        </div>

        <div className="x-saver-grid">
          {/* RTK Card */}
          <section className="x-panel x-saver">
            <span className="x-dialog-icon"><Cpu size={24} /></span>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <h2>{s.rtk}</h2>
              <button
                type="button"
                className="x-switch"
                role="switch"
                aria-checked={rtkData?.enabled ?? true}
                disabled={!canEdit || rtkMutation.isPending}
                onClick={() => rtkMutation.mutate(!(rtkData?.enabled ?? true))}
              >
                <span />
              </button>
            </div>
            <p>{s.rtkHelp}</p>
            <div style={{ marginTop: '0.75rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
              <span>Trạng thái: </span>
              <strong style={{ color: rtkData?.enabled ? '#10b981' : 'inherit' }}>
                {rtkData?.enabled ? s.active : s.paused}
              </strong>
              {rtkData?.stats && (
                <div style={{ marginTop: '0.5rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                  <span>Số lần nén: <strong>{rtkData.stats.totalCompressions}</strong></span>
                  <span>Ước tính tiết kiệm: <strong style={{ color: '#10b981' }}>{fmtTokens(rtkData.stats.tokensSavedEst)} tokens</strong></span>
                </div>
              )}
            </div>
          </section>

          {/* pxpipe Card */}
          <section className="x-panel x-saver">
            <span className="x-dialog-icon"><FileCode2 size={24} /></span>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <h2>{s.pxpipe}</h2>
              <button
                type="button"
                className="x-switch"
                role="switch"
                aria-checked={pxpipeData?.enabled ?? false}
                disabled={!canEdit || pxpipeMutation.isPending}
                onClick={() => pxpipeMutation.mutate({ enabled: !(pxpipeData?.enabled ?? false) })}
              >
                <span />
              </button>
            </div>
            <p>{s.pxpipeHelp}</p>

            <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label style={{ fontSize: '0.8125rem', fontWeight: 500 }}>
                {s.pxpipeMinChars}:
              </label>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input
                  type="number"
                  min="5000"
                  max="100000"
                  step="1000"
                  style={{
                    padding: '0.375rem 0.5rem',
                    borderRadius: '6px',
                    border: '1px solid var(--border)',
                    backgroundColor: 'var(--bg-subtle, rgba(0,0,0,0.05))',
                    width: '120px',
                    fontSize: '0.875rem',
                  }}
                  value={pxpipeMinCharsDraft ?? pxpipeData?.minChars ?? 25000}
                  disabled={!canEdit || pxpipeMutation.isPending}
                  onChange={e => setPxpipeMinCharsDraft(Number(e.target.value))}
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>ký tự (&gt; 25k)</span>
                {pxpipeMinCharsDraft !== null && pxpipeMinCharsDraft !== pxpipeData?.minChars && (
                  <button
                    type="button"
                    className="x-button x-small x-primary"
                    disabled={!canEdit || pxpipeMutation.isPending}
                    onClick={() => pxpipeMutation.mutate({ minChars: pxpipeMinCharsDraft })}
                  >
                    {s.save}
                  </button>
                )}
              </div>
              <small style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {s.pxpipeThresholdHelp}
              </small>
            </div>
          </section>
        </div>

        {/* Token Savings AreaChart & Metrics Dashboard */}
        <section className="x-panel" style={{ marginTop: '1.5rem', padding: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Activity size={20} color="#10b981" />
              <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>{s.tokenSavingsStats}</h3>
            </div>
            {/* Window tabs */}
            <div style={{ display: 'flex', gap: '0.25rem', background: 'var(--bg-subtle, rgba(0,0,0,0.05))', padding: '0.25rem', borderRadius: '8px' }}>
              {(['today', 'last7d', 'last30d', 'all'] as const).map(wId => (
                <button
                  key={wId}
                  type="button"
                  onClick={() => setSelectedWindow(wId)}
                  style={{
                    padding: '0.25rem 0.65rem',
                    borderRadius: '6px',
                    fontSize: '0.75rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                    border: 'none',
                    background: selectedWindow === wId ? '#10b981' : 'transparent',
                    color: selectedWindow === wId ? '#fff' : 'inherit',
                  }}
                >
                  {wId === 'today' ? s.today : wId === 'last7d' ? s.days7 : wId === 'last30d' ? s.days30 : s.allTime}
                </button>
              ))}
            </div>
          </div>

          {/* Metric cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
            <div className="x-panel" style={{ padding: '0.75rem', textAlign: 'center' }}>
              <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>{s.originalTokens}</p>
              <h4 style={{ margin: '0.25rem 0 0', fontSize: '1.2rem', fontWeight: 600 }}>
                {fmtTokens(currentWindowStats?.tokensBeforeEst ?? 0)}
              </h4>
            </div>
            <div className="x-panel" style={{ padding: '0.75rem', textAlign: 'center' }}>
              <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>{s.afterCompression}</p>
              <h4 style={{ margin: '0.25rem 0 0', fontSize: '1.2rem', fontWeight: 600 }}>
                {fmtTokens(currentWindowStats?.tokensAfterEst ?? 0)}
              </h4>
            </div>
            <div className="x-panel" style={{ padding: '0.75rem', textAlign: 'center' }}>
              <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>{s.tokensSaved}</p>
              <h4 style={{ margin: '0.25rem 0 0', fontSize: '1.2rem', fontWeight: 600, color: '#10b981' }}>
                {fmtTokens(currentWindowStats?.tokensSavedEst ?? 0)}
              </h4>
            </div>
            <div className="x-panel" style={{ padding: '0.75rem', textAlign: 'center' }}>
              <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>{s.reductionRate}</p>
              <h4 style={{ margin: '0.25rem 0 0', fontSize: '1.2rem', fontWeight: 600, color: '#10b981', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.25rem' }}>
                <TrendingDown size={16} />
                {currentWindowStats?.savedPct ?? 0}%
              </h4>
            </div>
          </div>

          {/* AreaChart */}
          <div style={{ width: '100%', height: 220 }}>
            {hasTimelineData ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timeline} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradTokensSaved" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={d => String(d).slice(5)} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtTokens} width={45} />
                  <Tooltip
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    formatter={(v: any) => [fmtTokens(Number(v) || 0), s.tokensSaved] as [string, string]}
                    labelFormatter={d => String(d)}
                  />
                  <Area
                    type="monotone"
                    dataKey="tokensSavedEst"
                    stroke="#10b981"
                    strokeWidth={2}
                    fill="url(#gradTokensSaved)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                {s.noSavingsRecorded}
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  )
}
