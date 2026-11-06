// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { UserAnalyticsView, type UserAnalytics } from './UserAnalyticsView'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
// Charts need layout that jsdom does not have; the numbers and tables are what matter here.
vi.mock('recharts', () => {
  const Stub = ({ children }: { children?: unknown }) => <div>{children as never}</div>
  return { ResponsiveContainer: Stub, BarChart: Stub, Bar: Stub, CartesianGrid: Stub, XAxis: Stub, YAxis: Stub, Tooltip: Stub, Legend: Stub }
})

function analytics(over: Partial<UserAnalytics['totals']> = {}): UserAnalytics {
  return {
    userId: 7, email: 'm@example.com', days: 30, since: '2026-10-07 00:00:00',
    totals: { requests: 10, success: 8, errors: 2, canceled: 0, inputTokens: 1200, outputTokens: 300, avgLatencyMs: 420, lastRequestAt: '2026-11-06 09:30:00', ...over },
    daily: [{ date: '2026-11-05', requests: 4, errors: 1, tokens: 500 }, { date: '2026-11-06', requests: 6, errors: 1, tokens: 1000 }],
    models: [{ platform: 'groq', modelId: 'qwen/qwen3-32b', requests: 10, errors: 2, tokens: 1500 }],
    retainedSince: '2026-10-20 08:00:00',
  }
}

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
async function render() {
  await act(async () => root.render(
    <QueryClientProvider client={client}><UserAnalyticsView endpoint="/api/user/analytics" queryKey={['t']} /></QueryClientProvider>,
  ))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

describe('UserAnalyticsView', () => {
  it('shows totals, success rate, tokens and the models table', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ analytics: analytics() })
    await render()
    const text = container.textContent ?? ''
    expect(apiFetch).toHaveBeenCalledWith('/api/user/analytics?days=30')
    expect(text).toContain('80.0%')
    expect(text).toContain('1,500')
    expect(text).toContain('420 ms')
    expect(text).toContain('qwen/qwen3-32b')
    expect(text).toContain('Oldest retained request: 2026-10-20')
  })

  it('reloads for another range', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ analytics: analytics() })
    await render()
    const tab = [...container.querySelectorAll('[role="tab"]')].find(b => b.textContent === '7 days') as HTMLElement
    await act(async () => { tab.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(apiFetch).toHaveBeenLastCalledWith('/api/user/analytics?days=7')
  })

  it('explains an empty window instead of drawing empty charts', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ analytics: { ...analytics({ requests: 0, success: 0, errors: 0, avgLatencyMs: null, lastRequestAt: null, inputTokens: 0, outputTokens: 0 }), models: [], retainedSince: null } })
    await render()
    expect(container.textContent).toContain('No requests in this window')
  })

  it('shows the error with a retry', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('boom'))
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('boom')
  })
})
