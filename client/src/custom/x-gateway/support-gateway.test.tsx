// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import SupportGateway from './pages/SupportGateway'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en', setLocale: vi.fn() }) }))
vi.mock('../use-session', () => ({
  useUserSession: () => ({
    hasPermission: (_p: string) => true,
    session: { userId: 1, email: 'admin@example.com' },
  }),
}))
vi.mock('../session-state', () => ({
  useSessionRevision: () => 1,
}))

let root: Root
let container: HTMLDivElement
let client: QueryClient

const mockTenant = {
  id: 1,
  name: 'Shop Demo',
  slug: 'shop-demo',
  publicKey: 'pk_sup_12345678',
  signingSecretMasked: 'sec_sup_****',
  defaultModel: 'auto',
  systemPrompt: 'Storefront assistant',
  allowedOrigins: ['https://shop.example.com'],
  allowGuest: true,
  rolesConfig: [
    { role: 'guest', label: 'Guest', permissions: ['products:read'] },
    { role: 'customer', label: 'Customer', permissions: ['products:read', 'orders:read_own'] },
    { role: 'staff', label: 'Staff', permissions: ['products:read', 'orders:read', 'customers:read'] },
    { role: 'admin', label: 'Admin', permissions: ['*'] },
  ],
  enabled: true,
  createdBy: 1,
  createdAt: '2026-11-12T00:00:00Z',
  updatedAt: '2026-11-12T00:00:00Z',
}

const mockTool = {
  id: 10,
  tenantId: 1,
  name: 'get_customer_orders',
  description: 'Fetch customer orders',
  method: 'POST' as const,
  endpointUrl: 'https://shop.example.com/api/orders',
  headers: {},
  parametersSchema: { type: 'object' },
  allowedRoles: ['customer', 'admin'],
  lockUserIdParam: 'user_id',
  bypassUserLockRoles: ['admin', 'staff'],
  enabled: true,
  createdAt: '2026-11-12T00:00:00Z',
  updatedAt: '2026-11-12T00:00:00Z',
}

const mockDbSource = {
  id: 20,
  tenantId: 1,
  name: 'E-Commerce Storefront DB',
  driver: 'sqlite-sandbox' as const,
  connectionUrl: '',
  authTokenMasked: '',
  schemaSql: 'CREATE TABLE products ...',
  tablePolicies: [
    { tableName: 'products', allowedRoles: ['guest', 'customer', 'admin'] },
    { tableName: 'orders', allowedRoles: ['customer', 'admin'], rowOwnerColumn: 'user_id', bypassRowLockRoles: ['admin'] },
    { tableName: 'customers', allowedRoles: ['customer', 'admin'], rowOwnerColumn: 'id', deniedColumns: ['password_hash', 'secret_note'], bypassRowLockRoles: ['admin'] },
  ],
  maxRows: 50,
  enabled: true,
  createdAt: '2026-11-12T00:00:00Z',
  updatedAt: '2026-11-12T00:00:00Z',
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  })

  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    // 1. Tenants list
    if (url === '/api/thruline/support/tenants' && (!init || !init.method || init.method === 'GET')) {
      return {
        tenants: [mockTenant],
        sampleSchemaSql: 'CREATE TABLE sample ...',
      }
    }

    // 2. Create Tenant
    if (url === '/api/thruline/support/tenants' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      return {
        tenant: {
          ...mockTenant,
          id: 2,
          name: body.name,
          slug: body.slug || 'new-slug',
        },
        signingSecret: 'sec_sup_new_signing_secret_9999',
      }
    }

    // 3. Tools list
    if (url.includes('/tools') && (!init || !init.method || init.method === 'GET')) {
      return { tools: [mockTool] }
    }

    // 4. DB sources list
    if (url.includes('/db-sources') && (!init || !init.method || init.method === 'GET')) {
      return { dbSources: [mockDbSource] }
    }

    // 5. Test Webhook Tool
    if (url.includes('/tools/10/test') && init?.method === 'POST') {
      return {
        ok: true,
        status: 200,
        effectiveArgs: { user_id: 'cust_101', status: 'delivered' },
        data: { orders: [{ id: 1, product: 'Wireless Mouse' }] },
      }
    }

    // 6. Test DB Query
    if (url.includes('/query-test') && init?.method === 'POST') {
      return {
        ok: true,
        rows: [
          { id: 1, user_id: 'cust_101', product_name: 'Wireless Mouse', total_usd: 19.99 },
        ],
        rowCount: 1,
        rewrittenSql: "SELECT * FROM (SELECT * FROM orders WHERE user_id = 'cust_101') AS orders",
        referencedTables: ['orders'],
      }
    }

    // 7. Simulate Chat
    if (url.includes('/simulate-chat') && init?.method === 'POST') {
      return {
        reply: 'Your order of Wireless Mouse is delivered.',
        userContext: {
          tenantId: 1,
          userId: 'cust_101',
          role: 'customer',
          permissions: ['orders:read_own'],
          verified: true,
        },
        allowedTools: [
          {
            kind: 'db',
            id: 20,
            functionName: 'query_orders',
            displayName: 'Orders',
            description: 'Query orders',
            parameters: {},
          },
        ],
        toolTrace: [
          {
            kind: 'db',
            name: 'query_orders',
            rewrittenSql: "SELECT * FROM orders WHERE user_id = 'cust_101'",
            durationMs: 8,
          },
        ],
        modelUsed: 'auto',
        usage: { prompt_tokens: 120, completion_tokens: 25, total_tokens: 145 },
      }
    }

    // 8. Mint token
    if (url.includes('/mint-token') && init?.method === 'POST') {
      return {
        token: 'sup_ctx_eyJuYW1lIjoiQWxpY2UifQ.mockSignature',
        context: {
          tenantId: 1,
          userId: 'cust_101',
          name: 'Alice Nguyen',
          role: 'customer',
          permissions: ['products:read', 'orders:read_own'],
          verified: true,
        },
      }
    }

    return { ok: true }
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
})

