/** Which side of the switch a router path belongs to, and where each side was last left. */
const THRULINE_HOME = '/thruline/providers'
const FREELLMAPI_HOME = '/models/chat'
const MEMORY_KEY = 'page-switch.last'

export type Side = 'freellmapi' | 'thruline'

export const sideOf = (pathname: string): Side =>
  pathname === '/thruline' || pathname.startsWith('/thruline/') ? 'thruline' : 'freellmapi'

/** Where each side was last left, so the switch returns you to the page you were on. */
export function readMemory(): Partial<Record<Side, string>> {
  try { return JSON.parse(window.sessionStorage.getItem(MEMORY_KEY) ?? '{}') } catch { return {} }
}
export function remember(side: Side, path: string) {
  try {
    window.sessionStorage.setItem(MEMORY_KEY, JSON.stringify({ ...readMemory(), [side]: path }))
  } catch { /* the memory is a convenience; the switch still works without it */ }
}

/** A remembered path is only reused if it still belongs to the side it was saved for. */
export function switchTarget(to: Side, memory: Partial<Record<Side, string>>): string {
  const saved = memory[to]
  if (saved && sideOf(saved.split(/[?#]/)[0]) === to) return saved
  return to === 'thruline' ? THRULINE_HOME : FREELLMAPI_HOME
}
