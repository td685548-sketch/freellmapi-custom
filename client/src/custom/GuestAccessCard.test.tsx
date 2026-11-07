// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { GuestAccessCard } from './GuestAccessCard'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const available = [
  { key: 'view_models', title: 'Models and token budget', description: 'd' },
  { key: 'view_usage_profiles', title: 'Client key ranking', description: 'd' },
  { key: 'view_usage_accounts', title: 'Account ranking', description: 'shows every account email', warning: true },
  { key: 'try_playground', title: 'Try the chat', description: 'spends provider quota', warning: true },
]
const trial = { perIpPerHour: 5, dailyCap: 200, maxTokens: 512, maxInputChars: 2000, models: [] as string[] }
let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (_url: string, init?: RequestInit) => ({ permissions: init?.body ? JSON.parse(String(init.body)).permissions : [], available, trial }) as never)
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
async function render(canEdit: boolean) {
  await act(async () => root.render(<QueryClientProvider client={client}><GuestAccessCard canEdit={canEdit} /></QueryClientProvider>))
  await flush()
}

describe('GuestAccessCard', () => {
  it('opens read-only views to guests', async () => {
    await render(true)
    expect(container.textContent).toContain('shows every account email')
    await act(async () => { (container.querySelector('[aria-label="Models and token budget"]') as HTMLInputElement).click() })
    await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Save')!.click() })
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/admin/guest-access', { method: 'PUT', body: JSON.stringify({ permissions: ['view_models'] }) })
  })

  it('shows the trial limits once the chat is ticked and saves them with it', async () => {
    await render(true)
    expect(container.querySelector('[aria-label="Trial chat limits"]')).toBeNull()
    await act(async () => { (container.querySelector('[aria-label="Try the chat"]') as HTMLInputElement).click() })
    expect(container.querySelector('[aria-label="Trial chat limits"]')).not.toBeNull()
    const set = async (label: string, value: string, proto: typeof HTMLInputElement.prototype | typeof HTMLTextAreaElement.prototype = HTMLInputElement.prototype) => {
      const el = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
      await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    await set('Messages per visitor (IP) per hour', '3')
    await set('Trial models', 'llama-3.1-8b-instant\n\nqwen3', HTMLTextAreaElement.prototype)
    await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Save')!.click() })
    await flush()
    expect(apiFetch).toHaveBeenLastCalledWith('/api/admin/guest-access', { method: 'PUT', body: JSON.stringify({ permissions: ['try_playground'], trial: { perIpPerHour: 3, dailyCap: 200, maxTokens: 512, maxInputChars: 2000, models: ['llama-3.1-8b-instant', 'qwen3'] } }) })
    await set('Messages per visitor (IP) per hour', '0')
    expect([...container.querySelectorAll('button')].find(b => b.textContent === 'Save')!.disabled).toBe(true)
  })

  it('is read-only without the permission-assigning right', async () => {
    await render(false)
    expect((container.querySelector('[aria-label="Models and token budget"]') as HTMLInputElement).disabled).toBe(true)
    expect([...container.querySelectorAll('button')].find(b => b.textContent === 'Save')).toBeUndefined()
  })
})
