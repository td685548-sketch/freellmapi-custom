/** One logged request (or failed attempt) of an account or client profile. */
export interface RecentRequest {
  id: number
  /** 'YYYY-MM-DD HH:MM:SS' UTC */
  createdAt: string
  status: 'success' | 'error' | 'canceled' | string
  platform: string
  modelId: string
  /** The model the caller pinned; null for automatic routing. */
  requestedModel: string | null
  latencyMs: number
  ttfbMs: number | null
  inputTokens: number
  outputTokens: number
  error: string | null
}

export interface RecentRequestsPage {
  requests: RecentRequest[]
  /** Pass as `before` to load the next (older) page; null when there is none. */
  nextBefore: number | null
}

/** One upstream attempt behind a request (the failover chain). */
export interface RequestAttempt {
  ordinal: number
  platform: string
  modelId: string
  keyLabel: string | null
  outcome: string
  durationMs: number
  error: string | null
}
