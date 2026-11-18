// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import SupportServiceDesk from './pages/SupportServiceDesk'
import type { SupportDeskWidgetConfig } from '@freellmapi/shared/support-service-desk.js'
import type {
  SupportLiveTestOriginCheckResponse,
  SupportLiveTestPendingActionItem,
  SupportLiveTestPersonaSessionResponse,
  SupportLiveTestPlaybook,
  SupportLiveTestPlaybookCase,
} from '@freellmapi/shared/support-service-desk-live-test.js'
import { getSupportRuntimeWidgetScript } from '../../../../server/src/custom/x-gateway/support-runtime-widget.ts'

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

interface MockConversation {
  id: string
  tenantId: number
  userId: string
  userRole: string
  status: string
  messages: Array<{
    id: string
    role: string
    senderType: string
    senderName?: string
    content: string
    requestId?: string
    evidence?: Record<string, unknown>
    createdAt: string
  }>
  createdAt: string
  updatedAt: string
}

let root: Root
let container: HTMLDivElement
let queryClient: QueryClient
let fetchSpy: ReturnType<typeof vi.spyOn>

let tenants: Array<{
  id: number
  name: string
  slug: string
  publicKey: string
  defaultModel: string
  allowedOrigins: string[]
  enabled: boolean
  allowGuest: boolean
  rolesConfig: Array<{ role: string; permissions: string[] }>
}>

let widgetConfigs: Record<number, SupportDeskWidgetConfig>
let conversationsByTenant: Record<number, MockConversation[]>
let pendingActionsByTenant: Record<number, SupportLiveTestPendingActionItem[]>
let playbooksByTenant: Record<number, SupportLiveTestPlaybook>
let recordedReplyBodies: Array<{ tenantId: number; convId: string; body: Record<string, unknown> }>
let recordedCsatSubmissions: Array<Record<string, unknown>>
let recordedLiveHeaders: Array<{ url: string; auth: string | null; simOrigin: string | null }>

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone() {
      return jsonResponse(body, status)
    },
  } as unknown as Response
}

