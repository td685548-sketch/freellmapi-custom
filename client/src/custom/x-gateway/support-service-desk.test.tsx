// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import SupportServiceDesk from './pages/SupportServiceDesk'
import { SUPPORT_SERVICE_DESK_STRINGS } from './support-service-desk-strings'
import type {
  SupportDeskCopilotResult,
  SupportDeskPublicWidgetConfig,
  SupportDeskSlaPolicy,
  SupportDeskWidgetConfig,
} from '@freellmapi/shared/support-service-desk.js'

const session = vi.hoisted(() => ({
  locale: 'en',
  canUse: true,
  canEdit: true,
  revision: 1,
  email: 'agent@example.com',
}))

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: session.locale }) }))
vi.mock('../session-state', () => ({ useSessionRevision: () => session.revision }))
vi.mock('../use-session', () => ({
  useUserSession: () => ({
    hasPermission: (permission: string) => {
      if (permission === 'use_x_gateway') return session.canUse
      if (permission === 'edit_x_settings') return session.canEdit
      return true
    },
    session: { email: session.email },
  }),
}))

let root: Root
let container: HTMLDivElement
let queryClient: QueryClient

let tenants: Array<{
  id: number
  name: string
  slug: string
  publicKey: string
  defaultModel: string
  allowedOrigins: string[]
  enabled: boolean
}>

