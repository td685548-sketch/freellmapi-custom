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
  type ContextPolicySuggested,
  type ContextPreview,
  type ContextStats,
} from '@freellmapi/shared/context-budget.js'
import { apiFetch, type ApiError } from '@/lib/api'
import { ContextPolicyCard } from './ContextPolicyCard'
import { ConversationsCard } from './ConversationsCard'
import { RecentRequestsCard } from './RecentRequestsCard'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const makePolicy = (over: Partial<ContextPolicy> = {}): ContextPolicy => ({
  profileId: 5,
  enabled: false,
  inherited: true,
  preset: 'balanced',
  ...CONTEXT_PRESETS.balanced,
  updatedAt: '2026-11-17T08:00:00.000Z',
  ...over,
})

const makeStats = (over: Partial<ContextStats> = {}): ContextStats => ({
  days: 7,
  requests: 1240,
  avgInputTokens: 6120,
  avgBudgetTokens: 14400,
  trimmedRate: 0.37,
  avgHistoryDropped: 11.2,
  savedTokens: 4180000,
  summaryUsedRate: 0.52,
  estimateError: {
    samples: 980,
    p50Pct: 4.1,
    p95Pct: 12.7,
    within15PctRate: 0.96,
  },
  byDay: [{ day: '2026-11-17', requests: 180, avgInputTokens: 6050, trimmedRate: 0.35 }],
  ...over,
})

let policyState: ContextPolicyResponse
let statsState: ContextStats
let container: HTMLDivElement
let root: Root
let client: QueryClient

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  policyState = {
    policy: makePolicy(),
    suggested: null,
    presets: CONTEXT_PRESETS,
    limits: CONTEXT_POLICY_LIMITS,
  }
  statsState = makeStats()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/context-stats?days=7')) return statsState as never
    if (url.endsWith('/context-policy') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Partial<ContextPolicy>
      const nextPreset = body.preset ?? policyState.policy.preset
      const presetValues = nextPreset !== 'custom' ? CONTEXT_PRESETS[nextPreset] : {}
      policyState = {
        ...policyState,
        policy: {
          ...policyState.policy,
          ...body,
          ...presetValues,
          inherited: false,
          preset: nextPreset,
        },
        suggested: null,
      }
      return policyState as never
    }
    if (url.endsWith('/context-policy') && init?.method === 'DELETE') {
      policyState = {
        ...policyState,
        policy: makePolicy({ inherited: true }),
      }
      return undefined as never
    }
    if (url.endsWith('/context-policy')) return policyState as never
    return {} as never
  })
})

afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
})

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

async function render(canEdit = true) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ContextPolicyCard profileId={5} canEdit={canEdit} />
      </QueryClientProvider>,
    ),
  )
  await flush()
}

