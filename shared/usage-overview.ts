/** One row of the usage ranking: an account or a client profile over a time window. */

export type UsageSubjectKind = 'account' | 'profile'

export interface UsageRow {
  kind: UsageSubjectKind
  id: number
  /** Account email or profile name. */
  name: string
  /** Accounts only. */
  role?: 'admin' | 'member'
  /** Profiles only; a disabled profile's key is rejected. */
  enabled?: boolean
  requests: number
  success: number
  errors: number
  canceled: number
  inputTokens: number
  outputTokens: number
  /** Mean / 95th percentile latency of successful requests; null when there were none. */
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  lastRequestAt: string | null
  /** Per-minute request cap; null means unlimited (or no key yet for an account). */
  rpmLimit: number | null
  /** The same figures over the window of the same length just before this one. */
  previous: { requests: number; errors: number; tokens: number }
  /** The fullest daily / monthly allowance right now (share used, 0..1+); null when none is set. */
  allowance: { used: number; period: 'day' | 'month'; metric: 'requests' | 'tokens' } | null
}

export interface UsageOverview {
  kind: UsageSubjectKind
  days: number
  /** Window start, 'YYYY-MM-DD HH:MM:SS' UTC. */
  since: string
  /** Every account / profile, including idle ones, in no particular order. */
  rows: UsageRow[]
  /** When these figures were computed (they are reused for up to 30 seconds). */
  generatedAt: string
}