describe('SupportGateway Component', () => {
  it('renders tenant information and overview tab with roles', async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <SupportGateway />
          </MemoryRouter>
        </QueryClientProvider>
      )
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('AI Support Gateway')
      expect(container.textContent).toContain('Shop Demo')
      expect(container.textContent).toContain('pk_sup_12345678')
      expect(container.textContent).toContain('Guest OK')
      expect(container.textContent).toContain('Guest')
      expect(container.textContent).toContain('Customer')
      expect(container.textContent).toContain('Admin')
    })
  })

  it('navigates through all 5 tabs properly', async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <SupportGateway />
          </MemoryRouter>
        </QueryClientProvider>
      )
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Shop Demo')
    })

    // Click Webhook Tools Tab
    const webhookTabBtn = Array.from(container.querySelectorAll('.x-tabs button')).find(
      b => b.textContent?.includes('Webhook Tools')
    ) as HTMLButtonElement
    expect(webhookTabBtn).toBeDefined()

    act(() => {
      webhookTabBtn.click()
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('get_customer_orders')
      expect(container.textContent).toContain('Live Webhook Tester')
    })

    // Click Database Tab
    const dbTabBtn = Array.from(container.querySelectorAll('.x-tabs button')).find(
      b => b.textContent?.includes('Database & Policies')
    ) as HTMLButtonElement

    act(() => {
      dbTabBtn.click()
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('E-Commerce Storefront DB')
      expect(container.textContent).toContain('Live SQL Role Policy Tester')
    })

    // Click Live Role Simulator Tab
    const simTabBtn = Array.from(container.querySelectorAll('.x-tabs button')).find(
      b => b.textContent?.includes('Live Role Simulator')
    ) as HTMLButtonElement

    act(() => {
      simTabBtn.click()
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Storefront Support AI Simulator')
      expect(container.textContent).toContain('Alice Nguyen (cust_101)')
    })

    // Click Embed Widget Tab
    const embedTabBtn = Array.from(container.querySelectorAll('.x-tabs button')).find(
      b => b.textContent?.includes('Embed Widget & Integration')
    ) as HTMLButtonElement

    act(() => {
      embedTabBtn.click()
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('widget.js')
      expect(container.textContent).toContain('Interactive Context Token Generator')
    })
  })

  it('creates a new tenant and shows the signing secret banner', async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <SupportGateway />
          </MemoryRouter>
        </QueryClientProvider>
      )
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Shop Demo')
    })

    // Click "New Tenant" button
    const newTenantBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent?.includes('New Tenant')
    ) as HTMLButtonElement
    expect(newTenantBtn).toBeDefined()

    act(() => {
      newTenantBtn.click()
    })

    // Fill form and submit
    await vi.waitFor(() => {
      expect(container.querySelector('div[role="dialog"]')).not.toBeNull()
    })

    const nameInput = container.querySelector('input[placeholder="e.g. MyStore Online"]') as HTMLInputElement
    expect(nameInput).not.toBeNull()

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(nameInput, 'Awesome Shop')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      nameInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const form = container.querySelector('div[role="dialog"] form') as HTMLFormElement
    expect(form).not.toBeNull()

    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    // Check that new secret banner appeared
    await vi.waitFor(() => {
      expect(container.textContent).toContain('New Signing Secret Generated')
      expect(container.textContent).toContain('sec_sup_new_signing_secret_9999')
    })
  })

  it('tests SQL role policy and displays rewritten SQL and result rows', async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <SupportGateway />
          </MemoryRouter>
        </QueryClientProvider>
      )
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Shop Demo')
    })

    // Navigate to Database Tab
    const dbTabBtn = Array.from(container.querySelectorAll('.x-tabs button')).find(
      b => b.textContent?.includes('Database & Policies')
    ) as HTMLButtonElement

    act(() => {
      dbTabBtn.click()
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Execute Policy Test')
    })

    // Click "Execute Policy Test" button
    const testSqlBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent?.includes('Execute Policy Test')
    ) as HTMLButtonElement

    act(() => {
      testSqlBtn.click()
    })

    // Verify rewrittenSql and result rows are rendered
    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        "SELECT * FROM (SELECT * FROM orders WHERE user_id = 'cust_101') AS orders"
      )
      expect(container.textContent).toContain('Wireless Mouse')
      expect(container.textContent).toContain('1 rows returned')
    })
  })

  it('simulates chat with live tool trace', async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <SupportGateway />
          </MemoryRouter>
        </QueryClientProvider>
      )
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Shop Demo')
    })

    // Navigate to Simulator Tab
    const simTabBtn = Array.from(container.querySelectorAll('.x-tabs button')).find(
      b => b.textContent?.includes('Live Role Simulator')
    ) as HTMLButtonElement

    act(() => {
      simTabBtn.click()
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Check status of my recent orders')
    })

    // Click quick prompt button
    const promptBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent?.includes('Check status of my recent orders')
    ) as HTMLButtonElement

    act(() => {
      promptBtn.click()
    })

    // Check that AI reply and tool trace are displayed
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Your order of Wireless Mouse is delivered.')
      expect(container.textContent).toContain('Agentic Tool & SQL Execution Trace')
      expect(container.textContent).toContain("SELECT * FROM orders WHERE user_id = 'cust_101'")
    })
  })

  it('mints signed user token in embed tab', async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <SupportGateway />
          </MemoryRouter>
        </QueryClientProvider>
      )
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Shop Demo')
    })

    // Navigate to Embed Tab
    const embedTabBtn = Array.from(container.querySelectorAll('.x-tabs button')).find(
      b => b.textContent?.includes('Embed Widget & Integration')
    ) as HTMLButtonElement

    act(() => {
      embedTabBtn.click()
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Generate Signed Token')
    })

    // Click "Generate Signed Token"
    const mintBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent?.includes('Generate Signed Token')
    ) as HTMLButtonElement

    act(() => {
      mintBtn.click()
    })

    // Verify token output
    await vi.waitFor(() => {
      expect(container.textContent).toContain('sup_ctx_eyJuYW1lIjoiQWxpY2UifQ.mockSignature')
      expect(container.textContent).toContain('Verified Context Payload')
    })
  })
})
