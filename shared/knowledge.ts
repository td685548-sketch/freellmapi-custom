/** A document of a client key's knowledge base. */
export interface KnowledgeDoc {
  id: number
  title: string
  content: string
  /** Characters. */
  size: number
  chunks: number
  updatedAt: string
}

export interface KnowledgeSettings {
  enabled: boolean
  /** Most characters of reference material added to one request. */
  maxChars: number
}

/** One passage chosen for a question. */
export interface KnowledgeHit { docId: number; title: string; text: string; score: number }

export const KNOWLEDGE_LIMITS = {
  maxDocs: 200,
  maxDocChars: 20_000,
  maxTitle: 200,
  defaultMaxChars: 3_000,
  minMaxChars: 500,
  maxMaxChars: 20_000,
} as const
