// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONTEXT_POLICY_LIMITS,
  CONTEXT_PRESETS,
  type ContextAssemblySummary,
  type ContextPolicy,
  type ContextPolicyResponse,
  type ContextPreview,
  type ContextStats,
} from '@freellmapi/shared/context-budget.js'
import { clearToken, setToken } from '@/lib/api'
import { I18nProvider, useI18n } from '@/i18n'
import { ConversationsCard } from './ConversationsCard'
import { ContextPolicyCard } from './ContextPolicyCard'
import { RecentRequestsCard } from './RecentRequestsCard'

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: status === 204 ? undefined : { 'content-type': 'application/json' },
  })
}

const makeInheritedPolicy = (over: Partial<ContextPolicy> = {}): ContextPolicy => ({
  profileId: 1,
  enabled: false,
  inherited: true,
  preset: 'balanced',
  ...CONTEXT_PRESETS.balanced,
  updatedAt: '2026-11-18T00:00:00.000Z',
  ...over,
})

function LocaleSwitchButton() {
  const { locale, setLocale } = useI18n()
  return (
    <button type="button" data-testid="switch-vi" onClick={() => setLocale('vi')}>
      {locale}
    </button>
  )
}

function Harness() {
  return (
    <div>
      <LocaleSwitchButton />
      <ConversationsCard profileId={1} canEdit={true} />
      <ContextPolicyCard profileId={1} canEdit={true} />
      <RecentRequestsCard endpoint="/api/client-profiles/1/requests" />
    </div>
  )
}

let container: HTMLDivElement
let root: Root
let client: QueryClient
let previewFetchCount: number
let policyState: ContextPolicy
let convSettings: {
  enabled: boolean
  ttlHours: number
  maxMessages: number
  maxChars: number
  summarize: boolean
}
let recordedPuts: Array<Record<string, unknown>>

const statsData: ContextStats = {
  days: 7,
  requests: 34,
  avgInputTokens: 3790,
  avgBudgetTokens: 4000,
  trimmedRate: 0.76,
  avgHistoryDropped: 18.4,
  savedTokens: 142800,
  summaryUsedRate: 0.65,
  estimateError: {
    samples: 34,
    p50Pct: 2.1,
    p95Pct: 8.9,
    within15PctRate: 0.97,
  },
  byDay: [{ day: '2026-11-18', requests: 34, avgInputTokens: 3790, trimmedRate: 0.76 }],
}

const report501: ContextAssemblySummary = {
  budget: 8000,
  window: 131072,
  mandatory: 240,
  summary: 310,
  knowledge: 0,
  history: 3250,
  histSent: 12,
  histDropped: 16,
  kbSent: 0,
  kbDropped: 0,
  clientDropped: 0,
  refits: 1,
  estimatedTokens: 3800,
  heuristicTokens: 3520,
  modelKey: 'custom:mock-web-128k',
  createdAt: '2026-11-18T00:10:00.000Z',
}

