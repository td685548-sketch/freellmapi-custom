// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderTiersPanel } from './ProviderTiersPanel'
import { apiFetch } from '@/lib/api'

const session = vi.hoisted(() => ({ allowed: true }))
vi.mock('./use-session', () => ({ useUserSession: () => ({ hasPermission: () => session.allowed }) }))
vi.mock('./session-state', () => ({ useSessionRevision: () => 1 }))
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

let root: Root
let container: HTMLDivElement
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  session.allowed = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
})
async function render() {
  await act(async () => { root.render(<QueryClientProvider client={client}><ProviderTiersPanel range="7d" /></QueryClientProvider>) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
}

describe('Provider tier panel', () => {
  it('places key counts next to the provider, distinguishes usable counts and shows unknown axes', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ rows: [{
      providerId: 'groq', name: 'groq', linkedKeyCount: 4, usableKeyCount: 2,
      tier: null, samples: 5, modelCount: 1, reliability: .8, speed: null, intelligence: null, score: .8,
    }] })
    await render()
    const provider = container.querySelector('tbody th')
    expect(provider?.textContent).toContain('groq')
    expect(provider?.textContent).toContain('4 keys')
    expect(container.textContent).toContain('2 / 4')
    expect(container.textContent).toContain('Unranked')
    expect(container.textContent).toContain('—')
    expect(apiFetch).toHaveBeenCalledWith('/api/analytics/provider-tiers?range=7d', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('does not fetch install-wide metadata without permission', async () => {
    session.allowed = false
    await render()
    expect(apiFetch).not.toHaveBeenCalled()
    expect(container.textContent).toBe('')
  })

  it('offers refresh/retry on errors', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('unavailable'))
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not load')
    vi.mocked(apiFetch).mockResolvedValue({ rows: [] })
    await act(async () => { container.querySelector('button')?.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(container.textContent).toContain('No linked providers')
  })
});
