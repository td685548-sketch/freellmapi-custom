import { useMemo } from 'react'

export type TopologyStatus = 'healthy' | 'degraded' | 'cooldown' | 'paused'

export interface TopologyNode {
  provider: string
  name: string
  status: TopologyStatus
  totalAccounts: number
  activeAccounts: number
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  successRate: number
  avgLatencyMs: number
}

const STATUS_COLOR: Record<TopologyStatus, string> = {
  healthy: '#10b981',
  degraded: '#f59e0b',
  cooldown: '#ef4444',
  paused: '#6b7280',
}

const STATUS_LABEL: Record<TopologyStatus, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  cooldown: 'Cooldown',
  paused: 'Paused',
}

const fmtCount = (n: number) => {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const WIDTH = 900
const NODE_W = 210
const NODE_H = 62
const ROW_GAP = 14
const CLIENT_X = 20
const CLIENT_W = 130
const CORE_X = 330
const CORE_W = 150
const PROVIDER_X = WIDTH - NODE_W - 20

/** Hub-and-spoke view: AI clients -> X Gateway core -> active providers. */
export default function ProviderTopology({
  nodes,
  loading,
}: {
  nodes: TopologyNode[]
  loading?: boolean
}) {
  const layout = useMemo(() => {
    const rows = Math.max(nodes.length, 1)
    const height = Math.max(rows * (NODE_H + ROW_GAP) + ROW_GAP, 200)
    const centerY = height / 2
    const startY = (height - (rows * (NODE_H + ROW_GAP) - ROW_GAP)) / 2
    const maxRequests = Math.max(1, ...nodes.map(n => n.requests))
    return {
      height,
      centerY,
      items: nodes.map((node, i) => {
        const y = startY + i * (NODE_H + ROW_GAP)
        return { node, y, cy: y + NODE_H / 2, weight: node.requests / maxRequests }
      }),
    }
  }, [nodes])

  const coreRightX = CORE_X + CORE_W
  const clientRightX = CLIENT_X + CLIENT_W

  return (
    <section className="x-panel x-topology" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
      <style>{`
        @keyframes x-topology-flow { to { stroke-dashoffset: -24; } }
        @keyframes x-topology-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
        .x-topology-flow { animation: x-topology-flow 1.2s linear infinite; }
        .x-topology-dot-live { animation: x-topology-pulse 1.8s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .x-topology-flow, .x-topology-dot-live { animation: none; }
        }
      `}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>Provider Topology</h3>
        <div style={{ display: 'flex', gap: '0.9rem', fontSize: '0.75rem' }}>
          {(Object.keys(STATUS_COLOR) as TopologyStatus[]).map(st => (
            <span key={st} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[st] }} />
              {STATUS_LABEL[st]}
            </span>
          ))}
        </div>
      </div>

      {nodes.length === 0 ? (
        <div className="x-empty">
          <p>{loading ? 'Loading topology...' : 'No providers connected yet.'}</p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <svg
            role="img"
            aria-label="Provider topology: AI clients to X Gateway core to active providers"
            viewBox={`0 0 ${WIDTH} ${layout.height}`}
            style={{ width: '100%', minWidth: 640, height: 'auto', display: 'block' }}
          >
            {/* client -> core */}
            <path
              d={`M ${clientRightX} ${layout.centerY} L ${CORE_X} ${layout.centerY}`}
              stroke="#3b82f6"
              strokeWidth={2.5}
              fill="none"
              strokeDasharray="8 4"
              className="x-topology-flow"
            />

            {/* core -> providers */}
            {layout.items.map(({ node, cy, weight }) => {
              const color = STATUS_COLOR[node.status]
              const live = node.status === 'healthy' || node.status === 'degraded'
              const midX = (coreRightX + PROVIDER_X) / 2
              return (
                <path
                  key={`edge-${node.provider}`}
                  d={`M ${coreRightX} ${layout.centerY} C ${midX} ${layout.centerY}, ${midX} ${cy}, ${PROVIDER_X} ${cy}`}
                  stroke={color}
                  strokeWidth={1.5 + weight * 3}
                  strokeOpacity={node.status === 'paused' ? 0.35 : 0.85}
                  fill="none"
                  strokeDasharray={live ? '8 4' : '3 5'}
                  className={live ? 'x-topology-flow' : undefined}
                />
              )
            })}

            {/* AI clients */}
            <g>
              <rect
                x={CLIENT_X} y={layout.centerY - 32} width={CLIENT_W} height={64} rx={12}
                fill="rgba(59,130,246,0.12)" stroke="#3b82f6"
              />
              <text x={CLIENT_X + CLIENT_W / 2} y={layout.centerY - 3} textAnchor="middle" fontSize={14} fontWeight={600} fill="currentColor">
                AI Clients
              </text>
              <text x={CLIENT_X + CLIENT_W / 2} y={layout.centerY + 16} textAnchor="middle" fontSize={10.5} fill="currentColor" opacity={0.65}>
                /x/v1 API keys
              </text>
            </g>

            {/* X Gateway core */}
            <g>
              <rect
                x={CORE_X} y={layout.centerY - 40} width={CORE_W} height={80} rx={16}
                fill="rgba(16,185,129,0.14)" stroke="#10b981" strokeWidth={2}
              />
              <text x={CORE_X + CORE_W / 2} y={layout.centerY - 4} textAnchor="middle" fontSize={15} fontWeight={700} fill="currentColor">
                X Gateway
              </text>
              <text x={CORE_X + CORE_W / 2} y={layout.centerY + 16} textAnchor="middle" fontSize={10.5} fill="currentColor" opacity={0.65}>
                {nodes.length} provider{nodes.length === 1 ? '' : 's'}
              </text>
            </g>

            {/* providers */}
            {layout.items.map(({ node, y }) => {
              const color = STATUS_COLOR[node.status]
              return (
                <g key={node.provider}>
                  <title>
                    {`${node.name} - ${STATUS_LABEL[node.status]}: ${node.requests} requests, ${fmtCount(node.totalTokens)} tokens (${fmtCount(node.promptTokens)} in / ${fmtCount(node.completionTokens)} out), ${node.successRate}% success, ${node.avgLatencyMs} ms avg`}
                  </title>
                  <rect
                    x={PROVIDER_X} y={y} width={NODE_W} height={NODE_H} rx={10}
                    fill="rgba(127,127,127,0.08)" stroke={color} strokeOpacity={0.8}
                  />
                  <circle
                    cx={PROVIDER_X + 16} cy={y + 18} r={5} fill={color}
                    className={node.status === 'healthy' ? 'x-topology-dot-live' : undefined}
                  />
                  <text x={PROVIDER_X + 28} y={y + 22} fontSize={12.5} fontWeight={600} fill="currentColor">
                    {node.name.length > 22 ? `${node.name.slice(0, 21)}...` : node.name}
                  </text>
                  <text x={PROVIDER_X + NODE_W - 10} y={y + 22} textAnchor="end" fontSize={10} fill={color}>
                    {STATUS_LABEL[node.status]}
                  </text>
                  <text x={PROVIDER_X + 12} y={y + 41} fontSize={10.5} fill="currentColor" opacity={0.75}>
                    {`${node.activeAccounts}/${node.totalAccounts} accounts active`}
                  </text>
                  <text x={PROVIDER_X + 12} y={y + 55} fontSize={10.5} fill="currentColor" opacity={0.75}>
                    {`${fmtCount(node.requests)} req - ${node.avgLatencyMs} ms avg - ${node.successRate}%`}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>
      )}
    </section>
  )
}
