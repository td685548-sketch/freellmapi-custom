/** What a visitor who is not signed in may look at. Read-only by design: there is no guest write. */
export const GUEST_PERMISSIONS = [
  { key: 'view_models', title: 'Models and token budget', description: 'The Models page (Chat): the monthly token budget bar and the ranked model list, without any switch.' },
  { key: 'view_usage_profiles', title: 'Client key ranking', description: 'The usage ranking of client keys (names and figures) and its CSV export.' },
  { key: 'view_usage_accounts', title: 'Account ranking', description: 'The usage ranking of accounts. It shows every account\'s email address to anyone on the internet.', warning: true },
  { key: 'try_playground', title: 'Try the chat', description: 'A small chat to try the models before signing in, within the limits below. It spends provider quota; nothing is stored.', warning: true },
] as const

export type GuestPermission = typeof GUEST_PERMISSIONS[number]['key']

/** Limits of the chat a signed-out visitor may try (permission try_playground). */
export interface GuestTrialSettings {
  /** Messages one IP address may send per rolling hour. */
  perIpPerHour: number
  /** Messages all visitors together may send per UTC day. */
  dailyCap: number
  /** Most output tokens of one answer. */
  maxTokens: number
  /** Longest visitor message, in characters. */
  maxInputChars: number
  /** Model ids a visitor may pick; empty = automatic routing. */
  models: string[]
}

export const GUEST_TRIAL_DEFAULTS: GuestTrialSettings = { perIpPerHour: 5, dailyCap: 200, maxTokens: 512, maxInputChars: 2_000, models: [] }

export const GUEST_TRIAL_LIMITS = {
  perIpPerHour: [1, 50], dailyCap: [1, 10_000], maxTokens: [64, 4_096], maxInputChars: [100, 8_000],
  maxModels: 10, maxTurns: 10,
} as const

/** What the dashboard tells a visitor about the trial. */
export interface GuestTrialInfo { models: string[]; perIpPerHour: number; maxInputChars: number }

export interface GuestAccess {
  permissions: GuestPermission[]
  trial?: GuestTrialInfo
}
