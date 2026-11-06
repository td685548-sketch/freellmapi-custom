// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import type { UsageQuotaState } from '../../../shared/usage-quota'
import { QuotaCard } from './QuotaCard'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const state = (over: Partial<UsageQuotaState> = {}): UsageQuotaState => ({
  quota: { dailyRequests: 100, dailyTokens: null, monthlyRequests: 1000, monthlyTokens: 50000 },
  tracked: true,
  usage: { day: { requests: 40, tokens: 900 }, month: { requests: 1000, tokens: 12000 } },
  resetsAt: { day: '2026-11-07T00:00:00.000Z', month: '2026-12-01T00:00:00.000Z' },
  ...over,
})
const untracked = state({ quota: { dailyRequests: null, dailyTokens: null, monthlyRequests: null, monthlyTokens: null }, tracked: false, usage: { day: { requests: 0, tokens: 0 }, month: { requests: 0, tokens: 0 } } })

let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
async function render(canEdit: boolean) {
  await act(async () => root.render(<QueryClientProvider client={client}><QuotaCard endpoint="/e" queryKey={['q']} canEdit={canEdit} /></QueryClientProvider>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const input = (f: string) => container.querySelector(`#quota-${f}`) as HTMLInputElement
const type = async (f: string, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input(f), value); input(f).dispatchEvent(new Event('input', { bubbles: true })) })
}
const save = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Save allowances') as HTMLButtonElement

describe('QuotaCard', () => {
  it('shows each limit with how much of it is used', async () => {
    vi.mocked(apiFetch).mockResolvedValue(state())
    await render(true)
    expect(input('dailyRequests').value).toBe('100')
    expect(input('dailyTokens').value).toBe('')
    expect(container.textContent).toContain('40 of 100 used')
    expect(container.textContent).toContain('1,000 of 1,000 used')
    const bars = [...container.querySelectorAll('[role="progressbar"]')].map(b => b.getAttribute('aria-valuenow'))
    expect(bars).toEqual(['40', '100', '24']) // daily requests, monthly requests, monthly tokens; the unlimited one has no bar
    expect(container.textContent).toContain('2026-11-07 00:00 UTC')
  })

  it('saves the four limits, an empty field meaning no limit', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(state()).mockResolvedValueOnce(state({ quota: { dailyRequests: 250, dailyTokens: 5000, monthlyRequests: 1000, monthlyTokens: null } }))
    await render(true)
    expect(save().disabled).toBe(true)
    await type('dailyRequests', '250')
    await type('dailyTokens', '5000')
    await type('monthlyTokens', '')
    expect(save().disabled).toBe(false)
    await act(async () => { save().click() })
    expect(apiFetch).toHaveBeenLastCalledWith('/e', { method: 'PUT', body: JSON.stringify({ dailyRequests: 250, dailyTokens: 5000, monthlyRequests: 1000, monthlyTokens: null }) })
    expect(input('dailyRequests').value).toBe('250')
  })

  it('refuses anything but whole numbers from 1', async () => {
    vi.mocked(apiFetch).mockResolvedValue(state())
    await render(true)
    for (const bad of ['0', '-3', '1.5', 'abc', '1000000000001']) {
      await type('dailyRequests', bad)
      expect(save().disabled, bad).toBe(true)
    }
    await type('dailyRequests', '100')
    expect(save().disabled).toBe(true) // back to the stored value: nothing to save
  })

  it('is read-only for a viewer, and invisible when there is nothing to show', async () => {
    vi.mocked(apiFetch).mockResolvedValue(state())
    await render(false)
    expect(container.querySelector('input')).toBeNull()
    expect(save()).toBeUndefined()
    expect(container.textContent).toContain('40 of 100 used')

    vi.mocked(apiFetch).mockResolvedValue(untracked)
    client.clear()
    await render(false)
    expect(container.textContent).toBe('')
  })

  it('lets an editor start from no limits', async () => {
    vi.mocked(apiFetch).mockResolvedValue(untracked)
    await render(true)
    expect(container.querySelector('form')).not.toBeNull()
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
    expect(input('monthlyTokens').placeholder).toBe('No limit')
  })

  it('renders nothing for an unexpected answer', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ analytics: {} })
    await render(true)
    expect(container.textContent).toBe('')
  })
})
