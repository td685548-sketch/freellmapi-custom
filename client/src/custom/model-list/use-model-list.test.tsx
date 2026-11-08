// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
import FallbackPage from '@/pages/FallbackPage'
import type { FallbackEntry, ModelGroupRow, RoutingData, RoutingStrategy } from '@/lib/routing'
import type { ModelListPage } from './use-model-list'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/components/getting-started', () => ({ GettingStarted: () => null }))
vi.mock('@/components/chain-manager', () => ({ ChainManager: () => null }))
vi.mock('@/components/penalty-inspector', () => ({ PenaltyInspector: () => null }))
vi.mock('@/components/reliability-floor-control', () => ({ ReliabilityFloorControl: () => null }))
vi.mock('@/components/provider-moment-control', () => ({ ProviderMomentControl: () => null }))
vi.mock('@/components/peak-hours-controls', () => ({ PeakHoursControls: () => null }))
vi.mock('@/components/decision-routing-popover', () => ({ DecisionRoutingPopover: () => null, DecisionSetupGuide: () => null }))
vi.mock('@/components/floating-bar', () => ({ FloatingBar: ({ show, children }: { show: boolean; children: ReactNode }) => show ? <div>{children}</div> : null }))
vi.mock('@/components/model-table', () => ({
  ModelTableHead: () => <thead><tr><th>Model</th></tr></thead>,
  SortableGroupRow: ({ group, onMoveRank }: { group: ModelGroupRow; onMoveRank: (rank: number) => void }) =>
    <tr><td>{group.label}<button aria-label={`rank ${group.members[0].modelDbId}`} onClick={() => onMoveRank(1)}>Move first</button></td></tr>,
  GroupHeaderCells: ({ group, onToggleGroup }: { group: ModelGroupRow; onToggleGroup: (ids: number[], on: boolean) => void }) =>
    <td>{group.label}<button aria-label={`toggle ${group.members[0].modelDbId}`}
      aria-pressed={group.members.some(m => m.enabled)}
      onClick={event => { event.stopPropagation(); onToggleGroup(group.members.map(m => m.modelDbId), !group.members.some(m => m.enabled)) }}>Toggle</button></td>,
}))

