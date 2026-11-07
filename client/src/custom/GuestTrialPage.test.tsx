// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { GuestTrialPage } from './GuestTrialPage'
import { GUEST_PROMPT_EVENT } from './guest-prompt'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/components/markdown', () => ({ Markdown: ({ children }: { children: string }) => <p>{children}</p> }))

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  vi.mocked(apiFetch).mockReset()
})
afterEach(() => { act(() => root.unmount()); container.remove() })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const type = async (value: string) => {
  const el = container.querySelector('[aria-label="Message"]') as HTMLTextAreaElement
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const sendButton = () => [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Send')) as HTMLButtonElement
async function render(models: string[] = ['llama-3.1-8b-instant', 'qwen3']) {
  await act(async () => root.render(<GuestTrialPage trial={{ models, perIpPerHour: 5, maxInputChars: 20 }} />))
}

describe('GuestTrialPage', () => {
  it('chats with the chosen model, sending the turns so far, and shows what is left', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ reply: 'Chào bạn!', model: 'qwen3', error: null, remaining: { hour: 4, perHour: 5 } } as never)
    await render()
    const select = container.querySelector('[aria-label="Model"]') as HTMLSelectElement
    await act(async () => { select.value = 'qwen3'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await type('Xin chào')
    await act(async () => { sendButton().click() })
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/guest/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Xin chào' }], model: 'qwen3' }) })
    expect(container.querySelector('[aria-label="Guest chat"]')!.textContent).toContain('Chào bạn!')
    expect(container.querySelector('[data-testid="trial-left"]')!.textContent).toBe('4 of 5 messages left this hour')
    await type('Bạn là ai?')
    await act(async () => { sendButton().click() })
    await flush()
    const second = JSON.parse((vi.mocked(apiFetch).mock.calls[1]![1] as { body: string }).body)
    expect(second.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('asks to sign in when the hour is used up, and keeps the message', async () => {
    const asked = vi.fn()
    window.addEventListener(GUEST_PROMPT_EVENT, asked)
    vi.mocked(apiFetch).mockRejectedValue(Object.assign(new Error('limit'), { status: 429, code: 'guest_trial_hourly_limit' }))
    await render(['llama-3.1-8b-instant'])
    await type('Hello')
    await act(async () => { sendButton().click() })
    await flush()
    expect(asked).toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('Sign in to keep chatting')
    expect((container.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Hello')
    expect(sendButton().disabled).toBe(true)
    window.removeEventListener(GUEST_PROMPT_EVENT, asked)
  })

  it('refuses a message over the length limit', async () => {
    await render()
    await type('x'.repeat(21))
    expect(sendButton().disabled).toBe(true)
  })
})
