// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import { UsageAlertsCard } from './UsageAlertsCard'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

let stored = { webhookUrl: '', email: '', emailAvailable: false }
let container: HTMLDivElement
let root: Root
let client: QueryClient
let report = { enabled: false, lastSentWeek: null as string | null }
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  stored = { webhookUrl: '', email: '', emailAvailable: false }
  report = { enabled: false, lastSentWeek: '2026-10-26' }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/usage-report/preview')) return { text: 'Weekly usage report 2026-11-02 to 2026-11-08: 180 requests' } as never
    if (url.endsWith('/usage-report/send')) return { delivery: { webhook: { sent: true, status: 200 }, email: null } } as never
    if (url.endsWith('/usage-report')) { if (init?.method === 'PUT') report = JSON.parse(String(init.body)).enabled ? { enabled: true, lastSentWeek: null } : { enabled: false, lastSentWeek: null }; return report as never }
    if (url.endsWith('/test')) return { delivery: { webhook: stored.webhookUrl ? { sent: true, status: 204 } : null, email: null } } as never
    if (init?.method === 'PUT') { stored = { ...stored, ...JSON.parse(String(init.body)) }; return stored as never }
    return stored as never
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
async function render(canEdit: boolean) {
  await act(async () => root.render(<QueryClientProvider client={client}><UsageAlertsCard canEdit={canEdit} /></QueryClientProvider>))
  await flush()
}
const type = async (id: string, value: string) => {
  const el = container.querySelector(`#${id}`) as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement | undefined

describe('UsageAlertsCard', () => {
  it('saves the destinations and sends a test', async () => {
    await render(true)
    expect(button('Save')!.disabled).toBe(true)
    await type('alert-webhook', 'https://hooks.example.com/x')
    await type('alert-email', 'ops@example.com')
    expect(button('Send test alert')!.disabled).toBe(true) // save first
    await act(async () => { button('Save')!.click() })
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/settings/usage-alerts', { method: 'PUT', body: JSON.stringify({ webhookUrl: 'https://hooks.example.com/x', email: 'ops@example.com' }) })
    await act(async () => { button('Send test alert')!.click() })
    await flush()
    expect(container.querySelector('[role=status]')?.textContent).toContain('webhook answered 204')
  })

  it('switches the weekly report on, previews and sends it', async () => {
    await render(true)
    await flush() // the section loads its own settings once the card is shown
    expect(container.textContent).toContain('Last sent for the week of 2026-10-26')
    await act(async () => { (container.querySelector('[aria-label="Send a weekly report"]') as HTMLElement).click() })
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/settings/usage-report', { method: 'PUT', body: JSON.stringify({ enabled: true }) })
    await act(async () => { button('Preview')!.click() })
    await flush()
    expect(container.querySelector('[aria-label="Report preview"]')?.textContent).toContain('180 requests')
    await act(async () => { button('Send now')!.click() })
    await flush()
    expect(container.textContent).toContain('webhook answered 200')
  })

  it('refuses bad values', async () => {
    await render(true)
    await type('alert-webhook', 'ftp://x')
    expect(button('Save')!.disabled).toBe(true)
    expect(container.textContent).toContain('Use an http(s) address')
    await type('alert-webhook', '')
    await type('alert-email', 'not-an-email')
    expect(button('Save')!.disabled).toBe(true)
  })

  it('says when email cannot be sent', async () => {
    await render(true)
    expect(container.textContent).toContain('No Gmail sender is configured')
  })

  it('is read-only without edit rights', async () => {
    stored = { webhookUrl: 'https://hooks.example.com/x', email: '', emailAvailable: true }
    await render(false)
    expect((container.querySelector('#alert-webhook') as HTMLInputElement).value).toBe('https://hooks.example.com/x')
    expect((container.querySelector('#alert-webhook') as HTMLInputElement).disabled).toBe(true)
    expect(button('Save')).toBeUndefined()
    expect(container.textContent).toContain('configured Gmail sender')
  })
})
