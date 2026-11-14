// @vitest-environment jsdom
import { Suspense, act, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isChunkLoadError, lazyNamed, lazyPage } from './lazy-page'
import { preloadBrowserPath, preloadRoute } from './lazy-pages'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  sessionStorage.clear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })

const Hello: ComponentType = () => <p>hello page</p>
async function show(node: React.ReactNode) {
  await act(async () => root.render(<Suspense fallback={<p>loading</p>}>{node}</Suspense>))
  await act(async () => { await Promise.resolve() })
}

describe('lazyPage', () => {
  it('shows the fallback, then the page once it has downloaded', async () => {
    let finish!: (module: { default: ComponentType }) => void
    const Page = lazyPage<object>(() => new Promise(resolve => { finish = resolve }))
    await show(<Page />)
    expect(container.textContent).toBe('loading')
    await act(async () => { finish({ default: Hello }) })
    expect(container.textContent).toBe('hello page')
  })

  it('downloads once however many times it is preloaded or rendered', async () => {
    const load = vi.fn(async () => ({ default: Hello }))
    const Page = lazyPage(load)
    Page.preload(); Page.preload()
    await show(<Page />)
    expect(load).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('hello page')
  })

  it('does not remember a failed download, so the next attempt asks again', async () => {
    const load = vi.fn<() => Promise<{ default: ComponentType }>>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ default: Hello })
    const Page = lazyPage(load)
    Page.preload() // fails quietly
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    await show(<Page />)
    expect(load).toHaveBeenCalledTimes(2)
    expect(container.textContent).toBe('hello page')
  })

  it('reloads the tab once when a chunk from an older build is gone, then stops', async () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, configurable: true })
    const stale = (): Promise<{ default: ComponentType }> => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/Old-abc.js'))
    lazyPage(stale).preload()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(reload).toHaveBeenCalledTimes(1)
    lazyPage(stale).preload()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(reload).toHaveBeenCalledTimes(1) // the guard stops a reload loop
  })

  it('does not reload for an ordinary error', async () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, configurable: true })
    lazyPage<object>(() => Promise.reject(new Error('boom'))).preload()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('lazyNamed', () => {
  it('picks a named export as the page', async () => {
    const Page = lazyNamed(async () => ({ Other: (() => <p>other</p>) as ComponentType, Wanted: Hello }), 'Wanted')
    await show(<Page />)
    expect(container.textContent).toBe('hello page')
  })
})

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://x/assets/a.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
  ])('recognises %s', message => expect(isChunkLoadError(new TypeError(message))).toBe(true))
  it('leaves other errors alone', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
  })
})

describe('preloadRoute', () => {
  // Importing the table above only declares the loaders; spying on preload shows which page a path wants.
  it.each([
    ['/', 'FallbackPage'], ['/models', 'FallbackPage'], ['/models/chat', 'FallbackPage'],
    ['/models/chat/abc', 'ModelDetailPage'], ['/models/image', 'ImagePage'], ['/models/image/x', 'MediaDetailPage'],
    ['/keys', 'KeysPage'], ['/playground', 'PlaygroundPage'], ['/analytics', 'AnalyticsAccessPage'],
    ['/users/5/analytics', 'UserAnalyticsPage'], ['/users', 'UsersAccessPage'], ['/thruline/combos', 'XGatewayApp'],
    ['/ai-platform/flags', 'AiPlatformApp'],
  ])('%s starts downloading %s only', async (path, expected) => {
    const pages = await import('./lazy-pages')
    const spies = Object.entries(pages)
      .filter(([, value]) => typeof value === 'object' && value !== null && 'preload' in value)
      .map(([name, value]) => [name, vi.spyOn(value as { preload: () => void }, 'preload').mockImplementation(() => {})] as const)
    preloadRoute(path)
    expect(spies.filter(([, spy]) => spy.mock.calls.length > 0).map(([name]) => name)).toEqual([expected])
  })

  it('ignores paths no page owns', () => { expect(() => preloadRoute('/nope/nothing')).not.toThrow() })

  it('strips the app base path from a browser path', async () => {
    const pages = await import('./lazy-pages')
    const spy = vi.spyOn(pages.KeysPage, 'preload').mockImplementation(() => {})
    preloadBrowserPath('/dashboard/keys', '/dashboard/')
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
