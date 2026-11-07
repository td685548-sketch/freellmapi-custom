/** How a client key keeps its web app's conversations on the server. */
export interface ConversationSettings {
  enabled: boolean
  /** A conversation left untouched this long is deleted. */
  ttlHours: number
  /** Most earlier messages added to one request. */
  maxMessages: number
  /** Most characters of earlier messages added to one request. */
  maxChars: number
}

/** A stored conversation, as the dashboard lists it. */
export interface StoredConversation {
  id: string
  endUser: string | null
  messages: number
  /** Characters of the stored messages. */
  chars: number
  createdAt: string
  updatedAt: string
  /** When it is deleted unless it is used again. */
  expiresAt: string
}

export interface StoredMessage {
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export const CONVERSATION_LIMITS = {
  /** Allowed characters of a conversation id (also URL-safe). */
  idPattern: '^[A-Za-z0-9._:-]{1,128}$',
  defaultTtlHours: 168,
  minTtlHours: 1,
  maxTtlHours: 2_160,
  defaultMaxMessages: 20,
  minMaxMessages: 2,
  maxMaxMessages: 100,
  defaultMaxChars: 12_000,
  minMaxChars: 1_000,
  maxMaxChars: 100_000,
  /** A longer message is stored cut to this length. */
  maxStoredMessageChars: 32_000,
  /** Most conversations one dashboard listing returns. */
  listLimit: 100,
} as const
