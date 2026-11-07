// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import type { XQuotaResponse } from '../../../../shared/x-quota';
import Quota from './pages/Quota';
import { quotaCountdown } from './quota-format';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }));
const permissions = vi.hoisted(() => ({ edit: false, view: true }));
vi.mock('../use-session', () => ({ useUserSession: () => ({ hasPermission: (p: string) => p === 'view_x_usage' ? permissions.view : permissions.edit }) }));

let root: Root; let container: HTMLDivElement; let client: QueryClient; let data: XQuotaResponse;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T07:00:00Z'));
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  permissions.edit = false; permissions.view = true;
  data = { freshnessMs: 300000, accounts: [{
    accountId: 1, provider: 'claude', providerName: 'Claude', label: 'Work', enabled: true, tier: 'subscription', supported: true,
    windows: [{ id: 'five_hour', limit: 100, remaining: 25, unit: '%', source: 'quota_api', blocking: true, resetAt: '2026-11-07T07:00:02Z' }],
    observedAt: '2026-11-07T07:00:00Z', checkedAt: '2026-11-07T07:00:00Z', stale: false, error: null,
    local: { requests: 1, tokens: 2, requestCap: 0, tokenCap: 0, resetAt: '2026-12-01T00:00:00Z' },
  }] };
  vi.mocked(apiFetch).mockReset().mockImplementation(async () => structuredClone(data));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.useRealTimers(); });
async function render() {
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><Quota /></QueryClientProvider></MemoryRouter>));
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
}
describe('Quota view', () => {
  it('shows real allowance and advances countdown without a provider request every second', async () => {
    await render();
    expect(container.textContent).toContain('Resets in 00:00:02');
    expect(container.textContent).toContain('Provider API');
    expect(container.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('25');
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(container.textContent).toContain('Reset time passed — refresh to confirm');
    expect(container.textContent).toContain('Stale / needs refresh');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect((container.querySelector('[aria-label="Routing tier: Work"]') as HTMLSelectElement).disabled).toBe(true);
  });
  it('shows unknown without a fake full bar and reports refresh failures', async () => {
    data.accounts[0].windows = []; data.accounts[0].observedAt = null; data.accounts[0].stale = true;
    await render();
    expect(container.textContent).toContain('Provider quota not reported yet.');
    expect(container.querySelector('[role=progressbar]')).toBeNull();
    vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
      if (init?.method === 'POST') throw new Error('offline');
      return structuredClone(data);
    });
    const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Refresh quota')!;
    await act(async () => { button.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(container.textContent).toContain('Could not refresh quota.');
  });
  it('sends a tier override only for settings editors', async () => {
    permissions.edit = true; await render();
    const select = container.querySelector('[aria-label="Routing tier: Work"]') as HTMLSelectElement;
    await act(async () => { select.value = 'free'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(apiFetch).toHaveBeenCalledWith('/api/x-gateway/quota/1/tier', expect.objectContaining({ method: 'PUT', body: '{"tier":"free"}' }));
  });
  it('does not query quota without permission', async () => {
    permissions.view = false; await render(); expect(apiFetch).not.toHaveBeenCalled();
  });
  it('formats unknown and expired reset times honestly', () => {
    expect(quotaCountdown(null, Date.now())).toBeNull();
    expect(quotaCountdown('invalid', Date.now())).toBeNull();
    expect(quotaCountdown('2026-11-07T06:59:59Z', Date.now())).toBe('reset');
  });
});
