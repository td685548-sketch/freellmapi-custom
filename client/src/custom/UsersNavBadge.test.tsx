// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { UsersNavBadge } from './UsersNavBadge'

const actor = vi.hoisted(() => ({ canViewRequests: true }))
vi.mock('./use-administrative-access', () => ({
  useAdministrativeAccess: () => ({ can: (p: string) => p === 'view_requests' && actor.canViewRequests }),
}))
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  actor.canViewRequests = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><UsersNavBadge /></QueryClientProvider>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

describe('UsersNavBadge', () => {
  it('shows the number of pending registration requests', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ requests: [{ id: 1 }, { id: 2 }] })
    await render()
    expect(container.querySelector('[role="status"]')?.textContent).toBe('2')
  })
  it('renders nothing when no request is pending', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ requests: [] })
    await render()
    expect(container.querySelector('[role="status"]')).toBeNull()
  })
  it('does not call the API or show a badge without view_requests', async () => {
    actor.canViewRequests = false
    await render()
    expect(apiFetch).not.toHaveBeenCalled()
    expect(container.querySelector('[role="status"]')).toBeNull()
  })
})
