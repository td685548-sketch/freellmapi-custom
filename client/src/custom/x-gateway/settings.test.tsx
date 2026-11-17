// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import Settings from './pages/Settings';

let canEdit = true;
const setLocale = vi.fn();

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), getToken: () => 'test-token' }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en', setLocale }) }));
vi.mock('../use-session', () => ({ useUserSession: () => ({ hasPermission: () => canEdit, session: { userId: 1 } }) }));
vi.mock('../session-state', () => ({ useSessionRevision: () => 1 }));

let root: Root;
let container: HTMLDivElement;

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const type = (el: HTMLInputElement, value: string) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const inputs = () => [...container.querySelectorAll('input')] as HTMLInputElement[];
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement;

beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  canEdit = true;
  setLocale.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/thruline/routing-defaults' && init?.method === 'PUT') return JSON.parse(String(init.body));
    if (url === '/api/thruline/routing-defaults') return { accountStrategy: 'fallback', accountStickyLimit: 3, comboRoundRobin: false, comboStickyLimit: 1 };
    return { success: true };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root.render(<QueryClientProvider client={client}><Settings /></QueryClientProvider>); });
  await flush();
});

afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('Thruline Settings page', () => {
  it('shows routing defaults and saves a change', async () => {
    const boxes = inputs().filter(i => i.type === 'checkbox');
    expect(boxes[0]!.checked).toBe(false);
    click(boxes[1]!);
    await click(button('Save'));
    await flush();
    const put = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(put?.[0]).toBe('/api/thruline/routing-defaults');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ accountStrategy: 'fallback', accountStickyLimit: 3, comboRoundRobin: true, comboStickyLimit: 1 });
    expect(container.textContent).toContain('Saved.');
  });

  it('blocks an out-of-range sticky limit', async () => {
    const combo = inputs().find(i => i.inputMode === 'numeric')!;
    type(combo, '500');
    expect(container.textContent).toContain('Enter a whole number from 1 to 100.');
    expect(button('Save').disabled).toBe(true);
  });

  it('is read-only without edit permission', async () => {
    act(() => root.unmount());
    canEdit = false;
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => { root.render(<QueryClientProvider client={client}><Settings /></QueryClientProvider>); });
    await flush();
    expect(container.textContent).toContain('You can view these settings but not change them.');
    expect(button('Save')).toBeUndefined();
  });

  it('validates and submits a password change', async () => {
    const [current, next, confirm] = inputs().filter(i => i.type === 'password') as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    type(current, 'OldPassword1!'); type(next, 'short'); type(confirm, 'short');
    await click(button('Change password'));
    expect(container.textContent).toContain('Use at least 8 characters.');
    type(next, 'NewPassword1!'); type(confirm, 'Different1!');
    await click(button('Change password'));
    expect(container.textContent).toContain('The passwords do not match.');
    type(confirm, 'NewPassword1!');
    await click(button('Change password'));
    await flush();
    const post = vi.mocked(apiFetch).mock.calls.find(([url]) => url === '/api/auth/change-password');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ currentPassword: 'OldPassword1!', newPassword: 'NewPassword1!' });
    expect(container.textContent).toContain('Password changed.');
  });

  it('switches language', () => {
    const select = container.querySelector('select')!;
    act(() => { select.value = 'vi'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(setLocale).toHaveBeenCalledWith('vi');
  });
});
