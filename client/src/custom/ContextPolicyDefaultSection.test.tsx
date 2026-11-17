// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONTEXT_POLICY_DEFAULT,
  type ContextPolicyDefault,
} from '@freellmapi/shared/context-budget.js'
import { apiFetch } from '@/lib/api'
import { ContextPolicyDefaultSection } from './ContextPolicyDefaultSection'

const actor = vi.hoisted(() => ({ perms: new Set<string>(['view_settings', 'edit_settings']) }))
vi.mock('./use-session', () => ({
  useUserSession: () => ({
    hasPermission: (p: string) => actor.perms.has(p),
  }),
}))
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

let defaultState: ContextPolicyDefault
let container: HTMLDivElement
let root: Root
let client: QueryClient

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  actor.perms = new Set(['view_settings', 'edit_settings'])
  defaultState = { ...CONTEXT_POLICY_DEFAULT }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/settings/context-policy') && init?.method === 'PUT') {
      const patch = JSON.parse(String(init.body)) as Partial<ContextPolicyDefault>
      defaultState = { ...defaultState, ...patch }
      return defaultState as never
    }
    if (url.endsWith('/api/settings/context-policy')) {
      return defaultState as never
    }
    return {} as never
  })
})

afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
})

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ContextPolicyDefaultSection />
      </QueryClientProvider>,
    ),
  )
  await flush()
}

const input = (id: string) => container.querySelector(`#${id}`) as HTMLInputElement
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
const typeInto = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ContextPolicyDefaultSection', () => {
  it('renders nothing without view_settings or edit_settings permission', async () => {
    actor.perms = new Set()
    await render()
    expect(container.textContent).toBe('')
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('shows read-only defaults with view_settings only', async () => {
    actor.perms = new Set(['view_settings'])
    await render()
    expect(container.textContent).toContain('Default context budget policy')
    expect(input('ctx-default-fallbackWindow').disabled).toBe(true)
    expect(input('ctx-default-imageTokens').disabled).toBe(true)
    expect(container.querySelector('[aria-label="Enable context budget by default"]')?.hasAttribute('data-disabled')).toBe(true)
  })

  it('validates ranges, saves preset+fields together on switch toggle, and invalidates profile policy queries', async () => {
    await render()
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')

    await typeInto(input('ctx-default-fallbackWindow'), '500')
    expect(button('Save')!.disabled).toBe(true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('1,024')

    await typeInto(input('ctx-default-fallbackWindow'), '16384')
    await typeInto(input('ctx-default-imageTokens'), '512')
    await click(tab('Saver'))
    await click(container.querySelector('[aria-label="Enable context budget by default"]'))

    const putCall = vi.mocked(apiFetch).mock.calls.find(
      ([u, i]) => u === '/api/settings/context-policy' && i?.method === 'PUT',
    )
    expect(putCall).toBeDefined()
    expect(JSON.parse(String(putCall![1]!.body))).toEqual({
      enabled: true,
      preset: 'saver',
      fallbackWindowTokens: 16384,
      imageTokens: 512,
    })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['context-policy'] })
  })
})
