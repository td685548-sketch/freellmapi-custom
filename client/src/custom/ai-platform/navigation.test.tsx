// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { permissionGroupVisible, permissionGranted, type Permission } from '../../../../shared/permissions';
import { Navbar } from '../../App';

const actor = vi.hoisted(() => ({ permissions: [] as Permission[], locale: 'en' }));
vi.mock('@/custom/use-administrative-access', () => ({
  useAdministrativeAccess: () => {
    const session = { role: 'member' as const, isPrimary: false, permissions: actor.permissions };
    return { isMember: true, isAdmin: false,
      hasPermission: (key: Parameters<typeof permissionGranted>[1]) => permissionGranted(session, key),
      group: (key: Parameters<typeof permissionGroupVisible>[1]) => permissionGroupVisible(session, key) };
  },
}));
vi.mock('@/hooks/use-premium', () => ({ usePremium: () => ({ data: null, licensed: false }) }));
vi.mock('@/components/settings-dialog', () => ({ SettingsDialog: () => null }));
vi.mock('@/components/updates-dialog', () => ({ UpdatesDialog: () => null }));
vi.mock('@/i18n', async importOriginal => ({ ...await importOriginal<object>(),
  useI18n: () => ({ locale: actor.locale, t: (key: string) => key }) }));

function Location() { return <p data-testid="location">{useLocation().pathname}</p>; }
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  actor.permissions = []; actor.locale = 'en';
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render() {
  await act(async () => root.render(<MemoryRouter initialEntries={['/models/chat']}><Navbar /><Location /></MemoryRouter>));
}

describe('native AI Platform navigation', () => {
  it.each(['view_ai_platform', 'edit_ai_flags', 'manage_ai_platform'] as const)('lets %s users discover and open the page', async permission => {
    actor.permissions = [permission]; await render();
    const link = container.querySelector<HTMLAnchorElement>('a[href="/ai-platform"]');
    expect(link?.textContent).toBe('AI Platform');
    await act(async () => link!.click());
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe('/ai-platform');
  });
  it('hides the entry from users without AI Platform permissions', async () => {
    await render(); expect(container.querySelector('a[href="/ai-platform"]')).toBeNull();
  });
  it('uses the Vietnamese label from the native menu', async () => {
    actor.permissions = ['view_ai_platform']; actor.locale = 'vi'; await render();
    expect(container.querySelector('a[href="/ai-platform"]')?.textContent).toBe('Nền tảng AI');
  });
});
