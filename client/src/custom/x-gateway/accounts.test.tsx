// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import type { ProviderAccountsResponse, ProviderAccount, ProviderAccountPollResponse } from '../../../../shared/x-accounts'
import Providers from './pages/Providers'
import ProviderAccounts from './pages/ProviderAccounts'
import { ConnectAccountDialog } from './ConnectAccountDialog'
import { AccountCallback } from './AccountCallback'
import { trustedLoginUrl } from './api'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/components/toaster', () => ({ Toaster: () => null }))
const actor = vi.hoisted(() => ({ permissions: [] as string[] }))
vi.mock('../use-session', () => ({
  useUserSession: () => ({
    isPending: false,
    session: { email: 'fixture@example.test' },
    hasPermission: (p: string) => actor.permissions.includes(p),
  }),
}))

class FakeChannel {
  static instances: FakeChannel[] = []
  name: string
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: unknown[] = []
  closed = false
  constructor(name: string) { this.name = name; FakeChannel.instances.push(this) }
  postMessage(data: unknown) { this.sent.push(data) }
  close() { this.closed = true }
}

function account(id: number, overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id, provider: 'openrouter', label: `Account ${id}`, identity: null, authMethod: 'oauth_pkce',
    enabled: true, status: 'healthy', monthlyUsage: { requests: 3, tokens: 30 },
    monthlyRequestCap: 100, monthlyTokenCap: 1000,
    models: [{ id: 'fixture-chat', name: 'Fixture Chat' }], ...overrides,
  }
}
function fixture(): ProviderAccountsResponse {
  return {
    providers: [
      { id: 'openrouter', name: 'OpenRouter', authMethods: ['api_key', 'oauth_pkce'], accounts: [account(1, { label: 'Work' }), account(2, { label: 'Personal', enabled: false, status: 'unknown' })] },
      { id: 'github-copilot', name: 'GitHub Copilot', authMethods: ['device_code'], accounts: [] },
      { id: 'groq', name: 'Groq', authMethods: ['api_key'], accounts: [] },
    ],
    permissions: { add: true, edit: true, delete: true, test: true, manageModels: true },
  }
}

