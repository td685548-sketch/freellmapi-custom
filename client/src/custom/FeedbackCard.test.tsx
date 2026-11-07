// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { FeedbackCard } from './FeedbackCard'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    if (url.endsWith('/comments')) return { comments: [{ id: 1, rating: 'down', comment: 'Sai giá ship', model: 'llama', endUser: 'khách-1', conversationId: 'c-1', createdAt: '2026-11-07T00:00:00.000Z' }] } as never
    return { summary: { days: 30, up: 6, down: 2, byModel: [{ model: 'qwen3', up: 5, down: 0 }, { model: null, up: 1, down: 2 }], byDay: [] } } as never
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
async function render(canReadComments = true) {
  await act(async () => root.render(<QueryClientProvider client={client}><FeedbackCard profileId={2} canReadComments={canReadComments} /></QueryClientProvider>))
  await flush()
}

describe('FeedbackCard', () => {
  it('shows satisfaction overall and per model, and comments', async () => {
    await render()
    expect(container.querySelector('[data-testid="feedback-total"]')?.textContent).toBe('6275% satisfied')
    const models = container.querySelector('[aria-label="Feedback per model"]')!.textContent!
    expect(models).toContain('qwen3')
    expect(models).toContain('100% satisfied')
    expect(models).toContain('model not reported')
    expect(container.querySelector('[aria-label="Comments"]')?.textContent).toContain('Sai giá ship')
  })

  it('switches the range and hides comments from viewers', async () => {
    await render(false)
    expect(container.querySelector('[aria-label="Comments"]')).toBeNull()
    expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).endsWith('/comments'))).toBe(false)
    await act(async () => { [...container.querySelectorAll('[role="tab"]')].find(b => b.textContent === '7 days')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/2/feedback?days=7')
  })
})
