import { useMemo, useState, useEffect, useCallback, useRef } from 'react'
import { AlertTriangle, Maximize2, Minus, Plus, RotateCcw, X } from 'lucide-react'
import { ThrulineLogo } from '../ThrulineLogo'

export type TopologyStatus = 'healthy' | 'degraded' | 'error' | 'cooldown' | 'paused'

export interface FailedModelInfo {
  model: string
  errorCount: number
  lastErrorMessage: string
  lastErrorAt: string
}

export interface LastErrorInfo {
  model: string
  message: string
  timestamp: string
  fromPlayground?: boolean
}

export interface TopologyNode {
  provider: string
  name: string
  status: TopologyStatus
  totalAccounts: number
  activeAccounts: number
  cooldownAccounts?: number
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  successRate: number
  avgLatencyMs: number
  errorCount?: number
  lastError?: LastErrorInfo | null
  failedModels?: FailedModelInfo[]
}

export interface ActiveRequestInfo {
  provider: string
  model?: string
  account?: string
}

const FE_ACTIVE_TIMEOUT_MS = 60_000
const FE_ACTIVE_TICK_MS = 1_000

const STATUS_COLOR: Record<TopologyStatus, string> = {
  healthy: '#10b981',
  degraded: '#f59e0b',
  error: '#ef4444',
  cooldown: '#f97316',
  paused: '#6b7280',
}

const STATUS_LABEL: Record<TopologyStatus, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  error: 'Error',
  cooldown: 'Cooldown',
  paused: 'Paused',
}

const fmtCount = (n: number) => {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const fmtRelativeTime = (iso: string) => {
  const ts = new Date(iso).getTime()
  if (Number.isNaN(ts)) return iso
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}

interface PositionedNode {
  node: TopologyNode
  x: number
  y: number
  cx: number
  cy: number
  w: number
  h: number
  sx: number
  sy: number
  tx: number
  ty: number
  c1x: number
  c1y: number
  c2x: number
  c2y: number
  path: string
}

const NODE_W = 168
const NODE_H = 44
const HUB_W = 132
const HUB_H = 46
const NODE_GAP = 22

function buildRadialLayout(nodes: TopologyNode[]) {
  const count = nodes.length
  if (count === 0) {
    return {
      items: [] as PositionedNode[],
      bounds: { minX: -HUB_W / 2, maxX: HUB_W / 2, minY: -HUB_H / 2, maxY: HUB_H / 2 },
    }
  }

  const minRx = ((NODE_W + NODE_GAP) * count) / (2 * Math.PI)
  const rx = Math.max(250, minRx)
  const ry = Math.max(155, rx * 0.56)

  let minX = -HUB_W / 2
  let maxX = HUB_W / 2
  let minY = -HUB_H / 2
  let maxY = HUB_H / 2

  const items: PositionedNode[] = nodes.map((node, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count
    const cx = rx * Math.cos(angle)
    const cy = ry * Math.sin(angle)
    const x = cx - NODE_W / 2
    const y = cy - NODE_H / 2

    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x + NODE_W)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y + NODE_H)

    // Pick closest anchor side on hub and target node
    let sx = 0
    let sy = 0
    let tx = cx
    let ty = cy
    let c1x = 0
    let c1y = 0
    let c2x = cx
    let c2y = cy

    const isTop = Math.abs(angle + Math.PI / 2) < Math.PI / 4 || Math.abs(angle - 1.5 * Math.PI) < Math.PI / 4
    const isBottom = Math.abs(angle - Math.PI / 2) < Math.PI / 4

    if (isTop) {
      sx = 0
      sy = -HUB_H / 2
      tx = cx
      ty = y + NODE_H
      const dy = (ty - sy) * 0.5
      c1x = sx
      c1y = sy + dy
      c2x = tx
      c2y = ty - dy
    } else if (isBottom) {
      sx = 0
      sy = HUB_H / 2
      tx = cx
      ty = y
      const dy = (ty - sy) * 0.5
      c1x = sx
      c1y = sy + dy
      c2x = tx
      c2y = ty - dy
    } else if (cx > 0) {
      sx = HUB_W / 2
      sy = 0
      tx = x
      ty = cy
      const dx = (tx - sx) * 0.5
      c1x = sx + dx
      c1y = sy
      c2x = tx - dx
      c2y = ty
    } else {
      sx = -HUB_W / 2
      sy = 0
      tx = x + NODE_W
      ty = cy
      const dx = (tx - sx) * 0.5
      c1x = sx + dx
      c1y = sy
      c2x = tx - dx
      c2y = ty
    }

    const path = `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`

    return { node, x, y, cx, cy, w: NODE_W, h: NODE_H, sx, sy, tx, ty, c1x, c1y, c2x, c2y, path }
  })

  return { items, bounds: { minX, maxX, minY, maxY } }
}

