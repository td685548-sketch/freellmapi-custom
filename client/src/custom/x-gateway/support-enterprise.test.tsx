// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import SupportEnterprise from './pages/SupportEnterprise'
import { SUPPORT_ENTERPRISE_STRINGS } from './support-enterprise-strings'

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

function matchesText(el: Element, matcher: string | RegExp): boolean {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (typeof matcher === 'string') {
    return text === matcher || text.includes(matcher)
  }
  return matcher.test(el.textContent ?? '')
}

function within(root: ParentNode) {
  const queryByText = (matcher: string | RegExp): HTMLElement | null => {
    const all = Array.from(root.querySelectorAll<HTMLElement>('*'))
    const exact = all.find(el => {
      const ownText = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent ?? '')
        .join('')
        .trim()
      if (typeof matcher === 'string') {
        return ownText === matcher || (el.children.length === 0 && (el.textContent ?? '').trim() === matcher)
      }
      return matcher.test(ownText) || (el.children.length === 0 && matcher.test(el.textContent ?? ''))
    })
    if (exact) return exact
    return all.find(el => matchesText(el, matcher)) ?? null
  }
  const getByText = (matcher: string | RegExp): HTMLElement => {
    const el = queryByText(matcher)
    if (!el) throw new Error(`Unable to find text: ${String(matcher)}`)
    return el
  }
  const findByText = (matcher: string | RegExp) => waitFor(() => getByText(matcher))

  const getByTestId = (id: string): HTMLElement => {
    const el = root.querySelector<HTMLElement>(`[data-testid="${id}"]`)
    if (!el) throw new Error(`Unable to find testid: ${id}`)
    return el
  }
  const findByTestId = (id: string) => waitFor(() => getByTestId(id))

  const getByLabelText = (label: string): HTMLElement => {
    const labels = Array.from(root.querySelectorAll<HTMLLabelElement>('label'))
    for (const lbl of labels) {
      const text = (lbl.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (text === label || text.startsWith(label) || text.includes(label)) {
        if (lbl.htmlFor) {
          const target = root.querySelector<HTMLElement>(`#${CSS.escape(lbl.htmlFor)}`)
          if (target) return target
        }
        const nested = lbl.querySelector<HTMLElement>('input, textarea, select')
        if (nested) return nested
      }
    }
    const aria = root.querySelector<HTMLElement>(`[aria-label="${label}"]`)
    if (aria) return aria
    throw new Error(`Unable to find label: ${label}`)
  }
  const findByLabelText = (label: string) => waitFor(() => getByLabelText(label))

  const queryByRole = (role: string, opts?: { name?: string }): HTMLElement | null => {
    const selectorMap: Record<string, string> = {
      button: 'button, [role="button"]',
      option: 'option, [role="option"]',
      heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
      table: 'table, [role="table"]',
      tablist: '[role="tablist"]',
      tabpanel: '[role="tabpanel"]',
      alert: '[role="alert"]',
    }
    const sel = selectorMap[role] ?? `[role="${role}"]`
    const candidates = Array.from(root.querySelectorAll<HTMLElement>(sel))
    if (!opts?.name) return candidates[0] ?? null
    return (
      candidates.find(el => {
        const ariaLabel = el.getAttribute('aria-label')?.trim()
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
        return ariaLabel === opts.name || text === opts.name || text.includes(opts.name!)
      }) ?? null
    )
  }
  const getByRole = (role: string, opts?: { name?: string }): HTMLElement => {
    const el = queryByRole(role, opts)
    if (!el) throw new Error(`Unable to find role="${role}" name="${opts?.name ?? ''}"`)
    return el
  }
  const findByRole = (role: string, opts?: { name?: string }) => waitFor(() => getByRole(role, opts))

  return {
    queryByText,
    getByText,
    findByText,
    getByTestId,
    findByTestId,
    getByLabelText,
    findByLabelText,
    queryByRole,
    getByRole,
    findByRole,
  }
}

const screen = within(document.body)

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

