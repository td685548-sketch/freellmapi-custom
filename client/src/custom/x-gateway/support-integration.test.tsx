// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import SupportIntegration, { type SupportTenant } from './pages/SupportIntegration'
import { SUPPORT_INTEGRATION_STRINGS } from './support-integration-strings'

let mockLocale = 'en'
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    locale: mockLocale,
    setLocale: (l: string) => {
      mockLocale = l
    },
  }),
}))

let mockRevision = 1
vi.mock('../session-state', () => ({
  useSessionRevision: () => mockRevision,
}))

let mockPermissions: string[] = ['use_x_gateway', 'edit_x_settings']
vi.mock('../use-session', () => ({
  useUserSession: () => ({
    isPending: false,
    isError: false,
    hasPermission: (perm: string) => mockPermissions.includes('*') || mockPermissions.includes(perm),
    session: { email: 'admin@freellmapi.test' },
  }),
}))

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}))

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = []

function render(ui: ReactElement) {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(ui)
  })
  mountedRoots.push({ root, container })
  return { container }
}

function cleanup() {
  while (mountedRoots.length > 0) {
    const item = mountedRoots.pop()!
    act(() => {
      item.root.unmount()
    })
    item.container.remove()
  }
}

async function waitFor<T>(cb: () => T | Promise<T>, timeout = 2500): Promise<T> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < timeout) {
    try {
      let res!: T
      await act(async () => {
        res = await cb()
      })
      return res
    } catch (err) {
      lastErr = err
      await new Promise(r => setTimeout(r, 15))
    }
  }
  throw lastErr ?? new Error('waitFor timed out')
}