function currentPolicyResponse(): ContextPolicyResponse {
  const suggested =
    policyState.inherited && convSettings.enabled
      ? { maxInputTokens: 8000, summarize: convSettings.summarize }
      : null
  return {
    policy: policyState,
    suggested,
    presets: CONTEXT_PRESETS,
    limits: CONTEXT_POLICY_LIMITS,
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.removeItem('freellmapi.locale')
  setToken('web-e2e-token')
  previewFetchCount = 0
  recordedPuts = []
  convSettings = {
    enabled: true,
    ttlHours: 168,
    maxMessages: 60,
    maxChars: 24000,
    summarize: true,
  }
  policyState = makeInheritedPolicy()

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const authHeader = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(
      'authorization',
    )
    if (authHeader !== 'Bearer web-e2e-token') {
      return jsonResponse({ error: { message: 'Unauthorized', type: 'authentication_error' } }, 401)
    }

    if (url.endsWith('/api/client-profiles/1/conversations') && method === 'GET') {
      return jsonResponse({
        settings: convSettings,
        conversations: [
          {
            id: 'conv-demo-01',
            endUser: 'khach-vip-01',
            messages: 68,
            updatedAt: '2026-11-18T00:05:00.000Z',
            expiresAt: '2026-11-25T00:05:00.000Z',
          },
        ],
      })
    }

    if (url.endsWith('/api/client-profiles/1/conversation-settings') && method === 'PUT') {
      convSettings = { ...convSettings, ...(JSON.parse(String(init?.body)) as typeof convSettings) }
      return jsonResponse({ settings: convSettings, conversations: [] })
    }

    if (url.endsWith('/api/client-profiles/1/context-policy')) {
      if (method === 'GET') return jsonResponse(currentPolicyResponse())
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        recordedPuts.push(body)
        const nextPreset = (body.preset as ContextPolicy['preset']) ?? policyState.preset
        const presetDefaults = nextPreset !== 'custom' ? CONTEXT_PRESETS[nextPreset] : {}
        policyState = {
          ...policyState,
          ...presetDefaults,
          ...body,
          inherited: false,
          preset: nextPreset,
          updatedAt: '2026-11-18T00:12:00.000Z',
        }
        return jsonResponse(currentPolicyResponse())
      }
      if (method === 'DELETE') {
        policyState = makeInheritedPolicy()
        return jsonResponse(null, 204)
      }
    }

    if (url.endsWith('/api/client-profiles/1/context-stats?days=7')) {
      return jsonResponse(statsData)
    }

    if (url.includes('/api/client-profiles/1/conversations/conv-demo-01/context-preview')) {
      previewFetchCount += 1
      const effective = policyState.maxInputTokens ?? 16000
      const preview: ContextPreview = {
        model: { key: 'custom:mock-web-128k', contextWindow: 131072 },
        budget: {
          effective,
          mandatory: 240,
          summaryCap: Math.round((effective - 240) * (policyState.summarySharePct / 100)),
          knowledgeCap: Math.round((effective - 240) * (policyState.knowledgeSharePct / 100)),
          historyCap: Math.max(
            0,
            effective -
              240 -
              Math.round((effective - 240) * (policyState.summarySharePct / 100)) -
              Math.round((effective - 240) * (policyState.knowledgeSharePct / 100)),
          ),
        },
        summary: { coversThroughMessageId: 48, pendingFoldMessages: 4 },
        segments: [
          { kind: 'mandatory', role: 'system', tokens: 120, preview: 'Vietnamese support assistant', sent: true },
          { kind: 'summary', role: 'system', tokens: 190, preview: 'Rolling summary', sent: true },
          {
            kind: 'history',
            role: 'user',
            messageId: 49,
            tokens: 180,
            preview: 'Older order question',
            sent: false,
            reason: 'budget',
          },
          { kind: 'history', role: 'user', messageId: 67, tokens: 160, preview: 'Latest inquiry', sent: true },
        ],
        knowledgeNote: 'Tri thức phụ thuộc câu hỏi thật nên không được giả lập trong xem trước.',
      }
      return jsonResponse(preview)
    }

    if (url.startsWith('/api/client-profiles/1/requests?limit=25')) {
      return jsonResponse({
        requests: [
          {
            id: 501,
            createdAt: '2026-11-18 00:10:00',
            status: 'success',
            platform: 'custom',
            modelId: 'mock-web-128k',
            requestedModel: 'auto',
            latencyMs: 14,
            ttfbMs: null,
            inputTokens: 3800,
            outputTokens: 37,
            endUser: 'khach-vip-01',
            error: null,
          },
        ],
        nextBefore: null,
      })
    }

    if (url.endsWith('/api/client-profiles/1/requests/501/attempts')) {
      return jsonResponse({ attempts: [] })
    }

    if (url.endsWith('/api/client-profiles/1/requests/501/context')) {
      return jsonResponse(report501)
    }

    return jsonResponse({ error: { message: `Unhandled ${method} ${url}` } }, 404)
  })

  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
})

afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
  clearToken()
  localStorage.removeItem('freellmapi.locale')
  vi.restoreAllMocks()
})

const flush = (ms = 20) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

async function renderHarness() {
  await act(async () =>
    root.render(
      <I18nProvider>
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>
      </I18nProvider>,
    ),
  )
  await flush()
}

