import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

export type UsageViewMode = 'costs' | 'tokens'

export interface UsageValueSummary {
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  inputCost: number
  outputCost: number
  totalCost: number
  errors?: number
}

export interface UsageGroup<T> {
  groupKey: string
  label: ReactNode
  meta?: ReactNode
  summary: UsageValueSummary
  items: T[]
}

const fmtInt = (n: number) => new Intl.NumberFormat().format(Math.round(n || 0))
const fmtCost = (n: number) => {
  if (!n || n <= 0) return '$0.00'
  if (n < 0.0001) return `$${n.toFixed(6)}`
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

export function UsageViewModeToggle({
  value,
  onChange,
}: {
  value: UsageViewMode
  onChange: (next: UsageViewMode) => void
}) {
  return (
    <div className="inline-grid grid-cols-2 items-center gap-1 rounded-lg border border-border bg-black/5 dark:bg-white/5 p-0.5">
      <button
        type="button"
        onClick={() => onChange('costs')}
        className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
          value === 'costs' ? 'bg-blue-600 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        Costs
      </button>
      <button
        type="button"
        onClick={() => onChange('tokens')}
        className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
          value === 'tokens' ? 'bg-blue-600 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        Tokens
      </button>
    </div>
  )
}

function ValueCells({ item, viewMode }: { item: UsageValueSummary; viewMode: UsageViewMode }) {
  if (viewMode === 'tokens') {
    return (
      <>
        <td style={{ textAlign: 'right' }}>{fmtInt(item.promptTokens)}</td>
        <td style={{ textAlign: 'right' }}>{fmtInt(item.completionTokens)}</td>
        <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtInt(item.totalTokens)}</td>
      </>
    )
  }
  return (
    <>
      <td style={{ textAlign: 'right' }}>{fmtCost(item.inputCost)}</td>
      <td style={{ textAlign: 'right' }}>{fmtCost(item.outputCost)}</td>
      <td style={{ textAlign: 'right', fontWeight: 600, color: '#f59e0b' }}>{fmtCost(item.totalCost)}</td>
    </>
  )
}

export default function UsageTable<T extends UsageValueSummary>({
  groups,
  extraHeaders,
  renderDetailExtraCells,
  renderSummaryExtraCells,
  viewMode,
  storageKey,
  emptyMessage = 'No usage recorded for this range.',
  primaryHeader = 'Group',
}: {
  groups: UsageGroup<T>[]
  extraHeaders?: ReactNode
  renderDetailExtraCells?: (item: T) => ReactNode
  renderSummaryExtraCells?: (group: UsageGroup<T>) => ReactNode
  viewMode: UsageViewMode
  storageKey: string
  emptyMessage?: string
  primaryHeader?: string
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) return new Set(JSON.parse(saved) as string[])
    } catch {
      // ignore storage errors
    }
    return new Set()
  })

  // A different table re-reads its own stored expansion (render adjustment;
  // the initial key was already read by the useState initializer above).
  const [prevStorageKey, setPrevStorageKey] = useState(storageKey)
  if (storageKey !== prevStorageKey) {
    setPrevStorageKey(storageKey)
    try {
      const saved = localStorage.getItem(storageKey)
      setExpanded(saved ? new Set(JSON.parse(saved) as string[]) : new Set())
    } catch {
      setExpanded(new Set())
    }
  }

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...expanded]))
    } catch {
      // ignore storage errors
    }
  }, [expanded, storageKey])

  const toggleGroup = useCallback((groupKey: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  }, [])

  if (groups.length === 0) {
    return (
      <div className="x-empty">
        <p>{emptyMessage}</p>
      </div>
    )
  }

  return (
    <div className="x-table-wrap">
      <table className="x-table">
        <thead>
          <tr>
            <th>{primaryHeader}</th>
            {extraHeaders}
            <th style={{ textAlign: 'right' }}>Requests</th>
            {viewMode === 'tokens' ? (
              <>
                <th style={{ textAlign: 'right' }}>Input Tokens</th>
                <th style={{ textAlign: 'right' }}>Output Tokens</th>
                <th style={{ textAlign: 'right' }}>Total Tokens</th>
              </>
            ) : (
              <>
                <th style={{ textAlign: 'right' }}>Input Cost</th>
                <th style={{ textAlign: 'right' }}>Output Cost</th>
                <th style={{ textAlign: 'right' }}>Total Cost</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {groups.map(group => {
            const isOpen = expanded.has(group.groupKey)
            return (
              <Fragment key={group.groupKey}>
                <tr
                  onClick={() => toggleGroup(group.groupKey)}
                  style={{ cursor: 'pointer' }}
                  className="hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
                >
                  <th>
                    <div className="flex items-center gap-1.5">
                      <ChevronRight
                        size={15}
                        className={`shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      />
                      <span>{group.label}</span>
                      <span className="rounded bg-black/10 dark:bg-white/10 px-1.5 py-0.2 text-[10px] font-normal text-muted-foreground">
                        {group.items.length}
                      </span>
                    </div>
                  </th>
                  {renderSummaryExtraCells ? renderSummaryExtraCells(group) : null}
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtInt(group.summary.requests)}</td>
                  <ValueCells item={group.summary} viewMode={viewMode} />
                </tr>
                {isOpen &&
                  group.items.map((item, idx) => (
                    <tr
                      key={`${group.groupKey}-${idx}`}
                      className="bg-black/[0.015] dark:bg-white/[0.015]"
                    >
                      <td style={{ paddingLeft: '2rem' }} className="text-muted-foreground">
                        —
                      </td>
                      {renderDetailExtraCells ? renderDetailExtraCells(item) : null}
                      <td style={{ textAlign: 'right' }}>{fmtInt(item.requests)}</td>
                      <ValueCells item={item} viewMode={viewMode} />
                    </tr>
                  ))}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