let container: HTMLDivElement; let root: Root; let client: QueryClient
let models: FallbackEntry[]
let failNext: number | null
let totalBudget = 0
let strategy: RoutingStrategy = 'balanced'
const writes: Array<{ profileId: number; entries: Array<{ modelDbId: number; enabled: boolean }> }> = []
const entry = (i: number): FallbackEntry => ({
  modelDbId: i, priority: i, effectivePriority: i, penalty: 0, rateLimitHits: 0, enabled: true,
  platform: 'groq', modelId: `model-${i}`, displayName: `Model ${String(i).padStart(3, '0')}`,
  intelligenceRank: 1, speedRank: 1, sizeLabel: 'Large', rpmLimit: null, rpdLimit: null,
  monthlyTokenBudget: '', supportsVision: true, supportsTools: true, keyCount: 1,
  groupKey: `group-${i}`, groupLabel: `Model ${String(i).padStart(3, '0')}`, canonicalId: `model-${i}`,
})
function page(url: URL): ModelListPage {
  const query = url.searchParams.get('search')?.toLowerCase() ?? ''
  const selected = models.filter(m => m.displayName.toLowerCase().includes(query))
  const offset = Number(url.searchParams.get('offset') ?? 0)
  const entries = selected.slice(offset, offset + 20)
  return {
    snapshot: '11111111-1111-4111-8111-111111111111', nextOffset: offset + 20 < selected.length ? offset + 20 : null,
    totalGroups: models.length, matchedGroups: selected.length, entries,
    ranks: Object.fromEntries(entries.map(e => [e.groupKey!, e.priority])), unconfiguredPlatforms: [],
    groupKeys: entries.map(e => e.groupKey!),
    tokenSummary: { totalBudget, totalUsed: 0 },
    routing: {
      strategy, weights: { reliability: 0.4, speed: 0.3, intelligence: 0.3 },
      customWeights: { reliability: 0.4, speed: 0.3, intelligence: 0.3 }, exploreEnabled: false,
      keySelectionStrategy: 'auto', cooldownCeilingMs: null, peakAdjusted: false,
      peakHoursAdjust: false, peakStartHour: 0, peakEndHour: 0, peakTimezone: 'UTC',
      scores: entries.map(e => ({ modelDbId: e.modelDbId, platform: e.platform, modelId: e.modelId,
        displayName: e.displayName, enabled: e.enabled, reliability: 0.9, speed: 0.8,
        intelligence: 0.9, headroom: 1, rateLimit: 1, score: 1 - e.modelDbId / 100, totalRequests: 10 })),
    } satisfies RoutingData,
    rateLimitUsage: { generatedAtMs: Date.now(), rows: [] },
  }
}
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  models = Array.from({ length: 45 }, (_, i) => entry(i + 1)); failNext = null; writes.length = 0; totalBudget = 0
  strategy = 'balanced'
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn() })
  localStorage.clear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/profiles/active') return { activeProfileId: 1 } as never
    if (path.startsWith('/api/fallback/page/budget?')) return { totalBudget, totalUsed: 0, models: [] } as never
    if (path.startsWith('/api/fallback/page/live?')) {
      const url = new URL(path, 'http://localhost')
      const result = page(url)
      const count = Number(url.searchParams.get('count'))
      return { ...result, routing: { ...result.routing, scores: models.slice(0, count).map(m => ({
        modelDbId: m.modelDbId, platform: m.platform, modelId: m.modelId, displayName: m.displayName,
        enabled: m.enabled, reliability: 0.9, speed: 0.8, intelligence: 0.9, headroom: 1, rateLimit: 1, score: 1 - m.modelDbId / 100, totalRequests: 10,
      })) } } as never
    }
    if (path === '/api/fallback/page' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)); writes.push(body)
      models = models.map(m => ({ ...m, ...(body.entries.find((e: { modelDbId: number }) => e.modelDbId === m.modelDbId) ?? {}) }))
      return { success: true } as never
    }
    if (path.startsWith('/api/fallback/page?')) {
      const url = new URL(path, 'http://localhost')
      if (url.searchParams.has('offset') && failNext) {
        const status = failNext; failNext = null
        throw Object.assign(new Error('Page failed'), { status })
      }
      return page(url) as never
    }
    throw new Error(`Unexpected eager request: ${path}`)
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals() })
const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function render() {
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><FallbackPage /></QueryClientProvider></MemoryRouter>))
  await flush()
}
const rows = () => container.querySelectorAll('tbody tr').length
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text)!
const click = async (element: HTMLElement) => { await act(async () => element.click()); await flush() }
const pageCalls = () => vi.mocked(apiFetch).mock.calls.map(c => c[0]).filter(p => p.startsWith('/api/fallback/page?'))