async function click(el: Element | null) {
  expect(el).not.toBeNull()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

async function setInput(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

const findBtn = (rootEl: ParentNode, label: string) =>
  [...rootEl.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) ?? null

describe('Spec 021 real-apiFetch full-stack web flow', () => {
  it('completes apply-suggested, live Preview context activation, cache refresh after budget edit, validation, reset, one-click preset+switch, and request context inspection', async () => {
    await renderHarness()

    // 1. Initial state: Inherited, Suggested 8,000 visible, Preview context hidden
    expect(findBtn(container, 'Preview context')).toBeNull()
    expect(container.textContent).toContain('Inherited from system default')
    const suggested = container.querySelector('[aria-label="Suggested policy values"]')
    expect(suggested).not.toBeNull()
    expect(suggested!.textContent).toContain('8,000')

    // 2. Click Apply suggested -> PUT sent with Bearer header -> Preview context appears live
    await click(findBtn(container, 'Apply suggested'))
    expect(recordedPuts[0]).toEqual({
      enabled: true,
      preset: 'custom',
      maxInputTokens: 8000,
      summarize: true,
    })
    expect(container.textContent).toContain('Custom override')
    const previewBtn = findBtn(container, 'Preview context')
    expect(previewBtn).not.toBeNull()

    // 3. Open Preview context -> real apiFetch + scrollable wrapper + segments + summary coverage
    await click(previewBtn)
    expect(previewFetchCount).toBe(1)
    expect(document.body.textContent).toContain('custom:mock-web-128k')
    expect(document.body.textContent).toContain('8,000 tokens')
    expect(document.body.textContent).toContain('Summarized through message #48')
    expect(document.body.querySelector('.max-h-\\[50vh\\].overflow-auto')).not.toBeNull()

    await click(document.querySelector('[aria-label="Close"]'))

    // 4. Edit budget to 12,000 and Save -> reopening Preview context fetches updated 12,000 budget
    const maxInputEl = container.querySelector<HTMLInputElement>('#ctx-maxInputTokens')
    await setInput(maxInputEl, '12000')
    await click(findBtn(container, 'Save'))
    expect(policyState.maxInputTokens).toBe(12000)

    await click(findBtn(container, 'Preview context'))
    expect(previewFetchCount).toBe(2)
    expect(document.body.textContent).toContain('12,000 tokens')
    await click(document.querySelector('[aria-label="Close"]'))

    // 5. Validation + Discard + Enforce budget warning
    await setInput(container.querySelector<HTMLInputElement>('#ctx-maxInputTokens'), '500')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(findBtn(container, 'Save')?.disabled).toBe(true)
    await click(findBtn(container, 'Discard'))
    expect(container.querySelector('[role="alert"]')).toBeNull()

    await click(findBtn(container, 'Enforce budget'))
    expect(container.textContent).toContain('without creating server summaries')
    await click(findBtn(container, 'Discard'))

    // 6. Reset to default -> DELETE 204 -> Inherited + Suggested restored + Preview button hidden
    await click(findBtn(container, 'Reset to default'))
    expect(container.textContent).toContain('Inherited from system default')
    expect(container.querySelector('[aria-label="Suggested policy values"]')).not.toBeNull()
    expect(findBtn(container, 'Preview context')).toBeNull()

    // 7. One-click Saver preset + Enable context policy switch saves both together
    await click(findBtn(container, 'Saver'))
    const enableSwitch = container.querySelector('[aria-label="Enable context policy"]')
    await click(enableSwitch)
    const lastPut = recordedPuts[recordedPuts.length - 1]
    expect(lastPut?.enabled).toBe(true)
    expect(lastPut?.preset).toBe('saver')
    expect(findBtn(container, 'Preview context')).not.toBeNull()

    // 8. Expand RecentRequestsCard row 501 -> Context assembly details render
    const rowButton = container.querySelector('[aria-label="Requests"] > li > button')
    await click(rowButton)
    const reportEl = container.querySelector('[aria-label="Context assembly report"]')
    expect(reportEl).not.toBeNull()
    expect(reportEl!.textContent).toContain('Context assembly')
    expect(reportEl!.textContent).toContain('8,000')
    expect(reportEl!.textContent).toContain('12/16')
    expect(reportEl!.textContent).toContain('Refits: 1')
  })

  it('switches cleanly to Vietnamese (vi) across ConversationsCard, ContextPolicyCard, Preview dialog, and RecentRequestsCard', async () => {
    await renderHarness()

    await click(findBtn(container, 'Apply suggested'))
    const rowButton = container.querySelector('[aria-label="Requests"] > li > button')
    await click(rowButton)

    await click(container.querySelector('[data-testid="switch-vi"]'))
    // Dynamic locale import needs an extra microtask/timer flush
    await flush(50)

    expect(container.textContent).toContain('Hội thoại được lưu')
    expect(container.textContent).toContain('Chính sách ngân sách ngữ cảnh')
    expect(container.textContent).toContain('Xem trước ngữ cảnh')
    expect(container.textContent).toContain('Lắp ráp ngữ cảnh')
  })
})
