// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { GuestModelsPage } from './GuestModelsPage'
import { GUEST_PROMPT_EVENT } from './guest-prompt'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
// jsdom has no ResizeObserver; the shared table components use one for layout only.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

const entry = (id: number, name: string) => ({
  modelDbId: id, groupKey: name.toLowerCase(), canonicalId: name.toLowerCase(), groupLabel: name, priority: id, effectivePriority: id, penalty: 0, rateLimitHits: 0,
  enabled: true, platform: 'groq', modelId: name.toLowerCase(), displayName: name, intelligenceRank: 1, speedRank: 1, sizeLabel: 'Medium', rpmLimit: 30, rpdLimit: 1000,
  tpmLimit: null, tpdLimit: null, contextWindow: 131072, monthlyTokenBudget: '~6M', monthlyTokenBudgetTokens: 6_000_000, supportsVision: false, supportsTools: true,
  source: 'catalog', keyId: null, keyLabel: null, endpointScope: null, qualifiedModelId: null, hasOverrides: false, overrideFields: [], retiredUpstream: false, retiredReason: null, keyCount: 1,
})
let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    if (url === '/api/profiles/active') return { activeProfileId: 1 } as never
    if (url.startsWith('/api/fallback?')) return [entry(1, 'Alpha'), entry(2, 'Beta'), { ...entry(3, 'NoKey'), keyCount: 0 }] as never
    if (url === '/api/fallback/token-usage') return { totalBudget: 12_000_000, totalUsed: 1_000, models: [] } as never
    if (url === '/api/fallback/routing') return { strategy: 'balanced', scores: [] } as never
    return { rows: [] } as never
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

describe('GuestModelsPage', () => {
  it('lists the routed models read-only, without the switch column', async () => {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><GuestModelsPage /></MemoryRouter></QueryClientProvider>))
    await flush(); await flush()
    expect(container.querySelector('[data-testid="guest-models-count"]')?.textContent).toBe('2 of 2 models') // models without a key are not routed
    expect(container.querySelector('[data-testid="guest-models-table"]')!.className).toContain('[&_td:last-child]:hidden')
    expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init || !(init as RequestInit).method || (init as RequestInit).method === 'GET')).toBe(true)
  })

  it('asks to sign in instead of following a model link', async () => {
    const asked = vi.fn()
    window.addEventListener(GUEST_PROMPT_EVENT, asked)
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><GuestModelsPage /></MemoryRouter></QueryClientProvider>))
    await flush(); await flush()
    const link = container.querySelector('tbody a') as HTMLAnchorElement
    await act(async () => { link.click() })
    expect(asked).toHaveBeenCalled()
    window.removeEventListener(GUEST_PROMPT_EVENT, asked)
  })
})