let widgetConfig: SupportDeskWidgetConfig
let widgetVersion: number
let slaPolicy: SupportDeskSlaPolicy
let slaVersion: number
let conversations: Array<{
  id: string
  tenantId: number
  userId: string
  userRole?: string
  status: string
  messages: Array<{
    id?: string
    role?: string
    senderType?: string
    senderName?: string
    content: string
    createdAt?: string
  }>
  createdAt: string
  updatedAt: string
}>
let queueItems: Array<{
  ticket: {
    id: string
    conversationId?: string
    subject: string
    reason?: string
    customerRole?: string
    status: string
    priority: 'urgent' | 'high' | 'medium' | 'low'
    department?: 'general' | 'billing' | 'technical' | 'account' | 'sales'
    createdAt: string
    updatedAt: string
  }
  state?: {
    ticketId: string
    version: number
    department: 'general' | 'billing' | 'technical' | 'account' | 'sales'
    priority: 'urgent' | 'high' | 'medium' | 'low'
    firstResponseDueAt?: string
    resolutionDueAt?: string
    updatedAt: string
  }
  firstResponseClock?: {
    dueAt: string
    targetMinutes: number
    remainingMinutes: number
    isBreached: boolean
    status: 'healthy' | 'warning' | 'breached' | 'met' | 'not_observed'
  }
  resolutionClock?: {
    dueAt: string
    targetMinutes: number
    remainingMinutes: number
    isBreached: boolean
    status: 'healthy' | 'warning' | 'breached' | 'met' | 'not_observed'
  }
}>
let copilotResponse: SupportDeskCopilotResult
let simulateWidgetConflict = false
let simulateSlaConflict = false

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  session.locale = 'en'
  session.canUse = true
  session.canEdit = true
  session.revision = 1
  session.email = 'agent@example.com'

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })

  tenants = [
    {
      id: 1,
      name: 'Acme Store',
      slug: 'acme',
      publicKey: 'pk_acme_1',
      defaultModel: 'gpt-4o-mini',
      allowedOrigins: ['*'],
      enabled: true,
    },
    {
      id: 2,
      name: 'Beta Services',
      slug: 'beta',
      publicKey: 'pk_beta_2',
      defaultModel: 'gpt-4o-mini',
      allowedOrigins: ['*'],
      enabled: true,
    },
  ]

  widgetVersion = 1
  widgetConfig = {
    version: 1,
    updatedAt: '2026-11-13T00:00:00.000Z',
    enabled: true,
    appearance: {
      primaryColor: '#2563eb',
      title: 'Acme Support',
      welcomeMessage: 'Welcome to Acme! How can we help?',
      position: 'bottom-right',
      quickPrompts: ['Check shipping', 'Refund policy'],
    },
    intake: {
      required: false,
      fields: [],
    },
  }

  slaVersion = 1
  slaPolicy = {
    version: 1,
    updatedAt: '2026-11-13T00:00:00.000Z',
    enabled: true,
    targets: {
      urgent: { firstResponseMinutes: 15, resolutionMinutes: 120 },
      high: { firstResponseMinutes: 60, resolutionMinutes: 480 },
      medium: { firstResponseMinutes: 240, resolutionMinutes: 1440 },
      low: { firstResponseMinutes: 480, resolutionMinutes: 2880 },
    },
    routingRules: [
      { id: 'rule_1', department: 'billing', keywords: ['refund', 'invoice', 'charge'] },
    ],
  }

  conversations = [
    {
      id: 'conv-101',
      tenantId: 1,
      userId: 'user_alice',
      userRole: 'customer',
      status: 'open',
      messages: [
        {
          id: 'm1',
          role: 'user',
          senderType: 'customer',
          senderName: 'Alice',
          content: 'Hello, I have an issue with my recent invoice.',
          createdAt: '2026-11-13T10:00:00Z',
        },
      ],
      createdAt: '2026-11-13T10:00:00Z',
      updatedAt: '2026-11-13T10:00:00Z',
    },
  ]

  queueItems = [
    {
      ticket: {
        id: 'tkt-001',
        conversationId: 'conv-101',
        subject: 'Billing discrepancy',
        reason: 'Customer requested human agent',
        customerRole: 'customer',
        status: 'escalated',
        priority: 'high',
        department: 'billing',
        createdAt: '2026-11-13T10:00:00Z',
        updatedAt: '2026-11-13T10:00:00Z',
      },
      state: {
        ticketId: 'tkt-001',
        version: 1,
        department: 'billing',
        priority: 'high',
        firstResponseDueAt: '2026-11-13T11:00:00Z',
        resolutionDueAt: '2026-11-13T18:00:00Z',
        updatedAt: '2026-11-13T10:00:00Z',
      },
      firstResponseClock: {
        dueAt: '2026-11-13T11:00:00Z',
        targetMinutes: 60,
        remainingMinutes: 30,
        isBreached: false,
        status: 'warning',
      },
      resolutionClock: {
        dueAt: '2026-11-13T18:00:00Z',
        targetMinutes: 480,
        remainingMinutes: 400,
        isBreached: false,
        status: 'healthy',
      },
    },
  ]

  const sampleCitation = {
    id: 'cit_1',
    ordinal: 1,
    sourceId: 'src_1',
    revisionId: 'rev_1',
    chunkId: 'chk_1',
    title: 'Invoice Policy Guide',
    startLine: 1,
    endLine: 10,
    excerpt: 'Invoice discrepancies are reviewed by billing.',
  }

  copilotResponse = {
    jobId: 'job_1',
    requestId: 'req_1',
    conversationId: 'conv-101',
    status: 'completed',
    summary: 'Alice reported an invoice issue and requests human billing assistance.',
    summaryCitations: [sampleCitation],
    drafts: [
      {
        tone: 'empathetic',
        text: 'Hi Alice, I am very sorry for any confusion with your invoice. Let me review it right now.',
        citations: [sampleCitation],
      },
      {
        tone: 'direct',
        text: 'Hello Alice, please provide your invoice number so I can investigate the charges.',
        citations: [sampleCitation],
      },
      {
        tone: 'technical',
        text: 'Hello Alice, charges follow our published tariff schedule. I can verify line items for you.',
        citations: [sampleCitation],
      },
    ],
    conversationSnapshot: 'snap_conv_1',
    evidenceSnapshot: 'snap_ev_1',
    policyVersion: 1,
    modelUsed: 'claude-3-5-sonnet',
    usage: {
      promptTokens: 250,
      completionTokens: 110,
      totalTokens: 360,
      accounting: 'actual',
    },
    replayed: false,
    createdAt: '2026-11-13T10:01:00.000Z',
  }

  simulateWidgetConflict = false
  simulateSlaConflict = false

  // Provide mock FreeLLMAPISupport with preview method
  window.FreeLLMAPISupport = {
    preview: vi.fn((previewContainer: HTMLElement, publicConfig: SupportDeskPublicWidgetConfig) => {
      const rootEl = document.createElement('div')
      rootEl.setAttribute('data-testid', 'widget-preview-root')
      rootEl.textContent = `Preview: ${publicConfig.appearance?.title}`
      previewContainer.appendChild(rootEl)
      return {
        destroy: () => {
          rootEl.remove()
        },
      }
    }),
  }

  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (path, options) => {
    const method = options?.method ?? 'GET'
    const body = options?.body ? JSON.parse(String(options.body)) : {}

    if (path === '/api/thruline/support/tenants') {
      return { ok: true, tenants }
    }

    if (path.includes('/service-desk/widget-config')) {
      if (method === 'PUT') {
        if (simulateWidgetConflict) {
          const conflictErr = new Error('version_conflict: expected version mismatch')
          ;(conflictErr as unknown as { status: number }).status = 409
          throw conflictErr
        }
        widgetVersion++
        widgetConfig = {
          version: widgetVersion,
          updatedAt: '2026-11-13T00:00:00.000Z',
          enabled: body.enabled,
          appearance: body.appearance,
          intake: body.intake,
        }
        return {
          ok: true,
          config: widgetConfig,
          publicConfig: { ...widgetConfig, schemaHash: 'hash-test' },
        }
      }
      return {
        ok: true,
        config: widgetConfig,
        publicConfig: { ...widgetConfig, schemaHash: 'hash-test' },
        embedSnippet: '<script src="/thruline/v1/support/widget.js"></script>\n<script>FreeLLMAPISupport.init({ tenantKey: "pk_acme_1", loadTenantProfile: true });</script>',
      }
    }

    if (path.includes('/copilot/jobs/')) {
      return { ok: true, result: copilotResponse }
    }
    if (path.includes('/service-desk/copilot')) {
      return { ok: true, result: copilotResponse }
    }

    if (path.endsWith('/conversations')) {
      return { ok: true, conversations }
    }

    if (path.includes('/conversations/') && path.endsWith('/reply')) {
      conversations[0].messages.push({
        id: `m_${Date.now()}`,
        role: 'assistant',
        senderType: 'staff',
        senderName: body.agentName,
        content: body.content,
        createdAt: new Date().toISOString(),
      })
      return { ok: true }
    }

    if (path.includes('/service-desk/sla-policy')) {
      if (method === 'PUT') {
        if (simulateSlaConflict) {
          const conflictErr = new Error('version_conflict: sla policy version mismatch')
          ;(conflictErr as unknown as { status: number }).status = 409
          throw conflictErr
        }
        slaVersion++
        slaPolicy = {
          version: slaVersion,
          updatedAt: '2026-11-13T00:00:00.000Z',
          enabled: body.enabled,
          targets: body.targets,
          routingRules: body.routingRules,
        }
        return { ok: true, policy: slaPolicy }
      }
      return { ok: true, policy: slaPolicy }
    }

    if (path.includes('/service-desk/queue')) {
      return { ok: true, items: queueItems }
    }

    if (path.includes('/routing') && method === 'PATCH') {
      queueItems[0].ticket.department = body.department
      queueItems[0].state!.department = body.department
      queueItems[0].state!.version++
      return { ok: true, state: queueItems[0].state }
    }

    throw new Error(`Unhandled mock path: ${method} ${path}`)
  })
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  queryClient.clear()
  container.remove()
  delete (window as unknown as { FreeLLMAPISupport?: unknown }).FreeLLMAPISupport
})

