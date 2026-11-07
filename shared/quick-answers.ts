/** A ready answer of a client key: sent at once, without an AI call, when the visitor's message matches. */
export interface QuickAnswer {
  id: number
  /** Ways a visitor may ask it (one is enough). */
  questions: string[]
  answer: string
  enabled: boolean
  hits: number
  lastHitAt: string | null
  updatedAt: string
}

export interface QuickAnswerSettings {
  enabled: boolean
  /** How close a message must be to a question, in percent (word overlap, accents ignored). */
  minSimilarity: number
}

export const QUICK_ANSWER_LIMITS = {
  maxAnswers: 200,
  maxQuestions: 10,
  maxQuestionChars: 300,
  maxAnswerChars: 4_000,
  defaultMinSimilarity: 85,
  minMinSimilarity: 60,
  maxMinSimilarity: 100,
} as const
