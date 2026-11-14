// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PageSwitch } from './PageSwitch'

const session = vi.hoisted(() => ({ pending: false, error: false, granted: true }))
vi.mock('../use-session', () => ({
  useUserSession: () => ({
    isPending: session.pending,
    isError: session.error,
    hasPermission: (permission: string) => session.granted && permission === 'use_x_gateway',
  }),
}))
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }))
// The galaxy label pulls in a large generated star texture; the switch only needs it to render its text.
vi.mock('../x-gateway/GatewayGalaxyLabel', () => ({ GatewayGalaxyLabel: ({ children }: { children: string }) => <span>{children}</span> }))

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.assign(session, { pending: false, error: false, granted: true })
  sessionStorage.clear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
async function render(path: string) {
  await act(async () => root.render(<MemoryRouter initialEntries={[path]}><PageSwitch /></MemoryRouter>))
}
const link = () => container.querySelector<HTMLAnchorElement>('a[data-page-switch]')

describe('PageSwitch', () => {
  it('leads from FreeLLMAPI into Thruline with the galaxy look', async () => {
    await render('/keys')
    expect(link()?.getAttribute('href')).toBe('/thruline/providers')
    expect(link()?.dataset.pageSwitch).toBe('to-thruline')
    expect(link()?.className).toContain('page-switch--galaxy')
    expect(link()?.getAttribute('aria-label')).toBe('Switch to Thruline')
    expect(link()?.textContent).toBe('Thruline')
  })

  it('leads from Thruline back to FreeLLMAPI with the black-hole look', async () => {
    await render('/thruline/combos')
    expect(link()?.getAttribute('href')).toBe('/models/chat')
    expect(link()?.dataset.pageSwitch).toBe('to-freellmapi')
    expect(link()?.className).toContain('page-switch--hole')
    expect(link()?.getAttribute('aria-label')).toBe('Switch to FreeLLMAPI')
    expect(link()?.textContent).toBe('FreeLLMAPI')
  })

  it('returns to the page each side was last left on', async () => {
    sessionStorage.setItem('page-switch.last', JSON.stringify({ thruline: '/thruline/logs' }))
    await render('/keys')
    expect(link()?.getAttribute('href')).toBe('/thruline/logs')
    // Being on /keys is what makes it the FreeLLMAPI page to come back to.
    await act(async () => root.unmount())
    root = createRoot(container)
    await render('/thruline/logs')
    expect(link()?.getAttribute('href')).toBe('/keys')
  })

  it('does not remember the one-shot sign-in callback', async () => {
    await render('/thruline/accounts/callback')
    expect(JSON.parse(sessionStorage.getItem('page-switch.last') ?? '{}').thruline).toBeUndefined()
  })

  it('makes room in the headers only while it is shown', async () => {
    await render('/keys')
    expect(document.documentElement.hasAttribute('data-has-page-switch')).toBe(true)
    await act(async () => root.unmount())
    expect(document.documentElement.hasAttribute('data-has-page-switch')).toBe(false)
    root = createRoot(container)
  })

  it.each([
    ['without the Thruline permission', { granted: false }],
    ['while the session loads', { pending: true }],
    ['when the session fails to load', { error: true }],
  ])('renders nothing %s', async (_name, state) => {
    Object.assign(session, state)
    await render('/keys')
    expect(link()).toBeNull()
    expect(document.documentElement.hasAttribute('data-has-page-switch')).toBe(false)
  })
})
