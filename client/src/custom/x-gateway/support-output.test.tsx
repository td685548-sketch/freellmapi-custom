// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, type ApiError } from '@/lib/api'
import SupportOutput, { type SupportOutputPolicy } from './pages/SupportOutput'
import { SUPPORT_OUTPUT_STRINGS } from './support-output-strings'

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
    session: { email: 'editor@freellmapi.test' },
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
    await act(async () => {
      await new Promise(r => setTimeout(r, 15))
    })
    try {
      return await cb()
    } catch (err) {
      lastErr = err
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
  change(el: Element, init: { target: { value?: string; checked?: boolean } }) {
    act(() => {
      if (el instanceof HTMLInputElement && el.type === 'checkbox' && init.target.checked !== undefined) {
        if (el.checked !== init.target.checked) {
          el.click()
        }
        return
      }
      const value = init.target.value ?? ''
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

function makePolicy(tenantId: number, overrides: Partial<SupportOutputPolicy> = {}): SupportOutputPolicy {
  return {
    tenantId,
    version: 1,
    mode: 'off',
    blockedTerms: [],
    maxOutputChars: 16000,
    redactCredentials: false,
    updatedAt: '2026-11-15T00:00:00.000Z',
    ...overrides,
  }
}

function makeApiError(status: number, message: string, code?: string): ApiError {
  const err = new Error(message) as ApiError
  err.status = status
  err.code = code
  return err
}

describe('SupportOutput Studio UI (Spec 020)', () => {
  let queryClient: QueryClient

  function mountPage() {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    return render(
      <QueryClientProvider client={queryClient}>
        <SupportOutput />
      </QueryClientProvider>,
    )
  }

  beforeEach(() => {
    mockLocale = 'en'
    mockRevision = 1
    mockPermissions = ['use_x_gateway', 'edit_x_settings']
    vi.mocked(apiFetch).mockReset()
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    queryClient?.clear()
    vi.restoreAllMocks()
  })

  it('renders EN and VI strings including literal matching and credential pattern limitations', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (path === '/api/thruline/support/tenants') {
        return { tenants: [{ id: 1, name: 'Acme' }] }
      }
      if (path === '/api/thruline/support/tenants/1/output-policy') {
        return { ok: true, policy: makePolicy(1) }
      }
      if (path.startsWith('/api/thruline/support/tenants/1/output-events')) {
        return { ok: true, items: [] }
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    const { container } = mountPage()
    await waitFor(() => {
      expect(container.textContent).toContain(SUPPORT_OUTPUT_STRINGS.en.limitationsTitle)
      expect(container.textContent).toContain(SUPPORT_OUTPUT_STRINGS.en.limitationsBody)
    })

    cleanup()
    mockLocale = 'vi'
    const viRender = mountPage()
    await waitFor(() => {
      expect(viRender.container.textContent).toContain(SUPPORT_OUTPUT_STRINGS.vi.limitationsTitle)
      expect(viRender.container.textContent).toContain(SUPPORT_OUTPUT_STRINGS.vi.limitationsBody)
    })
  })

  it('shows readonly banner and skips editor API calls when user lacks edit_x_settings', async () => {
    mockPermissions = ['use_x_gateway']
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (path === '/api/thruline/support/tenants') {
        return { tenants: [{ id: 1, name: 'Acme' }] }
      }
      throw new Error(`Should not fetch editor endpoint: ${path}`)
    })

    const { container } = mountPage()
    await waitFor(() => {
      expect(container.textContent).toContain(SUPPORT_OUTPUT_STRINGS.en.readonlyBanner)
    })

    const calledPaths = vi.mocked(apiFetch).mock.calls.map(c => c[0])
    expect(calledPaths).toEqual(['/api/thruline/support/tenants'])
  })

  it('saves policy with OCC envelope, handles 409 conflict without losing draft, and handles 503', async () => {
    let serverPolicy = makePolicy(1, { version: 2, mode: 'log' })
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path === '/api/thruline/support/tenants') {
        return { tenants: [{ id: 1, name: 'Acme' }] }
      }
      if (path === '/api/thruline/support/tenants/1/output-policy' && (!init?.method || init.method === 'GET')) {
        return { ok: true, policy: serverPolicy }
      }
      if (path === '/api/thruline/support/tenants/1/output-policy' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { expectedVersion: number; policy: { mode: string } }
        if (body.expectedVersion === 2) {
          throw makeApiError(409, 'Conflict', 'output_policy_conflict')
        }
        serverPolicy = makePolicy(1, { version: 4, mode: 'enforce' })
        return { ok: true, policy: serverPolicy }
      }
      if (path.startsWith('/api/thruline/support/tenants/1/output-events')) {
        return { ok: true, items: [] }
      }
      throw new Error(`Unexpected call: ${path}`)
    })

    const { container } = mountPage()
    await waitFor(() => {
      const modeSelect = container.querySelector(`select[aria-label="${SUPPORT_OUTPUT_STRINGS.en.policy.mode}"]`) as HTMLSelectElement
      expect(modeSelect.value).toBe('log')
    })

    // Edit draft to enforce
    const modeSelect = container.querySelector(`select[aria-label="${SUPPORT_OUTPUT_STRINGS.en.policy.mode}"]`) as HTMLSelectElement
    fireEvent.change(modeSelect, { target: { value: 'enforce' } })
    expect(container.textContent).toContain(SUPPORT_OUTPUT_STRINGS.en.unsavedDraft)

    // Background refetch must NOT overwrite unsaved draft
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['x-support-output-policy', 1, 1] })
    })
    expect((container.querySelector(`select[aria-label="${SUPPORT_OUTPUT_STRINGS.en.policy.mode}"]`) as HTMLSelectElement).value).toBe('enforce')

    // Save triggers 409 OCC conflict
    const saveBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes(SUPPORT_OUTPUT_STRINGS.en.save))!
    fireEvent.click(saveBtn)
    await waitFor(() => {
      expect(container.textContent).toContain(SUPPORT_OUTPUT_STRINGS.en.conflictError)
    })

    // Reload latest policy clears conflict and syncs server version
    serverPolicy = makePolicy(1, { version: 3, mode: 'off' })
    const reloadBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes(SUPPORT_OUTPUT_STRINGS.en.reloadPolicy))!
    fireEvent.click(reloadBtn)
    await waitFor(() => {
      expect(container.textContent).toContain('v3')
    })

    // 503 unavailable state on policy fetch
    cleanup()
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (path === '/api/thruline/support/tenants') return { tenants: [{ id: 1, name: 'Acme' }] }
      if (path === '/api/thruline/support/tenants/1/output-policy') throw makeApiError(503, 'Unavailable', 'output_policy_unavailable')
      return { ok: true, items: [] }
    })
    const errRender = mountPage()
    await waitFor(() => {
      expect(errRender.container.textContent).toContain(SUPPORT_OUTPUT_STRINGS.en.unavailableError)
    })
  })

  it('evaluates unsaved preview safely without XSS, localStorage writes, or extra metadata fields', async () => {
    const previewPayloads: Array<Record<string, unknown>> = []
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path === '/api/thruline/support/tenants') return { tenants: [{ id: 1, name: 'Acme' }] }
      if (path === '/api/thruline/support/tenants/1/output-policy') return { ok: true, policy: makePolicy(1) }
      if (path.startsWith('/api/thruline/support/tenants/1/output-events')) return { ok: true, items: [] }
      if (path === '/api/thruline/support/tenants/1/output-policy/preview' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        previewPayloads.push(body)
        if (String(body.text).includes('BLOCK_ME')) {
          return {
            ok: true,
            decision: {
              action: 'block',
              leaves: [],
              reasons: ['blocked_term'],
              ruleIds: ['r1'],
              redactionCount: 0,
              policyVersion: 0,
            },
          }
        }
        return {
          ok: true,
          decision: {
            action: 'allow',
            leaves: [{ path: 'reply', text: String(body.text) }],
            reasons: [],
            ruleIds: [],
            redactionCount: 0,
            policyVersion: 0,
          },
        }
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    const { container } = mountPage()
    await waitFor(() => expect(container.textContent).toContain(SUPPORT_OUTPUT_STRINGS.en.tabs.preview))

    const previewTab = Array.from(container.querySelectorAll('button[role="tab"]')).find(b =>
      b.textContent?.includes(SUPPORT_OUTPUT_STRINGS.en.tabs.preview),
    )!
    fireEvent.click(previewTab)

    const textarea = container.querySelector(`textarea[aria-label="${SUPPORT_OUTPUT_STRINGS.en.preview.textLabel}"]`) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '<script>window.__xss=1</script>' } })
    const runBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes(SUPPORT_OUTPUT_STRINGS.en.preview.run))!
    fireEvent.click(runBtn)

    await waitFor(() => {
      expect(container.querySelector('pre')?.textContent).toBe('<script>window.__xss=1</script>')
    })
    expect(container.querySelectorAll('script')).toHaveLength(0)
    expect(window.localStorage.length).toBe(0)
    // Preview payload must not include tenantId/version/updatedAt
    const sentPolicy = previewPayloads[0]!.policy as Record<string, unknown>
    expect(Object.keys(sentPolicy).sort()).toEqual(['blockedTerms', 'maxOutputChars', 'mode', 'redactCredentials'])

    // Blocked preview hides raw text and displays fixed notice
    fireEvent.change(textarea, { target: { value: 'BLOCK_ME secret' } })
    fireEvent.click(runBtn)
    await waitFor(() => {
      expect(container.textContent).toContain(SUPPORT_OUTPUT_STRINGS.en.preview.blockedNotice)
    })
    expect(container.querySelectorAll('pre')).toHaveLength(0)
  })

  it('paginates metadata-only events and cancels/clears stale state on tenant and session changes', async () => {
    let resolvePreview1!: (v: unknown) => void
    let previewSignal1: AbortSignal | undefined

    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path === '/api/thruline/support/tenants') {
        return { tenants: [{ id: 1, name: 'Tenant One' }, { id: 2, name: 'Tenant Two' }] }
      }
      if (path === '/api/thruline/support/tenants/1/output-policy') return { ok: true, policy: makePolicy(1, { mode: 'enforce' }) }
      if (path === '/api/thruline/support/tenants/2/output-policy') return { ok: true, policy: makePolicy(2, { mode: 'off' }) }
      if (path === '/api/thruline/support/tenants/1/output-events?limit=50') {
        return {
          ok: true,
          items: [
            {
              id: 'ev-1',
              tenantId: 1,
              operationId: 'op-1',
              surface: 'chat',
              policyVersion: 1,
              action: 'block',
              reasons: ['blocked_term'],
              ruleIds: ['r1'],
              redactionCount: 0,
              createdAt: '2026-11-15T01:00:00.000Z',
            },
          ],
          nextCursor: 'cur-1',
        }
      }
      if (path === '/api/thruline/support/tenants/1/output-events?limit=50&before=cur-1') {
        return {
          ok: true,
          items: [
            {
              id: 'ev-2',
              tenantId: 1,
              operationId: 'op-2',
              surface: 'copilot',
              policyVersion: 1,
              action: 'redact',
              reasons: ['credential'],
              ruleIds: [],
              redactionCount: 1,
              createdAt: '2026-11-15T00:30:00.000Z',
            },
          ],
        }
      }
      if (path === '/api/thruline/support/tenants/2/output-events?limit=50') {
        return { ok: true, items: [] }
      }
      if (path === '/api/thruline/support/tenants/1/output-policy/preview') {
        previewSignal1 = init?.signal ?? undefined
        return new Promise((resolve) => {
          resolvePreview1 = resolve
        })
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    const { container } = mountPage()
    await waitFor(() => expect(container.textContent).toContain(SUPPORT_OUTPUT_STRINGS.en.tabs.events))

    // Check events pagination
    const eventsTab = Array.from(container.querySelectorAll('button[role="tab"]')).find(b =>
      b.textContent?.includes(SUPPORT_OUTPUT_STRINGS.en.tabs.events),
    )!
    fireEvent.click(eventsTab)
    await waitFor(() => expect(container.textContent).toContain('op-1'))

    const loadMoreBtn = Array.from(container.querySelectorAll('button')).find(b =>
      b.textContent?.includes(SUPPORT_OUTPUT_STRINGS.en.events.loadMore),
    )!
    fireEvent.click(loadMoreBtn)
    await waitFor(() => expect(container.textContent).toContain('op-2'))

    // Start preview on Tenant 1, then switch to Tenant 2 before it resolves
    const previewTab = Array.from(container.querySelectorAll('button[role="tab"]')).find(b =>
      b.textContent?.includes(SUPPORT_OUTPUT_STRINGS.en.tabs.preview),
    )!
    fireEvent.click(previewTab)
    const textarea = container.querySelector(`textarea[aria-label="${SUPPORT_OUTPUT_STRINGS.en.preview.textLabel}"]`) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'STALE_TENANT_1_TEXT' } })
    const runBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes(SUPPORT_OUTPUT_STRINGS.en.preview.run))!
    fireEvent.click(runBtn)

    const tenantSelect = container.querySelector(`select[aria-label="${SUPPORT_OUTPUT_STRINGS.en.tenant}"]`) as HTMLSelectElement
    fireEvent.change(tenantSelect, { target: { value: '2' } })

    await waitFor(() => {
      expect(previewSignal1?.aborted).toBe(true)
      expect((container.querySelector(`textarea[aria-label="${SUPPORT_OUTPUT_STRINGS.en.preview.textLabel}"]`) as HTMLTextAreaElement).value).toBe('')
    })

    // Resolving stale promise must NOT populate Tenant 2's UI
    await act(async () => {
      resolvePreview1({
        ok: true,
        decision: {
          action: 'allow',
          leaves: [{ path: 'reply', text: 'STALE_TENANT_1_TEXT' }],
          reasons: [],
          ruleIds: [],
          redactionCount: 0,
          policyVersion: 0,
        },
      })
    })
    expect(container.textContent).not.toContain('STALE_TENANT_1_TEXT')

    // Session revision change remounts page and clears state
    mockRevision = 2
    cleanup()
    const remount = mountPage()
    await waitFor(() => expect(remount.container.textContent).toContain(SUPPORT_OUTPUT_STRINGS.en.tabs.policy))
    expect(remount.container.textContent).not.toContain('STALE_TENANT_1_TEXT')
  })
})