function loadCanonicalWidgetScript() {
  const scriptSource = getSupportRuntimeWidgetScript()
  new Function('window', 'document', scriptSource)(window, document)
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.localStorage.setItem('freellmapi_dashboard_token', 'dash-test-jwt-123')

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

  loadCanonicalWidgetScript()

  tenants = [
    {
      id: 1,
      name: 'Acme Store',
      slug: 'acme',
      publicKey: 'pk_acme_1',
      defaultModel: 'gpt-4o-mini',
      allowedOrigins: ['https://shop.acme.test'],
      enabled: true,
      allowGuest: false,
      rolesConfig: [
        { role: 'guest', permissions: [] },
        { role: 'customer', permissions: ['orders:read'] },
        { role: 'staff', permissions: ['orders:read', 'refund:draft'] },
        { role: 'admin', permissions: ['*'] },
      ],
    },
    {
      id: 2,
      name: 'Beta Support',
      slug: 'beta',
      publicKey: 'pk_beta_2',
      defaultModel: 'gpt-4o-mini',
      allowedOrigins: ['*'],
      enabled: true,
      allowGuest: true,
      rolesConfig: [
        { role: 'guest', permissions: [] },
        { role: 'customer', permissions: ['orders:read'] },
      ],
    },
  ]

  widgetConfigs = {
    1: {
      version: 1,
      updatedAt: '2026-11-18T00:00:00.000Z',
      enabled: true,
      appearance: {
        primaryColor: '#2563eb',
        title: 'Acme Concierge',
        welcomeMessage: 'Welcome to Acme!',
        position: 'bottom-right',
        quickPrompts: ['Return policy'],
      },
      intake: {
        required: true,
        fields: [{ key: 'order_id', label: 'Order ID', type: 'text', required: true }],
      },
    },
    2: {
      version: 1,
      updatedAt: '2026-11-18T00:00:00.000Z',
      enabled: true,
      appearance: {
        primaryColor: '#059669',
        title: 'Beta Desk',
        welcomeMessage: 'Hello from Beta!',
        position: 'bottom-right',
        quickPrompts: [],
      },
      intake: {
        required: false,
        fields: [],
      },
    },
  }

  conversationsByTenant = { 1: [], 2: [] }
  pendingActionsByTenant = { 1: [], 2: [] }
  playbooksByTenant = {
    1: { version: 1, updatedAt: '2026-11-18T00:00:00.000Z', cases: [] },
    2: { version: 1, updatedAt: '2026-11-18T00:00:00.000Z', cases: [] },
  }
  recordedReplyBodies = []
  recordedCsatSubmissions = []
  recordedLiveHeaders = []

  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (path, options) => {
    const method = options?.method ?? 'GET'
    const body = options?.body ? JSON.parse(String(options.body)) : {}

    if (path === '/api/thruline/support/tenants') {
      return { ok: true, tenants }
    }

    const tenantMatch = /\/api\/thruline\/support\/tenants\/(\d+)/.exec(path)
    const tenantId = tenantMatch ? Number(tenantMatch[1]) : 1
    const tenant = tenants.find((t) => t.id === tenantId) ?? tenants[0]

    if (path.includes('/service-desk/widget-config')) {
      if (method === 'PUT') {
        const nextVersion = widgetConfigs[tenantId].version + 1
        widgetConfigs[tenantId] = {
          version: nextVersion,
          updatedAt: '2026-11-18T00:10:00.000Z',
          enabled: body.enabled,
          appearance: body.appearance,
          intake: body.intake,
        }
        return {
          ok: true,
          config: widgetConfigs[tenantId],
          publicConfig: {
            version: nextVersion,
            enabled: body.enabled,
            appearance: body.appearance,
            intake: { ...body.intake, schemaHash: `hash_v${nextVersion}` },
          },
          embedSnippet: '<script src="/thruline/v1/support/widget.js"></script>',
        }
      }
      const cfg = widgetConfigs[tenantId]
      return {
        ok: true,
        config: cfg,
        publicConfig: {
          version: cfg.version,
          enabled: cfg.enabled,
          appearance: cfg.appearance,
          intake: { ...cfg.intake, schemaHash: `hash_v${cfg.version}` },
        },
        embedSnippet: '<script src="/thruline/v1/support/widget.js"></script>',
      }
    }

    if (path.includes('/service-desk/live-test/persona-session') && method === 'POST') {
      if (body.mode === 'guest') {
        const resp: SupportLiveTestPersonaSessionResponse = {
          ok: true,
          mode: 'guest',
          contextToken: null,
          allowGuest: tenant.allowGuest,
        }
        return resp
      }
      const resp: SupportLiveTestPersonaSessionResponse = {
        ok: true,
        mode: 'authenticated',
        contextToken: `ctx_${tenantId}_${body.role}_${body.userId}`,
        expiresIn: 3600,
        allowGuest: tenant.allowGuest,
        userContext: {
          tenantId,
          userId: String(body.userId),
          role: String(body.role),
          ...(body.name ? { name: String(body.name) } : {}),
          ...(body.email ? { email: String(body.email) } : {}),
          permissions: Array.isArray(body.permissions) ? body.permissions : [],
          verified: true,
        },
      }
      return resp
    }

    if (path.includes('/service-desk/live-test/origin-check') && method === 'POST') {
      const origin = String(body.origin ?? '').trim()
      const allowed =
        tenant.allowedOrigins.includes('*') || tenant.allowedOrigins.includes(origin)
      const resp: SupportLiveTestOriginCheckResponse = {
        ok: true,
        origin,
        allowed,
        reason: tenant.allowedOrigins.includes('*')
          ? 'wildcard'
          : allowed
            ? 'matched'
            : 'not_in_allowlist',
        allowedOrigins: tenant.allowedOrigins,
      }
      return resp
    }

    if (path.includes('/service-desk/live-test/sandbox')) {
      if (method === 'DELETE') {
        const prevConvs = (conversationsByTenant[tenantId] ?? []).length
        const prevActions = (pendingActionsByTenant[tenantId] ?? []).length
        const prevCsat = recordedCsatSubmissions.filter((c) => c.tenantId === tenantId).length
        conversationsByTenant[tenantId] = []
        pendingActionsByTenant[tenantId] = []
        recordedCsatSubmissions = recordedCsatSubmissions.filter((c) => c.tenantId !== tenantId)
        return {
          ok: true,
          tenantId,
          deleted: {
            conversations: prevConvs,
            tickets: 0,
            pendingActions: prevActions,
            csatRatings: prevCsat,
          },
        }
      }
      const conversationsCount = (conversationsByTenant[tenantId] ?? []).length
      const pendingActionsCount = (pendingActionsByTenant[tenantId] ?? []).length
      const csatRatingsCount = recordedCsatSubmissions.filter((c) => c.tenantId === tenantId).length
      return {
        ok: true,
        tenantId,
        conversationsCount,
        ticketsCount: 0,
        pendingActionsCount,
        csatRatingsCount,
        totalCount: conversationsCount + pendingActionsCount + csatRatingsCount,
      }
    }

    if (path.includes('/service-desk/live-test/pending-actions')) {
      const reviewMatch = /\/pending-actions\/([^/]+)\/(approve|reject)$/.exec(path)
      if (reviewMatch && method === 'POST') {
        const actionId = decodeURIComponent(reviewMatch[1])
        const decision = reviewMatch[2] === 'approve' ? 'approved' : 'rejected'
        const list = pendingActionsByTenant[tenantId] ?? []
        const idx = list.findIndex((a) => a.id === actionId)
        if (idx < 0) {
          throw new Error(`Pending action not found: ${actionId}`)
        }
        const reviewNote = typeof body.reviewNote === 'string' ? body.reviewNote : undefined
        const updated: SupportLiveTestPendingActionItem = {
          ...list[idx],
          status: decision,
        }
        list[idx] = updated
        if (updated.conversationId) {
          const conv = conversationsByTenant[tenantId]?.find((c) => c.id === updated.conversationId)
          if (conv) {
            conv.messages.push({
              id: `msg_act_${conv.messages.length + 1}`,
              role: 'assistant',
              senderType: 'human_agent',
              senderName: session.email,
              content:
                decision === 'approved'
                  ? `Action "${updated.toolName}" was approved and executed${reviewNote ? ` (${reviewNote})` : ''}.`
                  : `Action "${updated.toolName}" was rejected${reviewNote ? `: ${reviewNote}` : '.'}`,
              createdAt: '2026-11-18T00:16:00.000Z',
            })
          }
        }
        return {
          ok: true,
          action: {
            ...updated,
            reviewedBy: session.email,
            ...(reviewNote ? { reviewNote } : {}),
            executionStatus: decision === 'approved' ? 'succeeded' : 'failed',
          },
        }
      }

      const queryIdx = path.indexOf('?')
      const queryParams = new URLSearchParams(queryIdx >= 0 ? path.slice(queryIdx + 1) : '')
      const filterConvId = queryParams.get('conversationId')
      const actions = (pendingActionsByTenant[tenantId] ?? []).filter(
        (a) => a.status === 'pending' && (!filterConvId || a.conversationId === filterConvId),
      )
      return { ok: true, actions }
    }

    if (path.includes('/service-desk/live-test/playbook/run') && method === 'POST') {
      const inputCases = Array.isArray(body.cases)
        ? (body.cases as SupportLiveTestPlaybookCase[])
        : playbooksByTenant[tenantId].cases
      const results = inputCases.map((c) => {
        if (c.expectation === 'guest_denied') {
          return {
            caseId: c.id,
            title: c.title,
            passed: !tenant.allowGuest,
            status: 403,
            durationMs: 5,
            actualOutcome: 'guest_denied' as const,
            citationsCount: 0,
            toolsCalled: [],
            errorCode: 'guest_not_allowed',
          }
        }
        return {
          caseId: c.id,
          title: c.title,
          passed: c.expectation !== 'guardrail_blocked',
          status: 200,
          durationMs: 12,
          actualOutcome: c.expectation === 'cited' ? ('cited' as const) : ('any_reply' as const),
          replyPreview: 'Mock runtime playbook reply.',
          citationsCount: c.expectation === 'cited' ? 1 : 0,
          toolsCalled: c.expectation === 'tool_called' ? ['lookup_order'] : [],
        }
      })
      const passedCount = results.filter((r) => r.passed).length
      return {
        ok: true,
        tenantId,
        ranAt: '2026-11-18T00:20:00.000Z',
        passedCount,
        failedCount: results.length - passedCount,
        results,
      }
    }

    if (path.includes('/service-desk/live-test/playbook')) {
      if (method === 'PUT') {
        const next: SupportLiveTestPlaybook = {
          version: playbooksByTenant[tenantId].version + 1,
          updatedAt: '2026-11-18T00:18:00.000Z',
          cases: Array.isArray(body.cases) ? (body.cases as SupportLiveTestPlaybookCase[]) : [],
        }
        playbooksByTenant[tenantId] = next
        return { ok: true, playbook: next }
      }
      return { ok: true, playbook: playbooksByTenant[tenantId] }
    }

    if (path.endsWith('/conversations')) {
      return { ok: true, conversations: conversationsByTenant[tenantId] ?? [] }
    }

    const replyMatch = /\/conversations\/([^/]+)\/reply$/.exec(path)
    if (replyMatch && method === 'POST') {
      const convId = decodeURIComponent(replyMatch[1])
      recordedReplyBodies.push({ tenantId, convId, body })
      const conv = conversationsByTenant[tenantId]?.find((c) => c.id === convId)
      if (conv) {
        conv.messages.push({
          id: `msg_staff_${conv.messages.length + 1}`,
          role: 'assistant',
          senderType: 'human_agent',
          senderName: String(body.agentName ?? 'Support Agent'),
          content: String(body.content),
          createdAt: '2026-11-18T00:15:00.000Z',
        })
        if (body.resolveConversation === true) {
          conv.status = 'resolved'
        }
      }
      return { ok: true }
    }

    if (path.includes('/service-desk/sla-policy')) {
      return {
        ok: true,
        policy: {
          version: 1,
          updatedAt: '2026-11-18T00:00:00.000Z',
          enabled: false,
          targets: {
            urgent: { firstResponseMinutes: 15, resolutionMinutes: 120 },
            high: { firstResponseMinutes: 60, resolutionMinutes: 480 },
            medium: { firstResponseMinutes: 240, resolutionMinutes: 1440 },
            low: { firstResponseMinutes: 480, resolutionMinutes: 2880 },
          },
          routingRules: [],
        },
      }
    }

    if (path.includes('/service-desk/queue')) {
      return { ok: true, items: [], total: 0 }
    }

    throw new Error(`Unhandled apiFetch: ${method} ${path}`)
  })

  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers ?? {})
    const authHeader = headers.get('authorization')
    const simOrigin = headers.get('x-support-simulated-origin')
    recordedLiveHeaders.push({ url, auth: authHeader, simOrigin })

    const match = /\/api\/thruline\/support\/tenants\/(\d+)\/service-desk\/live-test(\/.*)$/.exec(url)
    if (!match) {
      return jsonResponse({ error: { code: 'not_found', message: `Unexpected fetch ${url}` } }, 404)
    }

    const tenantId = Number(match[1])
    const subpath = match[2].split('?')[0]
    const tenant = tenants.find((t) => t.id === tenantId)!
    const cfg = widgetConfigs[tenantId]

    if (simOrigin && !tenant.allowedOrigins.includes('*') && !tenant.allowedOrigins.includes(simOrigin)) {
      return jsonResponse(
        { error: { code: 'origin_denied', message: `Origin "${simOrigin}" denied.` } },
        403,
      )
    }

    const body = init?.body ? JSON.parse(String(init.body)) : {}

    if (method === 'GET' && subpath === '/widget/config') {
      return jsonResponse({
        ok: true,
        config: {
          version: cfg.version,
          enabled: cfg.enabled,
          appearance: cfg.appearance,
          intake: { ...cfg.intake, schemaHash: `hash_v${cfg.version}` },
        },
      })
    }

    if (method === 'POST' && subpath === '/widget/intake') {
      return jsonResponse(
        {
          ok: true,
          receipt: {
            intakeReceiptId: `rcpt_${tenantId}_${Date.now()}`,
            schemaHash: `hash_v${cfg.version}`,
          },
        },
        201,
      )
    }

    if (method === 'POST' && subpath === '/chat') {
      const userContent = String(body.messages?.[0]?.content ?? '')
      const convId = body.conversationId || `conv_live_${tenantId}`
      let conv = conversationsByTenant[tenantId].find((c) => c.id === convId)
      if (!conv) {
        conv = {
          id: convId,
          tenantId,
          userId: 'cust_101',
          userRole: 'customer',
          status: 'open',
          messages: [],
          createdAt: '2026-11-18T00:05:00.000Z',
          updatedAt: '2026-11-18T00:05:00.000Z',
        }
        conversationsByTenant[tenantId].push(conv)
      }
      const evidence = {
        requestId: body.requestId,
        status: 'cited',
        policyVersion: 1,
        snapshotId: 'snap_1',
        citations: [
          {
            id: 'cit_1',
            ordinal: 1,
            sourceId: 'src_1',
            revisionId: 'rev_1',
            chunkId: 'chk_1',
            title: 'Return Rules',
            excerpt: '30-day refunds with receipt.',
          },
        ],
      }
      const isRefundRequest = userContent.toLowerCase().includes('refund')
      const createdPendingAction = isRefundRequest
        ? {
            id: `act_live_${tenantId}_${(pendingActionsByTenant[tenantId] ?? []).length + 1}`,
            conversationId: convId,
            userId: 'cust_101',
            userName: 'Alice Nguyen',
            userRole: 'customer',
            toolName: 'refund_order',
            actionSummary: 'Process refund for order ORD-900',
            payload: { orderId: 'ORD-900' },
            status: 'pending' as const,
            isLiveTest: true,
            createdAt: '2026-11-18T00:05:03.000Z',
          }
        : null
      if (createdPendingAction) {
        pendingActionsByTenant[tenantId].push(createdPendingAction)
      }

      const replyText = createdPendingAction
        ? 'Your refund request is waiting for operator approval.'
        : 'Return policy allows returns in 30 days [1].'
      conv.messages.push(
        {
          id: `msg_u_${conv.messages.length + 1}`,
          role: 'user',
          senderType: 'customer',
          content: userContent,
          requestId: body.requestId,
          createdAt: '2026-11-18T00:05:01.000Z',
        },
        {
          id: `msg_a_${conv.messages.length + 2}`,
          role: 'assistant',
          senderType: 'ai_assistant',
          content: replyText,
          requestId: body.requestId,
          evidence,
          createdAt: '2026-11-18T00:05:02.000Z',
        },
      )
      return jsonResponse({
        object: 'support.chat.completion',
        model: 'gpt-4o-mini',
        userContext: { role: 'customer', userId: 'cust_101', verified: true },
        allowedTools: createdPendingAction ? ['webhook__refund_order'] : ['lookup_order'],
        toolTrace: createdPendingAction
          ? [{ name: 'webhook__refund_order', kind: 'webhook', status: 'pending_approval', pendingApproval: true }]
          : [{ name: 'lookup_order', kind: 'db' }],
        reply: replyText,
        runtime: {
          conversationId: convId,
          requestId: body.requestId,
          replySource: 'ai',
          evidence,
          ...(createdPendingAction
            ? {
                pendingActions: [
                  {
                    id: createdPendingAction.id,
                    toolName: createdPendingAction.toolName,
                    executionStatus: 'pending',
                  },
                ],
              }
            : {}),
        },
      })
    }

    if (method === 'POST' && subpath === '/escalate') {
      const convId = String(body.conversationId || `conv_live_${tenantId}`)
      const conv = conversationsByTenant[tenantId].find((c) => c.id === convId)
      if (conv) conv.status = 'escalated'
      return jsonResponse({ ok: true, ticket: { id: `tkt_${tenantId}_1`, conversationId: convId }, conversationId: convId }, 201)
    }

    if (method === 'GET' && subpath.startsWith('/conversations/')) {
      const convId = decodeURIComponent(subpath.slice('/conversations/'.length))
      const conv = conversationsByTenant[tenantId].find((c) => c.id === convId)
      if (!conv) return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404)
      return jsonResponse({ ok: true, conversation: conv })
    }

    if (method === 'POST' && subpath === '/csat') {
      recordedCsatSubmissions.push({ tenantId, ...body })
      return jsonResponse({ ok: true }, 201)
    }

    return jsonResponse({ error: { code: 'not_found', message: `Unhandled bridge ${method} ${subpath}` } }, 404)
  })
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  queryClient.clear()
  fetchSpy?.mockRestore()
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
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
    }
  }
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = container.querySelector<T>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`Missing test element: [data-testid="${id}"]`)
  return el
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
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    )
  })
}

