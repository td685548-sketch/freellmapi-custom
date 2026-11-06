/** What a client profile's key may do. Empty / null means no restriction. */

export interface ProfileRestrictions {
  /** Model ids the key may use (lowercase). Empty = any model. */
  allowedModels: string[]
  /** Largest max_tokens one request may ask for (larger or missing values are lowered to it). null = no cap. */
  maxTokens: number | null
}

export const MAX_ALLOWED_MODELS = 100
export const MAX_TOKENS_CAP_LIMIT = 1_000_000
