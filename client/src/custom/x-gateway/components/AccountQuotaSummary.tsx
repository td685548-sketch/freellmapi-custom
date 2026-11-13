import { RefreshCw } from 'lucide-react'
import { useI18n } from '@/i18n'
import type { XAccountQuota, XQuotaWindow } from '../../../../../shared/x-quota'
import { quotaCountdown } from '../quota-format'

function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1)
}

export function formatWindowLabel(w: XQuotaWindow): string {
  const map: Record<string, string> = {
    CREDIT: 'Credits',
    CREDIT_freetrial: 'Free Trial',
    AGENTIC_REQUEST: 'Agentic Credits',
    AGENTIC_REQUEST_freetrial: 'Free Trial',
    five_hour: '5h Session',
    seven_day: '7d Weekly',
    seven_day_opus: 'Opus Weekly',
    seven_day_sonnet: 'Sonnet Weekly',
    primary_window: 'Primary Window',
    secondary_window: 'Secondary Window',
    chat: 'Chat',
    completions: 'Completions',
    premium_interactions: 'Premium',
    credits: 'Credits',
    requests: 'Requests',
    tokens: 'Tokens',
  }
  const base = map[w.id] ?? w.id
  return w.modelId ? `${base} · ${w.modelId}` : base
}

export function windowColor(pct: number | null): string {
  if (pct == null) return '#64748b'
  if (pct > 70) return '#10b981'
  if (pct >= 30) return '#f59e0b'
  return '#ef4444'
}

export function formatWindowValue(w: XQuotaWindow): string {
  if (w.remaining == null && w.limit == null) return '—'
  if (w.unit === '%' && w.remaining != null) {
    return `${Math.round(w.remaining)}%`
  }
  if (w.unit === 'USD') {
    if (w.remaining != null && w.limit != null) return `$${w.remaining.toFixed(2)} / $${w.limit.toFixed(2)}`
    if (w.remaining != null) return `$${w.remaining.toFixed(2)}`
  }
  if (w.remaining != null && w.limit != null) {
    return `${formatCompact(w.remaining)} / ${formatCompact(w.limit)} ${w.unit}`
  }
  if (w.remaining != null) {
    return `${formatCompact(w.remaining)} ${w.unit}`
  }
  return `— / ${formatCompact(w.limit!)} ${w.unit}`
}

interface Props {
  quota?: XAccountQuota
  now?: number
  onRefresh?: () => void
  refreshing?: boolean
  compact?: boolean
}

export default function AccountQuotaSummary({
  quota,
  now = Date.now(),
  onRefresh,
  refreshing = false,
  compact = false,
}: Props) {
  const { locale } = useI18n()
  const vi = locale === 'vi'

  if (!quota) {
    return <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>—</span>
  }

  if (!quota.windows.length) {
    if (!quota.supported) {
      return (
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          {vi ? 'Theo dõi cục bộ' : 'Local tracking'}
        </span>
      )
    }
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.75rem', color: quota.error ? '#ef4444' : 'var(--text-muted)' }}>
          {quota.error ? (vi ? 'Lỗi đo quota' : 'Quota error') : (vi ? 'Chưa đo quota' : 'Not checked')}
        </span>
        {onRefresh && (
          <button
            type="button"
            className="x-button x-small"
            disabled={refreshing || !quota.enabled}
            onClick={onRefresh}
            style={{ padding: '0.15rem 0.45rem', fontSize: '0.72rem' }}
          >
            <RefreshCw size={11} className={refreshing ? 'x-spin' : undefined} />
            {vi ? 'Đo ngay' : 'Check'}
          </button>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? '0.35rem' : '0.45rem', minWidth: compact ? '170px' : undefined }}>
      {quota.windows.map(w => {
        const pct = w.limit != null && w.limit > 0 && w.remaining != null
          ? Math.max(0, Math.min(100, (w.remaining / w.limit) * 100))
          : null
        const color = windowColor(pct)
        const countdown = quotaCountdown(w.resetAt, now)
        return (
          <div key={`${w.id}:${w.modelId ?? ''}`} style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', fontSize: '0.75rem' }}>
              <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{formatWindowLabel(w)}</span>
              <span
                style={{ fontWeight: 600, color, whiteSpace: 'nowrap' }}
                title={w.limit != null && w.remaining != null ? `${w.remaining.toLocaleString()} / ${w.limit.toLocaleString()} ${w.unit}` : undefined}
              >
                {formatWindowValue(w)}
                {pct != null && w.unit !== '%' ? ` (${Math.round(pct)}%)` : ''}
              </span>
            </div>
            {pct != null && (
              <div
                role="progressbar"
                aria-label={`${formatWindowLabel(w)} remaining`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pct)}
                style={{
                  height: '5px',
                  borderRadius: '999px',
                  backgroundColor: 'var(--bg-subtle, rgba(128,128,128,0.18))',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: '100%',
                    backgroundColor: color,
                    transition: 'width 0.25s ease',
                  }}
                />
              </div>
            )}
            {countdown && (
              <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                {countdown === 'reset'
                  ? (vi ? 'Đã đến giờ reset' : 'Reset due')
                  : `${vi ? 'Reset sau' : 'Resets in'} ${countdown}`}
              </span>
            )}
          </div>
        )
      })}
      {onRefresh && quota.supported && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.4rem' }}>
          {quota.error ? <small style={{ color: '#ef4444', fontSize: '0.68rem' }}>{quota.error}</small> : <span />}
          <button
            type="button"
            className="x-button x-small"
            disabled={refreshing || !quota.enabled}
            onClick={onRefresh}
            title={vi ? 'Cập nhật quota' : 'Refresh quota'}
            style={{ padding: '0.1rem 0.4rem', fontSize: '0.7rem' }}
          >
            <RefreshCw size={11} className={refreshing ? 'x-spin' : undefined} />
          </button>
        </div>
      )}
    </div>
  )
}
