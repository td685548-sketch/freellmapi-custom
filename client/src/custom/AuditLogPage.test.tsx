// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { AuditLogPage } from './AuditLogPage'

const actor = vi.hoisted(() => ({ perms: new Set<string>() }))
vi.mock('./use-administrative-access', () => ({ useAdministrativeAccess: () => ({ can: (p: string) => actor.perms.has(p), isPending: false, identity: 'x' }) }))
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

const entry = (id: number, over: Record<string, unknown> = {}) => ({
  id, createdAt: '2026-11-07T01:00:00.000Z', actorId: 1, actorEmail: 'owner@example.com', ip: '1.2.3.4', method: 'PUT',
  path: `/api/client-profiles/${id}/quota`, route: '/api/client-profiles/:id/quota', area: 'client-profiles', targetId: id, status: 200, summary: { rpmLimit: 30 }, ...over,
})
let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  actor.perms = new Set(['view_audit_log'])
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    if (url.includes('before=')) return { entries: [entry(1)], areas: ['client-profiles', 'keys'] } as never
    if (url.includes('area=keys')) return { entries: [entry(9, { area: 'keys', method: 'DELETE', route: '/api/keys/:id' })], areas: ['client-profiles', 'keys'] } as never
    return { entries: Array.from({ length: 50 }, (_, i) => entry(100 - i)), areas: ['client-profiles', 'keys'] } as never
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><AuditLogPage /></QueryClientProvider>))
  await flush()
}

describe('AuditLogPage', () => {
  it('lists changes, opens one and loads older ones', async () => {
    await render()
    const list = container.querySelector('[aria-label="Changes"]')!
    expect(list.querySelectorAll('li')).toHaveLength(50)
    expect(list.textContent).toContain('owner@example.com')
    expect(list.textContent).toContain('Client keys #100')
    await act(async () => { (list.querySelector('button') as HTMLButtonElement).click() })
    expect(container.textContent).toContain('"rpmLimit": 30')
    await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Load older')!.click() })
    await flush()
    expect(apiFetch).toHaveBeenLastCalledWith('/api/audit?limit=50&before=51')
    expect(container.querySelector('[aria-label="Changes"]')!.querySelectorAll('li')).toHaveLength(51)
  })

  it('filters by area', async () => {
    await render()
    const select = container.querySelector('[aria-label="Area"]') as HTMLSelectElement
    await act(async () => { select.value = 'keys'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    expect(apiFetch).toHaveBeenLastCalledWith('/api/audit?limit=50&area=keys')
    expect(container.textContent).toContain('Deleted')
  })

  it('refuses without the permission', async () => {
    actor.perms = new Set()
    await render()
    expect(container.textContent).toContain('does not have permission')
    expect(apiFetch).not.toHaveBeenCalled()
  })
})