const input = (id: string) => container.querySelector(`#${id}`) as HTMLInputElement
const typeInto = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const button = (text: string) =>
  [...container.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement | undefined
const tab = (text: string) =>
  [...container.querySelectorAll('[role="tab"]')].find(b => b.textContent === text) as HTMLButtonElement | undefined
const click = async (el: Element | null | undefined) => {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

describe('ContextPolicyCard', () => {
  it('shows inherited status and toggles enabled state', async () => {
    await render()
    const section = container.querySelector('[aria-label="Context budget policy"]')!
    expect(section.textContent).toContain('Inherited from system default')

    await click(container.querySelector('[aria-label="Enable context policy"]'))
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/5/context-policy', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    })
    expect(section.textContent).toContain('Custom override')
  })

  it('fills preset values when selecting Saver or Max context', async () => {
    await render()
    expect(input('ctx-maxInputTokens').value).toBe('16000')
    expect(input('ctx-knowledgeSharePct').value).toBe('25')

    await click(tab('Saver'))
    expect(input('ctx-maxInputTokens').value).toBe('8000')
    expect(input('ctx-knowledgeSharePct').value).toBe('20')
    expect(input('ctx-outputReserveTokens').value).toBe('1024')

    await click(tab('Max context'))
    expect(input('ctx-maxInputTokens').value).toBe('')
    expect(input('ctx-outputReserveTokens').value).toBe('2048')
    expect(input('ctx-summarySharePct').value).toBe('10')
    expect(input('ctx-knowledgeSharePct').value).toBe('30')
    expect(input('ctx-dropBlockTurns').value).toBe('8')
  })

  it('blocks custom share sum > 80 and maxInputTokens < 2000 before submitting', async () => {
    await render()
    await click(tab('Custom'))

    await typeInto(input('ctx-maxInputTokens'), '1500')
    expect(button('Save')!.disabled).toBe(true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('2,000')

    await typeInto(input('ctx-maxInputTokens'), '12000')
    await typeInto(input('ctx-summarySharePct'), '45')
    await typeInto(input('ctx-knowledgeSharePct'), '40')
    expect(button('Save')!.disabled).toBe(true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('80')

    // Submitting form directly while invalid must not call PUT
    const putCallsBefore = vi.mocked(apiFetch).mock.calls.filter(([, i]) => i?.method === 'PUT').length
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await flush()
    const putCallsAfter = vi.mocked(apiFetch).mock.calls.filter(([, i]) => i?.method === 'PUT').length
    expect(putCallsAfter).toBe(putCallsBefore)

    // Fix share sum to 70 and save
    await typeInto(input('ctx-knowledgeSharePct'), '25')
    expect(button('Save')!.disabled).toBe(false)
    await click(button('Save'))
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/client-profiles/5/context-policy',
      expect.objectContaining({ method: 'PUT' }),
    )
    const lastPut = vi.mocked(apiFetch).mock.calls.filter(([, i]) => i?.method === 'PUT').pop()!
    const sentBody = JSON.parse(String(lastPut[1]!.body))
    expect(sentBody).toMatchObject({
      preset: 'custom',
      maxInputTokens: 12000,
      summarySharePct: 45,
      knowledgeSharePct: 25,
    })
  })

  it('displays suggested values from legacy conversation settings and confirms applying them', async () => {
    const suggested: ContextPolicySuggested = { maxInputTokens: 4000, summarize: true }
    policyState = {
      ...policyState,
      suggested,
    }
    await render()

    const suggestedBox = container.querySelector('[aria-label="Suggested policy values"]')
    expect(suggestedBox).not.toBeNull()
    expect(suggestedBox!.textContent).toContain('4,000')

    await click(button('Apply suggested'))
    const putCall = vi.mocked(apiFetch).mock.calls.find(([, i]) => i?.method === 'PUT')
    expect(putCall).toBeDefined()
    expect(JSON.parse(String(putCall![1]!.body))).toMatchObject({
      enabled: true,
      preset: 'custom',
      maxInputTokens: 4000,
      summarize: true,
    })
  })

  it('renders 7-day context statistics including avg tokens, trimmed rate, saved tokens, and estimate error', async () => {
    await render()
    const stats = container.querySelector('[aria-label="Context budget statistics"]')!
    const text = stats.textContent ?? ''
    expect(text).toContain('6,120')
    expect(text).toContain('37%')
    expect(text).toContain('4,180,000')
    expect(text).toContain('4.1%')
    expect(text).toContain('12.7%')
    expect(text).toContain('96%')
  })

  it('is read-only when canEdit is false', async () => {
    policyState = {
      ...policyState,
      policy: makePolicy({ inherited: false, enabled: true }),
    }
    await render(false)
    expect(input('ctx-maxInputTokens').disabled).toBe(true)
    expect(container.querySelector('[aria-label="Enable context policy"]')?.hasAttribute('data-disabled')).toBe(true)
    expect(button('Save')).toBeUndefined()
    expect(button('Reset to default')).toBeUndefined()
  })

  it('resets custom override back to inherited system default', async () => {
    policyState = {
      ...policyState,
      policy: makePolicy({ inherited: false, enabled: true, preset: 'saver', ...CONTEXT_PRESETS.saver }),
    }
    await render()
    await click(button('Reset to default'))
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/5/context-policy', { method: 'DELETE' })
  })
})

describe('ContextPreviewDialog & ConversationsCard integration', () => {
  it('shows Preview context button only when policy is enabled and renders dry-run segments', async () => {
    const previewPayload: ContextPreview = {
      model: { key: 'google:gemini-2.5-flash', contextWindow: 1048576 },
      budget: { effective: 14400, mandatory: 310, summaryCap: 2113, knowledgeCap: 0, historyCap: 11977 },
      segments: [
        { kind: 'mandatory', role: 'system', tokens: 310, preview: 'You are helpful', sent: true },
        { kind: 'history', role: 'user', tokens: 120, messageId: 10, preview: 'Older question', sent: false, reason: 'budget' },
        { kind: 'history', role: 'assistant', tokens: 260, messageId: 11, preview: 'Recent answer', sent: true },
      ],
      summary: { coversThroughMessageId: 9, pendingFoldMessages: 2 },
      knowledgeNote: 'Knowledge depends on the actual user query.',
    }

    const convResponse = {
      settings: { enabled: true, ttlHours: 168, maxMessages: 20, maxChars: 12000, summarize: true },
      conversations: [
        {
          id: 'chat-9',
          endUser: 'alice',
          messages: 6,
          chars: 400,
          createdAt: '2026-11-17T00:00:00.000Z',
          updatedAt: '2026-11-17T01:00:00.000Z',
          expiresAt: '2026-11-24T01:00:00.000Z',
        },
      ],
    }

    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url.endsWith('/context-policy')) {
        return { ...policyState, policy: makePolicy({ enabled: false }) } as never
      }
      if (url.includes('/conversations')) return convResponse as never
      return {} as never
    })

    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ConversationsCard profileId={5} canEdit={true} />
        </QueryClientProvider>,
      ),
    )
    await flush()
    expect(button('Preview context')).toBeUndefined()

    // Now enable context policy
    client.clear()
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url.endsWith('/context-policy')) {
        return { ...policyState, policy: makePolicy({ enabled: true, inherited: false }) } as never
      }
      if (url.includes('/context-preview')) return previewPayload as never
      if (url.includes('/conversations')) return convResponse as never
      return {} as never
    })

    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ConversationsCard profileId={5} canEdit={true} />
        </QueryClientProvider>,
      ),
    )
    await flush()
    const previewBtn = button('Preview context')
    expect(previewBtn).toBeDefined()
    await click(previewBtn)

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/client-profiles/5/conversations/chat-9/context-preview?endUser=alice',
    )
    const dialogText = document.body.textContent ?? ''
    expect(dialogText).toContain('google:gemini-2.5-flash')
    expect(dialogText).toContain('14,400')
    expect(dialogText).toContain('Older question')
    expect(dialogText).toContain('Budget')
    expect(dialogText).toContain('Summarized through #9 · 2 pending')
  })
})

