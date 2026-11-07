// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { ProfileIntegrationCard } from './ProfileIntegrationCard'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn(async () => true) }))

const good = { result: { status: 200, ok: true, latencyMs: 321, model: 'qwen/qwen3-32b', platform: 'groq', reply: 'I am working.', usage: { inputTokens: 12, outputTokens: 4 }, error: null, retryAfter: null }, profileEnabled: true }
const refused = { result: { status: 403, ok: false, latencyMs: 4, model: null, platform: null, reply: null, usage: null, retryAfter: null, error: { message: "This key may not use the model 'x'.", code: 'model_not_allowed', type: 'permission_error' } }, profileEnabled: true }

let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
async function render(canTest: boolean) {
  await act(async () => root.render(<QueryClientProvider client={client}><ProfileIntegrationCard profileId={7} canTest={canTest} /></QueryClientProvider>))
}
const setInput = async (label: string, value: string) => {
  const el = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement
const send = () => act(async () => { button('Send test').click(); await new Promise(r => setTimeout(r, 0)) })

describe('ProfileIntegrationCard', () => {
  it('shows the server address and switches the example language', async () => {
    await render(false)
    expect(container.querySelector('[data-testid="base-url"]')?.textContent).toBe(`${window.location.origin}/v1`)
    expect(container.querySelector('pre')?.textContent).toContain('process.env.FREELLM_KEY')
    await act(async () => { (container.querySelector('[role=tab]:nth-child(1)') as HTMLElement).click() })
    expect(container.querySelector('pre')?.textContent).toContain('curl ')
    await act(async () => { ([...container.querySelectorAll('[role=tab]')].find(t => t.textContent === 'Python') as HTMLElement).click() })
    expect(container.querySelector('pre')?.textContent).toContain('from openai import OpenAI')
    expect(container.querySelector('pre')?.textContent).toContain(`${window.location.origin}/v1`)
  })

  it('has no test form for a viewer', async () => {
    await render(false)
    expect(container.querySelector('[aria-label="Test message"]')).toBeNull()
    expect(button('Send test')).toBeUndefined()
  })

  it('sends the test with the typed message and model and shows a working result', async () => {
    vi.mocked(apiFetch).mockResolvedValue(good)
    await render(true)
    await setInput('Test message', 'Is it up?')
    await setInput('Test model', 'qwen/qwen3-32b')
    await send()
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/7/test', { method: 'POST', body: JSON.stringify({ message: 'Is it up?', model: 'qwen/qwen3-32b' }) })
    const status = container.querySelector('[role="status"]')!.textContent!
    expect(status).toContain('Working')
    expect(status).toContain('321 ms')
    expect(status).toContain('qwen/qwen3-32b')
    expect(status).toContain('(groq)')
    expect(status).toContain('12 in / 4 out')
    expect(status).toContain('I am working.')
  })

  it('can ask for a streamed answer and shows how the stream behaved', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ result: { ...good.result, stream: { firstTokenMs: 180, chunks: 7, finished: true } }, profileEnabled: true })
    await render(true)
    await act(async () => { (container.querySelector('[aria-label="Stream the answer"]') as HTMLInputElement).click() })
    await send()
    expect(JSON.parse((vi.mocked(apiFetch).mock.calls[0]![1] as { body: string }).body).stream).toBe(true)
    expect(container.querySelector('[data-testid="stream-stats"]')!.textContent).toBe('Streamed: first text after 180 ms · 7 frames · ended properly')
  })

  it('leaves the model out when it is blank', async () => {
    vi.mocked(apiFetch).mockResolvedValue(good)
    await render(true)
    await send()
    const body = JSON.parse((vi.mocked(apiFetch).mock.calls[0]![1] as { body: string }).body)
    expect(body.model).toBeUndefined()
    expect(body.message).toContain('working')
  })

  it('explains a refusal', async () => {
    vi.mocked(apiFetch).mockResolvedValue(refused)
    await render(true)
    await setInput('Test model', 'x')
    await send()
    const status = container.querySelector('[role="status"]')!.textContent!
    expect(status).toContain('Refused or failed (403)')
    expect(status).toContain('model_not_allowed')
    expect(status).toContain('Restrictions')
  })

  it('reports when the test itself could not run', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('Permission denied'))
    await render(true)
    await send()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Permission denied')
  })
})
