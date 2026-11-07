/** What a client key does with a request its content rules flag. */
export type ContentFilterMode = 'off' | 'log' | 'block'

/** Why a request was flagged. */
export type ContentFilterReason = 'too_long' | 'repeated' | 'prompt_injection' | 'keyword'

export interface ContentFilterSettings {
  mode: ContentFilterMode
  /** Longest latest user message, in characters; null = no limit. */
  maxInputChars: number | null
  /** Flag well-known attempts to override the instructions ("ignore previous instructions", ...). */
  blockInjection: boolean
  /** The same message from the same end user this many times in 10 minutes is flagged; null = off. */
  repeatLimit: number | null
  /** Words or phrases (case-insensitive) that flag a message. */
  keywords: string[]
}

export interface ContentFilterEvent {
  id: number
  reason: ContentFilterReason
  /** The matched keyword or rule. */
  detail: string
  action: 'blocked' | 'logged'
  endUser: string | null
  /** The start of the flagged message. */
  excerpt: string
  createdAt: string
}

export const CONTENT_FILTER_LIMITS = {
  minInputChars: 50,
  maxInputChars: 200_000,
  minRepeatLimit: 2,
  maxRepeatLimit: 100,
  repeatWindowMinutes: 10,
  maxKeywords: 200,
  maxKeywordLength: 100,
  excerptChars: 200,
  /** Events are kept this long. */
  eventRetentionDays: 30,
  eventListLimit: 100,
} as const