const session = vi.hoisted(() => ({ locale: 'en', canEdit: true }))
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: session.locale }) }))
vi.mock('../session-state', () => ({ useSessionRevision: () => 1 }))
vi.mock('../use-session', () => ({ useUserSession: () => ({ session: { email: 'agent@example.com' },
  hasPermission: (permission: string) => permission !== 'edit_x_settings' || session.canEdit }) }))

let client: QueryClient
let tenants: { id: number; name: string }[]
let docs: { id: string; title: string; category: string; allowedRoles: string[]; tags: string[]; content: string; enabled: boolean }[]
let conversations: { id: string; subject: string; userId: string; userRole: string; status: string;
  messages: { id: string; senderType: string; content: string }[] }[]
let tickets: { id: string; subject: string; userId: string; reason: string; status: string; priority: string }[]
let actions: { id: string; toolName: string; actionSummary: string; userId: string; userRole: string;
  payload: Record<string, unknown>; status: string; reviewedBy?: string; reviewNote?: string }[]
let policy: { enabled: boolean; builtinDetectors: string[]; unmaskedRoles: string[] }

beforeEach(() => {
  session.locale = 'en'
  session.canEdit = true
  tenants = [{ id: 1, name: 'Demo Shop' }, { id: 2, name: 'Second Shop' }]
  docs = [{ id: 'kb_1', title: 'Shipping FAQ', category: 'faq', allowedRoles: ['*'], tags: ['shipping'], content: 'Ships in two days.', enabled: true }]
  policy = { enabled: true, builtinDetectors: ['email', 'phone', 'credit_card', 'api_key'], unmaskedRoles: ['admin'] }
  conversations = [{ id: 'conv_1', subject: 'Delivery question', userId: 'cust_101', userRole: 'customer', status: 'escalated',
    messages: [{ id: 'msg_1', senderType: 'customer', content: 'Where is my parcel?' }] }]
  tickets = [{ id: 'tkt_1', subject: 'Missing parcel', userId: 'cust_101', reason: 'Delivery is late', status: 'open', priority: 'high' }]
  actions = [{ id: 'act_1', toolName: 'issue_refund', actionSummary: 'Refund order 123', userId: 'cust_101', userRole: 'customer', payload: { orderId: 123, amount: 25 }, status: 'pending' }]
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (path, options) => {
    const method = options?.method ?? 'GET'
    const body = options?.body ? JSON.parse(String(options.body)) : {}
    if (path === '/api/x-gateway/support/tenants') return { tenants }
    if (path.endsWith('/knowledge/seed')) {
      docs = [...docs, { id: 'kb_seed', title: 'Internal Refund SOP', category: 'internal_sop', allowedRoles: ['staff', 'admin'], tags: ['refund'], content: 'Refund after review.', enabled: true }]
      return { ok: true, docs }
    }
    if (path.endsWith('/knowledge/search')) return { ok: true,
      matches: [{ docId: 'kb_seed', title: 'Internal Refund SOP', snippet: 'Refund after staff review.', score: 2 }], contextPrompt: 'Use the approved refund policy.' }
    if (/\/knowledge\/[^/]+$/.test(path) && method === 'DELETE') { docs = docs.filter(doc => !path.endsWith(`/${doc.id}`)); return { ok: true } }
    if (path.endsWith('/knowledge')) {
      if (method === 'POST') {
        const doc = { enabled: true, ...body, id: body.id ?? 'kb_new' }
        docs = [...docs.filter(d => d.id !== doc.id), doc]
        return { ok: true, doc }
      }
      return { ok: true, docs: path.includes('/2/') ? [] : docs }
    }
    if (path.endsWith('/masking/test')) return { ok: true, result: { masked: 'Contact [REDACTED_EMAIL]', redactionCount: 1, appliedRules: ['email'], bypassedByRole: false } }
    if (path.endsWith('/masking')) {
      if (method === 'PUT') policy = { ...policy, ...body }
      return { ok: true, policy }
    }
    if (path.endsWith('/conversations/conv_1/reply')) {
      conversations = conversations.map(c => ({ ...c, status: body.resolveConversation ? 'resolved' : c.status,
        messages: [...c.messages, { id: 'msg_reply', senderType: 'human_agent', content: body.content }] }))
      return { ok: true, conversation: conversations[0] }
    }
    if (path.endsWith('/conversations')) return { ok: true, conversations }
    if (path.endsWith('/tickets/tkt_1') && method === 'PATCH') { tickets = tickets.map(t => ({ ...t, ...body })); return { ok: true, ticket: tickets[0] } }
    if (path.endsWith('/tickets')) return { ok: true, tickets }
    if (/\/actions\/act_1\/(approve|reject)$/.test(path)) {
      actions = actions.map(a => ({ ...a, ...body, status: path.endsWith('/approve') ? 'approved' : 'rejected' }))
      return { ok: true, action: actions[0] }
    }
    if (path.endsWith('/actions')) return { ok: true, actions }
    if (path.endsWith('/analytics')) return { ok: true, analytics: { totalConversations: 12, deflectionRatePct: 75, openTickets: 3, awaitingApprovalActions: 1, byRole: { guest: 4, customer: 8 } } }
    throw new Error(`Unexpected request: ${method} ${path}`)
  })
})
afterEach(() => { cleanup(); client.clear() })

