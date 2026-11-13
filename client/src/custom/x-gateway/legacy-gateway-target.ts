/** Where a pre-rename console address (`/x/...`) lives now, or null for any other path. */
export function legacyGatewayTarget(location: { pathname: string; search: string; hash: string }): string | null {
  if (location.pathname !== '/x' && !location.pathname.startsWith('/x/')) return null
  return `/thruline${location.pathname.slice(2)}${location.search}${location.hash}`
}
