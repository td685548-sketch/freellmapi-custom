// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { ProfileRestrictionsCard } from './ProfileRestrictionsCard'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const catalog = [{ modelId: 'Llama-3.3-70b-versatile' }, { modelId: 'llama-3.3-70b-versatile' }, { modelId: 'qwen/qwen3-32b' }]
const answer = (restrictions: { allowedModels: string[]; maxTokens: number | null }) =>
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/models')) return catalog as never
    if (init?.method === 'PUT') return { restrictions: JSON.parse(String(init.body)) } as never
    return { restrictions } as never
  })

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
async function render(canEdit: boolean) {
  await act(async () => root.render(<QueryClientProvider client={client}><ProfileRestrictionsCard profileId={4} canEdit={canEdit} /></QueryClientProvider>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const setInput = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const modelInput = () => container.querySelector('[aria-label="Add a model"]') as HTMLInputElement
const maxInput = () => container.querySelector('#profile-max-tokens') as HTMLInputElement
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement
const chips = () => [...container.querySelectorAll('[aria-label="Allowed models"] li')].map(li => li.textContent?.trim())

describe('ProfileRestrictionsCard', () => {
  it('shows the saved restrictions and suggests catalog models', async () => {
    answer({ allowedModels: ['qwen/qwen3-32b'], maxTokens: 512 })
    await render(true)
    expect(chips()).toEqual(['qwen/qwen3-32b'])
    expect(maxInput().value).toBe('512')
    expect([...container.querySelectorAll('datalist option')].map(o => o.getAttribute('value'))).toEqual(['llama-3.3-70b-versatile', 'qwen/qwen3-32b'])
  })

  it('adds and removes models and saves the list with the cap', async () => {
    answer({ allowedModels: [], maxTokens: null })
    await render(true)
    expect(container.textContent).toContain('Any model.')
    expect(button('Save restrictions').disabled).toBe(true)
    await setInput(modelInput(), '  Llama-3.3-70B-Versatile ')
    await act(async () => { button('Add').click() })
    await setInput(modelInput(), 'qwen/qwen3-32b')
    await act(async () => { button('Add').click() })
    await setInput(modelInput(), 'qwen/qwen3-32b') // a duplicate is ignored
    await act(async () => { button('Add').click() })
    expect(chips()).toEqual(['llama-3.3-70b-versatile', 'qwen/qwen3-32b'])
    await act(async () => { (container.querySelector('[aria-label="Remove qwen/qwen3-32b"]') as HTMLElement).click() })
    await setInput(maxInput(), '256')
    await act(async () => { button('Save restrictions').click() })
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/4/restrictions', { method: 'PUT', body: JSON.stringify({ allowedModels: ['llama-3.3-70b-versatile'], maxTokens: 256 }) })
    expect(button('Save restrictions').disabled).toBe(true) // saved: nothing pending
  })

  it('an empty cap field means no cap, and bad numbers cannot be saved', async () => {
    answer({ allowedModels: [], maxTokens: 100 })
    await render(true)
    for (const bad of ['0', '-1', '1.5', 'abc', '1000001']) {
      await setInput(maxInput(), bad)
      expect(button('Save restrictions').disabled, bad).toBe(true)
    }
    await setInput(maxInput(), '')
    await act(async () => { button('Save restrictions').click() })
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/4/restrictions', { method: 'PUT', body: JSON.stringify({ allowedModels: [], maxTokens: null }) })
  })

  it('is read-only without edit rights', async () => {
    answer({ allowedModels: ['qwen/qwen3-32b'], maxTokens: 512 })
    await render(false)
    expect(chips()).toEqual(['qwen/qwen3-32b'])
    expect(modelInput()).toBeNull()
    expect(container.querySelector('[aria-label^="Remove"]')).toBeNull()
    expect(maxInput().disabled).toBe(true)
    expect(button('Save restrictions')).toBeUndefined()
    expect(apiFetch).not.toHaveBeenCalledWith('/api/models')
  })

  it('renders nothing for an unexpected answer', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ analytics: {} })
    await render(true)
    expect(container.textContent).toBe('')
  })
})
