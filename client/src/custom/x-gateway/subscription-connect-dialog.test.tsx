// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { SubscriptionConnectDialog } from './SubscriptionConnectDialog'
import type { AccountProvider } from '../../../../shared/x-accounts'
import { subscriptionApi } from './subscription-api'

vi.mock('./subscription-api', () => ({
  subscriptionApi: {
    start: vi.fn(),
    complete: vi.fn(),
    poll: vi.fn(),
    cancel: vi.fn(),
    import: vi.fn(),
    bulkImport: vi.fn(),
  },
}))
vi.mock('./api', () => ({
  accountsApi: { addKey: vi.fn(), addBulkKeys: vi.fn() },
  refreshAccounts: vi.fn(),
}))
vi.mock('./proxy-pool-api', () => ({
  proxyPoolApi: { list: vi.fn(async () => ({ entries: [] })) },
}))
vi.mock('../session-state', () => ({ useSessionRevision: () => 0 }))

// Qwen's browser flow is token_paste (it just opens chat.qwen.ai — no device
// code, no OAuth redirect), so the dialog must not tell the user to enter a
// device code. The device-code sentence stays for real device_code flows.
let root: Root
let container: HTMLDivElement
const onClose = vi.fn()

const qwenProvider: AccountProvider = { id: 'qwen', name: 'Qwen', authMethods: ['api_key', 'oauth_pkce'], accounts: [] }
const kiroProvider: AccountProvider = { id: 'kiro', name: 'Kiro', authMethods: ['api_key', 'device_code'], accounts: [] }

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  vi.mocked(subscriptionApi.start).mockReset()
  vi.mocked(subscriptionApi.poll).mockReset().mockResolvedValue({ status: 'pending', interval: 5 })
  vi.mocked(subscriptionApi.cancel).mockReset().mockResolvedValue(undefined)
  onClose.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

function mount(provider: AccountProvider) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  act(() => root.render(<QueryClientProvider client={client}><I18nProvider initialLocale="en"><SubscriptionConnectDialog provider={provider} onClose={onClose} /></I18nProvider></QueryClientProvider>))
}
function enter(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
async function clickSignIn() {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Sign in with browser'))!
  expect(button.disabled).toBe(false)
  await act(async () => { button.click() })
  await flush()
}

describe('SubscriptionConnectDialog Qwen copy', () => {
  it('tells the user Qwen Code sign-in needs Plus/Pro and points free accounts at a DashScope Standard key', () => {
    mount(qwenProvider)
    expect(document.body.textContent).toContain('Qwen Code sign-in needs a paid Plus/Pro plan')
    expect(document.body.textContent).toContain('DashScope Standard API key')
  })

  it('shows token-paste guidance instead of a device code after browser sign-in', async () => {
    vi.mocked(subscriptionApi.start).mockResolvedValue({
      attemptId: 'sub_qwen',
      flow: 'oauth_pkce',
      authorizationUrl: 'https://chat.qwen.ai',
      expiresAt: Date.now() + 600_000,
    })
    mount(qwenProvider)
    await flush()
    enter(document.querySelector('input')!, 'My Qwen')
    await clickSignIn()
    expect(document.body.textContent).toContain('Sign in at chat.qwen.ai, then paste your Qwen token or ~/.qwen/oauth_creds.json below.')
    expect(document.body.textContent).not.toContain('enter this device code')
    expect(document.body.textContent).toContain('Qwen token or ~/.qwen/oauth_creds.json')
  })

  it('still shows the device-code text for a real device-code flow', async () => {
    vi.mocked(subscriptionApi.start).mockResolvedValue({
      attemptId: 'sub_kiro',
      flow: 'device_code',
      verificationUri: 'https://example.com/verify',
      userCode: 'ABCD-EFGH',
      interval: 5,
      expiresAt: Date.now() + 600_000,
    })
    mount(kiroProvider)
    await flush()
    enter(document.querySelector('input')!, 'My Kiro')
    await clickSignIn()
    expect(document.body.textContent).toContain('Open the verification page and enter this device code.')
    expect(document.body.textContent).toContain('ABCD-EFGH')
  })
})