async function waitFor(check: () => void, timeout = 4000) {
  const start = Date.now()
  while (true) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() - start >= timeout) throw error
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
      })
    }
  }
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = container.querySelector<T>(`[data-testid="${id}"]`)
  if (!element) throw new Error(`Missing test element: [data-testid="${id}"]`)
  return element
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click()
  })
}

async function change(id: string, value: string) {
  const element = byId<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id)
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

async function renderPage() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SupportServiceDesk />
      </QueryClientProvider>
    )
  })
}

async function mount() {
  await renderPage()
  await waitFor(() => {
    expect(byId('support-desk-tenant').textContent).toContain('Acme Store')
  })
  await waitFor(() => {
    expect(byId<HTMLInputElement>('widget-title-input').value).toBe('Acme Support')
  })
}

async function selectTab(tabId: 'widget' | 'copilot' | 'queues' | 'embed') {
  await click(byId(`tab-${tabId}`))
}

describe('Support Service Desk & Widget Studio (SupportServiceDesk.tsx)', () => {
  it('1. permission check: unprivileged user sees permission denied notice and no tenant queries are performed', async () => {
    session.canEdit = false
    await renderPage()

    await waitFor(() => {
      expect(byId('support-desk-permission-denied')).not.toBeNull()
      expect(byId('support-desk-permission-denied').textContent).toContain(
        SUPPORT_SERVICE_DESK_STRINGS.en.permissionDenied
      )
    })

    const tenantCalls = vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/thruline/support/tenants')
    expect(tenantCalls.length).toBe(0)
  })

  it('2. renders all four tabs and switches active tabpanels correctly', async () => {
    await mount()

    const tabIds = ['widget', 'copilot', 'queues', 'embed'] as const
    for (const tid of tabIds) {
      await selectTab(tid)
      expect(byId(`tab-${tid}`).getAttribute('aria-selected')).toBe('true')
      expect(byId(`panel-${tid}`).getAttribute('role')).toBe('tabpanel')
    }
  })

  it('3. active tenant selector switches tenant and re-queries tenant-scoped configurations', async () => {
    await mount()

    const selectEl = byId<HTMLSelectElement>('support-desk-tenant')
    expect(selectEl.value).toBe('1')

    await change('support-desk-tenant', '2')

    await waitFor(() => {
      const callsForTenant2 = vi.mocked(apiFetch).mock.calls.filter(([p]) => p.includes('/tenants/2/service-desk'))
      expect(callsForTenant2.length).toBeGreaterThan(0)
    })
  })

  it('4. Tab 1 (Widget): loads config, updates title and position, and saves config with expectedVersion', async () => {
    await mount()

    expect(byId<HTMLInputElement>('widget-title-input').value).toBe('Acme Support')
    expect(byId<HTMLSelectElement>('widget-position-select').value).toBe('bottom-right')

    await change('widget-title-input', 'Updated Support Title')
    await change('widget-position-select', 'bottom-left')

    await click(byId('widget-save-btn'))

    await waitFor(() => {
      const putCalls = vi.mocked(apiFetch).mock.calls.filter(([path, opt]) =>
        path.includes('/service-desk/widget-config') && opt?.method === 'PUT'
      )
      expect(putCalls.length).toBe(1)
      const sentBody = JSON.parse(String(putCalls[0][1]?.body))
      expect(sentBody.expectedVersion).toBe(1)
      expect(sentBody.appearance.title).toBe('Updated Support Title')
      expect(sentBody.appearance.position).toBe('bottom-left')
    })
  })

  it('5. Tab 1 (Widget): handles 409 OCC conflict and displays conflict error banner', async () => {
    await mount()

    simulateWidgetConflict = true

    await change('widget-title-input', 'Conflicting Edit')
    await click(byId('widget-save-btn'))

    await waitFor(() => {
      const conflictAlert = byId('widget-conflict-error')
      expect(conflictAlert).not.toBeNull()
      expect(conflictAlert.textContent).toContain(SUPPORT_SERVICE_DESK_STRINGS.en.conflictError)
    })
  })

  it('6. Tab 1 (Widget): validates reserved field key (e.g. role, userId) and blocks invalid submission', async () => {
    await mount()

    await click(byId('intake-add-field-btn'))

    await waitFor(() => {
      expect(byId('intake-field-key-0')).not.toBeNull()
    })

    // Set reserved key 'role'
    await change('intake-field-key-0', 'role')
    await click(byId('widget-save-btn'))

    await waitFor(() => {
      expect(container.textContent).toContain(SUPPORT_SERVICE_DESK_STRINGS.en.widget.errors.reservedFieldKey)
    })

    // Ensure no PUT call was made
    const putCalls = vi.mocked(apiFetch).mock.calls.filter(([, opt]) => opt?.method === 'PUT')
    expect(putCalls.length).toBe(0)
  })

  it('7. Tab 1 (Widget): validates primaryColor hex format before submission', async () => {
    await mount()

    await change('widget-primary-color-input', 'invalid-color')
    await click(byId('widget-save-btn'))

    await waitFor(() => {
      expect(container.textContent).toContain(SUPPORT_SERVICE_DESK_STRINGS.en.widget.errors.invalidColor)
    })

    const putCalls = vi.mocked(apiFetch).mock.calls.filter(([, opt]) => opt?.method === 'PUT')
    expect(putCalls.length).toBe(0)
  })

  it('8. Tab 1 (Widget): renders live preview via SupportWidgetPreview with zero transport', async () => {
    await mount()

    await waitFor(() => {
      expect(byId('widget-preview-root')).not.toBeNull()
      expect(byId('widget-preview-root').textContent).toContain('Preview: Acme Support')
    })

    expect(window.FreeLLMAPISupport?.preview).toHaveBeenCalled()
  })

  it('9. Tab 2 (Copilot): selects conversation and displays message transcript', async () => {
    await mount()
    await selectTab('copilot')

    await waitFor(() => {
      expect(byId('copilot-conversation-select')).not.toBeNull()
      expect(byId('copilot-messages-list')).not.toBeNull()
      expect(byId('copilot-messages-list').textContent).toContain('Hello, I have an issue with my recent invoice.')
      expect(byId('copilot-messages-list').textContent).toContain('Alice')
    })
  })

  it('10. Tab 2 (Copilot): generates drafts via POST /copilot and renders summary, citations, 3 tones, and usage', async () => {
    await mount()
    await selectTab('copilot')

    await waitFor(() => expect(byId('copilot-generate-btn')).not.toBeNull())
    await click(byId('copilot-generate-btn'))

    await waitFor(() => {
      expect(byId('copilot-summary')).not.toBeNull()
      expect(byId('copilot-summary').textContent).toContain('Alice reported an invoice issue')
      expect(byId('copilot-summary-citations').textContent).toContain('Invoice Policy Guide')

      // Check 3 drafts
      expect(byId('copilot-draft-empathetic')).not.toBeNull()
      expect(byId('copilot-draft-direct')).not.toBeNull()
      expect(byId('copilot-draft-technical')).not.toBeNull()

      // Check citations on empathetic draft
      expect(byId('copilot-draft-citations-empathetic').textContent).toContain('Invoice Policy Guide')

      // Check token usage info
      expect(byId('copilot-usage-info').textContent).toContain('claude-3-5-sonnet')
      expect(byId('copilot-usage-info').textContent).toContain('360')
    })
  })

  it('11. Tab 2 (Copilot): copies draft into composer and operator manually sends reply via POST /reply', async () => {
    await mount()
    await selectTab('copilot')

    await waitFor(() => expect(byId('copilot-generate-btn')).not.toBeNull())
    await click(byId('copilot-generate-btn'))
    await waitFor(() => expect(byId('copilot-use-draft-direct')).not.toBeNull())

    // Click "Use Draft" on direct draft
    await click(byId('copilot-use-draft-direct'))

    const composer = byId<HTMLTextAreaElement>('copilot-composer-input')
    expect(composer.value).toContain('Hello Alice, please provide your invoice number')

    // Operator clicks "Send Reply"
    await click(byId('copilot-send-reply-btn'))

    await waitFor(() => {
      const replyCalls = vi.mocked(apiFetch).mock.calls.filter(([path, opt]) =>
        path.includes('/conversations/conv-101/reply') && opt?.method === 'POST'
      )
      expect(replyCalls.length).toBe(1)
      const body = JSON.parse(String(replyCalls[0][1]?.body))
      expect(body.content).toContain('Hello Alice, please provide your invoice number')
      expect(body.agentName).toBe('agent@example.com')
    })

    // Composer input is cleared
    expect(composer.value).toBe('')
  })

  it('12. Tab 2 (Copilot): displays abstention notice when copilot returns status abstained', async () => {
    copilotResponse = {
      jobId: 'job_2',
      requestId: 'req_2',
      conversationId: 'conv-101',
      status: 'abstained',
      reason: 'no_evidence',
      summary: '',
      drafts: [],
      summaryCitations: [],
      conversationSnapshot: 'snap_conv_1',
      evidenceSnapshot: 'snap_ev_1',
      policyVersion: 1,
      modelUsed: null,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        accounting: 'actual',
      },
      replayed: false,
      createdAt: '2026-11-13T10:02:00.000Z',
    }

    await mount()
    await selectTab('copilot')

    await waitFor(() => expect(byId('copilot-generate-btn')).not.toBeNull())
    await click(byId('copilot-generate-btn'))

    await waitFor(() => {
      const notice = byId('copilot-abstained-notice')
      expect(notice).not.toBeNull()
      expect(notice.textContent).toContain(SUPPORT_SERVICE_DESK_STRINGS.en.copilot.reasons.no_evidence)
    })
  })

  it('13. Tab 3 (Queues): loads SLA policy, edits priority targets, and saves policy via PUT', async () => {
    await mount()
    await selectTab('queues')

    await waitFor(() => {
      expect(byId('sla-enabled-toggle')).not.toBeNull()
      expect(byId<HTMLInputElement>('sla-target-first-urgent').value).toBe('15')
    })

    await change('sla-target-first-urgent', '20')
    await click(byId('sla-save-btn'))

    await waitFor(() => {
      const putCalls = vi.mocked(apiFetch).mock.calls.filter(([path, opt]) =>
        path.includes('/service-desk/sla-policy') && opt?.method === 'PUT'
      )
      expect(putCalls.length).toBe(1)
      const sentBody = JSON.parse(String(putCalls[0][1]?.body))
      expect(sentBody.targets.urgent.firstResponseMinutes).toBe(20)
    })
  })

  it('14. Tab 3 (Queues): renders queue tickets with SLA badges and reassigns department via PATCH', async () => {
    await mount()
    await selectTab('queues')

    await waitFor(() => {
      expect(byId('queue-ticket-row-tkt-001')).not.toBeNull()
      expect(byId('queue-first-response-status-tkt-001').textContent).toContain(
        SUPPORT_SERVICE_DESK_STRINGS.en.queues.slaStatus.warning
      )
      expect(byId('queue-resolution-status-tkt-001').textContent).toContain(
        SUPPORT_SERVICE_DESK_STRINGS.en.queues.slaStatus.healthy
      )
    })

    // Reassign department to technical
    await change('queue-reassign-select-tkt-001', 'technical')
    await click(byId('queue-reassign-btn-tkt-001'))

    await waitFor(() => {
      const patchCalls = vi.mocked(apiFetch).mock.calls.filter(([path, opt]) =>
        path.includes('/service-desk/tickets/tkt-001/routing') && opt?.method === 'PATCH'
      )
      expect(patchCalls.length).toBe(1)
      const sentBody = JSON.parse(String(patchCalls[0][1]?.body))
      expect(sentBody.department).toBe('technical')
      expect(sentBody.expectedVersion).toBe(1)
    })
  })

  it('15. Tab 4 (Embed): renders snippet with loadTenantProfile: true and copies to clipboard', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    })

    await mount()
    await selectTab('embed')

    await waitFor(() => {
      const codeSnippet = byId('embed-snippet-code')
      expect(codeSnippet).not.toBeNull()
      expect(codeSnippet.textContent).toContain('loadTenantProfile: true')
      expect(codeSnippet.textContent).toContain('pk_acme_1')
      // Ensure no raw secret tokens are embedded
      expect(codeSnippet.textContent).not.toContain('secret')
    })

    await click(byId('embed-copy-snippet-btn'))
    expect(writeTextMock).toHaveBeenCalled()
  })

  it('16. localizes UI strings in Vietnamese when locale is vi', async () => {
    session.locale = 'vi'
    await mount()

    expect(container.textContent).toContain(SUPPORT_SERVICE_DESK_STRINGS.vi.title)
    expect(byId('tab-widget').textContent).toContain(SUPPORT_SERVICE_DESK_STRINGS.vi.tabs.widget)
    expect(byId('tab-copilot').textContent).toContain(SUPPORT_SERVICE_DESK_STRINGS.vi.tabs.copilot)
    expect(byId('tab-queues').textContent).toContain(SUPPORT_SERVICE_DESK_STRINGS.vi.tabs.queues)
    expect(byId('tab-embed').textContent).toContain(SUPPORT_SERVICE_DESK_STRINGS.vi.tabs.embed)
  })

  it('17. Tab 2 (Copilot): hides stale drafts on 409 context change and distinguishes auth/provider errors', async () => {
    await mount()
    await selectTab('copilot')
    await waitFor(() => expect(byId('copilot-generate-btn')).not.toBeNull())

    await click(byId('copilot-generate-btn'))
    await waitFor(() => expect(byId('copilot-draft-direct')).not.toBeNull())

    // Next Copilot call fails with 409 copilot_context_changed -> must hide stale drafts
    const baseImpl = vi.mocked(apiFetch).getMockImplementation()!
    vi.mocked(apiFetch).mockImplementationOnce(async (path, options) => {
      if (String(path).includes('/service-desk/copilot')) {
        const err = new Error('copilot_context_changed')
        ;(err as unknown as { status: number }).status = 409
        throw err
      }
      return baseImpl(path, options)
    })

    await click(byId('copilot-generate-btn'))
    await waitFor(() => {
      expect(byId('copilot-error').textContent).toContain(
        SUPPORT_SERVICE_DESK_STRINGS.en.copilot.errors.contextChanged
      )
      expect(container.querySelector('[data-testid="copilot-draft-direct"]')).toBeNull()
    })

    // 403 auth error is distinguished from 503 model unavailable
    vi.mocked(apiFetch).mockImplementationOnce(async (path, options) => {
      if (String(path).includes('/service-desk/copilot')) {
        const err = new Error('unsupported_evidence_role')
        ;(err as unknown as { status: number }).status = 403
        throw err
      }
      return baseImpl(path, options)
    })

    await click(byId('copilot-generate-btn'))
    await waitFor(() => {
      expect(byId('copilot-error').textContent).toContain(
        SUPPORT_SERVICE_DESK_STRINGS.en.copilot.errors.authError
      )
    })
  })

  it('18. tenant switch aborts in-flight mutation and fences late callbacks', async () => {
    await mount()

    let mutationSignal: AbortSignal | undefined
    let resolvePendingSave: ((value: unknown) => void) | undefined
    const baseImpl = vi.mocked(apiFetch).getMockImplementation()!
    vi.mocked(apiFetch).mockImplementation(async (path, options) => {
      if (String(path).includes('/tenants/1/service-desk/widget-config') && options?.method === 'PUT') {
        mutationSignal = options.signal as AbortSignal | undefined
        return new Promise(resolve => {
          resolvePendingSave = resolve
        })
      }
      return baseImpl(path, options)
    })

    await click(byId('widget-save-btn'))
    await waitFor(() => {
      expect(mutationSignal).toBeDefined()
      expect(mutationSignal?.aborted).toBe(false)
    })

    // Switch tenant while PUT is in flight
    await change('support-desk-tenant', '2')
    await waitFor(() => {
      expect(mutationSignal?.aborted).toBe(true)
    })

    // Late resolution must not crash or show saved banner on tenant 2
    await act(async () => {
      resolvePendingSave?.({ ok: true, config: widgetConfig, publicConfig: { ...widgetConfig, schemaHash: 'h' } })
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="feedback-success"]')).toBeNull()
  })

  it('clears composed drafts and aborts work when selecting another customer', async () => {
    conversations.push({...conversations[0],id:'conv-202',userId:'customer-202',messages:[]});
    await mount(); await selectTab('copilot');
    await waitFor(() => expect(byId('copilot-generate-btn')).not.toBeNull());
    await click(byId('copilot-generate-btn'));
    await waitFor(() => expect(byId('copilot-use-draft-direct')).not.toBeNull());
    await click(byId('copilot-use-draft-direct'));
    await waitFor(() => expect(byId<HTMLTextAreaElement>('copilot-composer-input').value).toContain('Alice'));
    await act(async () => { const select=byId<HTMLSelectElement>('copilot-conversation-select'); select.value='conv-202'; select.dispatchEvent(new Event('change',{bubbles:true})); });
    expect(byId<HTMLTextAreaElement>('copilot-composer-input').value).toBe('');
    expect(container.querySelector('[data-testid="copilot-drafts"]')).toBeNull();
  });
  it('revalidates a copied draft and blocks sending after source revocation', async () => {
    await mount(); await selectTab('copilot');
    await waitFor(() => expect(byId('copilot-generate-btn')).not.toBeNull());
    await click(byId('copilot-generate-btn'));
    await waitFor(() => expect(byId('copilot-use-draft-direct')).not.toBeNull());
    await click(byId('copilot-use-draft-direct'));
    await waitFor(() => expect(byId<HTMLTextAreaElement>('copilot-composer-input').value).toContain('Alice'));
    const base = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (path, options) => {
      if(path.includes('/copilot/jobs/')) throw Object.assign(new Error('sources changed'), {status:409});
      return base(path, options);
    });
    await click(byId('copilot-send-reply-btn'));
    await waitFor(() => expect(byId<HTMLTextAreaElement>('copilot-composer-input').value).toBe(''));
    expect(vi.mocked(apiFetch).mock.calls.filter(([path,opt])=>path.endsWith('/reply')&&opt?.method==='POST')).toHaveLength(0);
    expect(container.querySelector('[data-testid="copilot-drafts"]')).toBeNull();
  });

  it('loads the preview script under the deployment prefix and fences late load events', async () => {
    vi.stubEnv('BASE_URL','/prefix/');
    const factory = vi.fn(() => ({destroy:vi.fn()}));
    delete window.FreeLLMAPISupport;
    await mount();
    let script: HTMLScriptElement | undefined;
    await waitFor(() => {
      script = Array.from(document.scripts).find(item => item.getAttribute('src') === '/prefix/thruline/v1/support/widget.js');
      expect(script).toBeDefined();
    });
    await act(async () => { root.render(null); });
    window.FreeLLMAPISupport = {preview:factory};
    await act(async () => { script!.dispatchEvent(new Event('load')); });
    expect(factory).not.toHaveBeenCalled();
    script!.remove();
    vi.unstubAllEnvs();
  });
})
