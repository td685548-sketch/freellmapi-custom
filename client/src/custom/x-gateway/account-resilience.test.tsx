// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import type {
  AccountResilienceListResponse,
  AccountResiliencePolicy,
  AccountSemaphoreSnapshot,
} from '../../../../shared/account-resilience'
import type { ProviderAccount, ProviderAccountsResponse } from '../../../../shared/x-accounts'
import ProviderAccounts from './pages/ProviderAccounts'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/components/toaster', () => ({ Toaster: () => null }))

const actor = vi.hoisted(() => ({ permissions: [] as string[] }))
vi.mock('../use-session', () => ({
  useUserSession: () => ({
    isPending: false,
    session: { email: 'resilience@example.test' },
    hasPermission: (perm: string) => actor.permissions.includes(perm),
  }),
}))

function buildAccount(id: number, overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id,
    provider: 'claude',
    label: `Claude Account ${id}`,
    identity: 'dev@example.test',
    authMethod: 'oauth_pkce',
    enabled: true,
    status: 'healthy',
    monthlyUsage: { requests: 12, tokens: 1200 },
    monthlyRequestCap: 0,
    monthlyTokenCap: 0,
    models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
    ...overrides,
  }
}

function buildAccountsFixture(): ProviderAccountsResponse {
  return {
    providers: [
      {
        id: 'claude',
        name: 'Claude Code',
        category: 'oauth',
        authMethods: ['oauth_pkce'],
        accounts: [
          buildAccount(1, { label: 'Primary Sub' }),
          buildAccount(2, { label: 'Drained Sub' }),
        ],
      },
    ],
    permissions: { add: true, edit: true, delete: true, test: true, manageModels: true },
  }
}

let accountsData: ProviderAccountsResponse
let resilienceData: AccountResilienceListResponse | undefined
let returnUndefinedForResilience: boolean
let root: Root
let container: HTMLDivElement
let queryClient: QueryClient

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  accountsData = buildAccountsFixture()
  returnUndefinedForResilience = false
  actor.permissions = ['use_x_gateway', 'view_keys', 'edit_keys', 'test_keys']

  const policies: Record<number, AccountResiliencePolicy> = {
    1: {
      accountId: 1,
      weight: 3,
      maxConcurrency: 2,
      maxQueueSize: 20,
      failFast: false,
      refreshCircuitUntil: '2099-01-01T12:30:00.000Z',
      refreshFailureCount: 2,
      lastRefreshError: 'OAuth token endpoint returned HTTP 503',
      updatedAt: '2026-11-18T00:00:00.000Z',
    },
    2: {
      accountId: 2,
      weight: 0,
      maxConcurrency: null,
      maxQueueSize: 20,
      failFast: true,
      refreshCircuitUntil: null,
      refreshFailureCount: 0,
      lastRefreshError: null,
      updatedAt: '2026-11-18T00:00:00.000Z',
    },
  }
  const semaphores: Record<number, AccountSemaphoreSnapshot> = {
    1: {
      accountId: 1,
      provider: 'claude',
      running: 2,
      queued: 1,
      maxConcurrency: 2,
      blockedUntil: null,
    },
    2: {
      accountId: 2,
      provider: 'claude',
      running: 0,
      queued: 0,
      maxConcurrency: null,
      blockedUntil: null,
    },
  }
  resilienceData = { policies, semaphores }

  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/thruline-accounts' && (!init?.method || init.method === 'GET')) {
      return structuredClone(accountsData)
    }
    if (path === '/api/thruline-accounts/cooldowns') {
      return { cooldowns: {} }
    }
    if (path === '/api/thruline/proxy-pool') {
      return { entries: [] }
    }
    if (path.endsWith('/models') && (!init?.method || init.method === 'GET')) {
      return {
        providerId: 'claude',
        catalogModels: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
        disabledModels: [],
        customModels: [],
        modelAliases: {},
      }
    }
    if (path === '/api/thruline-accounts/resilience') {
      if (returnUndefinedForResilience) return undefined
      return structuredClone(resilienceData)
    }
    if (path === '/api/thruline-accounts/1/resilience' && init?.method === 'PUT') {
      const patch = JSON.parse(String(init.body ?? '{}')) as Partial<AccountResiliencePolicy>
      const updated: AccountResiliencePolicy = {
        ...resilienceData!.policies[1]!,
        ...(patch.weight !== undefined ? { weight: patch.weight } : {}),
        ...(patch.maxConcurrency !== undefined ? { maxConcurrency: patch.maxConcurrency } : {}),
        ...(patch.failFast !== undefined ? { failFast: patch.failFast } : {}),
      }
      resilienceData!.policies[1] = updated
      resilienceData!.semaphores[1] = {
        ...resilienceData!.semaphores[1]!,
        maxConcurrency: updated.maxConcurrency,
      }
      return {
        ok: true,
        policy: structuredClone(updated),
        semaphore: structuredClone(resilienceData!.semaphores[1]!),
      }
    }
    if (path === '/api/thruline-accounts/1/resilience/reset-circuit' && init?.method === 'POST') {
      const updated: AccountResiliencePolicy = {
        ...resilienceData!.policies[1]!,
        refreshCircuitUntil: null,
        refreshFailureCount: 0,
        lastRefreshError: null,
      }
      resilienceData!.policies[1] = updated
      return {
        ok: true,
        policy: structuredClone(updated),
        semaphore: structuredClone(resilienceData!.semaphores[1]!),
      }
    }
    return undefined
  })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})

