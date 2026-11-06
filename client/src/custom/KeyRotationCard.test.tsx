// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { KeyRotationCard } from './KeyRotationCard'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn(async () => true) }))

let previous: Array<{ keyHint: string; expiresAt: string; createdAt: string }> = []
const answer = () => vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
  if (String(url).endsWith('/rotate-with-grace')) {
    const { graceHours } = JSON.parse(String(init!.body))
    previous = [{ keyHint: 'sk-c...aaaa', expiresAt: new Date(Date.now() + graceHours * 3_600_000).toISOString(), createdAt: '2026-11-07 00:00:00' }]
    return { id: 3, key: 'sk-cp-NEWKEY0123456789', maskedKey: 'sk-c...6789', previousKeyExpiresAt: previous[0]!.expiresAt } as never
  }
  if (init?.method === 'DELETE') { const n = previous.length; previous = []; return { revoked: n } as never }
  return { previousKeys: previous } as never
})

let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  previous = []
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
  answer()
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
async function render(canEdit: boolean) {
  await act(async () => root.render(<QueryClientProvider client={client}><KeyRotationCard profileId={3} canEdit={canEdit} /></QueryClientProvider>))
  await flush()
}
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement | undefined
const confirm = async (text: string, armed: string) => {
  await act(async () => { button(text)!.click() })
  await act(async () => { button(armed)!.click() })
  await flush()
}

describe('KeyRotationCard', () => {
  it('rotates with the chosen grace period after a confirmation and shows the new key once', async () => {
    await render(true)
    expect(container.textContent).toContain('Only the current key works.')
    await act(async () => { ([...container.querySelectorAll('[role=tab]')].find(t => t.textContent === '3 days') as HTMLElement).click() })
    await act(async () => { button('Rotate key')!.click() })
    expect(apiFetch).not.toHaveBeenCalledWith('/api/client-profiles/3/rotate-with-grace', expect.anything()) // armed, not yet sent
    await act(async () => { button('Confirm rotation')!.click() })
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/3/rotate-with-grace', { method: 'POST', body: JSON.stringify({ graceHours: 72 }) })
    expect(container.querySelector('[data-testid="new-key"]')?.textContent).toBe('sk-cp-NEWKEY0123456789')
    expect(container.textContent).toContain('not shown again')
    expect(container.querySelector('[aria-label="Old keys still working"]')?.textContent).toContain('sk-c...aaaa')
  })

  it('ends the grace period after a confirmation', async () => {
    previous = [{ keyHint: 'sk-c...bbbb', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: '' }]
    await render(true)
    expect(container.textContent).toContain('sk-c...bbbb')
    await confirm('End grace period now', 'Confirm: stop old keys now')
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/3/previous-keys', { method: 'DELETE' })
    expect(container.textContent).toContain('Only the current key works.')
  })

  it('shows the old keys read-only to a viewer', async () => {
    previous = [{ keyHint: 'sk-c...cccc', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: '' }]
    await render(false)
    expect(container.textContent).toContain('sk-c...cccc')
    expect(button('Rotate key')).toBeUndefined()
    expect(button('End grace period now')).toBeUndefined()
    expect(container.querySelector('[role=tablist]')).toBeNull()
  })

  it('copes with an unexpected answer', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ analytics: {} } as never)
    await render(true)
    expect(container.textContent).toContain('Only the current key works.')
  })
})
