/** Daily / monthly allowances of an account or a client profile (null = unlimited). */

export interface UsageQuota {
  dailyRequests: number | null
  dailyTokens: number | null
  monthlyRequests: number | null
  monthlyTokens: number | null
}

export interface UsageAmount {
  requests: number
  tokens: number
}

export interface UsageQuotaState {
  quota: UsageQuota
  /** False when no limit is set: usage is then not tracked here at all. */
  tracked: boolean
  /** What has been used in the current UTC day / month. Zeros when not tracked. */
  usage: { day: UsageAmount; month: UsageAmount }
  /** When each window resets, ISO 8601 UTC. */
  resetsAt: { day: string; month: string }
}