async function mount() {
  render(<QueryClientProvider client={client}><SupportEnterprise /></QueryClientProvider>)
  await screen.findByRole('option', { name: 'Demo Shop' })
}
function input(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }) }
function tab(name: string) { fireEvent.click(screen.getByTestId(`tab-${name}`)) }
function writes(suffix: string, method = 'POST') {
  return vi.mocked(apiFetch).mock.calls.filter(([path, options]) => path.endsWith(suffix) && options?.method === method)
}
function lastBody(suffix: string, method = 'POST') { return JSON.parse(String(writes(suffix, method).at(-1)?.[1]?.body)) }

describe('Support Operations Center', () => {
  it('loads tenants and clears drafts and prior tenant documents when switching tenants', async () => {
    await mount()
    await screen.findByText('Shipping FAQ')
    input('Title', 'Private draft for Demo Shop')
    fireEvent.change(screen.getByTestId('support-ops-tenant'), { target: { value: '2' } })
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/x-gateway/support/tenants/2/knowledge')).toBe(true))
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('')
    expect(screen.queryByText('Shipping FAQ')).toBeNull()
    expect((screen.getByTestId('support-ops-tenant') as HTMLSelectElement).value).toBe('2')
  })

  it('switches across all five accessible tabs and displays analytics KPIs and roles', async () => {
    await mount()
    for (const name of ['knowledge', 'masking', 'inbox', 'approvals', 'analytics']) {
      tab(name)
      expect(screen.getByTestId(`tab-${name}`).getAttribute('aria-selected')).toBe('true')
      expect(screen.getByTestId(`panel-${name}`).getAttribute('role')).toBe('tabpanel')
    }
    expect((await screen.findByTestId('kpi-totalConversations')).textContent).toContain('12')
    expect(screen.getByTestId('kpi-deflectionRatePct').textContent).toContain('75%')
    expect(screen.getByTestId('kpi-openTickets').textContent).toContain('3')
    expect(screen.getByTestId('kpi-awaitingApprovalActions').textContent).toContain('1')
    const table = screen.getByRole('table')
    expect(within(table).getByText('Customer')).toBeTruthy()
    expect(within(table).getByText('8')).toBeTruthy()
  })

  it('seeds knowledge and sends the selected role to the live RAG search tester', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Seed Default Knowledge Docs' }))
    await screen.findByText('Internal Refund SOP')
    input('Role', 'staff')
    input('Search query', 'refund')
    fireEvent.click(screen.getByRole('button', { name: 'Search knowledge' }))
    await screen.findByText('Refund after staff review.')
    expect(screen.getByText('Use the approved refund policy.')).toBeTruthy()
    expect(lastBody('/knowledge/search')).toEqual({ query: 'refund', role: 'staff' })
    expect(writes('/knowledge/seed')).toHaveLength(1)
  })

  it('creates, updates and deletes documents with role and tag arrays', async () => {
    await mount()
    input('Title', 'Returns policy')
    input('Category', 'policy')
    input('Allowed roles', 'customer, staff, customer')
    input('Tags', 'returns, orders')
    input('Content', 'Returns accepted for 30 days.')
    fireEvent.click(screen.getByRole('button', { name: 'Save document' }))
    await screen.findByText('Returns policy')
    expect(lastBody('/knowledge')).toMatchObject({ title: 'Returns policy', category: 'policy', allowedRoles: ['customer', 'staff'], tags: ['returns', 'orders'] })
    fireEvent.click(screen.getByRole('button', { name: 'Edit: Returns policy' }))
    expect((screen.getByLabelText('Content') as HTMLTextAreaElement).value).toBe('Returns accepted for 30 days.')
    input('Title', 'Updated returns policy')
    fireEvent.click(screen.getByRole('button', { name: 'Save document' }))
    await screen.findByText('Updated returns policy')
    expect(lastBody('/knowledge')).toMatchObject({ id: 'kb_new', title: 'Updated returns policy' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete: Updated returns policy' }))
    await waitFor(() => expect(screen.queryByText('Updated returns policy')).toBeNull())
    expect(writes('/knowledge/kb_new', 'DELETE')).toHaveLength(1)
  })

  it('loads and saves masking configuration and shows the live redaction result', async () => {
    await mount(); tab('masking')
    const email = await screen.findByLabelText('Email addresses')
    expect((email as HTMLInputElement).checked).toBe(true)
    fireEvent.click(email)
    input('Unmasked roles', 'admin, staff')
    fireEvent.click(screen.getByRole('button', { name: 'Save masking policy' }))
    await screen.findByText('Changes saved.')
    expect(lastBody('/masking', 'PUT')).toEqual({ enabled: true, builtinDetectors: ['phone', 'credit_card', 'api_key'], unmaskedRoles: ['admin', 'staff'] })
    input('Role', 'guest')
    input('Sample text', 'Contact alice@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Test redaction' }))
    await screen.findByText('Contact [REDACTED_EMAIL]')
    expect(screen.getByText('Redaction count: 1')).toBeTruthy()
    expect(screen.getByText('Applied rules: email')).toBeTruthy()
    expect(lastBody('/masking/test')).toEqual({ text: 'Contact alice@example.com', role: 'guest' })
  })

  it('replies as a human agent and moves an escalation ticket through its lifecycle', async () => {
    await mount(); tab('inbox')
    await screen.findByText('Where is my parcel?')
    input('Human agent reply', 'Your parcel will arrive tomorrow.')
    fireEvent.click(screen.getByLabelText('Resolve conversation after replying'))
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    await screen.findByText('Your parcel will arrive tomorrow.')
    expect(lastBody('/conversations/conv_1/reply')).toEqual({ agentName: 'agent@example.com', content: 'Your parcel will arrive tomorrow.', resolveConversation: true })
    fireEvent.click(screen.getByRole('button', { name: 'Mark in progress' }))
    await screen.findByText('In progress')
    expect(lastBody('/tickets/tkt_1', 'PATCH')).toEqual({ status: 'in_progress' })
    fireEvent.click(screen.getByRole('button', { name: 'Mark resolved' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Mark resolved' }) as HTMLButtonElement).disabled).toBe(true))
    expect(lastBody('/tickets/tkt_1', 'PATCH')).toEqual({ status: 'resolved' })
  })

  it('shows action details and approves a pending action with an audit note', async () => {
    await mount(); tab('approvals')
    await screen.findByText('issue_refund')
    expect(screen.getByText('Refund order 123')).toBeTruthy()
    expect(screen.getByText(/"amount": 25/)).toBeTruthy()
    input('Review note', 'Receipt verified')
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText('Approved')
    expect(lastBody('/actions/act_1/approve')).toEqual({ reviewedBy: 'agent@example.com', reviewNote: 'Receipt verified' })
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('rejects a pending action without calling the approval endpoint', async () => {
    await mount(); tab('approvals')
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }))
    await screen.findByText('Rejected')
    expect(writes('/actions/act_1/reject')).toHaveLength(1)
    expect(writes('/actions/act_1/approve')).toHaveLength(0)
  })

  it('surfaces failed mutations and preserves the pending action for retry', async () => {
    const normal = vi.mocked(apiFetch).getMockImplementation()!
    vi.mocked(apiFetch).mockImplementation((path, options) => path.endsWith('/approve') ? Promise.reject(new Error('Approval failed')) : normal(path, options))
    await mount(); tab('approvals')
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Approval failed')
    expect(screen.getByText('Pending')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not display a delayed search result after switching tenants', async () => {
    let resolveSearch!: (value: unknown) => void
    const normal = vi.mocked(apiFetch).getMockImplementation()!
    vi.mocked(apiFetch).mockImplementation((path, options) => path.endsWith('/knowledge/search')
      ? new Promise(resolve => { resolveSearch = resolve }) : normal(path, options))
    await mount()
    input('Search query', 'private')
    fireEvent.click(screen.getByRole('button', { name: 'Search knowledge' }))
    await waitFor(() => expect(writes('/knowledge/search')).toHaveLength(1))
    fireEvent.change(screen.getByTestId('support-ops-tenant'), { target: { value: '2' } })
    await act(async () => resolveSearch({ matches: [{ docId: 'secret', title: 'Private first tenant doc', snippet: 'Private first tenant result' }], contextPrompt: 'Private context' }))
    expect(screen.queryByText('Private first tenant result')).toBeNull()
    expect(screen.queryByText('Private context')).toBeNull()
  })

  it('disables configuration changes for read-only users while allowing role search', async () => {
    session.canEdit = false
    await mount()
    expect((screen.getByRole('button', { name: 'Seed Default Knowledge Docs' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Title') as HTMLInputElement).closest('fieldset')?.disabled).toBe(true)
    input('Search query', 'shipping')
    expect((screen.getByRole('button', { name: 'Search knowledge' }) as HTMLButtonElement).disabled).toBe(false)
    tab('masking')
    expect((await screen.findByRole('button', { name: 'Save masking policy' })).closest('fieldset')?.disabled).toBe(true)
    expect(writes('/masking', 'PUT')).toHaveLength(0)
  })

  it('renders complete Vietnamese strings and tab labels', async () => {
    session.locale = 'vi'
    await mount()
    expect(screen.getByRole('heading', { name: 'Trung tâm vận hành hỗ trợ' })).toBeTruthy()
    for (const name of ['knowledge', 'masking', 'inbox', 'approvals', 'analytics'] as const) {
      expect(screen.getByTestId(`tab-${name}`).textContent).toBe(SUPPORT_ENTERPRISE_STRINGS.vi[name])
    }
    expect(Object.keys(SUPPORT_ENTERPRISE_STRINGS.vi)).toEqual(Object.keys(SUPPORT_ENTERPRISE_STRINGS.en))
  })

  it('shows an empty tenant state without fetching tenant-specific resources', async () => {
    tenants = []
    render(<QueryClientProvider client={client}><SupportEnterprise /></QueryClientProvider>)
    await screen.findByText('Create a tenant in AI Support Gateway to get started.')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(vi.mocked(apiFetch).mock.calls.every(([path]) => path === '/api/x-gateway/support/tenants')).toBe(true)
  })

  it('shows loading and a retryable tenant error', async () => {
    let fail!: (error: Error) => void
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    render(<QueryClientProvider client={client}><SupportEnterprise /></QueryClientProvider>)
    expect(screen.getByText('Loading…')).toBeTruthy()
    await act(async () => fail(new Error('Tenants unavailable')))
    expect((await screen.findByRole('alert')).textContent).toContain('Tenants unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('option', { name: 'Demo Shop' })
  })
})