async function setWidgetDomValue(selector: string, value: string) {
  const el = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
  if (!el) throw new Error(`Missing widget element: ${selector}`)
  await act(async () => {
    el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function mountStudio() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SupportServiceDesk />
      </QueryClientProvider>,
    )
  })
  await waitFor(() => {
    expect(byId('support-desk-tenant').textContent).toContain('Acme Store')
  })
  await waitFor(() => {
    expect(byId<HTMLInputElement>('widget-title-input').value).toBe('Acme Concierge')
  })
}

describe('Service Desk Studio Live End-User Widget Testing UI (Spec 023)', () => {
  it('defaults to Design Preview with zero live-test network calls, then tests guest lock -> Alice intake -> RAG citations & external diagnostics', async () => {
    await mountStudio()

    expect(byId('widget-mode-design').getAttribute('aria-selected')).toBe('true')
    await waitFor(() => expect(byId('widget-preview-title').textContent).toContain('Acme Concierge'))
    expect(
      vi.mocked(apiFetch).mock.calls.some(([p]) => String(p).includes('/live-test/')),
    ).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()

    // Toggle to Live End-User Test (Tenant 1 has allowGuest: false)
    await click(byId('widget-mode-live'))

    await waitFor(() => {
      expect(
        vi.mocked(apiFetch).mock.calls.some(([p]) => String(p).includes('/live-test/persona-session')),
      ).toBe(true)
    })

    await waitFor(() => {
      expect(byId('live-test-guest-disabled-hint')).toBeTruthy()
      const sendBtn = byId<HTMLButtonElement>('widget-send-btn')
      expect(sendBtn.disabled).toBe(true)
    })

    // Switch persona to Customer Alice
    await click(byId('live-test-preset-customer_alice'))

    await waitFor(() => {
      expect(byId('widget-intake-input-order_id')).toBeTruthy()
    })

    await setWidgetDomValue('[data-testid="widget-intake-input-order_id"]', 'ORD-777')
    await click(byId('widget-intake-submit-btn'))

    await waitFor(() => {
      const form = byId('widget-intake-form')
      expect(form.style.display).toBe('none')
    })

    await setWidgetDomValue('[data-testid="widget-input"]', 'Return policy?')
    await click(byId('widget-send-btn'))

    await waitFor(() => {
      expect(byId('support-widget-live-container').textContent).toContain(
        'Return policy allows returns in 30 days',
      )
      expect(byId('widget-citation-card').textContent).toContain('Return Rules')
    })

    // Verify diagnostics live strictly outside the widget container & Auth header was passed
    const diagPanel = byId('live-test-diagnostics-panel')
    const widgetBox = byId('support-widget-live-container')
    expect(widgetBox.contains(diagPanel)).toBe(false)
    expect(diagPanel.textContent).toContain('gpt-4o-mini')
    expect(diagPanel.textContent).toContain('lookup_order')
    expect(diagPanel.textContent).toContain('cited')
    expect(byId('live-test-open-copilot-btn')).toBeTruthy()
    expect(recordedLiveHeaders.some((h) => h.auth === 'Bearer dash-test-jwt-123')).toBe(true)
  })

  it('shows unsaved changes warning and reloads widget profile when Save & Apply Now is clicked', async () => {
    await mountStudio()
    await click(byId('widget-mode-live'))
    await waitFor(() => expect(byId('live-test-persona-panel')).toBeTruthy())

    await click(byId('live-test-preset-customer_alice'))
    await waitFor(() => {
      expect(byId('widget-title').textContent).toContain('Acme Concierge')
    })

    expect(container.querySelector('[data-testid="live-test-unsaved-banner"]')).toBeNull()

    await change('widget-title-input', 'VIP Concierge')
    await waitFor(() => expect(byId('live-test-unsaved-banner')).toBeTruthy())

    await click(byId('live-test-save-apply-btn'))

    await waitFor(() => {
      expect(container.querySelector('[data-testid="live-test-unsaved-banner"]')).toBeNull()
      expect(byId('widget-title').textContent).toContain('VIP Concierge')
    })
  })

  it('supports Escalate -> Open in Copilot -> Reply & Resolve -> return to Widget -> immediate 5-star CSAT', async () => {
    await mountStudio()
    await click(byId('widget-mode-live'))
    await waitFor(() => expect(byId('live-test-persona-panel')).toBeTruthy())

    await click(byId('live-test-preset-customer_alice'))
    await waitFor(() => expect(byId('widget-intake-input-order_id')).toBeTruthy())

    await setWidgetDomValue('[data-testid="widget-intake-input-order_id"]', 'ORD-888')
    await click(byId('widget-intake-submit-btn'))
    await waitFor(() => expect(byId('widget-intake-form').style.display).toBe('none'))

    await setWidgetDomValue('[data-testid="widget-input"]', 'Please escalate me')
    await click(byId('widget-send-btn'))
    await waitFor(() => expect(byId('live-test-open-copilot-btn')).toBeTruthy())

    await click(byId('widget-escalate-btn'))
    await waitFor(() => {
      expect(
        recordedLiveHeaders.some((h) => h.url.includes('/live-test/escalate')),
      ).toBe(true)
    })

    await click(byId('live-test-open-copilot-btn'))
    await waitFor(() => expect(byId('panel-copilot')).toBeTruthy())
    await waitFor(() => expect(byId('copilot-composer-input')).toBeTruthy())

    await change('copilot-composer-input', 'Manual refund approved.')
    await click(byId('copilot-resolve-on-send'))
    await click(byId('copilot-send-reply-btn'))

    await waitFor(() => expect(recordedReplyBodies.length).toBe(1))
    expect(recordedReplyBodies[0].body).toMatchObject({
      content: 'Manual refund approved.',
      resolveConversation: true,
    })

    // Return to Widget & Intake -> live mode resumes conversation & immediately presents CSAT
    await click(byId('tab-widget'))
    await waitFor(() => expect(byId('support-widget-live-container').textContent).toContain('Manual refund approved.'))
    await waitFor(() => expect(byId('widget-csat-btn-5')).toBeTruthy())

    await click(byId('widget-csat-btn-5'))
    await waitFor(() => expect(recordedCsatSubmissions.length).toBe(1))
    expect(recordedCsatSubmissions[0]).toMatchObject({
      tenantId: 1,
      conversationId: 'conv_live_1',
      score: 5,
    })
  })

  it('isolates live sessions per tenant and checks/enforces simulated origins', async () => {
    await mountStudio()
    await click(byId('widget-mode-live'))
    await waitFor(() => expect(byId('live-test-origin-panel')).toBeTruthy())

    await change('live-test-origin-input', 'https://evil.test')
    await click(byId('live-test-origin-check-btn'))
    await waitFor(() => expect(byId('live-test-origin-result').textContent).toContain('Blocked'))

    await click(byId('live-test-origin-enforce-toggle'))
    await click(byId('live-test-refresh-widget-btn'))

    await waitFor(() => {
      expect(
        recordedLiveHeaders.some(
          (h) => h.url.includes('/widget/config') && h.simOrigin === 'https://evil.test',
        ),
      ).toBe(true)
    })

    await change('live-test-origin-input', 'https://shop.acme.test')
    await click(byId('live-test-origin-check-btn'))
    await waitFor(() => expect(byId('live-test-origin-result').textContent).toContain('Allowed'))

    // Switch tenant to Beta Support (id 2) -> cleanly resets to Design Preview without cross-tenant leaks
    await change('support-desk-tenant', '2')
    await waitFor(() => expect(byId<HTMLInputElement>('widget-title-input').value).toBe('Beta Desk'))
    expect(byId('widget-mode-design').getAttribute('aria-selected')).toBe('true')
    await waitFor(() => expect(byId('widget-preview-title').textContent).toContain('Beta Desk'))

    await click(byId('widget-mode-live'))
    await waitFor(() => {
      expect(
        vi.mocked(apiFetch).mock.calls.some(([p]) =>
          String(p).includes('/tenants/2/service-desk/live-test/persona-session'),
        ),
      ).toBe(true)
    })
    await waitFor(() => {
      expect(
        recordedLiveHeaders.some((h) => h.url.includes('/tenants/2/service-desk/live-test/widget/config')),
      ).toBe(true)
    })
  })

  it('localizes live test controls in Vietnamese when locale is vi', async () => {
    session.locale = 'vi'
    await mountStudio()

    expect(byId('widget-mode-design').textContent).toContain('Xem trước giao diện')
    expect(byId('widget-mode-live').textContent).toContain('Test trực tiếp người dùng cuối')

    await click(byId('widget-mode-live'))
    await waitFor(() => expect(byId('live-test-persona-panel')).toBeTruthy())

    expect(byId('live-test-persona-panel').textContent).toContain('Danh tính & Phân quyền test')
    expect(byId('live-test-apply-persona-btn').textContent).toContain('Áp dụng danh tính')
    expect(byId('live-test-reset-btn').textContent).toContain('Tạo hội thoại mới')
    expect(byId('live-test-origin-panel').textContent).toContain('Kiểm tra Origin & Tên miền')
    expect(byId('live-test-diagnostics-panel').textContent).toContain('Chẩn đoán vận hành')
    expect(byId('live-test-sandbox-panel').textContent).toContain('Dữ liệu thử nghiệm')
    expect(byId('live-test-cleanup-btn').textContent).toContain('Xóa dữ liệu test')
    expect(byId('live-test-playbook-panel').textContent).toContain('Bộ kiểm thử hồi quy')
  })

  it('tracks live-test sandbox counts and cleans up tenant sandbox data cleanly', async () => {
    await mountStudio()
    await click(byId('widget-mode-live'))
    await waitFor(() => expect(byId('live-test-sandbox-panel')).toBeTruthy())
    expect(byId('live-test-sandbox-counts').textContent).toContain('0 chats')
    expect(byId<HTMLButtonElement>('live-test-cleanup-btn').disabled).toBe(true)

    await click(byId('live-test-preset-customer_alice'))
    await waitFor(() => expect(byId('widget-intake-input-order_id')).toBeTruthy())
    await setWidgetDomValue('[data-testid="widget-intake-input-order_id"]', 'ORD-500')
    await click(byId('widget-intake-submit-btn'))
    await waitFor(() => expect(byId('widget-intake-form').style.display).toBe('none'))

    await setWidgetDomValue('[data-testid="widget-input"]', 'Test sandbox count')
    await click(byId('widget-send-btn'))

    await waitFor(() => expect(byId('live-test-sandbox-counts').textContent).toContain('1 chats'))
    expect(byId<HTMLButtonElement>('live-test-cleanup-btn').disabled).toBe(false)

    await click(byId('live-test-cleanup-btn'))
    await waitFor(() => expect(byId('live-test-cleanup-status')).toBeTruthy())
    await waitFor(() => expect(byId('live-test-sandbox-counts').textContent).toContain('0 chats'))
    expect(byId<HTMLButtonElement>('live-test-cleanup-btn').disabled).toBe(true)
  })

  it('surfaces live-test pending actions inline, approves them with a review note, and syncs widget outcome immediately', async () => {
    await mountStudio()
    await click(byId('widget-mode-live'))
    await waitFor(() => expect(byId('live-test-persona-panel')).toBeTruthy())

    await click(byId('live-test-preset-customer_alice'))
    await waitFor(() => expect(byId('widget-intake-input-order_id')).toBeTruthy())
    await setWidgetDomValue('[data-testid="widget-intake-input-order_id"]', 'ORD-900')
    await click(byId('widget-intake-submit-btn'))
    await waitFor(() => expect(byId('widget-intake-form').style.display).toBe('none'))

    await setWidgetDomValue('[data-testid="widget-input"]', 'Please refund order ORD-900')
    await click(byId('widget-send-btn'))

    await waitFor(() => expect(byId('live-test-approvals-panel')).toBeTruthy())
    await waitFor(() => expect(byId('live-test-pending-action-act_live_1_1')).toBeTruthy())
    expect(byId('live-test-pending-action-act_live_1_1').textContent).toContain('refund_order')

    await change('live-test-review-note-act_live_1_1', 'Approved in test')
    await click(byId('live-test-approve-btn-act_live_1_1'))

    await waitFor(() => expect(byId('live-test-action-review-status')).toBeTruthy())
    await waitFor(() => {
      expect(byId('support-widget-live-container').textContent).toContain(
        'Action "refund_order" was approved and executed (Approved in test).',
      )
    })
    expect(container.querySelector('[data-testid="live-test-pending-action-act_live_1_1"]')).toBeNull()
  })

  it('configures, saves, and runs per-tenant regression playbooks with pass/fail summary', async () => {
    await mountStudio()
    await click(byId('widget-mode-live'))
    await waitFor(() => expect(byId('live-test-playbook-panel')).toBeTruthy())
    expect(byId<HTMLButtonElement>('live-test-playbook-run-btn').disabled).toBe(true)

    await click(byId('live-test-playbook-toggle'))
    await waitFor(() => expect(byId('live-test-playbook-starter-btn')).toBeTruthy())

    await click(byId('live-test-playbook-starter-btn'))
    await waitFor(() => expect(byId('live-test-playbook-case-0')).toBeTruthy())
    expect(byId<HTMLButtonElement>('live-test-playbook-run-btn').disabled).toBe(false)

    await click(byId('live-test-playbook-save-btn'))
    await waitFor(() => expect(byId('live-test-playbook-saved')).toBeTruthy())

    await click(byId('live-test-playbook-run-btn'))
    await waitFor(() => expect(byId('live-test-playbook-results')).toBeTruthy())
    expect(byId('live-test-playbook-results').textContent).toContain('Passed: 3')
    expect(byId('live-test-playbook-results').textContent).toContain('Failed: 0')
    expect(byId('live-test-playbook-result-pbk_guest_access').textContent).toContain('PASS')
  })
})
