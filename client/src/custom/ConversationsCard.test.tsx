// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { ConversationsCard } from './ConversationsCard'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const conv = (id: string, endUser: string | null) => ({ id, endUser, messages: 4, chars: 120, createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T01:00:00.000Z', expiresAt: '2026-11-14T01:00:00.000Z' })
let state: { settings: { enabled: boolean; ttlHours: number; maxMessages: number; maxChars: number }; conversations: ReturnType<typeof conv>[] }
let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  state = { settings: { enabled: false, ttlHours: 168, maxMessages: 20, maxChars: 12000 }, conversations: [conv('chat-1', 'alice'), conv('chat-2', null)] }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/conversation-settings')) { state.settings = { ...state.settings, ...JSON.parse(String(init!.body)) }; return { settings: state.settings } as never }
    if (init?.method === 'DELETE') return { deleted: 1 } as never
    if (url.includes('/conversations/chat-1')) return { conversation: state.conversations[0], messages: [{ role: 'user', content: 'Xin chào', createdAt: '2026-11-07T00:00:00.000Z' }, { role: 'assistant', content: 'Chào bạn', createdAt: '2026-11-07T00:00:01.000Z' }] } as never
    if (url.includes('?endUser=alice')) return { ...state, conversations: [state.conversations[0]] } as never
    return state as never
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
async function render(canEdit = true) {
  await act(async () => root.render(<QueryClientProvider client={client}><ConversationsCard profileId={5} canEdit={canEdit} /></QueryClientProvider>))
  await flush()
}
const typeInto = async (el: HTMLInputElement, value: string) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement | undefined
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click() }); await flush() }

describe('ConversationsCard', () => {
  it('lists conversations and switches storage on', async () => {
    await render()
    const list = container.querySelector('[aria-label="Conversations"]')?.textContent ?? ''
    expect(list).toContain('chat-1')
    expect(list).toContain('alice')
    expect(list).toContain('no end user')
    await click(container.querySelector('[aria-label="Keep conversations on the server"]'))
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/5/conversation-settings', { method: 'PUT', body: JSON.stringify({ enabled: true }) })
  })

  it('saves valid limits and blocks out-of-range ones', async () => {
    await render()
    await typeInto(container.querySelector('#conv-maxMessages') as HTMLInputElement, '1')
    expect(button('Save')!.disabled).toBe(true)
    await typeInto(container.querySelector('#conv-maxMessages') as HTMLInputElement, '10')
    await click(button('Save'))
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/5/conversation-settings', { method: 'PUT', body: JSON.stringify({ ttlHours: 168, maxMessages: 10, maxChars: 12000 }) })
  })

  it('opens a conversation and erases one end user', async () => {
    await render()
    await click(button('chat-1'))
    expect(container.querySelector('[aria-label="Messages of chat-1"]')?.textContent).toContain('Chào bạn')
    await typeInto(container.querySelector('[aria-label="Filter by end user"]') as HTMLInputElement, 'alice')
    await click(button('Filter'))
    expect(container.querySelector('[aria-label="Conversations"]')?.textContent).not.toContain('chat-2')
    const eraseAll = container.querySelector('[aria-label="Delete every conversation of alice"]')
    await click(eraseAll) // arms
    await click(eraseAll) // confirms
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/5/conversations?endUser=alice', { method: 'DELETE' })
  })

  it('is read-only without edit rights and never fetches message text', async () => {
    await render(false)
    expect(button('chat-1')).toBeUndefined()
    expect(container.querySelector('[aria-label="Delete chat-1"]')).toBeNull()
    expect(container.querySelector('[aria-label="Keep conversations on the server"]')?.hasAttribute('data-disabled')).toBe(true)
    expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('/conversations/'))).toBe(false)
  })
})
