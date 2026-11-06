// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { ProfileUsagePage } from './ProfileUsagePage'
import { ProfileUsageLink } from './ProfileUsageLink'

const actor = vi.hoisted(() => ({ perms: new Set<string>(['view_client_profiles', 'edit_client_profiles']) }))
vi.mock('./use-administrative-access', () => ({
  useAdministrativeAccess: () => ({ can: (p: string) => actor.perms.has(p), isPending: false, identity: 'x' }),
}))
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('recharts', () => {
  const Stub = ({ children }: { children?: unknown }) => <div>{children as never}</div>
  return { ResponsiveContainer: Stub, BarChart: Stub, Bar: Stub, CartesianGrid: Stub, XAxis: Stub, YAxis: Stub, Tooltip: Stub, Legend: Stub }
})

const analytics = (rpmLimit: number | null) => ({
  analytics: {
    profileId: 5, name: 'Shop widget', enabled: true, rpmLimit, days: 30, since: '2026-10-07 00:00:00',
    totals: { requests: 4, success: 4, errors: 0, canceled: 0, inputTokens: 40, outputTokens: 8, avgLatencyMs: 300, lastRequestAt: '2026-11-06 10:00:00' },
    daily: [{ date: '2026-11-06', requests: 4, errors: 0, tokens: 48 }],
    models: [{ platform: 'groq', modelId: 'qwen/qwen3-32b', requests: 4, errors: 0, tokens: 48 }],
    retainedSince: '2026-11-01 00:00:00',
  },
})

let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  actor.perms = new Set(['view_client_profiles', 'edit_client_profiles'])
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
async function render() {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/profiles/5/usage']}>
        <Routes><Route path="/profiles/:id/usage" element={<ProfileUsagePage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const input = () => container.querySelector('#profile-rpm') as HTMLInputElement
const type = async (value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input(), value); input().dispatchEvent(new Event('input', { bubbles: true })) })
}
const saveButton = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Save') as HTMLButtonElement

describe('ProfileUsagePage', () => {
  it('shows the profile, its numbers and its current limit', async () => {
    vi.mocked(apiFetch).mockResolvedValue(analytics(60))
    await render()
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/5/analytics?days=30')
    expect(container.textContent).toContain('Shop widget')
    expect(container.textContent).toContain('qwen/qwen3-32b')
    expect(input().value).toBe('60')
    expect(container.textContent).toContain('Currently 60 per minute.')
  })

  it('saves a new limit, and an empty field clears it', async () => {
    vi.mocked(apiFetch).mockResolvedValue(analytics(60))
    await render()
    expect(saveButton().disabled).toBe(true)
    await type('120')
    await act(async () => { saveButton().click() })
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/5/quota', { method: 'PUT', body: JSON.stringify({ rpmLimit: 120 }) })
    await type('')
    await act(async () => { saveButton().click() })
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/5/quota', { method: 'PUT', body: JSON.stringify({ rpmLimit: null }) })
  })

  it('refuses a value outside 1..1000', async () => {
    vi.mocked(apiFetch).mockResolvedValue(analytics(60))
    await render()
    for (const bad of ['0', '1001', '1.5', 'abc']) {
      await type(bad)
      expect(saveButton().disabled).toBe(true)
    }
  })

  it('is read-only without edit_client_profiles', async () => {
    actor.perms = new Set(['view_client_profiles'])
    vi.mocked(apiFetch).mockResolvedValue(analytics(60))
    await render()
    expect(input().disabled).toBe(true)
    expect(saveButton().disabled).toBe(true)
  })

  it('does not open without view_client_profiles', async () => {
    actor.perms = new Set()
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('does not have permission')
    expect(apiFetch).not.toHaveBeenCalled()
  })
})

describe('ProfileUsageLink', () => {
  it('links to the usage page, and renders nothing outside a router', async () => {
    await act(async () => root.render(<MemoryRouter><ProfileUsageLink profileId={9} /></MemoryRouter>))
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/profiles/9/usage')
    await act(async () => root.render(<ProfileUsageLink profileId={9} />))
    expect(container.querySelector('a')).toBeNull()
  })
})