describe('explicit 20-model loading in the Chat Models page', () => {
  it('loads 20 initially, ignores scrolling, then appends 20 and the final 5 on clicks', async () => {
    await render(); expect(rows()).toBe(20); expect(pageCalls()).toHaveLength(1)
    window.dispatchEvent(new Event('scroll')); await flush(); expect(pageCalls()).toHaveLength(1)
    await click(button('Load 20 more models')); expect(rows()).toBe(40)
    await click(button('Load 20 more models')); expect(rows()).toBe(45)
    expect(button('Load 20 more models')).toBeUndefined()
    expect(container.textContent).toContain('Showing 45 / 45 models')
    expect(pageCalls()).toHaveLength(3)
  })
  it('keeps staged toggles when more rows append and saves only staged IDs to the pinned chain', async () => {
    await render()
    await click(container.querySelector('[aria-label="toggle 1"]') as HTMLElement)
    await click(button('Load 20 more models'))
    expect(rows()).toBe(40)
    expect(container.querySelector('[aria-label="toggle 1"]')?.getAttribute('aria-pressed')).toBe('false')
    await click(button('common.saveChanges'))
    expect(writes).toHaveLength(1)
    expect(writes[0].profileId).toBe(1)
    expect(writes[0].entries).toHaveLength(1)
    expect(writes[0].entries.find(e => e.modelDbId === 1)?.enabled).toBe(false)
    expect(writes[0].entries.some(e => e.modelDbId === 45)).toBe(false)
    expect(rows()).toBe(20)
    expect(pageCalls()).toHaveLength(3) // saving reloads the first batch, not every opened page
  })
  it('does not fetch the full budget legend until the user opens its details', async () => {
    totalBudget = 1000
    await render()
    expect(vi.mocked(apiFetch).mock.calls.some(([url]) => url.includes('/budget?'))).toBe(false)
    await click(button('View budget details'))
    expect(vi.mocked(apiFetch).mock.calls.filter(([url]) => url.includes('/budget?'))).toHaveLength(1)
  })
  it('refreshes all opened rows in one request instead of refetching each page', async () => {
    await render(); await click(button('Load 20 more models'))
    const before = pageCalls().length
    await act(async () => { await client.invalidateQueries({ queryKey: ['fallback', 'routing', 'page-live'] }) }); await flush()
    const liveCalls = vi.mocked(apiFetch).mock.calls.map(([url]) => url).filter(url => url.startsWith('/api/fallback/page/live?'))
    expect(liveCalls).toHaveLength(1)
    expect(new URL(liveCalls[0], 'http://localhost').searchParams.get('count')).toBe('40')
    expect(pageCalls()).toHaveLength(before)
    expect(rows()).toBe(40)
  })
  it('deduplicates repeated clicks while the next page is in flight', async () => {
    await render()
    let resolve!: (value: ModelListPage) => void
    const pending = new Promise<ModelListPage>(done => { resolve = done })
    vi.mocked(apiFetch).mockImplementationOnce(() => pending as never)
    const more = button('Load 20 more models')
    await act(async () => { more.click(); more.click() }); await flush()
    expect(pageCalls()).toHaveLength(2)
    expect(more.disabled).toBe(true)
    await act(async () => resolve(page(new URL('http://localhost/api/fallback/page?offset=20')))); await flush()
    expect(rows()).toBe(40)
  })
  it('preserves existing rows after an append error and retries explicitly', async () => {
    await render(); failNext = 503
    await click(button('Load 20 more models'))
    expect(rows()).toBe(20); expect(container.textContent).toContain('Could not load models.')
    await click(button('Retry')); expect(rows()).toBe(40)
  })
  it('guards manual ranking until all rows are loaded, then reuses existing priority slots', async () => {
    strategy = 'priority'; models = models.map(m => ({ ...m, priority: m.priority * 2 }))
    await render()
    expect(container.querySelector('[aria-label="rank 1"]')).toBeNull()
    expect(container.textContent).toContain('Load the complete list')
    await click(button('Load 20 more models')); await click(button('Load 20 more models'))
    await click(container.querySelector('[aria-label="rank 45"]') as HTMLElement)
    await click(button('common.saveChanges'))
    expect(writes[0].entries.find(e => e.modelDbId === 45)).toMatchObject({ priority: 2 })
    expect(writes[0].entries.every(e => (e as { priority?: number }).priority! % 2 === 0)).toBe(true)
  })
  it('discards staged edits across A to B to A chain switches', async () => {
    await render(); await click(container.querySelector('[aria-label="toggle 1"]') as HTMLElement)
    await click(button('Load 20 more models')); expect(rows()).toBe(40)
    for (const activeProfileId of [2, 1]) {
      await act(async () => { client.setQueryData(['profiles', 'active'], { activeProfileId }) }); await flush()
      expect(rows()).toBe(20)
    }
    expect(container.querySelector('[aria-label="toggle 1"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(button('common.saveChanges')).toBeUndefined()
  })
  it('keeps the search field focused while the filtered first batch is loading', async () => {
    await render()
    const input = container.querySelector('input[placeholder]') as HTMLInputElement
    let resolve!: (value: ModelListPage) => void
    const pending = new Promise<ModelListPage>(done => { resolve = done })
    vi.mocked(apiFetch).mockImplementationOnce(() => pending as never)
    await act(async () => {
      input.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Model 045')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise(r => setTimeout(r, 270)) }); await flush()
    expect(document.activeElement).toBe(input); expect(input.isConnected).toBe(true)
    await act(async () => resolve(page(new URL('http://localhost/api/fallback/page?search=Model%20045')))); await flush()
    expect(rows()).toBe(1)
  })
  it('reloads the first page after an expired cursor', async () => {
    await render(); failNext = 410
    await click(button('Load 20 more models')); expect(rows()).toBe(20)
    await click(button('Reload list')); expect(rows()).toBe(20)
    expect(new URL(pageCalls().at(-1)!, 'http://localhost').searchParams.has('offset')).toBe(false)
  })
  it('searches beyond the first page and resets continuation when the chain changes', async () => {
    await render()
    const input = container.querySelector('input[placeholder]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Model 045')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise(r => setTimeout(r, 270)) }); await flush()
    expect(rows()).toBe(1); expect(container.textContent).toContain('Model 045')
    await act(async () => { client.setQueryData(['profiles', 'active'], { activeProfileId: 2 }) }); await flush()
    const last = new URL(pageCalls().at(-1)!, 'http://localhost')
    expect(last.searchParams.get('profile')).toBe('2'); expect(last.searchParams.has('offset')).toBe(false)
  })
})