let data: ProviderAccountsResponse
let pollResults: ProviderAccountPollResponse[]
let startExpires: number
let loadError: boolean
let root: Root
let container: HTMLDivElement
let client: QueryClient
const onClose = vi.fn()

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  FakeChannel.instances = []
  data = fixture()
  pollResults = []
  startExpires = 600_000
  loadError = false
  actor.permissions = ['use_x_gateway', 'view_keys', 'add_keys', 'edit_keys', 'delete_keys', 'test_keys', 'manage_key_models', 'manage_compression']
  onClose.mockReset()
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/x-accounts' && (!init?.method || init.method === 'GET')) {
      if (loadError) throw new Error('offline')
      return structuredClone(data)
    }
    if (path === '/api/x-accounts' && init?.method === 'POST') return { id: 99 }
    if (path.endsWith('/start')) {
      return path.includes('/openrouter/')
        ? { flow: 'oauth_pkce', attemptId: 'attempt-1', authorizationUrl: 'https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A3000%2Fx%2Faccounts%2Fcallback%3FattemptId%3Dattempt-1', expiresAt: Date.now() + startExpires }
        : { flow: 'device_code', attemptId: 'attempt-1', verificationUri: 'https://github.com/login/device', userCode: 'FIXT-URE1', interval: 1, expiresAt: Date.now() + startExpires }
    }
    if (path.endsWith('/poll')) return pollResults.shift() ?? { status: 'pending', interval: 1 }
    if (path.endsWith('/complete')) return { status: 'connected', accountId: 99 }
    if (path.endsWith('/test')) return { ok: true }
    return undefined
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
async function waitFor(predicate: () => boolean, timeout = 4000) {
  const deadline = Date.now() + timeout
  while (!predicate() && Date.now() < deadline) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(predicate()).toBe(true)
}
function mount(node: React.ReactNode, path = '/x/providers') {
  act(() => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  ))
}
function providerRoute() {
  return <Routes><Route path="/x/providers/:providerId" element={<ProviderAccounts />} /></Routes>
}
function enter(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function click(el: Element) {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}
function submit(form: HTMLFormElement) {
  act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}
const body = () => document.body
const button = (text: string) => [...body().querySelectorAll('button')].find(b => b.textContent?.includes(text))!

describe('trusted login URLs', () => {
  it('only accepts the pinned provider hosts over https without credentials or ports', () => {
    expect(trustedLoginUrl('https://openrouter.ai/auth?x=1', 'openrouter')).toBe('https://openrouter.ai/auth?x=1')
    expect(trustedLoginUrl('https://github.com/login/device', 'github-copilot')).toBe('https://github.com/login/device')
    for (const bad of ['http://openrouter.ai/auth', 'https://evil.test/auth', 'https://openrouter.ai.evil.test/auth', 'https://u:p@openrouter.ai/auth', 'https://openrouter.ai:8443/auth', 'https://groq.com/auth']) {
      expect(trustedLoginUrl(bad, 'openrouter')).toBeNull()
    }
    expect(trustedLoginUrl('https://github.com/login/device', 'groq')).toBeNull()
  })
})

describe('provider catalog', () => {
  it('shows real counts, filters by account, and never offers fake browser login for API-only providers', async () => {
    mount(<Providers />)
    await flush()
    expect(container.textContent).toContain('OpenRouter')
    expect(container.textContent).toContain('2')
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
    enter(search, 'Personal')
    await flush()
    expect(container.textContent).toContain('OpenRouter')
    expect(container.textContent).not.toContain('GitHub Copilot')
    enter(search, '')
    click(button('Connected'))
    await flush()
    expect(container.textContent).not.toContain('Groq')
    click(button('All providers'))
    await flush()
    const groqCard = [...container.querySelectorAll('a')].find(a => a.textContent?.includes('Groq'))!
    expect(groqCard.textContent).toContain('API key')
    expect(groqCard.textContent).not.toContain('Browser login')
    const logoSources = [...container.querySelectorAll<HTMLImageElement>('.x-provider-mark-logo img')].map(img => img.getAttribute('src'))
    expect(logoSources).toContain('/providers/openrouter.png')
    expect(logoSources).toContain('/providers/copilot.png')
    expect(logoSources).toContain('/providers/groq.png')

    // Filter by Login (OAuth) vs API key
    click(button('Login (OAuth)'))
    await flush()
    expect(container.textContent).toContain('OpenRouter')
    expect(container.textContent).toContain('GitHub Copilot')
    expect(container.textContent).not.toContain('Groq')

    click(button('API key'))
    await flush()
    expect(container.textContent).toContain('Groq')
    expect(container.textContent).not.toContain('GitHub Copilot')

    click(button('All types'))
    await flush()
    expect(container.textContent).toContain('Groq')
    expect(container.textContent).toContain('GitHub Copilot')
  })

  it('hides providers that already have API keys in the main DB by default and shows them when toggled', async () => {
    data.providers[2].hasMainDbKey = true
    mount(<Providers />)
    await flush()
    expect(container.textContent).toContain('OpenRouter')
    expect(container.textContent).not.toContain('Groq')
    expect(container.textContent).toContain('Hide main DB (1)')

    click(button('Show all DBs'))
    await flush()
    expect(container.textContent).toContain('Groq')
    expect(container.textContent).toContain('In main DB')
  })

  it('surfaces a load error with a working retry', async () => {
    loadError = true
    mount(<Providers />)
    await flush()
    expect(container.textContent).toContain('Could not load providers.')
    loadError = false
    click(button('Try again'))
    await flush()
    expect(container.textContent).toContain('OpenRouter')
  })
})

describe('provider accounts', () => {
  it('hides every mutation in read-only mode and dedupes models with keyboard tabs', async () => {
    data.permissions = { add: false, edit: false, delete: false, test: false, manageModels: false }
    data.providers[0].accounts = [account(1), account(2, { models: [{ id: 'fixture-chat', name: 'Fixture Chat' }] })]
    mount(providerRoute(), '/x/providers/openrouter')
    await flush()
    expect(body().querySelector('[role="switch"]')).toBeNull()
    expect(body().textContent).not.toContain('Add account')
    expect(body().textContent).not.toContain('Sign in again')
    const tabs = [...body().querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs[0].tabIndex).toBe(0)
    act(() => { tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    await flush()
    expect(body().querySelector('[role="tabpanel"]')?.id).toBe('x-models-panel')
    expect(body().querySelectorAll('#x-models-panel > div')).toHaveLength(1)
  })

  it('requires manage_key_models before reconnecting Copilot', async () => {
    data.permissions.manageModels = false
    data.providers[1].accounts = [account(3, { provider: 'github-copilot', authMethod: 'device_code', identity: '11' })]
    mount(providerRoute(), '/x/providers/github-copilot')
    await flush()
    expect(body().textContent).not.toContain('Sign in again')
    expect(body().textContent).not.toContain('Add account')
  })

  it('toggles, tests, renames and deletes only after confirmation', async () => {
    mount(providerRoute(), '/x/providers/openrouter')
    await flush()
    click(body().querySelector('[role="switch"]')!)
    await flush()
    expect(vi.mocked(apiFetch).mock.calls.some(([p, i]) => p === '/api/x-accounts/1' && i?.method === 'PATCH' && JSON.parse(String(i.body)).enabled === false)).toBe(true)
    click(button('Check connection'))
    await flush()
    expect(body().textContent).toContain('Connection is valid')
    click(body().querySelector('[aria-label="Edit account: Work"]')!)
    await flush()
    const nameInput = body().querySelector<HTMLInputElement>('.x-dialog input[maxlength="100"]')!
    enter(nameInput, 'Renamed')
    submit(nameInput.closest('form')!)
    await flush()
    expect(vi.mocked(apiFetch).mock.calls.some(([p, i]) => p === '/api/x-accounts/1' && i?.method === 'PATCH' && JSON.parse(String(i.body)).label === 'Renamed')).toBe(true)
    click(body().querySelector('[aria-label="Remove: Work"]')!)
    await flush()
    expect(vi.mocked(apiFetch).mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(false)
    click(body().querySelector('.x-destructive')!)
    await flush()
    expect(vi.mocked(apiFetch).mock.calls.some(([p, i]) => p === '/api/x-accounts/1' && i?.method === 'DELETE')).toBe(true)
  })
})

describe('connect dialog', () => {
  it('stores an API key through the dedicated X Gateway endpoint and clears it from the form', async () => {
    const groq = data.providers[2]
    mount(<ConnectAccountDialog provider={groq} onClose={onClose} />)
    await flush()
    enter(body().querySelector<HTMLInputElement>('.x-dialog input[maxlength="100"]')!, 'My Groq')
    enter(body().querySelector<HTMLInputElement>('input[type="password"]')!, '  gsk_fixture  ')
    submit(body().querySelector<HTMLFormElement>('.x-dialog form')!)
    await flush()
    const call = vi.mocked(apiFetch).mock.calls.find(([p, i]) => p === '/api/x-accounts' && i?.method === 'POST')!
    expect(JSON.parse(String(call[1]!.body))).toEqual({ provider: 'groq', key: 'gsk_fixture', label: 'My Groq' })
    expect(onClose).toHaveBeenCalled()
  })

  it('starts OpenRouter PKCE with a same-origin callback and validates a manual callback', async () => {
    const openrouter = data.providers[0]
    mount(<ConnectAccountDialog provider={openrouter} onClose={onClose} />)
    await flush()
    enter(body().querySelector<HTMLInputElement>('.x-dialog input[maxlength="100"]')!, 'Work login')
    submit(body().querySelector<HTMLFormElement>('.x-dialog form')!)
    await flush()
    const start = vi.mocked(apiFetch).mock.calls.find(([p]) => p.endsWith('/start'))!
    expect(JSON.parse(String(start[1]!.body))).toEqual({ label: 'Work login', callbackUrl: `${window.location.origin}/x/accounts/callback` })
    const link = body().querySelector<HTMLAnchorElement>('a[target="_blank"]')!
    expect(link.href).toContain('https://openrouter.ai/auth')
    expect(link.rel).toContain('noopener')
    const manual = body().querySelector<HTMLInputElement>('input[type="url"]')!
    enter(manual, `${window.location.origin}/x/accounts/callback?attemptId=other&code=x`)
    submit(manual.closest('form')!)
    await flush()
    expect(vi.mocked(apiFetch).mock.calls.some(([p]) => p.endsWith('/complete'))).toBe(false)
    expect(body().textContent).toContain('does not belong to the current login attempt')
    enter(manual, `${window.location.origin}/x/accounts/callback?attemptId=attempt-1&code=fixture-code`)
    submit(manual.closest('form')!)
    await flush()
    const complete = vi.mocked(apiFetch).mock.calls.find(([p]) => p.endsWith('/complete'))!
    expect(JSON.parse(String(complete[1]!.body))).toEqual({ code: 'fixture-code' })
    expect(onClose).toHaveBeenCalled()
  })

  it('cancels the pending attempt when the dialog unmounts', async () => {
    const openrouter = data.providers[0]
    mount(<ConnectAccountDialog provider={openrouter} onClose={onClose} />)
    await flush()
    enter(body().querySelector<HTMLInputElement>('.x-dialog input[maxlength="100"]')!, 'Work login')
    submit(body().querySelector<HTMLFormElement>('.x-dialog form')!)
    await flush()
    act(() => root.unmount())
    await flush()
    expect(vi.mocked(apiFetch).mock.calls.some(([p, i]) => p === '/api/x-accounts/auth/attempt-1' && i?.method === 'DELETE')).toBe(true)
    root = createRoot(container)
  })

  it('polls a device code until connected and stops on expiry', async () => {
    pollResults = [{ status: 'pending', interval: 1 }, { status: 'connected', accountId: 99 }]
    const copilot = data.providers[1]
    mount(<ConnectAccountDialog provider={copilot} onClose={onClose} />)
    await flush()
    enter(body().querySelector<HTMLInputElement>('.x-dialog input[maxlength="100"]')!, 'Copilot')
    submit(body().querySelector<HTMLFormElement>('.x-dialog form')!)
    await flush()
    expect(body().textContent).toContain('FIXT-URE1')
    await waitFor(() => onClose.mock.calls.length > 0)
    expect(vi.mocked(apiFetch).mock.calls.filter(([p]) => p.endsWith('/poll')).length).toBe(2)
  })

  it('extracts accessToken from pasted CLI credentials JSON for OAuth CLI providers', async () => {
    const claudeProvider = { id: 'claude', name: 'Claude Code', category: 'oauth' as const, authMethods: ['api_key' as const], accounts: [] }
    mount(<ConnectAccountDialog provider={claudeProvider} onClose={onClose} />)
    await flush()
    expect(body().textContent).toContain('claude setup-token')
    enter(body().querySelector<HTMLInputElement>('.x-dialog input[maxlength="100"]')!, 'My Claude')
    const textarea = body().querySelector<HTMLTextAreaElement>('#x-account-credential')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-fixture"}}')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    submit(body().querySelector<HTMLFormElement>('.x-dialog form')!)
    await flush()
    const call = vi.mocked(apiFetch).mock.calls.find(([p, i]) => p === '/api/x-accounts' && i?.method === 'POST')!
    expect(JSON.parse(String(call[1]!.body))).toEqual({ provider: 'claude', key: 'sk-ant-oat01-fixture', label: 'My Claude' })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows expiry and stops polling when the attempt expires', async () => {
    startExpires = 40
    pollResults = [{ status: 'pending', interval: 1 }]
    const copilot = data.providers[1]
    mount(<ConnectAccountDialog provider={copilot} onClose={onClose} />)
    await flush()
    enter(body().querySelector<HTMLInputElement>('.x-dialog input[maxlength="100"]')!, 'Copilot')
    submit(body().querySelector<HTMLFormElement>('.x-dialog form')!)
    await flush()
    await waitFor(() => body().textContent!.includes('expired'))
    const polls = vi.mocked(apiFetch).mock.calls.filter(([p]) => p.endsWith('/poll')).length
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1200)) })
    expect(vi.mocked(apiFetch).mock.calls.filter(([p]) => p.endsWith('/poll')).length).toBe(polls)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('OAuth callback', () => {
  it('exchanges the code once under StrictMode, strips it from the URL and notifies the opener', async () => {
    window.history.replaceState(null, '', '/x/accounts/callback?attemptId=attempt-1&code=fixture-code')
    mount(<StrictMode><AccountCallback /></StrictMode>, '/x/accounts/callback')
    await flush()
    await waitFor(() => container.textContent!.includes('Account connected'))
    expect(vi.mocked(apiFetch).mock.calls.filter(([p]) => p.endsWith('/complete'))).toHaveLength(1)
    expect(window.location.search).toBe('')
    const channel = FakeChannel.instances.find(c => c.name === 'x-provider-connections')!
    expect(channel.sent).toEqual([{ attemptId: 'attempt-1', status: 'connected' }])
    expect(channel.closed).toBe(true)
  })

  it('reports denial or missing parameters without exchanging a code', async () => {
    window.history.replaceState(null, '', '/x/accounts/callback?error=access_denied&code=fixture-code')
    mount(<AccountCallback />, '/x/accounts/callback')
    await flush()
    expect(container.textContent).toContain('Could not complete the connection.')
    expect(vi.mocked(apiFetch).mock.calls.some(([p]) => p.endsWith('/complete'))).toBe(false)
  })
})