// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { UsageLink } from './UsageLink'

async function mount(node: React.ReactNode) {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(node))
  return { container, done: () => { act(() => root.unmount()); container.remove() } }
}

describe('UsageLink', () => {
  it('points at the account analytics route', async () => {
    const { container, done } = await mount(<MemoryRouter><UsageLink userId={42} /></MemoryRouter>)
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/users/42/analytics')
    done()
  })
  it('renders nothing outside a router', async () => {
    const { container, done } = await mount(<UsageLink userId={42} />)
    expect(container.querySelector('a')).toBeNull()
    done()
  })
})
