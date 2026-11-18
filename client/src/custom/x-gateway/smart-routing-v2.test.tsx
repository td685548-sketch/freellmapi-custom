// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { SmartRoutingV2Panel } from './components/SmartRoutingV2Panel'
import type {
  IntentClassificationResult,
  LearnedModelCapRecord,
  ModelsDevSyncStatus,
  ScenarioRoutingPolicy,
} from './smart-routing-v2-strings'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

let root: Root
let container: HTMLDivElement
let queryClient: QueryClient

const samplePolicy: ScenarioRoutingPolicy = {
  enabled: true,
  decisionMode: 'heuristic',
  longContextThresholdTokens: 60000,
  simpleMaxWords: 60,
  lanes: {
    default: 'combo:coding-flagship',
    background: 'combo:fast-autocomplete',
    think: 'combo:reasoning-deep',
    longContext: '',
    webSearch: '',
    vision: '',
  },
  intentTargets: {},
  updatedAt: '2026-11-18T00:00:00.000Z',
}

const sampleCaps: LearnedModelCapRecord[] = [
  {
    provider: 'groq',
    modelId: 'llama-3.3-70b-versatile',
    endpointScope: '',
    maxOutputTokens: 32768,
    maxThinkingBudget: 16384,
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    lastErrorSample: 'max_tokens <= 32768',
    hitCount: 2,
    updatedAt: '2026-11-18T01:00:00.000Z',
  },
]

const sampleModelsDevStatus: ModelsDevSyncStatus = {
  enabled: false,
  envOverride: 'unset',
  periodicActive: false,
  intervalMs: 86400000,
  lastSyncAt: '2026-11-18T01:30:00.000Z',
  lastSyncModelCount: 412,
  lastSyncProviderCount: 18,
  storedModelCount: 412,
  lastError: null,
}

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  queryClient.clear()
  container.remove()
  document.body.innerHTML = ''
})

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    })
  }
}

