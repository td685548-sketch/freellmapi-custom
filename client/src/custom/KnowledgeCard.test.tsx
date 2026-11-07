// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { KnowledgeCard } from './KnowledgeCard'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

let state = { settings: { enabled: false, maxChars: 3000 }, docs: [{ id: 1, title: 'Shipping', content: 'We ship in 2 days.', size: 18, chunks: 1, updatedAt: '' }] }
let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  state = { settings: { enabled: false, maxChars: 3000 }, docs: [{ id: 1, title: 'Shipping', content: 'We ship in 2 days.', size: 18, chunks: 1, updatedAt: '' }] }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes('/search')) return { hits: url.includes('ship') ? [{ docId: 1, title: 'Shipping', text: 'We ship in 2 days.', score: 1.2 }] : [] } as never
    if (url.endsWith('/knowledge-settings')) { state.settings = { ...state.settings, ...JSON.parse(String(init!.body)) }; return { settings: state.settings } as never }
    if (init?.method === 'POST') { const b = JSON.parse(String(init.body)); state.docs.push({ id: 2, ...b, size: b.content.length, chunks: 1, updatedAt: '' }); return {} as never }
    if (init?.method === 'PUT') { const b = JSON.parse(String(init.body)); state.docs = state.docs.map(d => (d.id === 1 ? { ...d, ...b } : d)); return {} as never }
    return state as never
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
async function render(canEdit = true) {
  await act(async () => root.render(<QueryClientProvider client={client}><KnowledgeCard profileId={5} canEdit={canEdit} /></QueryClientProvider>))
  await flush()
}
const typeInto = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement | undefined

describe('KnowledgeCard', () => {
  it('lists documents and switches the knowledge base on', async () => {
    await render()
    expect(container.querySelector('[aria-label="Documents"]')?.textContent).toContain('Shipping')
    await act(async () => { (container.querySelector('[aria-label="Use the knowledge base"]') as HTMLElement).click() })
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/5/knowledge-settings', { method: 'PUT', body: JSON.stringify({ enabled: true }) })
  })

  it('adds a document and edits one', async () => {
    await render()
    await typeInto(container.querySelector('[aria-label="Document title"]') as HTMLInputElement, 'Returns')
    await typeInto(container.querySelector('[aria-label="Document content"]') as HTMLTextAreaElement, '7 days to return.')
    await act(async () => { button('Add')!.click() })
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/5/knowledge', { method: 'POST', body: JSON.stringify({ title: 'Returns', content: '7 days to return.' }) })
    await act(async () => { (container.querySelector('[aria-label="Edit Shipping"]') as HTMLElement).click() })
    expect((container.querySelector('[aria-label="Document content"]') as HTMLTextAreaElement).value).toBe('We ship in 2 days.')
    await typeInto(container.querySelector('[aria-label="Document content"]') as HTMLTextAreaElement, 'We ship in 1 day.')
    await act(async () => { button('Save changes')!.click() })
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/5/knowledge/1', { method: 'PUT', body: JSON.stringify({ title: 'Shipping', content: 'We ship in 1 day.' }) })
  })

  it('validates the budget and shows what a question would get', async () => {
    await render()
    await typeInto(container.querySelector('#kb-budget') as HTMLInputElement, '100')
    expect(button('Save')!.disabled).toBe(true)
    await typeInto(container.querySelector('[aria-label="Test question"]') as HTMLInputElement, 'how fast do you ship')
    await act(async () => { button('Search')!.click() })
    await flush()
    expect(container.querySelector('[aria-label="Passages"]')?.textContent).toContain('We ship in 2 days.')
    await typeInto(container.querySelector('[aria-label="Test question"]') as HTMLInputElement, 'zzz')
    await act(async () => { button('Search')!.click() })
    await flush()
    expect(container.textContent).toContain('Nothing matches')
  })

  it('is read-only without edit rights', async () => {
    await render(false)
    expect(container.querySelector('[aria-label="Document title"]')).toBeNull()
    expect(container.querySelector('[aria-label="Edit Shipping"]')).toBeNull()
    expect(container.querySelector('[aria-label="Test question"]')).not.toBeNull()
  })
})
