// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { permissionGranted, permissionGroupVisible } from '../../../shared/permissions'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { CacheSettingsSection } from './CacheSettingsSection'
import { ScopedKeysPage } from './ScopedKeysPage'
import { PermissionsDialog } from './PermissionsDialog'
import { togglePermissionSelection } from './permission-selection'
import type { AdminUser } from '../../../shared/user-access'

const actor = vi.hoisted(() => ({ permissions: ['*'] as string[] }))
vi.mock('./use-session', () => ({ useUserSession: () => ({
  hasPermission: (p: Parameters<typeof permissionGranted>[1]) => permissionGranted({ role: 'admin', permissions: actor.permissions }, p),
  hasPermissionGroup: (p: Parameters<typeof permissionGroupVisible>[1]) => permissionGroupVisible({ role: 'admin', permissions: actor.permissions }, p),
}) }))
vi.mock('./session-state', () => ({ useSessionRevision: () => 1 }))
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/components/keys/add-key-dialog', () => ({ AddKeyDialog: () => null }))
vi.mock('@/components/keys/edit-key-dialog', () => ({ EditKeyDialog: () => null }))
vi.mock('@/components/keys/copy-key-dialog', () => ({ CopyKeyDialog: () => null }))
vi.mock('@/components/keys/export-keys-dialog', () => ({ ExportKeysDialog: () => null }))
vi.mock('@/components/keys/backups-section', () => ({ BackupsSection: () => null }))
vi.mock('@/components/keys/import-keys-section', () => ({ ImportKeysSection: () => null }))

let container: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  actor.permissions = ['*']
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(apiFetch).mockReset()
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks() })
async function render(node: React.ReactNode) {
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider initialLocale="en">{node}</I18nProvider></QueryClientProvider>))
}
async function until(check: () => void) {
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); check() })
}

