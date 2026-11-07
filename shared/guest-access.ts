/** What a visitor who is not signed in may look at. Read-only by design: there is no guest write. */
export const GUEST_PERMISSIONS = [
  { key: 'view_models', title: 'Models and token budget', description: 'The Models page (Chat): the monthly token budget bar and the ranked model list, without any switch.' },
  { key: 'view_usage_profiles', title: 'Client key ranking', description: 'The usage ranking of client keys (names and figures) and its CSV export.' },
  { key: 'view_usage_accounts', title: 'Account ranking', description: 'The usage ranking of accounts. It shows every account\'s email address to anyone on the internet.', warning: true },
] as const

export type GuestPermission = typeof GUEST_PERMISSIONS[number]['key']

export interface GuestAccess {
  permissions: GuestPermission[]
}
