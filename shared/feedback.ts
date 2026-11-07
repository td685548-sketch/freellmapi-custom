/** Visitors' votes on a client key's replies over a window. */
export interface FeedbackSummary {
  days: number
  up: number
  down: number
  /** Per model the web app reported (null = not reported), most votes first. */
  byModel: Array<{ model: string | null; up: number; down: number }>
  /** Per UTC day, oldest first. */
  byDay: Array<{ day: string; up: number; down: number }>
}

export interface FeedbackComment {
  id: number
  rating: 'up' | 'down'
  comment: string
  model: string | null
  endUser: string | null
  conversationId: string | null
  createdAt: string
}

export const FEEDBACK_LIMITS = {
  maxComment: 1_000,
  maxModel: 200,
  maxReference: 200,
  retentionDays: 365,
  commentListLimit: 100,
} as const
