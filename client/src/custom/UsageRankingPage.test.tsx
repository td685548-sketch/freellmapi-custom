// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import type { UsageOverview, UsageRow } from '../../../shared/usage-overview'
import { UsageRankingPage } from './UsageRankingPage'

const actor = vi.hoisted(() => ({ perms: new Set<string>() }))
vi.mock('./use-administrative-access', () => ({
  useAdministrativeAccess: () => ({ can: (p: string) => actor.perms.has(p), isPending: false, identity: 'x' }),
}))
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

const row = (over: Partial<UsageRow>): UsageRow => ({
  kind: 'account', id: 1, name: 'a', role: 'member', requests: 0, success: 0, errors: 0, canceled: 0, inputTokens: 0, outputTokens: 0,
  avgLatencyMs: null, p95LatencyMs: null, lastRequestAt: null, rpmLimit: null, ...over,
})
const accounts: UsageOverview = { kind: 'account', days: 30, since: '', rows: [
  row({ id: 1, name: 'alice@x.com', requests: 100, success: 90, errors: 10, inputTokens: 500, outputTokens: 100, avgLatencyMs: 800, p95LatencyMs: 2000, lastRequestAt: '2026-11-06 10:00:00', rpmLimit: 60 }),
  row({ id: 2, name: 'bob@x.com', requests: 40, success: 40, inputTokens: 90, outputTokens: 10, avgLatencyMs: 300, p95LatencyMs: 500 }),
  row({ id: 3, name: 'idle@x.com' }),
] }
const profiles: UsageOverview = { kind: 'profile', days: 30, since: '', rows: [
  row({ kind: 'profile', id: 9, name: 'Shop widget', role: undefined, enabled: true, requests: 70, success: 70, avgLatencyMs: 1200, p95LatencyMs: 4000, rpmLimit: 120 }),
] }

let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  actor.perms = new Set(['view_usage_accounts', 'view_usage_profiles'])
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (url: string) => ({ overview: url.includes('/accounts') ? accounts : profiles }) as never)
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><UsageRankingPage /></MemoryRouter></QueryClientProvider>))
  await flush()
}
const order = () => [...container.querySelectorAll('tbody tr')].map(tr => tr.querySelectorAll('td')[1]?.textContent?.replace(/(Member|Admin|Client key.*)$/, '').trim())
const setInput = async (label: string, value: string) => {
  const el = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const headerButton = (label: string) => [...container.querySelectorAll('th button')].find(b => b.textContent === label)
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click() })

describe('UsageRankingPage', () => {
  it('lists accounts and client keys together, busiest first, with totals', async () => {
    await render()
    expect(apiFetch).toHaveBeenCalledWith('/api/usage/accounts?days=30')
    expect(apiFetch).toHaveBeenCalledWith('/api/usage/profiles?days=30')
    expect(order()).toEqual(['alice@x.com', 'Shop widget', 'bob@x.com', 'idle@x.com'])
    expect(container.textContent).toContain('90.0%')
    expect(container.textContent).toContain('4 shown')
    expect(container.querySelector('tfoot')?.textContent).toContain('210') // 100 + 40 + 70
  })

  it('re-ranks when a column header is clicked and cycles back to the default', async () => {
    await render()
    const header = () => headerButton('Avg latency')
    await click(header())
    expect(order()).toEqual(['bob@x.com', 'alice@x.com', 'Shop widget', 'idle@x.com']) // asc, missing last
    await click(header())
    expect(order()).toEqual(['Shop widget', 'alice@x.com', 'bob@x.com', 'idle@x.com']) // desc
    await click(header())
    expect(order()).toEqual(['alice@x.com', 'Shop widget', 'bob@x.com', 'idle@x.com']) // back to requests desc
  })

  it('filters by name, kind, idleness and errors, and resets', async () => {
    await render()
    await setInput('Search by name', 'bob')
    expect(order()).toEqual(['bob@x.com'])
    await setInput('Search by name', '')
    await click([...container.querySelectorAll('[role="tab"]')].find(b => b.textContent === 'Client keys'))
    expect(order()).toEqual(['Shop widget'])
    await click([...container.querySelectorAll('button')].find(b => b.textContent?.includes('Reset filters')))
    expect(order()).toHaveLength(4)
    await click(container.querySelector('#usage-hide-idle'))
    expect(order()).not.toContain('idle@x.com')
    await click(container.querySelector('#usage-only-errors'))
    expect(order()).toEqual(['alice@x.com'])
    await setInput('Minimum requests', '500')
    expect(container.textContent).toContain('No row matches these filters')
  })

  it('remembers the sort and filters in this browser', async () => {
    await render()
    await click(container.querySelector('#usage-hide-idle'))
    await click(headerButton('Errors'))
    expect(JSON.parse(localStorage.getItem('usage-ranking.filters')!).hideIdle).toBe(true)
    expect(JSON.parse(localStorage.getItem('usage-ranking.sort')!)).toEqual({ column: 'errors', direction: 'asc' })
    act(() => root.unmount()); root = createRoot(container)
    await render()
    expect((container.querySelector('#usage-hide-idle') as HTMLInputElement).checked).toBe(true)
  })

  it('links rows to their detail pages only when the viewer may open them', async () => {
    await render()
    expect(container.querySelector('a')).toBeNull()
    actor.perms = new Set(['view_usage_accounts', 'view_usage_profiles', 'view_users', 'view_client_profiles'])
    act(() => root.unmount()); root = createRoot(container)
    await render()
    const hrefs = [...container.querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(hrefs).toContain('/users/1/analytics')
    expect(hrefs).toContain('/profiles/9/usage')
  })

  it('asks only for the kinds the viewer holds', async () => {
    actor.perms = new Set(['view_usage_profiles'])
    await render()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch).toHaveBeenCalledWith('/api/usage/profiles?days=30')
    expect(order()).toEqual(['Shop widget'])
    expect(container.querySelector('[role="tablist"][aria-label="Show"]')).toBeNull()
  })

  it('does not open without a usage permission', async () => {
    actor.perms = new Set(['view_users'])
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('does not have permission')
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('shows a retry when loading fails', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('boom'))
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not load usage')
  })
})