describe('Granular permissions UI', () => {
  it('removes parent/wildcard authority when an individual child is unchecked', () => {
    const narrowed = togglePermissionSelection(new Set(['*']), 'reveal_keys')
    expect(narrowed.has('*')).toBe(false)
    expect(narrowed.has('manage_keys')).toBe(false)
    expect(permissionGranted({ permissions: [...narrowed] }, 'reveal_keys')).toBe(false)
    expect(permissionGranted({ permissions: [...narrowed] }, 'view_keys')).toBe(true)
    expect(permissionGranted({ permissions: [...narrowed] }, 'manage_users')).toBe(true)
  })
  it('saves actual child grants for a restricted secondary admin', async () => {
    const user: AdminUser = { id: 2, email: 'secondary@example.com', role: 'admin', isPrimary: false, isSelf: false, permissions: ['manage_keys'], activeKeys: 0, sessions: 1, createdAt: '' }
    vi.mocked(apiFetch).mockResolvedValue({ success: true })
    await render(<PermissionsDialog user={user} open onOpenChange={() => {}} onSuccess={() => {}} />)
    const label = [...container.ownerDocument.querySelectorAll('label')].find(l => l.textContent?.startsWith('Reveal keys'))!
    await act(async () => { (label.querySelector('input') as HTMLInputElement).click() })
    const save = [...container.ownerDocument.querySelectorAll('button')].find(b => b.textContent === 'Save Permissions')!
    await act(async () => save.click())
    const call = vi.mocked(apiFetch).mock.calls.find(([path]) => path === '/api/admin/users/2/permissions')!
    const permissions = JSON.parse(String(call[1]?.body)).permissions as string[]
    expect(permissions).toContain('view_keys'); expect(permissions).toContain('add_keys')
    expect(permissions).not.toContain('manage_keys'); expect(permissions).not.toContain('reveal_keys')
  })
  it('keeps Primary Admin authority immutable in the editor', async () => {
    const user: AdminUser = { id: 1, email: 'primary@example.com', role: 'admin', isPrimary: true, isSelf: true, permissions: ['*'], activeKeys: 0, sessions: 1, createdAt: '' }
    await render(<PermissionsDialog user={user} open onOpenChange={() => {}} onSuccess={() => {}} />)
    const checks = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(checks.length).toBeGreaterThan(40)
    expect(checks.every(input => input.disabled && input.checked)).toBe(true)
    expect(document.body.textContent).not.toContain('Save Permissions')
    expect(apiFetch).not.toHaveBeenCalled()
  })
  it('separates FreeLLMAPI and Thruline permissions into tabs and toggles between them', async () => {
    const user: AdminUser = { id: 3, email: 'member@example.com', role: 'member', isPrimary: false, isSelf: false, permissions: [], activeKeys: 0, sessions: 1, createdAt: '' }
    vi.mocked(apiFetch).mockResolvedValue({ success: true })
    await render(<PermissionsDialog user={user} open onOpenChange={() => {}} onSuccess={() => {}} />)

    const tabs = [...container.ownerDocument.querySelectorAll<HTMLButtonElement>('button[role="tab"]')]
    expect(tabs.length).toBe(2)
    const freellmTab = tabs.find(t => t.textContent?.includes('FreeLLMAPI'))!
    const xGatewayTab = tabs.find(t => t.textContent?.includes('Thruline'))!
    expect(freellmTab).toBeDefined()
    expect(xGatewayTab).toBeDefined()

    expect(freellmTab.getAttribute('aria-selected')).toBe('true')
    expect(xGatewayTab.getAttribute('aria-selected')).toBe('false')

    await act(async () => { xGatewayTab.click() })
    expect(freellmTab.getAttribute('aria-selected')).toBe('false')
    expect(xGatewayTab.getAttribute('aria-selected')).toBe('true')

    const useXLabel = [...container.ownerDocument.querySelectorAll('label')].find(l => l.textContent?.includes('Use Thruline'))!
    expect(useXLabel).toBeDefined()
    await act(async () => { (useXLabel.querySelector('input') as HTMLInputElement).click() })

    const save = [...container.ownerDocument.querySelectorAll('button')].find(b => b.textContent === 'Save Permissions')!
    await act(async () => save.click())

    const call = vi.mocked(apiFetch).mock.calls.find(([path]) => path === '/api/admin/users/3/permissions')!
    const permissions = JSON.parse(String(call[1]?.body)).permissions as string[]
    expect(permissions).toContain('use_x_gateway')
  })
  it('separates FreeLLMAPI and Thruline permissions into tabs and toggles between them', async () => {
    const user: AdminUser = { id: 3, email: 'member@example.com', role: 'member', isPrimary: false, isSelf: false, permissions: [], activeKeys: 0, sessions: 1, createdAt: '' }
    vi.mocked(apiFetch).mockResolvedValue({ success: true })
    await render(<PermissionsDialog user={user} open onOpenChange={() => {}} onSuccess={() => {}} />)

    const tabs = [...container.ownerDocument.querySelectorAll<HTMLButtonElement>('button[role="tab"]')]
    expect(tabs.length).toBe(2)
    const freellmTab = tabs.find(t => t.textContent?.includes('FreeLLMAPI'))!
    const xGatewayTab = tabs.find(t => t.textContent?.includes('Thruline'))!
    expect(freellmTab).toBeDefined()
    expect(xGatewayTab).toBeDefined()

    expect(freellmTab.getAttribute('aria-selected')).toBe('true')
    expect(xGatewayTab.getAttribute('aria-selected')).toBe('false')

    await act(async () => { xGatewayTab.click() })
    expect(freellmTab.getAttribute('aria-selected')).toBe('false')
    expect(xGatewayTab.getAttribute('aria-selected')).toBe('true')

    const useXLabel = [...container.ownerDocument.querySelectorAll('label')].find(l => l.textContent?.includes('Use Thruline'))!
    expect(useXLabel).toBeDefined()
    await act(async () => { (useXLabel.querySelector('input') as HTMLInputElement).click() })

    const save = [...container.ownerDocument.querySelectorAll('button')].find(b => b.textContent === 'Save Permissions')!
    await act(async () => save.click())

    const call = vi.mocked(apiFetch).mock.calls.find(([path]) => path === '/api/admin/users/3/permissions')!
    const permissions = JSON.parse(String(call[1]?.body)).permissions as string[]
    expect(permissions).toContain('use_x_gateway')
  })
  it('shows only masked key viewing for a view-only administrator', async () => {
    actor.permissions = ['view_keys']
    vi.mocked(apiFetch).mockResolvedValue([{ id: 1, platform: 'groq', label: 'Work', maskedKey: 'gsk_••••', status: 'healthy' }])
    await render(<ScopedKeysPage />)
    await until(() => expect(container.textContent).toContain('gsk_••••'))
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(vi.mocked(apiFetch).mock.calls.every(([path]) => path === '/api/keys')).toBe(true)
  })
  it('does not read the key inventory for add-only accounts', async () => {
    actor.permissions = ['add_keys']
    await render(<ScopedKeysPage />)
    expect(container.textContent).toContain('Add key')
    expect(apiFetch).not.toHaveBeenCalled()
  })
  it('does not activate caching on mount and prevents view-only mutations', async () => {
    actor.permissions = ['view_cache']
    vi.mocked(apiFetch).mockResolvedValue({ enabled: false, persist: true, ttlSeconds: 3600, maxEntries: 5000 })
    await render(<CacheSettingsSection />)
    await until(() => expect(container.querySelectorAll('[role="switch"]')).toHaveLength(2))
    const switches = [...container.querySelectorAll<HTMLElement>('[role="switch"]')]
    expect(switches.every(b => b.hasAttribute('data-disabled') || b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true')).toBe(true)
    await act(async () => { for (const control of switches) control.click() })
    expect(vi.mocked(apiFetch).mock.calls.every(([, options]) => !options?.method)).toBe(true)
  })
  it('lets cache editors toggle configuration while withholding clear permission', async () => {
    actor.permissions = ['edit_cache']
    const preferences = { enabled: false, persist: false, ttlSeconds: 3600, maxEntries: 5000 }
    vi.mocked(apiFetch).mockImplementation(async (_path, options) => {
      if (options?.method === 'PUT') Object.assign(preferences, JSON.parse(String(options.body)))
      return { ...preferences }
    })
    await render(<CacheSettingsSection />)
    await until(() => expect(container.querySelectorAll('[role="switch"]')).toHaveLength(2))
    await act(async () => { container.querySelector<HTMLButtonElement>('[role="switch"]')!.click() })
    await until(() => expect(vi.mocked(apiFetch).mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(true))
    const call = vi.mocked(apiFetch).mock.calls.find(([, o]) => o?.method === 'PUT')!
    expect(JSON.parse(String(call[1]?.body))).toEqual({ enabled: true })
    expect(container.textContent).not.toContain('Clear cached responses')
  })
  it('shows the requested cache state while a slow save is pending', async () => {
    actor.permissions = ['edit_cache']
    const preferences = { enabled: false, persist: false, ttlSeconds: 3600, maxEntries: 5000 }
    let finishSave!: () => void
    const saved = new Promise<void>(resolve => { finishSave = resolve })
    vi.mocked(apiFetch).mockImplementation(async (_path, options) => {
      if (options?.method === 'PUT') {
        await saved
        Object.assign(preferences, JSON.parse(String(options.body)))
      }
      return { ...preferences }
    })
    await render(<CacheSettingsSection />)
    await until(() => expect(container.querySelector('[role="switch"]')).not.toBeNull())
    await act(async () => { container.querySelector<HTMLElement>('[role="switch"]')!.click() })
    await until(() => {
      expect(container.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
      expect(container.textContent).toContain('Saving cache settings')
    })
    await act(async () => { finishSave(); await saved })
    await until(() => expect(container.textContent).toContain('Cache settings saved'))
    expect(container.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
  })
  it('restores the saved cache state and reports a failed update', async () => {
    actor.permissions = ['edit_cache']
    const preferences = { enabled: false, persist: true, ttlSeconds: 3600, maxEntries: 5000 }
    let failSave!: (error: Error) => void
    const saved = new Promise<never>((_resolve, reject) => { failSave = reject })
    vi.mocked(apiFetch).mockImplementation(async (_path, options) => {
      if (options?.method === 'PUT') return saved
      return { ...preferences }
    })
    await render(<CacheSettingsSection />)
    await until(() => expect(container.querySelector('[role="switch"]')).not.toBeNull())
    await act(async () => { container.querySelector<HTMLElement>('[role="switch"]')!.click() })
    await until(() => expect(container.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true'))
    await act(async () => { failSave(new Error('Could not save cache settings')) })
    await until(() => {
      expect(container.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save cache settings')
    })
  })
});