afterEach(() => {
  act(() => root.unmount())
  queryClient.clear()
  container.remove()
  vi.unstubAllGlobals()
})

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

function mountPage(locale: 'en' | 'vi' = 'en', element?: ReactNode): void {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale={locale}>
          <MemoryRouter initialEntries={['/thruline/providers/claude']}>
            {element ?? (
              <Routes>
                <Route path="/thruline/providers/:providerId" element={<ProviderAccounts />} />
              </Routes>
            )}
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    )
  })
}

function setInputValue(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function clickElement(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function submitForm(form: HTMLFormElement): void {
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('AccountResilienceControls in ProviderAccounts', () => {
  it('renders fallback badges safely when apiFetch returns undefined and hides mutations in read-only mode', async () => {
    returnUndefinedForResilience = true
    accountsData.permissions = { add: false, edit: false, delete: false, test: false, manageModels: false }

    mountPage('en')
    await flush()

    expect(container.querySelector('[role="switch"]')).toBeNull()
    expect(container.querySelector('[data-testid="account-save-resilience-1"]')).toBeNull()
    expect(container.querySelector('[data-testid="account-sem-badge-1"]')?.textContent).toContain(
      '0 running · 0 queued · Unlimited',
    )
    expect(container.querySelector('[data-testid="account-weight-badge-1"]')?.textContent).toContain(
      'Weight: 1',
    )
  })

  it('displays live running/queued saturation, draining badge, refresh circuit backoff, updates weight/concurrency, and resets circuit', async () => {
    mountPage('en')
    await flush()

    // Live semaphore badge & circuit warning on Account 1
    expect(container.querySelector('[data-testid="account-sem-badge-1"]')?.textContent).toContain(
      '2 running · 1 queued · cap 2',
    )
    expect(container.querySelector('[data-testid="account-circuit-badge-1"]')?.textContent).toContain(
      'Refresh backoff (2x)',
    )
    expect(container.querySelector('[data-testid="account-circuit-error-1"]')?.textContent).toContain(
      'OAuth token endpoint returned HTTP 503',
    )

    // Draining (weight 0) badge on Account 2
    expect(container.querySelector('[data-testid="account-drain-badge-2"]')?.textContent).toContain(
      'Draining (0)',
    )

    // Validate invalid weight > 1,000,000 client-side before sending PUT
    const weightInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Weight Primary Sub"]',
    )!
    setInputValue(weightInput, '1000001')
    submitForm(weightInput.closest('form')!)
    await flush()
    expect(container.textContent).toContain('Weight must be an integer from 0 to 1,000,000.')
    expect(
      vi.mocked(apiFetch).mock.calls.some(
        ([path, init]) => path === '/api/thruline-accounts/1/resilience' && init?.method === 'PUT',
      ),
    ).toBe(false)

    // Save valid weight = 8 and maxConcurrency = 4
    const concurrencyInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Max concurrency Primary Sub"]',
    )!
    setInputValue(weightInput, '8')
    setInputValue(concurrencyInput, '4')
    submitForm(weightInput.closest('form')!)
    await flush()

    const putCall = vi.mocked(apiFetch).mock.calls.find(
      ([path, init]) => path === '/api/thruline-accounts/1/resilience' && init?.method === 'PUT',
    )
    expect(putCall).toBeDefined()
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      weight: 8,
      maxConcurrency: 4,
      failFast: false,
    })
    expect(container.querySelector('[data-testid="account-weight-badge-1"]')?.textContent).toContain(
      'Weight: 8',
    )

    // Reset persisted OAuth refresh circuit
    const resetBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="account-reset-circuit-1"]',
    )!
    clickElement(resetBtn)
    await flush()

    expect(
      vi.mocked(apiFetch).mock.calls.some(
        ([path, init]) =>
          path === '/api/thruline-accounts/1/resilience/reset-circuit' && init?.method === 'POST',
      ),
    ).toBe(true)
    expect(container.querySelector('[data-testid="account-circuit-badge-1"]')?.textContent).toContain(
      'OAuth circuit OK',
    )
  })

  it('renders bilingual Vietnamese controls and badges accurately', async () => {
    mountPage('vi')
    await flush()

    expect(container.querySelector('[data-testid="account-sem-badge-1"]')?.textContent).toContain(
      '2 đang chạy · 1 hàng chờ · trần 2',
    )
    expect(container.querySelector('[data-testid="account-drain-badge-2"]')?.textContent).toContain(
      'Ngừng nhận tải (0)',
    )
    expect(container.querySelector('[data-testid="account-reset-circuit-1"]')?.textContent).toContain(
      'Đặt lại mạch',
    )
  })
})