/** Compact 9Router-style radial/elliptical hub-and-spoke provider topology with pan/zoom & error inspection. */
export default function ProviderTopology({
  nodes,
  loading,
  activeRequests = [],
  lastProvider = '',
  errorProvider = '',
  onInspectRequests,
}: {
  nodes: TopologyNode[]
  loading?: boolean
  activeRequests?: ActiveRequestInfo[]
  lastProvider?: string
  errorProvider?: string
  onInspectRequests?: (provider: string, onlyErrors?: boolean) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 640, height: 420 })
  const [transform, setTransform] = useState({ x: 320, y: 210, scale: 1 })
  const [dragging, setDragging] = useState(false)
  const dragStartRef = useRef<{ px: number; py: number; tx: number; ty: number } | null>(null)
  const [selectedProviderKey, setSelectedProviderKey] = useState<string | null>(null)

  const activeKey = useMemo(
    () => activeRequests.map(r => r.provider?.toLowerCase()).filter(Boolean).sort().join(','),
    [activeRequests],
  )
  const rawActiveSet = useMemo(() => new Set(activeKey ? activeKey.split(',') : []), [activeKey])
  const lastSet = useMemo(() => new Set(lastProvider ? [lastProvider.toLowerCase()] : []), [lastProvider])
  const errorSet = useMemo(() => new Set(errorProvider ? [errorProvider.toLowerCase()] : []), [errorProvider])

  // Track firstSeen per active provider; drop if running longer than FE_ACTIVE_TIMEOUT_MS
  const firstSeenRef = useRef<Record<string, number>>({})
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const seen = firstSeenRef.current
    const now = Date.now()
    for (const p of rawActiveSet) {
      if (!seen[p]) seen[p] = now
    }
    for (const p of Object.keys(seen)) {
      if (!rawActiveSet.has(p)) delete seen[p]
    }
  }, [rawActiveSet])

  useEffect(() => {
    if (rawActiveSet.size === 0) return
    const id = setInterval(() => setTick(t => t + 1), FE_ACTIVE_TICK_MS)
    return () => clearInterval(id)
  }, [rawActiveSet])

  const activeSet = useMemo(() => {
    const now = Date.now()
    const filtered = new Set<string>()
    for (const p of rawActiveSet) {
      const ts = firstSeenRef.current[p]
      if (!ts || now - ts < FE_ACTIVE_TIMEOUT_MS) filtered.add(p)
    }
    return filtered
  }, [rawActiveSet, tick])

  const layout = useMemo(() => buildRadialLayout(nodes), [nodes])

  const fitView = useCallback(() => {
    const { width, height } = size
    if (width <= 0 || height <= 0) return
    const { minX, maxX, minY, maxY } = layout.bounds
    const bw = Math.max(1, maxX - minX)
    const bh = Math.max(1, maxY - minY)
    const pad = 48
    const scaleX = (width - pad * 2) / bw
    const scaleY = (height - pad * 2) / bh
    const scale = Math.max(0.25, Math.min(1.25, Math.min(scaleX, scaleY)))
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    setTransform({
      x: width / 2 - cx * scale,
      y: height / 2 - cy * scale,
      scale,
    })
  }, [layout.bounds, size])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const updateSize = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height })
      }
    }
    updateSize()
    const ro = new ResizeObserver(updateSize)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    fitView()
  }, [fitView, nodes.length])

  const handleZoom = (delta: number) => {
    setTransform(prev => {
      const nextScale = Math.max(0.2, Math.min(2.5, prev.scale * delta))
      const ratio = nextScale / prev.scale
      const cx = size.width / 2
      const cy = size.height / 2
      return {
        scale: nextScale,
        x: cx - (cx - prev.x) * ratio,
        y: cy - (cy - prev.y) * ratio,
      }
    })
  }

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if ((e.target as HTMLElement).closest('[data-topology-node]')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    dragStartRef.current = {
      px: e.clientX,
      py: e.clientY,
      tx: transform.x,
      ty: transform.y,
    }
  }

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const start = dragStartRef.current
    if (!dragging || !start) return
    const nextX = start.tx + (e.clientX - start.px)
    const nextY = start.ty + (e.clientY - start.py)
    setTransform(prev => ({
      ...prev,
      x: nextX,
      y: nextY,
    }))
  }

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging) return
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // ignore if not captured
    }
    setDragging(false)
    dragStartRef.current = null
  }

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.12 : 0.89
    setTransform(prev => {
      const nextScale = Math.max(0.2, Math.min(2.5, prev.scale * factor))
      const ratio = nextScale / prev.scale
      return {
        scale: nextScale,
        x: mx - (mx - prev.x) * ratio,
        y: my - (my - prev.y) * ratio,
      }
    })
  }

  const selectedNode = useMemo(
    () => (selectedProviderKey ? nodes.find(n => n.provider === selectedProviderKey) ?? null : null),
    [nodes, selectedProviderKey],
  )

  const activeCount = activeSet.size

  return (
    <section
      className="x-panel x-topology relative flex h-[340px] sm:h-[460px] min-w-0 flex-col overflow-hidden"
      style={{ padding: '0.85rem 1rem' }}
    >
      <style>{`
        @keyframes x-topo-ping { 0% { transform: scale(1); opacity: 0.75; } 75%, 100% { transform: scale(2); opacity: 0; } }
        .x-topo-ping { animation: x-topo-ping 1.2s cubic-bezier(0, 0, 0.2, 1) infinite; transform-box: fill-box; transform-origin: center; }
        @media (prefers-reduced-motion: reduce) {
          .x-topo-ping { animation: none; }
        }
      `}</style>

      {/* Header + Compact Legend */}
      <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>Provider Topology</h3>
          {activeCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/15 px-2 py-0.5 text-[11px] font-semibold text-cyan-400">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
              {activeCount} active
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2.5 text-[11px] text-muted-foreground">
          {(Object.keys(STATUS_COLOR) as TopologyStatus[]).map(st => (
            <span key={st} className="inline-flex items-center gap-1">
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLOR[st] }} />
              {STATUS_LABEL[st]}
            </span>
          ))}
        </div>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60 bg-black/5 dark:bg-white/[0.02]"
      >
        {nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {loading ? 'Loading topology...' : 'No providers connected yet.'}
          </div>
        ) : (
          <svg
            role="img"
            aria-label="Radial provider topology around Thruline core"
            width="100%"
            height="100%"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onDoubleClick={fitView}
            onWheel={handleWheel}
            style={{
              display: 'block',
              cursor: dragging ? 'grabbing' : 'grab',
              touchAction: 'none',
              userSelect: 'none',
            }}
          >
            {/* Subtle dot grid */}
            <defs>
              <pattern id="x-topo-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <circle cx="1.5" cy="1.5" r="1" fill="currentColor" fillOpacity="0.08" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#x-topo-grid)" />

            <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
              {/* Edges */}
              {layout.items.map(({ node, path }) => {
                const key = node.provider.toLowerCase()
                const isActive = activeSet.has(key)
                const hasError =
                  node.status === 'error' ||
                  (node.errorCount ?? 0) > 0 ||
                  (node.failedModels?.length ?? 0) > 0 ||
                  errorSet.has(key)
                const isLast = !isActive && !hasError && lastSet.has(key)

                if (isActive) {
                  return (
                    <g key={`edge-${node.provider}`}>
                      <path d={path} fill="none" stroke="#22d3ee" strokeWidth={8} strokeOpacity={0.28} strokeLinecap="round" />
                      <path d={path} fill="none" stroke="#4ade80" strokeWidth={3.5} strokeOpacity={0.85} strokeLinecap="round" />
                      <path d={path} fill="none" stroke="#f8fafc" strokeWidth={1.6} strokeOpacity={0.95} strokeLinecap="round" />
                      {[0, 1, 2, 3].map(pi => (
                        <circle
                          key={`p-${node.provider}-${pi}`}
                          r={pi % 2 === 0 ? 3.5 : 2.2}
                          fill={pi % 2 === 0 ? '#fde047' : '#67e8f9'}
                        >
                          <animateMotion
                            dur={`${0.55 + pi * 0.1}s`}
                            repeatCount="indefinite"
                            path={path}
                            begin={`${pi * 0.14}s`}
                          />
                        </circle>
                      ))}
                    </g>
                  )
                }

                const stroke = hasError
                  ? '#ef4444'
                  : isLast
                    ? '#f59e0b'
                    : node.status === 'cooldown'
                      ? '#f97316'
                      : node.status === 'degraded'
                        ? '#f59e0b'
                        : 'currentColor'
                const strokeOpacity = hasError
                  ? 0.9
                  : isLast
                    ? 0.75
                    : node.status === 'paused'
                      ? 0.18
                      : 0.25
                const strokeWidth = hasError ? 2.4 : isLast ? 2 : 1.25

                return (
                  <path
                    key={`edge-${node.provider}`}
                    d={path}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    strokeOpacity={strokeOpacity}
                    strokeDasharray={node.status === 'paused' ? '4 4' : undefined}
                  />
                )
              })}

              {/* Center Thruline Hub Node */}
              <g transform={`translate(${-HUB_W / 2}, ${-HUB_H / 2})`}>
                <rect
                  width={HUB_W}
                  height={HUB_H}
                  rx={12}
                  fill={activeCount > 0 ? 'rgba(34, 211, 238, 0.14)' : 'rgba(59, 130, 246, 0.12)'}
                  stroke={activeCount > 0 ? '#22d3ee' : '#3b82f6'}
                  strokeWidth={activeCount > 0 ? 2 : 1.5}
                />
                <foreignObject x={0} y={0} width={HUB_W} height={HUB_H}>
                  <div className="flex h-full w-full items-center justify-center gap-1.5 px-2">
                    <ThrulineLogo size={18} />
                    <span className="text-xs font-bold tracking-tight">Thruline</span>
                    {activeCount > 0 && (
                      <span className="rounded-full bg-amber-400 px-1.5 py-0.2 text-[10px] font-bold text-black">
                        {activeCount}
                      </span>
                    )}
                  </div>
                </foreignObject>
              </g>

              {/* Provider Nodes */}
              {layout.items.map(({ node, x, y, w, h }) => {
                const key = node.provider.toLowerCase()
                const isActive = activeSet.has(key)
                const errorBadgeCount = node.errorCount ?? node.failedModels?.reduce((s, m) => s + m.errorCount, 0) ?? 0
                const hasError =
                  node.status === 'error' ||
                  errorBadgeCount > 0 ||
                  (node.failedModels?.length ?? 0) > 0 ||
                  errorSet.has(key)
                const isLast = !isActive && !hasError && lastSet.has(key)
                const isSelected = selectedProviderKey === node.provider
                const statusColor = hasError ? '#ef4444' : STATUS_COLOR[node.status] ?? '#6b7280'
                const borderColor = isSelected
                  ? '#3b82f6'
                  : hasError
                    ? '#ef4444'
                    : isActive
                      ? '#22d3ee'
                      : isLast
                        ? '#f59e0b'
                        : 'rgba(148, 163, 184, 0.35)'

                return (
                  <g
                    key={`node-${node.provider}`}
                    data-topology-node={node.provider}
                    transform={`translate(${x}, ${y})`}
                    onClick={e => {
                      e.stopPropagation()
                      setSelectedProviderKey(prev => (prev === node.provider ? null : node.provider))
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <rect
                      width={w}
                      height={h}
                      rx={9}
                      fill={hasError ? 'rgba(239, 68, 68, 0.1)' : 'var(--bg-card, rgba(15, 23, 42, 0.72))'}
                      stroke={borderColor}
                      strokeWidth={isSelected || hasError || isActive ? 1.8 : 1.2}
                    />
                    <title>
                      {`${node.name} (${STATUS_LABEL[node.status]})\nAccounts: ${node.activeAccounts}/${node.totalAccounts}\nRequests: ${node.requests} | Tokens: ${fmtCount(node.totalTokens)}\nSuccess: ${node.successRate}% | Avg: ${node.avgLatencyMs}ms${
                        node.lastError ? `\nLast error (${node.lastError.model}): ${node.lastError.message}` : ''
                      }`}
                    </title>

                    <foreignObject x={0} y={0} width={w} height={h}>
                      <div className="flex h-full w-full items-center justify-between gap-1.5 px-2.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span
                            className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center"
                            aria-hidden="true"
                          >
                            {isActive && (
                              <span
                                className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping"
                                style={{ backgroundColor: '#22d3ee' }}
                              />
                            )}
                            <span
                              className="relative inline-flex h-2 w-2 rounded-full"
                              style={{ backgroundColor: isActive ? '#22d3ee' : statusColor }}
                            />
                          </span>
                          <div className="min-w-0">
                            <div className="truncate text-xs font-semibold leading-tight">{node.name}</div>
                            <div className="truncate text-[10px] leading-tight text-muted-foreground">
                              {node.activeAccounts}/{node.totalAccounts} · {fmtCount(node.requests)} req
                            </div>
                          </div>
                        </div>

                        {hasError ? (
                          <span
                            className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-bold text-red-400"
                            title={`${errorBadgeCount || 1} error(s)`}
                          >
                            <AlertTriangle size={10} />
                            {errorBadgeCount > 0 ? errorBadgeCount : '!'}
                          </span>
                        ) : (
                          <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                            {node.requests > 0 ? `${node.successRate}%` : '—'}
                          </span>
                        )}
                      </div>
                    </foreignObject>
                  </g>
                )
              })}
            </g>
          </svg>
        )}

        {/* Zoom / FitView Controls Toolbar */}
        {nodes.length > 0 && (
          <div className="absolute bottom-2.5 left-2.5 z-10 flex items-center gap-1 rounded-lg border border-border bg-background/90 p-1 shadow-sm backdrop-blur-sm">
            <button
              type="button"
              onClick={() => handleZoom(1.2)}
              title="Zoom in"
              aria-label="Zoom in"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Plus size={14} />
            </button>
            <button
              type="button"
              onClick={() => handleZoom(0.83)}
              title="Zoom out"
              aria-label="Zoom out"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Minus size={14} />
            </button>
            <button
              type="button"
              onClick={fitView}
              title="Fit view"
              aria-label="Fit view"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Maximize2 size={14} />
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedProviderKey(null)
                fitView()
              }}
              title="Reset view"
              aria-label="Reset view"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RotateCcw size={13} />
            </button>
          </div>
        )}

        {/* Selected Provider Inspection Popover */}
        {selectedNode && (
          <div
            className="absolute right-2.5 bottom-2.5 z-20 w-[min(320px,calc(100%-20px))] max-h-[calc(100%-20px)] overflow-y-auto rounded-lg border border-border bg-background/95 p-3 text-xs shadow-xl backdrop-blur-sm"
          >
            <div className="mb-2 flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-1.5 font-semibold text-sm">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: STATUS_COLOR[selectedNode.status] }}
                  />
                  {selectedNode.name}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {STATUS_LABEL[selectedNode.status]} · {selectedNode.activeAccounts}/{selectedNode.totalAccounts} accounts ·{' '}
                  {selectedNode.requests.toLocaleString()} req · {selectedNode.avgLatencyMs}ms avg
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedProviderKey(null)}
                aria-label="Close provider details"
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X size={14} />
              </button>
            </div>

            {selectedNode.lastError && (
              <div className="mb-2 rounded-md border border-red-500/40 bg-red-500/10 p-2">
                <div className="mb-0.5 flex items-center justify-between gap-1 font-semibold text-red-400">
                  <span className="truncate">Last Error · {selectedNode.lastError.model}</span>
                  {selectedNode.lastError.fromPlayground && (
                    <span className="shrink-0 rounded bg-red-500/20 px-1 py-0.2 text-[10px]">Playground</span>
                  )}
                </div>
                <div className="break-words text-[11px] text-red-200/90">{selectedNode.lastError.message}</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  {fmtRelativeTime(selectedNode.lastError.timestamp)}
                </div>
              </div>
            )}

            {selectedNode.failedModels && selectedNode.failedModels.length > 0 && (
              <div className="mb-2">
                <div className="mb-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                  Failing Models ({selectedNode.failedModels.length})
                </div>
                <div className="flex flex-col gap-1">
                  {selectedNode.failedModels.map(fm => (
                    <div key={fm.model} className="rounded border border-border/70 bg-muted/30 px-2 py-1">
                      <div className="flex items-center justify-between gap-2">
                        <code className="truncate font-mono text-[11px]">{fm.model}</code>
                        <span className="shrink-0 font-semibold text-red-400">{fm.errorCount} err</span>
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground" title={fm.lastErrorMessage}>
                        {fm.lastErrorMessage}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {onInspectRequests && (
              <button
                type="button"
                onClick={() => {
                  const hasErrors =
                    selectedNode.status === 'error' ||
                    (selectedNode.errorCount ?? 0) > 0 ||
                    (selectedNode.failedModels?.length ?? 0) > 0
                  onInspectRequests(selectedNode.provider, hasErrors)
                }}
                className="x-button w-full justify-center text-xs"
              >
                Filter Request Details
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
