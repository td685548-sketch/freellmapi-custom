/** The allowance every end user of one client key gets (null = unlimited). */
export interface EndUserQuota {
  dailyRequests: number | null
  dailyTokens: number | null
  monthlyRequests: number | null
  monthlyTokens: number | null
}

/** One end user of a client key over a window. */
export interface EndUserRow {
  endUser: string
  requests: number
  success: number
  errors: number
  tokens: number
  avgLatencyMs: number | null
  lastRequestAt: string | null
  /** Used of today's / this month's allowance; null when the key has no per-end-user allowance. */
  today: { requests: number; tokens: number } | null
  month: { requests: number; tokens: number } | null
}

export interface EndUserOverview {
  days: number
  /** Busiest first, at most 500. */
  endUsers: EndUserRow[]
  /** Requests of the window that named no end user (the web app is not sending one). */
  unattributedRequests: number
  quota: EndUserQuota
}