describe('RecentRequestsCard context assembly report', () => {
  it('displays context report when available and hides it on 404', async () => {
    const report: ContextAssemblySummary = {
      budget: 14400,
      window: 32768,
      mandatory: 310,
      summary: 402,
      knowledge: 1180,
      history: 8840,
      histSent: 18,
      histDropped: 24,
      kbSent: 3,
      kbDropped: 0,
      clientDropped: 0,
      refits: 1,
      estimatedTokens: 10732,
      heuristicTokens: 9800,
      modelKey: 'groq:llama-3.3-70b',
      createdAt: '2026-11-17T10:00:00.000Z',
    }

    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url.endsWith('/requests/101/context')) return report as never
      if (url.endsWith('/requests/102/context')) {
        const err = new Error('Not found') as ApiError
        err.status = 404
        throw err
      }
      if (url.includes('/attempts')) return { attempts: [] } as never
      return {
        requests: [
          {
            id: 101,
            createdAt: '2026-11-17 10:00:00',
            status: 'success',
            platform: 'groq',
            modelId: 'llama-3.3-70b',
            requestedModel: null,
            latencyMs: 200,
            ttfbMs: null,
            inputTokens: 10500,
            outputTokens: 50,
            error: null,
          },
          {
            id: 102,
            createdAt: '2026-11-17 09:59:00',
            status: 'success',
            platform: 'groq',
            modelId: 'llama-3.3-70b',
            requestedModel: null,
            latencyMs: 180,
            ttfbMs: null,
            inputTokens: 120,
            outputTokens: 20,
            error: null,
          },
        ],
        nextBefore: null,
      } as never
    })

    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RecentRequestsCard endpoint="/api/client-profiles/5/requests" />
        </QueryClientProvider>,
      ),
    )
    await flush()

    const rowButtons = [...container.querySelectorAll('[aria-label="Requests"] > li > button')]
    await click(rowButtons[0])
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/5/requests/101/context')
    const reportEl = container.querySelector('[aria-label="Context assembly report"]')
    expect(reportEl).not.toBeNull()
    expect(reportEl!.textContent).toContain('14,400')
    expect(reportEl!.textContent).toContain('18/24')
    expect(reportEl!.textContent).toContain('Refits: 1')

    await click(rowButtons[1])
    expect(apiFetch).toHaveBeenCalledWith('/api/client-profiles/5/requests/102/context')
    expect(container.querySelectorAll('[aria-label="Context assembly report"]').length).toBe(1)
  })
})
