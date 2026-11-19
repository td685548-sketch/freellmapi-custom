// @vitest-environment jsdom
// RecentRequestsPanel used to give every row its own 1s setInterval just to
// refresh its "5s ago" label — 20 rows, 20 timers, every second. The panel
// now runs one shared 30s timer for all rows.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import RecentRequestsPanel, { type RecentRequestItem } from './RecentRequestsPanel'

let root: Root
let container: HTMLDivElement

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function rows(count: number): RecentRequestItem[] {
  const now = Date.now()
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    provider: 'groq',
    model: 'test-model',
    status: 'success',
    promptTokens: 10,
    completionTokens: 5,
    latencyMs: 120,
    errorMessage: null,
    timestamp: new Date(now - 5_000).toISOString(),
  }))
}

describe('RecentRequestsPanel timer', () => {
  it('runs one 30s timer for the whole panel, not one 1s timer per row', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    act(() => { root.render(<RecentRequestsPanel requests={rows(3)} />) })

    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000)
    expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 1000)

    // The shared tick still moves the labels: 5s old at render, 35s after one tick.
    expect(container.textContent).toContain('5s ago')
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(container.textContent).toContain('35s ago')
  })

  it('clears the shared timer on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    act(() => { root.render(<RecentRequestsPanel requests={rows(1)} />) })
    act(() => root.unmount())
    expect(clearSpy).toHaveBeenCalledTimes(1)
  })
})
