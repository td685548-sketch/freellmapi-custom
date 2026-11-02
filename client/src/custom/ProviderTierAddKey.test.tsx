// @vitest-environment jsdom
import { webcrypto, createHash } from 'node:crypto'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { ProviderTierAddKey } from './ProviderTierAddKey'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/components/keys/add-key-dialog', () => ({
  AddKeyDialog: ({ open, initialPlatform, onOpenChange }: { open: boolean; initialPlatform: string; onOpenChange: (open: boolean) => void }) => {
    const [scope, setScope] = useState(false)
    return open ? <button onClick={() => { setScope(true); onOpenChange(false) }}>Complete {initialPlatform}</button>
      : scope ? <p>Model scope follow-up</p> : null
  },
}))
vi.mock('@/components/keys/add-endpoint-key-dialog', () => ({
  AddEndpointKeyDialog: ({ baseUrl }: { baseUrl: string }) => <p>Endpoint target: {baseUrl}</p>,
}))

let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('crypto', webcrypto)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  client.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function render(platform = 'google', canManageKeys = true, providerId = platform) {
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider initialLocale="en">
    <ProviderTierAddKey key={providerId} row={{ platform, providerId, name: platform, linkedKeyCount: 1 }} canManageKeys={canManageKeys} />
  </I18nProvider></QueryClientProvider>))
}
async function click() {
  await act(async () => { container.querySelector('button')?.click() })
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(container.querySelector('button')?.disabled).toBe(false)
  }, { timeout: 3000 })
}

describe('Add key from provider tiers', () => {
  it('preselects each provider without reading the key roster and preserves scope follow-up', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await render('google')
    await click()
    expect(container.textContent).toContain('Complete google')
    await act(async () => { container.querySelectorAll('button')[1]?.click() })
    expect(container.textContent).toContain('Model scope follow-up')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['provider-tiers'] })
    await click()
    expect(container.textContent).toContain('Complete google')
    expect(container.textContent).not.toContain('Model scope follow-up')
    await render('groq')
    await click()
    expect(container.textContent).toContain('Complete groq')
    expect(container.textContent).not.toContain('Complete google')
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('hides actions without manage_keys permission', async () => {
    await render('google', false)
    expect(container.querySelector('button')).toBeNull()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('matches a custom endpoint by normalized hash, not same-host display name', async () => {
    const scope = 'https://relay.example/tenant-b/v1'
    const id = `custom:${createHash('sha256').update(scope).digest('hex').slice(0, 20)}`
    vi.mocked(apiFetch).mockResolvedValue([
      { platform: 'custom', baseUrl: 'https://relay.example/tenant-a/v1' },
      { platform: 'custom', baseUrl: scope + '/' },
    ])
    await render('custom', true, id)
    await click()
    expect(container.textContent).toContain(`Endpoint target: ${scope}`)
    expect(container.textContent).not.toContain('tenant-a')
    expect(apiFetch).toHaveBeenCalledWith('/api/keys')
  })

  it('fails closed for a missing endpoint instead of opening another provider', async () => {
    vi.mocked(apiFetch).mockResolvedValue([])
    await render('custom', true, 'custom:missing')
    await click()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('endpoint')
    expect(container.textContent).not.toContain('Endpoint target:')
  })

  it('disables historical providers no longer supported by the original key form', async () => {
    await render('removed-provider')
    expect(container.querySelector('button')?.disabled).toBe(true)
    expect(apiFetch).not.toHaveBeenCalled()
  })
});
