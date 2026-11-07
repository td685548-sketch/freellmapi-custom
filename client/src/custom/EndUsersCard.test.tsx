// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { EndUsersCard } from './EndUsersCard'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const row = (endUser: string, requests: number, over: Record<string, unknown> = {}) => ({
  endUser, requests, success: requests, errors: 0, tokens: requests * 4, avgLatencyMs: 200, lastRequestAt: '2026-11-07 10:00:00', today: null, month: null, ...over,
})
let quota = { dailyRequests: null as number | null, dailyTokens: null, monthlyRequests: null, monthlyTokens: null }
let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  quota = { dailyRequests: null, dailyTokens: null, monthlyRequests: null, monthlyTokens: null }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { quota = { ...quota, ...JSON.parse(String(init.body)) }; return { quota } as never }
    if (url.includes('/requests')) return { requests: [{ id: 1, createdAt: '2026-11-07 10:00:00', status: 'success', platform: 'groq', modelId: 'm', requestedModel: null, latencyMs: 100, ttfbMs: null, inputTokens: 3, outputTokens: 1, error: null, endUser: 'alice' }], nextBefore: null } as never
    const tracked = quota.dailyRequests !== null
    return { overview: { days: 30, unattributedRequests: 3, quota, endUsers: [row('alice', 5, tracked ? { today: { requests: 2, tokens: 8 }, month: { requests: 5, tokens: 20 } } : {}), row('bob', 2, { errors: 1 })] } } as never
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
async function render(canEdit = true) {
  await act(async () => root.render(<QueryClientProvider client={client}><EndUsersCard profileId={4} canEdit={canEdit} /></QueryClientProvider>))
  await flush()
}
const type = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const names = () => [...container.querySelectorAll('tbody tr td:first-child')].map(td => td.textContent)

describe('EndUsersCard', () => {
  it('lists the end users, busiest first, and warns about requests that named none', async () => {
    await render()
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/4/end-users?days=30')
    expect(names()).toEqual(['alice', 'bob'])
    expect(container.textContent).toContain('3 request(s) in this window named no end user')
    expect(container.textContent).not.toContain('Today')
  })

  it('searches, and opens one end user\'s requests', async () => {
    await render()
    await type(container.querySelector('[aria-label="Search end user"]') as HTMLInputElement, 'BO')
    expect(names()).toEqual(['bob'])
    await type(container.querySelector('[aria-label="Search end user"]') as HTMLInputElement, '')
    await act(async () => { (container.querySelector('tbody tr') as HTMLElement).click() })
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/4/requests?limit=25&endUser=alice')
    expect(container.querySelector('[aria-label="Requests of alice"]')).not.toBeNull()
  })

  it('saves the per-end-user allowance and then shows today\'s use', async () => {
    await render()
    await type(container.querySelector('#eu-dailyRequests') as HTMLInputElement, '20')
    await act(async () => { ([...container.querySelectorAll('button')].find(b => b.textContent === 'Save') as HTMLButtonElement).click() })
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/4/end-user-quota', { method: 'PUT', body: JSON.stringify({ dailyRequests: 20, dailyTokens: null, monthlyRequests: null, monthlyTokens: null }) })
    await flush()
    expect(container.textContent).toContain('Today')
    expect(container.textContent).toContain('2 req · 8 tok')
  })

  it('is read-only without edit rights', async () => {
    await render(false)
    expect((container.querySelector('#eu-dailyRequests') as HTMLInputElement).disabled).toBe(true)
    expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Save')).toBe(false)
  })
})
