// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageExportCard } from './UsageExportCard'

vi.mock('@/lib/api', () => ({ getToken: () => 'tok' }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

let container: HTMLDivElement
let root: Root
const fetchMock = vi.fn()
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response('day\r\n', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement | undefined
const setDate = async (label: string, value: string) => {
  const el = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('UsageExportCard', () => {
  it('downloads the chosen kind over the chosen range with the session token', async () => {
    await act(async () => root.render(<UsageExportCard canAccounts canProfiles />))
    await setDate('From day', '2026-01-01')
    await setDate('To day', '2026-03-31')
    await act(async () => { button('End users')!.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(fetchMock).toHaveBeenCalledWith('/api/usage/export/end-users.csv?from=2026-01-01&to=2026-03-31', { headers: { Authorization: 'Bearer tok' } })
    expect(URL.createObjectURL).toHaveBeenCalled()
  })

  it('offers only the kinds the viewer may see and refuses a reversed range', async () => {
    await act(async () => root.render(<UsageExportCard canAccounts={false} canProfiles />))
    expect(button('Accounts')).toBeUndefined()
    await setDate('From day', '2026-05-01')
    await setDate('To day', '2026-04-01')
    expect(button('Client keys')!.disabled).toBe(true)
  })
})
