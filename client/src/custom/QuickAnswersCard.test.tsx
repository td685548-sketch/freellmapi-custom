// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { QuickAnswersCard } from './QuickAnswersCard'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const state = () => ({ settings: { enabled: false, minSimilarity: 85 }, answers: [{ id: 3, questions: ['Phí ship bao nhiêu?'], answer: 'Ship 30.000đ', enabled: true, hits: 12, lastHitAt: null, updatedAt: '' }] })
let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    if (url.includes('/match')) return { match: url.includes('ship') ? { id: 3, answer: 'Ship 30.000đ', similarity: 91 } : null } as never
    if (url.endsWith('/quick-answers')) return state() as never
    return {} as never
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
async function render(canEdit = true) {
  await act(async () => root.render(<QueryClientProvider client={client}><QuickAnswersCard profileId={4} canEdit={canEdit} /></QueryClientProvider>))
  await flush()
}
const typeInto = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement | undefined

describe('QuickAnswersCard', () => {
  it('lists answers with their use count and adds one with several phrasings', async () => {
    await render()
    expect(container.querySelector('[aria-label="Answers"]')?.textContent).toContain('12 uses')
    await typeInto(container.querySelector('[aria-label="Questions"]') as HTMLTextAreaElement, 'Mấy giờ mở cửa?\n\n Giờ làm việc ')
    await typeInto(container.querySelector('[aria-label="Answer"]') as HTMLTextAreaElement, '9h–21h')
    await act(async () => { button('Add')!.click() })
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/4/quick-answers', { method: 'POST', body: JSON.stringify({ questions: ['Mấy giờ mở cửa?', 'Giờ làm việc'], answer: '9h–21h' }) })
  })

  it('checks what a message would get', async () => {
    await render()
    await typeInto(container.querySelector('[aria-label="Test message"]') as HTMLInputElement, 'phi ship')
    await act(async () => { button('Check')!.click() })
    await flush()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('91% match')
    await typeInto(container.querySelector('[aria-label="Test message"]') as HTMLInputElement, 'hello')
    await act(async () => { button('Check')!.click() })
    await flush()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('the AI would answer')
  })

  it('is read-only without edit rights', async () => {
    await render(false)
    expect(container.querySelector('[aria-label="Questions"]')).toBeNull()
    expect(container.querySelector('[aria-label="Delete answer 3"]')).toBeNull()
    expect(container.querySelector('[aria-label="Test message"]')).not.toBeNull()
  })
})