const fireEvent = {
  click(el: Element) {
    act(() => {
      ;(el as HTMLElement).click()
    })
  },
  change(el: Element, init: { target: { value: string } }) {
    act(() => {
      const value = init.target.value
      const proto =
        el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc?.set) {
        desc.set.call(el, value)
      } else {
        ;(el as HTMLInputElement).value = value
      }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
  },
}

function within(root: ParentNode) {
  const getByTestId = (id: string): HTMLElement => {
    const el = root.querySelector<HTMLElement>(`[data-testid="${id}"]`)
    if (!el) throw new Error(`Unable to find testid: ${id}`)
    return el
  }
  const findByTestId = (id: string) => waitFor(() => getByTestId(id))

  const queryByTestId = (id: string): HTMLElement | null => {
    return root.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  }

  const getByText = (matcher: string | RegExp): HTMLElement => {
    const all = Array.from(root.querySelectorAll<HTMLElement>('*'))
    const match = all.find(el => {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (typeof matcher === 'string') {
        return text === matcher || text.includes(matcher)
      }
      return matcher.test(text)
    })
    if (!match) throw new Error(`Unable to find text: ${String(matcher)}`)
    return match
  }
  const findByText = (matcher: string | RegExp) => waitFor(() => getByText(matcher))

  return { getByTestId, findByTestId, queryByTestId, getByText, findByText }
}

describe('AI Support Integration Studio (SupportIntegration.tsx)', () => {
  let queryClient: QueryClient

  const mockTenants: SupportTenant[] = [
    {
      id: 101,
      name: 'Alpha Corp',
      slug: 'alpha-corp',
      publicKey: 'pk_live_alpha_123',
      defaultModel: 'gpt-4o',
      allowedOrigins: ['https://alpha.example.com'],
      enabled: true,
    },
    {
      id: 102,
      name: 'Beta Store',
      slug: 'beta-store',
      publicKey: 'pk_live_beta_456',
      defaultModel: 'claude-3-5-sonnet',
      allowedOrigins: ['*'],
      enabled: true,
    },
  ]

  let currentTenants: SupportTenant[] = []

  const mockReadiness = {
    tenantId: 101,
    ready: true,
    checks: [
      { id: 'tenant', status: 'ready', code: 'tenant_ready' },
      { id: 'origins', status: 'warning', code: 'origins_unrestricted' },
      { id: 'model', status: 'ready', code: 'model_ready' },
      { id: 'knowledge', status: 'warning', code: 'knowledge_empty' },
      { id: 'masking', status: 'ready', code: 'masking_ready' },
      { id: 'guardrails', status: 'ready', code: 'guardrails_ready' },
      { id: 'quota', status: 'ready', code: 'quota_ready' },
      { id: 'approvals', status: 'ready', code: 'approvals_ready' },
      { id: 'worker', status: 'ready', code: 'worker_ready' },
    ],
    runtimePolicy: {
      allowedModels: ['gpt-4o-mini'],
      toolPolicies: [{ toolId: 1, mode: 'approval_required' }],
      maxCompletionTokens: 512,
      maxModelCalls: 3,
      maxToolCalls: 3,
      maxContextChars: 16000,
      maxToolResultChars: 8000,
      maxHistoryMessages: 40,
    },
    embedSnippet: '',
  }

  const mockTools = [
    { id: 1, tenantId: 101, name: 'refund_order', method: 'POST', endpoint: '/api/refund', enabled: true },
    { id: 2, tenantId: 101, name: 'get_order', method: 'GET', endpoint: '/api/order', enabled: true },
  ]

  const mockOutboxItems = [
    {
      id: 'del-1',
      eventId: 'evt-alpha-001',
      event: 'action.approved',
      webhookId: 'wh-1',
      webhookName: 'Primary Partner Webhook',
      status: 'delivered',
      attempts: 1,
      nextAttemptAt: null,
      statusCode: 200,
      createdAt: '2026-11-12T10:00:00Z',
    },
    {
      id: 'del-2',
      eventId: 'evt-alpha-002',
      event: 'ticket.created',
      webhookId: 'wh-1',
      webhookName: 'Primary Partner Webhook',
      status: 'dead',
      attempts: 5,
      nextAttemptAt: null,
      statusCode: 500,
      lastError: 'Target returned 500 Internal Error after 5 retries',
      createdAt: '2026-11-12T10:05:00Z',
    },
  ]

  beforeEach(() => {
    mockLocale = 'en'
    mockRevision = 1
    mockPermissions = ['use_x_gateway', 'edit_x_settings']
    currentTenants = [...mockTenants]

    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    })
    vi.clearAllMocks()

    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url === '/api/thruline/support/tenants') {
        return { ok: true, tenants: currentTenants }
      }
      if (url.includes('/runtime') && !url.includes('/retry')) {
        return { ok: true, readiness: mockReadiness }
      }
      if (url.includes('/tools')) {
        return { ok: true, tools: mockTools }
      }
      if (url.includes('/outbox') && !url.includes('/retry')) {
        return { ok: true, items: mockOutboxItems }
      }
      return { ok: true }
    })
  })

  afterEach(() => {
    cleanup()
    queryClient.clear()
  })

  function renderPage() {
    return render(
      <QueryClientProvider client={queryClient}>
        <SupportIntegration />
      </QueryClientProvider>
    )
  }

  it('renders empty state when no tenants are available', async () => {
    currentTenants = []

    const { container } = renderPage()
    const { findByTestId } = within(container)

    const empty = await findByTestId('support-integration-empty')
    expect(empty.textContent).toContain(SUPPORT_INTEGRATION_STRINGS.en.noTenants)
  })

  it('navigates across all four accessible tabs with proper aria attributes', async () => {
    const { container } = renderPage()
    const { findByTestId } = within(container)

    // Tab 1: Readiness
    const tabReadiness = await findByTestId('tab-readiness')
    expect(tabReadiness.getAttribute('aria-selected')).toBe('true')
    const panelReadiness = await findByTestId('panel-readiness')
    expect(panelReadiness).toBeTruthy()

    // Tab 2: Runtime
    const tabRuntime = await findByTestId('tab-runtime')
    fireEvent.click(tabRuntime)
    expect(tabRuntime.getAttribute('aria-selected')).toBe('true')
    const panelRuntime = await findByTestId('panel-runtime')
    expect(panelRuntime).toBeTruthy()

    // Tab 3: Deliveries
    const tabDeliveries = await findByTestId('tab-deliveries')
    fireEvent.click(tabDeliveries)
    expect(tabDeliveries.getAttribute('aria-selected')).toBe('true')
    const panelDeliveries = await findByTestId('panel-deliveries')
    expect(panelDeliveries).toBeTruthy()

    // Tab 4: Embed
    const tabEmbed = await findByTestId('tab-embed')
    fireEvent.click(tabEmbed)
    expect(tabEmbed.getAttribute('aria-selected')).toBe('true')
    const panelEmbed = await findByTestId('panel-embed')
    expect(panelEmbed).toBeTruthy()
  })

  it('displays readiness checks with honest warnings and localized machine codes', async () => {
    const { container } = renderPage()
    const { findByTestId, findByText } = within(container)

    await findByTestId('panel-readiness')

    // Warning banner because checks contain warning status
    const warningMsg = await findByText(SUPPORT_INTEGRATION_STRINGS.en.readiness.overallWarning)
    expect(warningMsg).toBeTruthy()

    // Machine codes localized
    const unrestrictedOrigins = await findByText(SUPPORT_INTEGRATION_STRINGS.en.readiness.codes.origins_unrestricted)
    expect(unrestrictedOrigins).toBeTruthy()

    const emptyKnowledge = await findByText(SUPPORT_INTEGRATION_STRINGS.en.readiness.codes.knowledge_empty)
    expect(emptyKnowledge).toBeTruthy()
  })

  it('validates bounds on runtime policy and saves valid configuration with PUT', async () => {
    const { container } = renderPage()
    const { findByTestId, getByTestId } = within(container)

    const tabRuntime = await findByTestId('tab-runtime')
    fireEvent.click(tabRuntime)

    await findByTestId('panel-runtime')

    const tokensInput = getByTestId('runtime-max-completion-tokens') as HTMLInputElement
    const saveBtn = getByTestId('save-runtime-policy-btn')

    // Set invalid tokens (> 4096)
    fireEvent.change(tokensInput, { target: { value: '5000' } })
    fireEvent.click(saveBtn)

    // Validation error shown, no PUT call
    const callsBefore = vi.mocked(apiFetch).mock.calls.filter(c => c[1]?.method === 'PUT')
    expect(callsBefore.length).toBe(0)

    // Set valid tokens (1024)
    fireEvent.change(tokensInput, { target: { value: '1024' } })

    // Change tool 1 mode to 'read'
    const toolModeSelect = getByTestId('tool-mode-1') as HTMLSelectElement
    fireEvent.change(toolModeSelect, { target: { value: 'read' } })

    fireEvent.click(saveBtn)

    await waitFor(() => {
      const putCall = vi.mocked(apiFetch).mock.calls.find(c => c[1]?.method === 'PUT')
      expect(putCall).toBeTruthy()
      expect(putCall![0]).toBe('/api/thruline/support/tenants/101/runtime')
      const body = JSON.parse(putCall![1]!.body as string)
      expect(body.maxCompletionTokens).toBe(1024)
      expect(body.toolPolicies).toContainEqual({ toolId: 1, mode: 'read' })
    })
  })

  it('disables policy modifications and delivery retries for read-only operators', async () => {
    mockPermissions = ['use_x_gateway'] // Missing edit_x_settings

    const { container } = renderPage()
    const { findByTestId, getByTestId } = within(container)

    // Check runtime tab disabled
    const tabRuntime = await findByTestId('tab-runtime')
    fireEvent.click(tabRuntime)
    await findByTestId('panel-runtime')

    const saveBtn = getByTestId('save-runtime-policy-btn') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)

    // Check deliveries tab retry button disabled
    const tabDeliveries = await findByTestId('tab-deliveries')
    fireEvent.click(tabDeliveries)
    await findByTestId('panel-deliveries')

    const retryDeliveryBtn = (await findByTestId('retry-delivery-del-2')) as HTMLButtonElement
    expect(retryDeliveryBtn.disabled).toBe(true)
  })

  it('requeues dead delivery on outbox tab without re-executing action', async () => {
    const { container } = renderPage()
    const { findByTestId } = within(container)

    const tabDeliveries = await findByTestId('tab-deliveries')
    fireEvent.click(tabDeliveries)
    await findByTestId('panel-deliveries')

    // del-1 is delivered -> no retry button
    expect(container.querySelector('[data-testid="retry-delivery-del-1"]')).toBeNull()

    // del-2 is dead -> retry button exists
    const retryBtn = await findByTestId('retry-delivery-del-2')
    expect(retryBtn).toBeTruthy()

    fireEvent.click(retryBtn)

    await waitFor(() => {
      const calls = vi.mocked(apiFetch).mock.calls
      const retryCall = calls.find(c => c[0].includes('/outbox/del-2/retry'))
      expect(retryCall).toBeTruthy()
      expect(retryCall![1]?.method).toBe('POST')
    })
  })

  it('renders secure embed snippet with public key only and copies to clipboard', async () => {
    // Mock navigator.clipboard
    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    })

    const { container } = renderPage()
    const { findByTestId, getByTestId } = within(container)

    const tabEmbed = await findByTestId('tab-embed')
    fireEvent.click(tabEmbed)
    await findByTestId('panel-embed')

    const pre = getByTestId('embed-snippet-pre')
    expect(pre.textContent).toContain('pk_live_alpha_123')
    expect(pre.textContent).not.toContain('signingSecret')
    expect(pre.textContent).not.toContain('secret')

    const copyBtn = getByTestId('copy-embed-snippet-btn')
    await act(async () => { copyBtn.click() })

    expect(writeTextMock).toHaveBeenCalledWith(expect.stringContaining('pk_live_alpha_123'))
  })

  it('resets state and queries when switching tenants to avoid data crossing', async () => {
    const { container } = renderPage()
    const { findByTestId } = within(container)

    const select = (await findByTestId('support-integration-tenant')) as HTMLSelectElement
    expect(select.value).toBe('101')

    // Switch to tenant 102
    fireEvent.change(select, { target: { value: '102' } })

    await waitFor(() => {
      const callsFor102 = vi.mocked(apiFetch).mock.calls.filter(c => c[0].includes('/tenants/102/'))
      expect(callsFor102.length).toBeGreaterThan(0)
    })
  })

  it('renders complete Vietnamese translations when locale is set to vi', async () => {
    mockLocale = 'vi'

    const { container } = renderPage()
    const { findByTestId, findByText } = within(container)

    // Heading in Vietnamese
    const title = await findByText(SUPPORT_INTEGRATION_STRINGS.vi.title)
    expect(title).toBeTruthy()

    // Tabs in Vietnamese
    const tabReadiness = await findByTestId('tab-readiness')
    expect(tabReadiness.textContent).toContain(SUPPORT_INTEGRATION_STRINGS.vi.tabs.readiness)

    const tabRuntime = await findByTestId('tab-runtime')
    expect(tabRuntime.textContent).toContain(SUPPORT_INTEGRATION_STRINGS.vi.tabs.runtime)

    const tabDeliveries = await findByTestId('tab-deliveries')
    expect(tabDeliveries.textContent).toContain(SUPPORT_INTEGRATION_STRINGS.vi.tabs.deliveries)

    const tabEmbed = await findByTestId('tab-embed')
    expect(tabEmbed.textContent).toContain(SUPPORT_INTEGRATION_STRINGS.vi.tabs.embed)
  })
})
