// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GuestShell } from './GuestShell'
import { askToSignIn } from './guest-prompt'

vi.mock('./GuestModelsPage', () => ({ GuestModelsPage: () => <p>models page</p> }))
vi.mock('./UsageRankingPage', () => ({ UsageRankingPage: () => <p>usage page</p> }))

let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  sessionStorage.clear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers() })
async function render(permissions: Array<'view_models' | 'view_usage_profiles' | 'view_usage_accounts'>, path = '/', handlers = { onSignIn: vi.fn(), onRequest: vi.fn() }) {
  await act(async () => root.render(
    <QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><GuestShell permissions={permissions} {...handlers} /></MemoryRouter></QueryClientProvider>,
  ))
  return handlers
}
const dialog = () => container.querySelector('[role="dialog"]')
const button = (text: string) => [...(dialog() ?? container).querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement

describe('GuestShell', () => {
  it('shows only the pages opened to guests', async () => {
    await render(['view_models'])
    expect(container.textContent).toContain('models page')
    expect(container.querySelector('[aria-label="Guest pages"]')!.textContent).toBe('Models')
    await act(async () => root.unmount())
    container.remove(); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await render(['view_usage_profiles'], '/models/chat')
    expect(container.textContent).toContain('usage page') // a page not opened sends to one that is
  })

  it('asks to sign in five seconds after arriving, once per tab', async () => {
    const h = await render(['view_models'])
    await act(async () => { vi.advanceTimersByTime(4_900) })
    expect(dialog()).toBeNull()
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(dialog()?.textContent).toContain('Want to use these models?')
    await act(async () => { button('Request access').click() })
    expect(h.onRequest).toHaveBeenCalled()
    expect(dialog()).toBeNull()
    expect(sessionStorage.getItem('freellmapi.guestPromptSeen')).toBe('1')
  })

  it('does not ask again on its own in the same tab, but does when the visitor tries something', async () => {
    sessionStorage.setItem('freellmapi.guestPromptSeen', '1')
    const h = await render(['view_models'])
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(dialog()).toBeNull()
    await act(async () => { askToSignIn() })
    expect(dialog()).not.toBeNull()
    await act(async () => { button('Sign in').click() })
    expect(h.onSignIn).toHaveBeenCalled()
  })

  it('closes on Keep browsing and Escape', async () => {
    await render(['view_models'])
    await act(async () => { askToSignIn() })
    await act(async () => { button('Keep browsing').click() })
    expect(dialog()).toBeNull()
    await act(async () => { askToSignIn() })
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(dialog()).toBeNull()
  })
})
