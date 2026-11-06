/** Per-account usage analytics contract (admin view and "my usage"). */

export interface UserAnalyticsTotals {
  requests: number
  success: number
  errors: number
  canceled: number
  inputTokens: number
  outputTokens: number
  /** Mean latency of successful requests; null when there were none. */
  avgLatencyMs: number | null
  lastRequestAt: string | null
}

export interface UserAnalyticsDay {
  /** UTC calendar day, YYYY-MM-DD. Days without traffic are present with zeros. */
  date: string
  requests: number
  errors: number
  tokens: number
}

export interface UserAnalyticsModel {
  platform: string
  modelId: string
  requests: number
  errors: number
  tokens: number
}

export interface UserAnalytics {
  userId: number
  email: string
  days: number
  /** Window start, 'YYYY-MM-DD HH:MM:SS' UTC. */
  since: string
  totals: UserAnalyticsTotals
  daily: UserAnalyticsDay[]
  /** Busiest first, at most 10. */
  models: UserAnalyticsModel[]
  /** Oldest attributed row still retained; older traffic was pruned or predates attribution. */
  retainedSince: string | null
}
