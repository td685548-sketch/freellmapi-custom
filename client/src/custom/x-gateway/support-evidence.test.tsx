// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import SupportKnowledgeStudio, { type SupportTenant } from './pages/SupportKnowledgeStudio'
import { SUPPORT_EVIDENCE_STRINGS } from './support-evidence-strings'

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

  return { getByTestId, findByTestId, queryByTestId, getByText }
}

interface MockFetchInit {
  method?: string
  body?: string
}

function parseJsonBody<T = Record<string, unknown>>(body: unknown): T {
  if (typeof body !== 'string') {
    throw new Error(`Expected body to be string, received ${typeof body}`)
  }
  return JSON.parse(body) as T
}

const mockTenants: SupportTenant[] = [
  {
    id: 1,
    name: 'Acme Support',
    slug: 'acme-support',
    publicKey: 'pk_acme_123',
    defaultModel: 'gemini-1.5-flash',
    allowedOrigins: ['https://acme.example.com'],
    enabled: true,
  },
  {
    id: 2,
    name: 'Beta Store',
    slug: 'beta-store',
    publicKey: 'pk_beta_456',
    defaultModel: 'gemini-1.5-flash',
    allowedOrigins: ['https://beta.example.com'],
    enabled: true,
  },
]

describe('SupportKnowledgeStudio (Knowledge Studio & Evidence)', () => {
  let queryClient: QueryClient
  const mockApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    })
    mockLocale = 'en'
    mockRevision = 1
    mockPermissions = ['use_x_gateway', 'edit_x_settings']
    mockApiFetch.mockReset()

    // Default route mocks
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/thruline/support/tenants')) {
        return { ok: true, tenants: mockTenants }
      }
      if (url.includes('/knowledge-library/sources')) {
        return { ok: true, sources: [] }
      }
      if (url.includes('/knowledge-library/policy')) {
        return {
          ok: true,
          policy: {
            mode: 'off',
            includeLegacyDocs: true,
            topK: 3,
            minCoverage: 0.25,
            maxEvidenceChars: 6000,
            version: 1,
            updatedAt: '1970-01-01T00:00:00.000Z',
          },
        }
      }
      if (url.includes('/knowledge-library/suites')) {
        return { ok: true, suites: [] }
      }
      if (url.includes('/knowledge-library/runs')) {
        return { ok: true, runs: [] }
      }
      return { ok: true }
    })
  })

  afterEach(() => {
    cleanup()
    queryClient.clear()
  })

  function renderStudio() {
    return render(
      <QueryClientProvider client={queryClient}>
        <SupportKnowledgeStudio />
      </QueryClientProvider>
    )
  }

  // 1. Permissions gate
  it('permissions gate: hides studio queries and renders permission banner when missing edit_x_settings', async () => {
    mockPermissions = ['use_x_gateway'] // Missing edit_x_settings

    const { container } = renderStudio()
    const utils = within(container)

    await utils.findByTestId('support-evidence-permission-denied')
    expect(utils.getByTestId('support-evidence-permission-denied').textContent).toContain(
      SUPPORT_EVIDENCE_STRINGS.en.permissionDenied
    )

    // Verify no knowledge queries were dispatched
    const calls = mockApiFetch.mock.calls.map(c => c[0] as string)
    const knowledgeCalls = calls.filter(c => c.includes('/knowledge-library'))
    expect(knowledgeCalls.length).toBe(0)
  })

  // 2. Tenant selector and four tabs
  it('renders tenant selector and switches between all four tabs', async () => {
    const { container } = renderStudio()
    const utils = within(container)

    await utils.findByTestId('support-evidence-tenant')
    const tenantSelect = utils.getByTestId('support-evidence-tenant') as HTMLSelectElement
    expect(tenantSelect.value).toBe('1')

    // Sources panel is active by default
    await utils.findByTestId('panel-sources')
    expect(utils.queryByTestId('panel-preview')).toBeNull()

    // Switch to Preview tab
    fireEvent.click(utils.getByTestId('tab-preview'))
    await utils.findByTestId('panel-preview')
    expect(utils.queryByTestId('panel-sources')).toBeNull()

    // Switch to Policy tab
    fireEvent.click(utils.getByTestId('tab-policy'))
    await utils.findByTestId('panel-policy')

    // Switch to Evaluations tab
    fireEvent.click(utils.getByTestId('tab-evaluations'))
    await utils.findByTestId('panel-evaluations')
  })

  // 3. Sources CRUD & Default Admin ACL
  it('sources tab: lists sources, displays draft vs published status, and creates new source with default admin role', async () => {
    mockApiFetch.mockImplementation(async (url: string, init?: MockFetchInit) => {
      if (url.endsWith('/api/thruline/support/tenants')) {
        return { ok: true, tenants: mockTenants }
      }
      if (url.includes('/knowledge-library/sources') && init?.method === 'POST') {
        const body = parseJsonBody(init?.body)
        return {
          ok: true,
          source: {
            id: 'src_new_1',
            tenantId: 1,
            name: body.name,
            kind: body.kind,
            status: 'active',
            allowedRoles: body.allowedRoles,
            version: 1,
            publishedRevisionId: null,
            draftRevisionId: null,
            revisionCount: 0,
            createdAt: '2026-11-13T00:00:00.000Z',
            updatedAt: '2026-11-13T00:00:00.000Z',
          },
        }
      }
      if (url.includes('/knowledge-library/sources')) {
        return {
          ok: true,
          sources: [
            {
              id: 'src_existing_1',
              tenantId: 1,
              name: 'Return Policy',
              kind: 'markdown',
              status: 'active',
              allowedRoles: ['admin', 'customer'],
              version: 2,
              publishedRevisionId: 'rev_pub_1',
              draftRevisionId: 'rev_draft_2',
              revisionCount: 2,
              createdAt: '2026-11-13T00:00:00.000Z',
              updatedAt: '2026-11-13T00:00:00.000Z',
            },
          ],
        }
      }
      return { ok: true }
    })

    const { container } = renderStudio()
    const utils = within(container)

    await utils.findByTestId('source-card-src_existing_1')
    expect(container.textContent).toContain('Return Policy')
    expect(container.textContent).toContain('rev_pub_1')
    expect(container.textContent).toContain('rev_draft_2')

    // Create a new source with name and kind
    fireEvent.change(utils.getByTestId('source-name-input'), { target: { value: 'FAQ Billing' } })
    fireEvent.change(utils.getByTestId('source-kind-select'), { target: { value: 'faq_json' } })

    fireEvent.click(utils.getByTestId('create-source-btn'))

    await waitFor(() => {
      const postCall = mockApiFetch.mock.calls.find(c => c[0].endsWith('/sources') && c[1]?.method === 'POST')
      expect(postCall).toBeTruthy()
      const body = parseJsonBody(postCall![1].body)
      expect(body).toMatchObject({
        name: 'FAQ Billing',
        kind: 'faq_json',
        allowedRoles: ['admin'], // Default role is admin only
      })
    })
  })

  // 4. Draft revision import and client-side limit checks
  it('sources tab: imports draft revision with client-side size check and handles deduplication', async () => {
    mockApiFetch.mockImplementation(async (url: string, init?: MockFetchInit) => {
      if (url.endsWith('/api/thruline/support/tenants')) return { ok: true, tenants: mockTenants }
      if (url.includes('/knowledge-library/sources/src_1/revisions') && init?.method === 'POST') {
        return {
          ok: true,
          deduplicated: true,
          revision: {
            id: 'rev_dedup_1',
            tenantId: 1,
            sourceId: 'src_1',
            format: 'markdown',
            title: 'Terms of Service',
            category: 'Legal',
            tags: ['tos'],
            contentHash: 'hash123',
            chunkCount: 2,
            createdAt: '2026-11-13T00:00:00.000Z',
          },
          source: { id: 'src_1', version: 2 },
        }
      }
      if (url.includes('/knowledge-library/sources/src_1/revisions')) {
        return { ok: true, revisions: [] }
      }
      if (url.includes('/knowledge-library/sources')) {
        return {
          ok: true,
          sources: [
            {
              id: 'src_1',
              tenantId: 1,
              name: 'Terms of Service',
              kind: 'markdown',
              status: 'active',
              allowedRoles: ['admin'],
              version: 1,
              publishedRevisionId: null,
              draftRevisionId: null,
              revisionCount: 0,
            },
          ],
        }
      }
      return { ok: true }
    })

    const { container } = renderStudio()
    const utils = within(container)

    await utils.findByTestId('select-source-btn-src_1')
    fireEvent.click(utils.getByTestId('select-source-btn-src_1'))

    await utils.findByTestId('revision-title-input')
    fireEvent.change(utils.getByTestId('revision-title-input'), { target: { value: 'TOS 2026' } })

    // Test oversize client-side check (>64k chars)
    const giantText = 'A'.repeat(65_000)
    fireEvent.change(utils.getByTestId('revision-content-input'), { target: { value: giantText } })
    fireEvent.click(utils.getByTestId('import-revision-btn'))

    await waitFor(() => {
      expect(container.textContent).toContain('64,000')
    })
    // Verify POST was NOT made with giant text
    expect(mockApiFetch.mock.calls.some(c => c[1]?.method === 'POST' && c[0].includes('/revisions'))).toBe(false)

    // Valid text import
    fireEvent.change(utils.getByTestId('revision-content-input'), { target: { value: 'Valid terms content here' } })
    fireEvent.click(utils.getByTestId('import-revision-btn'))

    await waitFor(() => {
      expect(container.textContent).toContain(SUPPORT_EVIDENCE_STRINGS.en.sources.importDeduplicated)
    })
  })

  // 5. Publish and rollback
  it('sources tab: publishes revision and supports explicit rollback', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/thruline/support/tenants')) return { ok: true, tenants: mockTenants }
      if (url.includes('/knowledge-library/sources/src_pub/publish')) {
        return { ok: true, source: { id: 'src_pub', version: 3, publishedRevisionId: 'rev_old' } }
      }
      if (url.includes('/knowledge-library/sources/src_pub/revisions')) {
        return {
          ok: true,
          revisions: [
            { id: 'rev_current', title: 'Revision 2 (New)', format: 'text', chunkCount: 1, createdAt: '2026-11-13' },
            { id: 'rev_old', title: 'Revision 1 (Old)', format: 'text', chunkCount: 1, createdAt: '2026-11-12' },
          ],
        }
      }
      if (url.includes('/knowledge-library/sources')) {
        return {
          ok: true,
          sources: [
            {
              id: 'src_pub',
              tenantId: 1,
              name: 'Doc With Revisions',
              kind: 'text',
              status: 'active',
              allowedRoles: ['admin'],
              version: 2,
              publishedRevisionId: 'rev_current',
              draftRevisionId: 'rev_current',
              revisionCount: 2,
            },
          ],
        }
      }
      return { ok: true }
    })

    const { container } = renderStudio()
    const utils = within(container)

    await utils.findByTestId('select-source-btn-src_pub')
    fireEvent.click(utils.getByTestId('select-source-btn-src_pub'))

    await utils.findByTestId('publish-revision-btn-rev_old')
    // Click rollback to older revision
    fireEvent.click(utils.getByTestId('publish-revision-btn-rev_old'))

    await waitFor(() => {
      const pubCall = mockApiFetch.mock.calls.find(c => c[0].includes('/src_pub/publish'))
      expect(pubCall).toBeTruthy()
      expect(parseJsonBody(pubCall![1].body)).toMatchObject({
        expectedVersion: 2,
        revisionId: 'rev_old',
      })
    })
  })

  // 6. Archive and unarchive
  it('sources tab: archives and unarchives source', async () => {
    mockApiFetch.mockImplementation(async (url: string, init?: MockFetchInit) => {
      if (url.endsWith('/api/thruline/support/tenants')) return { ok: true, tenants: mockTenants }
      if (url.includes('/knowledge-library/sources/src_arch') && init?.method === 'PATCH') {
        return { ok: true, source: { id: 'src_arch', version: 2, status: 'archived' } }
      }
      if (url.includes('/knowledge-library/sources')) {
        return {
          ok: true,
          sources: [
            {
              id: 'src_arch',
              tenantId: 1,
              name: 'To Archive',
              kind: 'text',
              status: 'active',
              allowedRoles: ['admin'],
              version: 1,
              publishedRevisionId: null,
              draftRevisionId: null,
              revisionCount: 1,
            },
          ],
        }
      }
      return { ok: true }
    })

    const { container } = renderStudio()
    const utils = within(container)

    await utils.findByTestId('archive-source-btn-src_arch')
    fireEvent.click(utils.getByTestId('archive-source-btn-src_arch'))

    await waitFor(() => {
      const patchCall = mockApiFetch.mock.calls.find(c => c[0].includes('/src_arch') && c[1]?.method === 'PATCH')
      expect(patchCall).toBeTruthy()
      expect(parseJsonBody(patchCall![1].body)).toMatchObject({
        expectedVersion: 1,
        status: 'archived',
      })
    })
  })

  // 6b. Edit existing source allowedRoles via PATCH with expectedVersion and OCC 409 handling
  it('sources tab: edits allowedRoles of existing source via PATCH with expectedVersion, and handles 409 conflict', async () => {
    let patchCount = 0
    mockApiFetch.mockImplementation(async (url: string, init?: MockFetchInit) => {
      if (url.endsWith('/api/thruline/support/tenants')) return { ok: true, tenants: mockTenants }
      if (url.includes('/knowledge-library/sources/src_roles_1') && init?.method === 'PATCH') {
        patchCount++
        const body = parseJsonBody(init?.body)
        if (patchCount === 1) {
          return {
            ok: true,
            source: {
              id: 'src_roles_1',
              tenantId: 1,
              name: 'Protected Docs',
              kind: 'text',
              status: 'active',
              allowedRoles: body.allowedRoles,
              version: 4,
              publishedRevisionId: null,
              draftRevisionId: null,
              revisionCount: 0,
            },
          }
        }
        const err = new Error('Version conflict: Resource was updated by another session.')
        throw err
      }
      if (url.includes('/knowledge-library/sources')) {
        return {
          ok: true,
          sources: [
            {
              id: 'src_roles_1',
              tenantId: 1,
              name: 'Protected Docs',
              kind: 'text',
              status: 'active',
              allowedRoles: ['admin'],
              version: 3,
              publishedRevisionId: null,
              draftRevisionId: null,
              revisionCount: 0,
            },
          ],
        }
      }
      return { ok: true }
    })

    const { container } = renderStudio()
    const utils = within(container)

    await utils.findByTestId('source-card-src_roles_1')
    expect(container.textContent).toContain('Protected Docs')

    // Click edit roles button
    fireEvent.click(utils.getByTestId('edit-source-roles-btn-src_roles_1'))
    await utils.findByTestId('edit-source-roles-form-src_roles_1')

    // Add customer role
    fireEvent.click(utils.getByTestId('edit-role-customer-src_roles_1'))

    // Save roles
    fireEvent.click(utils.getByTestId('save-source-roles-btn-src_roles_1'))

    await waitFor(() => {
      const patchCall = mockApiFetch.mock.calls.find(c => c[0].includes('/src_roles_1') && c[1]?.method === 'PATCH')
      expect(patchCall).toBeTruthy()
      expect(parseJsonBody(patchCall![1].body)).toMatchObject({
        expectedVersion: 3,
        allowedRoles: ['admin', 'customer'],
      })
    })

    // Trigger conflict by opening form and saving again
    await utils.findByTestId('edit-source-roles-btn-src_roles_1')
    fireEvent.click(utils.getByTestId('edit-source-roles-btn-src_roles_1'))
    await utils.findByTestId('edit-source-roles-form-src_roles_1')
    fireEvent.click(utils.getByTestId('save-source-roles-btn-src_roles_1'))

    await utils.findByTestId('edit-source-roles-error-src_roles_1')
    expect(container.textContent).toContain('Version conflict')
  })

  // 6c. URL revision import with selected format
  it('sources tab: imports URL revision using selected format (markdown/faq_json)', async () => {
    mockApiFetch.mockImplementation(async (url: string, init?: MockFetchInit) => {
      if (url.endsWith('/api/thruline/support/tenants')) return { ok: true, tenants: mockTenants }
      if (url.includes('/knowledge-library/sources/src_url_1/revisions') && init?.method === 'POST') {
        const body = parseJsonBody(init?.body)
        return {
          ok: true,
          revision: {
            id: 'rev_url_imported',
            sourceId: 'src_url_1',
            version: 2,
            format: body.format,
            title: body.title,
            url: body.url,
            chunkCount: 3,
            contentChars: 500,
            createdAt: '2026-11-13T00:00:00.000Z',
          },
          source: {
            id: 'src_url_1',
            tenantId: 1,
            name: 'External Docs',
            kind: 'url',
            status: 'active',
            allowedRoles: ['admin'],
            version: 2,
            publishedRevisionId: null,
            draftRevisionId: 'rev_url_imported',
            revisionCount: 1,
          },
        }
      }
      if (url.includes('/knowledge-library/sources')) {
        return {
          ok: true,
          sources: [
            {
              id: 'src_url_1',
              tenantId: 1,
              name: 'External Docs',
              kind: 'url',
              status: 'active',
              allowedRoles: ['admin'],
              version: 1,
              publishedRevisionId: null,
              draftRevisionId: null,
              revisionCount: 0,
            },
          ],
        }
      }
      return { ok: true }
    })

    const { container } = renderStudio()
    const utils = within(container)

    await utils.findByTestId('source-card-src_url_1')
    // Open revisions & import section
    fireEvent.click(utils.getByTestId('select-source-btn-src_url_1'))

    await utils.findByTestId('revision-format-select')
    fireEvent.change(utils.getByTestId('revision-format-select'), { target: { value: 'markdown' } })
    fireEvent.change(utils.getByTestId('revision-title-input'), { target: { value: 'API Reference Markdown' } })
    fireEvent.change(utils.getByTestId('revision-url-input'), { target: { value: 'https://docs.example.com/api.md' } })

    fireEvent.click(utils.getByTestId('import-revision-btn'))

    await waitFor(() => {
      const importCall = mockApiFetch.mock.calls.find(c => c[0].includes('/src_url_1/revisions') && c[1]?.method === 'POST')
      expect(importCall).toBeTruthy()
      expect(parseJsonBody(importCall![1].body)).toMatchObject({
        expectedVersion: 1,
        title: 'API Reference Markdown',
        format: 'markdown',
        url: 'https://docs.example.com/api.md',
      })
    })
  })

  // 7. Preview simulation
  it('preview tab: simulates lexical retrieval without AI model calls and reports coverage and willAbstain', async () => {
    mockApiFetch.mockImplementation(async (url: string, init?: MockFetchInit) => {
      if (url.endsWith('/api/thruline/support/tenants')) return { ok: true, tenants: mockTenants }
      if (url.includes('/knowledge-library/preview') && init?.method === 'POST') {
        return {
          ok: true,
          preview: {
            snapshotId: 'snap_hex_preview_1234567890abcdef',
            policyVersion: 1,
            contextChars: 1200,
            willAbstain: false,
            candidates: [
              {
                citationId: 'cit_1',
                sourceId: 'src_refund',
                revisionId: 'rev_1',
                chunkId: 'chk_1',
                title: 'Refund Windows',
                startLine: 10,
                endLine: 25,
                excerpt: 'Customers may request a refund within 30 days of purchase.',
                lexicalCoverage: 0.8,
                score: 0.85,
              },
            ],
          },
        }
      }
      return { ok: true }
    })

    const { container } = renderStudio()
    const utils = within(container)

    await utils.findByTestId('tab-preview')
    fireEvent.click(utils.getByTestId('tab-preview'))

    await utils.findByTestId('preview-query-input')
    fireEvent.change(utils.getByTestId('preview-query-input'), { target: { value: 'How many days for refund?' } })
    fireEvent.change(utils.getByTestId('preview-role-select'), { target: { value: 'customer' } })

    fireEvent.click(utils.getByTestId('run-preview-btn'))

    await utils.findByTestId('preview-snapshot-id')
    expect(utils.getByTestId('preview-snapshot-id').textContent).toContain('snap_hex_preview')
    expect(utils.getByTestId('preview-will-abstain').textContent).toContain('Sufficient Evidence Found')

    expect(utils.getByTestId('candidate-lexical-coverage').textContent).toContain('80%')
    expect(utils.getByTestId('candidate-lexical-score').textContent).toContain('0.85')
    expect(container.textContent).toContain('Customers may request a refund within 30 days')
  })

  // 8. Policy & 409 OCC Conflict
  it('policy tab: saves policy and handles 409 version conflict by disabling mutations', async () => {
    mockApiFetch.mockImplementation(async (url: string, init?: MockFetchInit) => {
      if (url.endsWith('/api/thruline/support/tenants')) return { ok: true, tenants: mockTenants }
      if (url.includes('/knowledge-library/policy') && init?.method === 'PUT') {
        const err = Object.assign(new Error('source_conflict'), { status: 409 })
        throw err
      }
      if (url.includes('/knowledge-library/policy')) {
        return {
          ok: true,
          policy: {
            mode: 'off',
            includeLegacyDocs: true,
            topK: 3,
            minCoverage: 0.25,
            maxEvidenceChars: 6000,
            version: 1,
            updatedAt: '1970-01-01T00:00:00.000Z',
          },
        }
      }
      return { ok: true }
    })

    const { container } = renderStudio()
    const utils = within(container)

    await utils.findByTestId('tab-policy')
    fireEvent.click(utils.getByTestId('tab-policy'))

    await utils.findByTestId('policy-mode-select')
    fireEvent.change(utils.getByTestId('policy-mode-select'), { target: { value: 'required' } })

    fireEvent.click(utils.getByTestId('save-policy-btn'))

    await utils.findByTestId('policy-conflict-error')
    expect(utils.getByTestId('policy-conflict-error').textContent).toContain(
      SUPPORT_EVIDENCE_STRINGS.en.conflictError
    )
    expect((utils.getByTestId('save-policy-btn') as HTMLButtonElement).disabled).toBe(true)
  })

  // 9. Evaluations: Disjoint validation & Run
  it('evaluations tab: validates disjoint expected/forbidden IDs, saves suite, and runs evaluation', async () => {
    mockApiFetch.mockImplementation(async (url: string, init?: MockFetchInit) => {
      if (url.endsWith('/api/thruline/support/tenants')) return { ok: true, tenants: mockTenants }
      if (url.includes('/knowledge-library/suites/suite_1/runs') && init?.method === 'POST') {
        return {
          ok: true,
          run: {
            id: 'run_eval_99',
            tenantId: 1,
            suiteId: 'suite_1',
            suiteVersion: 1,
            status: 'completed',
            startedAt: '2026-11-13T00:00:00.000Z',
            completedAt: '2026-11-13T00:00:01.000Z',
            casesChecked: 2,
            totalCases: 2,
            matchedExpectedCases: 2,
            expectedCasesChecked: 2,
            casesWithoutForbiddenHits: 2,
            correctlyAbstainedCases: 0,
            hitAtK: 1.0,
            allPassed: true,
            snapshotIds: ['snap_eval_1'],
            results: [
              {
                caseId: 'case_1',
                role: 'customer',
                returnedSourceIds: ['src_1'],
                expectedHit: true,
                forbiddenHitCount: 0,
                abstentionMatched: true,
                passed: true,
              },
            ],
          },
        }
      }
      if (url.includes('/knowledge-library/suites')) {
        return {
          ok: true,
          suites: [
            {
              id: 'suite_1',
              tenantId: 1,
              name: 'FAQ Regression Suite',
              version: 1,
              cases: [{ id: 'case_1', query: 'FAQ', role: 'customer', expectedSourceIds: ['src_1'], forbiddenSourceIds: [], expectAbstention: false }],
              createdAt: '2026-11-13T00:00:00.000Z',
              updatedAt: '2026-11-13T00:00:00.000Z',
            },
          ],
        }
      }
      return { ok: true }
    })

    const { container } = renderStudio()
    const utils = within(container)

    await utils.findByTestId('tab-evaluations')
    fireEvent.click(utils.getByTestId('tab-evaluations'))

    await utils.findByTestId('suite-name-input')
    fireEvent.change(utils.getByTestId('suite-name-input'), { target: { value: 'Disjoint Test Suite' } })

    // Set overlapping expected and forbidden IDs
    fireEvent.change(utils.getByTestId('case-expected-input-0'), { target: { value: 'src_overlap' } })
    fireEvent.change(utils.getByTestId('case-forbidden-input-0'), { target: { value: 'src_overlap' } })

    fireEvent.click(utils.getByTestId('save-suite-btn'))

    await utils.findByTestId('suite-disjoint-warning')
    expect(utils.getByTestId('suite-disjoint-warning').textContent).toContain('disjoint')

    // Now run the existing suite
    await utils.findByTestId('run-suite-btn-suite_1')
    fireEvent.click(utils.getByTestId('run-suite-btn-suite_1'))

    await utils.findByTestId('evaluation-run-results')
    expect(utils.getByTestId('run-status').textContent).toBe('completed')
    expect(utils.getByTestId('run-all-passed').textContent).toBe('Yes')
    expect(utils.getByTestId('run-cases-checked').textContent).toBe('2 / 2')
    expect(utils.getByTestId('case-result-case_1').textContent).toContain('Passed')
  })

  // 9b. Load, edit, and update existing suite via PUT with expectedVersion
  it('evaluations tab: loads, edits, and updates existing suite via PUT with expectedVersion', async () => {
    mockApiFetch.mockImplementation(async (url: string, init?: MockFetchInit) => {
      if (url.endsWith('/api/thruline/support/tenants')) return { ok: true, tenants: mockTenants }
      if (url.includes('/knowledge-library/suites/suite_edit_1') && init?.method === 'PUT') {
        const body = parseJsonBody(init?.body)
        return {
          ok: true,
          suite: {
            id: 'suite_edit_1',
            tenantId: 1,
            name: body.name,
            version: 3,
            cases: body.cases,
            createdAt: '2026-11-13T00:00:00.000Z',
            updatedAt: '2026-11-13T00:00:00.000Z',
          },
        }
      }
      if (url.includes('/knowledge-library/suites')) {
        return {
          ok: true,
          suites: [
            {
              id: 'suite_edit_1',
              tenantId: 1,
              name: 'Original Suite Name',
              version: 2,
              cases: [
                { id: 'case_old_1', query: 'Old Query', role: 'customer', expectedSourceIds: ['src_1'], forbiddenSourceIds: [], expectAbstention: false },
              ],
              createdAt: '2026-11-13T00:00:00.000Z',
              updatedAt: '2026-11-13T00:00:00.000Z',
            },
          ],
        }
      }
      return { ok: true }
    })

    const { container } = renderStudio()
    const utils = within(container)

    await utils.findByTestId('tab-evaluations')
    fireEvent.click(utils.getByTestId('tab-evaluations'))
    await utils.findByTestId('suite-card-suite_edit_1')
    expect(container.textContent).toContain('Original Suite Name')

    // Click edit suite button
    fireEvent.click(utils.getByTestId('edit-suite-btn-suite_edit_1'))

    // Form title updates to Edit Suite (v2)
    expect(container.textContent).toContain('Edit Suite (v2)')
    expect((utils.getByTestId('suite-name-input') as HTMLInputElement).value).toBe('Original Suite Name')

    // Change name and update case
    fireEvent.change(utils.getByTestId('suite-name-input'), { target: { value: 'Renamed Suite' } })

    // Click update suite button
    fireEvent.click(utils.getByTestId('save-suite-btn'))

    await waitFor(() => {
      const putCall = mockApiFetch.mock.calls.find(c => c[0].includes('/suites/suite_edit_1') && c[1]?.method === 'PUT')
      expect(putCall).toBeTruthy()
      expect(parseJsonBody(putCall![1].body)).toMatchObject({
        expectedVersion: 2,
        name: 'Renamed Suite',
        cases: [
          { id: 'case_old_1', query: 'Old Query', role: 'customer' },
        ],
      })
    })
  })

  // 9c. Regression: Case IDs remain unique and stable after middle delete and add (1/2/3 -> remove 2 -> add -> save)
  it('evaluations tab regression: case IDs remain unique and stable after delete, reorder, and add (1/2/3 -> remove 2 -> add -> save)', async () => {
    mockApiFetch.mockImplementation(async (url: string, init?: MockFetchInit) => {
      if (url.endsWith('/api/thruline/support/tenants')) return { ok: true, tenants: mockTenants }
      if (url.includes('/knowledge-library/suites') && init?.method === 'POST') {
        const body = parseJsonBody(init?.body)
        return {
          ok: true,
          suite: {
            id: 'suite_reg_1',
            tenantId: 1,
            name: body.name,
            version: 1,
            cases: body.cases,
            createdAt: '2026-11-13T00:00:00.000Z',
            updatedAt: '2026-11-13T00:00:00.000Z',
          },
        }
      }
      if (url.includes('/knowledge-library/suites')) {
        return { ok: true, suites: [] }
      }
      return { ok: true }
    })

    const { container } = renderStudio()
    const utils = within(container)

    await utils.findByTestId('tab-evaluations')
    fireEvent.click(utils.getByTestId('tab-evaluations'))
    await utils.findByTestId('suite-name-input')

    // Initial state: case_1 exists
    expect((utils.getByTestId('case-id-input-0') as HTMLInputElement).value).toBe('case_1')

    // Add case_2
    fireEvent.click(utils.getByTestId('add-case-btn'))
    expect((utils.getByTestId('case-id-input-1') as HTMLInputElement).value).toBe('case_2')

    // Add case_3
    fireEvent.click(utils.getByTestId('add-case-btn'))
    expect((utils.getByTestId('case-id-input-2') as HTMLInputElement).value).toBe('case_3')

    // Remove case_2 (index 1)
    fireEvent.click(utils.getByTestId('remove-case-btn-1'))

    // Now index 0 is case_1, index 1 is case_3
    expect((utils.getByTestId('case-id-input-0') as HTMLInputElement).value).toBe('case_1')
    expect((utils.getByTestId('case-id-input-1') as HTMLInputElement).value).toBe('case_3')

    // Click Add Case again: MUST NOT produce duplicate case_3! It must produce case_4!
    fireEvent.click(utils.getByTestId('add-case-btn'))
    expect((utils.getByTestId('case-id-input-2') as HTMLInputElement).value).toBe('case_4')

    // Save suite
    fireEvent.change(utils.getByTestId('suite-name-input'), { target: { value: 'Unique ID Suite' } })
    fireEvent.change(utils.getByTestId('case-query-input-0'), { target: { value: 'Q1' } })
    fireEvent.change(utils.getByTestId('case-query-input-1'), { target: { value: 'Q3' } })
    fireEvent.change(utils.getByTestId('case-query-input-2'), { target: { value: 'Q4' } })

    fireEvent.click(utils.getByTestId('save-suite-btn'))

    await waitFor(() => {
      const postCall = mockApiFetch.mock.calls.find(c => c[0].endsWith('/suites') && c[1]?.method === 'POST')
      expect(postCall).toBeTruthy()
      const body = parseJsonBody<{ cases: Array<{ id: string }> }>(postCall![1].body)
      expect(body.cases.map(c => c.id)).toEqual(['case_1', 'case_3', 'case_4'])
    })
  })

  // 10. Localization: Vietnamese strings
  it('localization: supports English and Vietnamese strings across studio', async () => {
    mockLocale = 'vi'

    const { container } = renderStudio()
    const utils = within(container)

    await utils.findByTestId('tab-sources')
    expect(utils.getByTestId('tab-sources').textContent).toBe('Nguồn tri thức')
    expect(utils.getByTestId('tab-preview').textContent).toBe('Xem thử truy xuất')
    expect(utils.getByTestId('tab-policy').textContent).toBe('Chính sách bằng chứng')
    expect(utils.getByTestId('tab-evaluations').textContent).toBe('Đánh giá chất lượng')

    expect(container.textContent).toContain('Các nguồn mới xuất bản chỉ được dùng trong chat trực tiếp')
  })

  // 11. Tenant and session revision isolation
  it('tenant and session revision isolation: changes cancel and partition queries', async () => {
    const { container } = renderStudio()
    const utils = within(container)

    await utils.findByTestId('support-evidence-tenant')
    const select = utils.getByTestId('support-evidence-tenant') as HTMLSelectElement

    // Switch tenant to Tenant 2
    fireEvent.change(select, { target: { value: '2' } })

    await waitFor(() => {
      const tenant2Sources = mockApiFetch.mock.calls.find(c => c[0].includes('/tenants/2/knowledge-library/sources'))
      expect(tenant2Sources).toBeTruthy()
    })
  })
})