async function renderPanel(locale: 'en' | 'vi' = 'en'): Promise<void> {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale={locale}>
          <SmartRoutingV2Panel />
        </I18nProvider>
      </QueryClientProvider>,
    )
  })
  await flush()
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('SmartRoutingV2Panel', () => {
  it('renders scenario lanes, runs live <1ms preview, clears learned caps, and triggers models.dev sync in English', async () => {
    let currentCaps = [...sampleCaps]

    vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (path === '/api/user/session') {
        return { userId: 1, email: 'admin@local', role: 'admin', isPrimary: true, permissions: ['*'] }
      }
      if (path === '/api/thruline/smart-routing/policy' && method === 'GET') {
        return samplePolicy
      }
      if (path === '/api/thruline/smart-routing/policy' && method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Partial<ScenarioRoutingPolicy>
        return { ...samplePolicy, ...body }
      }
      if (path === '/api/thruline/smart-routing/classify-preview' && method === 'POST') {
        const preview: IntentClassificationResult = {
          intent: 'code',
          scenario: 'think',
          confidence: 0.95,
          signals: ['intent:code:typescript', 'scenario:think:thinking_param'],
          recommendedPreset: 'smartest',
          resolvedTarget: 'combo:reasoning-deep',
          estimatedTokens: 18,
          durationMs: 0.14,
        }
        return preview
      }
      if (path === '/api/thruline/smart-routing/learned-caps' && method === 'GET') {
        return { caps: currentCaps }
      }
      if (path.startsWith('/api/thruline/smart-routing/learned-caps') && method === 'DELETE') {
        currentCaps = []
        return { ok: true, cleared: 1, caps: [] }
      }
      if (path === '/api/thruline/smart-routing/models-dev/status' && method === 'GET') {
        return sampleModelsDevStatus
      }
      if (path === '/api/thruline/smart-routing/models-dev/sync' && method === 'POST') {
        return {
          success: true,
          dryRun: false,
          modelCount: 520,
          providerCount: 22,
          syncedAt: '2026-11-18T02:00:00.000Z',
          status: { ...sampleModelsDevStatus, storedModelCount: 520 },
        }
      }
      return {}
    })

    await renderPanel('en')

    expect(container.textContent).toContain('Smart Routing v2 & Learned Caps')
    const bgInput = container.querySelector('[data-testid="lane-input-background"]') as HTMLInputElement
    expect(bgInput.value).toBe('combo:fast-autocomplete')

    // Update vision lane and save policy
    const visionInput = container.querySelector('[data-testid="lane-input-vision"]') as HTMLInputElement
    await act(async () => {
      setInputValue(visionInput, 'gemini/gemini-2.5-flash')
    })
    const saveBtn = [...container.querySelectorAll('button')].find(b =>
      b.textContent?.includes('Save Smart Routing Policy'),
    ) as HTMLButtonElement
    await act(async () => {
      saveBtn.click()
    })
    await flush()

    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
      '/api/thruline/smart-routing/policy',
      expect.objectContaining({ method: 'PUT' }),
    )

    // Live Intent & Scenario Tester
    const promptTextarea = container.querySelector(
      '[data-testid="smart-routing-tester-prompt"]',
    ) as HTMLTextAreaElement
    await act(async () => {
      setInputValue(promptTextarea, 'Write a TypeScript compiler pass')
    })
    const classifyBtn = container.querySelector(
      '[data-testid="smart-routing-tester-run"]',
    ) as HTMLButtonElement
    await act(async () => {
      classifyBtn.click()
    })
    await flush()

    const previewEl = container.querySelector('[data-testid="smart-routing-preview-result"]')
    expect(previewEl?.textContent).toContain('code')
    expect(previewEl?.textContent).toContain('think')
    expect(previewEl?.textContent).toContain('combo:reasoning-deep')
    expect(previewEl?.textContent).toContain('0.14 ms')

    // Learned Caps table + Clear All
    const table = container.querySelector('[data-testid="learned-caps-table"]')
    expect(table?.textContent).toContain('groq/llama-3.3-70b-versatile')
    expect(table?.textContent).toContain('32768')
    expect(table?.textContent).toContain('16384')
    expect(table?.textContent).toContain('low, medium, high')

    const clearAllBtn = container.querySelector(
      '[data-testid="learned-caps-clear-all"]',
    ) as HTMLButtonElement
    await act(async () => {
      clearAllBtn.click()
    })
    await flush()
    expect(container.querySelector('[data-testid="learned-caps-empty"]')?.textContent).toContain(
      'No learned model caps recorded yet.',
    )

    // models.dev Sync trigger
    const syncNowBtn = container.querySelector('[data-testid="models-dev-sync-now"]') as HTMLButtonElement
    await act(async () => {
      syncNowBtn.click()
    })
    await flush()
    expect(container.textContent).toContain('520 models across 22 providers.')
  })

  it('renders localized Vietnamese strings and respects read-only permissions', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/user/session') {
        return {
          userId: 2,
          email: 'viewer@local',
          role: 'member',
          isPrimary: false,
          permissions: ['use_x_gateway'],
        }
      }
      if (path === '/api/thruline/smart-routing/policy') return samplePolicy
      if (path === '/api/thruline/smart-routing/learned-caps') return { caps: sampleCaps }
      if (path === '/api/thruline/smart-routing/models-dev/status') {
        return { ...sampleModelsDevStatus, envOverride: 'false' }
      }
      return {}
    })

    await renderPanel('vi')

    expect(container.textContent).toContain('Định tuyến thông minh v2 & Giới hạn tự học')
    expect(container.textContent).toContain('Làn tác vụ nền (tiêu đề, commit, tóm tắt)')
    expect(container.textContent).toContain('Bộ thử phân loại ý định & kịch bản <1ms')
    expect(container.textContent).toContain('Đã bị tắt cứng bởi biến môi trường MODELS_DEV_SYNC_ENABLED=0.')
    expect(container.querySelector('[data-testid="models-dev-sync-now"]')).toBeNull()
    expect(container.querySelector('[data-testid="learned-caps-clear-all"]')).toBeNull()
  })
})
