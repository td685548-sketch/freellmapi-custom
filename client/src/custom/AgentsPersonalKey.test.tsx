// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import AgentsPage from '@/pages/AgentsPage'

const actor = vi.hoisted(() => ({ canReveal: false }))
vi.mock('./use-session', () => ({ useUserSession: () => ({ hasPermission: (p: string) => p === 'reveal_gateway_key' && actor.canReveal }) }))
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  vi.stubGlobal('__SERVER_PORT__', 3001) // build-time define used by the page in dev mode
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/api/settings/api-key') return { apiKey: 'unified-secret-key-1234' }
    if (path === '/api/user/keys') return { keys: [{ id: 1, name: 'Agent key', keyPrefix: 'sk-flm-ab', revoked: false }] }
    return []
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider initialLocale="en"><AgentsPage /></I18nProvider></QueryClientProvider>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

describe('Agents page key for invited members', () => {
  it('shows the personal key panel and never requests the shared gateway key', async () => {
    actor.canReveal = false
    await render()
    expect(apiFetch).not.toHaveBeenCalledWith('/api/settings/api-key')
    expect(container.textContent).toContain('sk-flm-ab')
    expect(container.textContent).toContain('<your-personal-key>')
    expect(container.textContent).not.toContain('unified-secret-key')
  })
  it('keeps the shared gateway key for accounts allowed to reveal it', async () => {
    actor.canReveal = true
    await render()
    expect(apiFetch).toHaveBeenCalledWith('/api/settings/api-key')
    expect(container.textContent).not.toContain('Generate my API key')
  })
})
