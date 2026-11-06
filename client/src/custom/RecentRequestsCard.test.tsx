// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { RecentRequestsCard } from './RecentRequestsCard'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id, createdAt: `2026-11-07 10:${String(id).padStart(2, '0')}:00`, status: 'success', platform: 'groq', modelId: `m${id}`, requestedModel: null,
  latencyMs: 120 + id, ttfbMs: null, inputTokens: 10, outputTokens: 3, error: null, ...over,
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
    if (url.includes('/attempts')) return { attempts: [{ ordinal: 0, platform: 'groq', modelId: 'big', keyLabel: 'g1', outcome: 'rate_limited', durationMs: 40, error: '429 from groq' }, { ordinal: 1, platform: 'cerebras', modelId: 'small', keyLabel: null, outcome: 'ok', durationMs: 300, error: null }] } as never
    if (url.includes('status=error')) return { requests: [row(9, { status: 'error', error: 'Upstream 503' })], nextBefore: null } as never
    if (url.includes('before=7')) return { requests: [row(6), row(5)], nextBefore: null } as never
    return { requests: [row(9, { status: 'error', error: 'Upstream 503' }), row(8), row(7)], nextBefore: 7 } as never
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><RecentRequestsCard endpoint="/api/client-profiles/4/requests" /></QueryClientProvider>))
  await flush()
}
const models = () => [...container.querySelectorAll('[aria-label="Requests"] > li')].map(li => li.querySelector('[data-role=model]')?.textContent)
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement | undefined

describe('RecentRequestsCard', () => {
  it('lists the newest requests with status, model, latency, tokens and the error', async () => {
    await render()
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/4/requests?limit=25')
    expect(models()).toEqual(['m9', 'm8', 'm7'])
    const text = container.textContent!
    expect(text).toContain('Upstream 503')
    expect(text).toContain('128 ms')
    expect(text).toContain('10 in / 3 out')
  })

  it('loads older pages', async () => {
    await render()
    await act(async () => { button('Load older')!.click() })
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/4/requests?limit=25&before=7')
    expect(models()).toEqual(['m9', 'm8', 'm7', 'm6', 'm5'])
    expect(button('Load older')).toBeUndefined()
  })

  it('filters to errors', async () => {
    await render()
    await act(async () => { ([...container.querySelectorAll('[role=tab]')].find(t => t.textContent === 'Errors only') as HTMLElement).click() })
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/4/requests?limit=25&status=error')
    expect(models()).toEqual(['m9'])
  })

  it('opens the failover chain of a row', async () => {
    await render()
    const first = container.querySelector('[aria-label="Requests"] > li button') as HTMLButtonElement
    expect(first.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { first.click() })
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/4/requests/9/attempts')
    const chain = container.querySelector('[aria-label="Attempts"]')!.textContent!
    expect(chain).toContain('big')
    expect(chain).toContain('rate_limited')
    expect(chain).toContain('429 from groq')
    expect(chain).toContain('small')
  })

  it('says when there is nothing, and when loading failed', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ requests: [], nextBefore: null } as never)
    await render()
    expect(container.textContent).toContain('No requests yet.')
    act(() => root.unmount()); root = createRoot(container); client.clear()
    vi.mocked(apiFetch).mockRejectedValue(new Error('boom'))
    await render()
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Could not load')
  })
})
