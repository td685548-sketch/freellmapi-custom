// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import { galaxyEffect } from './x-gateway/transition/galaxy';
import { tenantPortalApi } from './tenant-portal/api';
import { TenantPortalApp } from './tenant-portal/TenantPortalApp';

vi.mock('./tenant-portal/api', () => ({
  tenantPortalApi: {
    listTenants: vi.fn(),
  },
}));

vi.mock('./tenant-portal/TenantAnalyticsTab', () => ({
  TenantAnalyticsTab: ({ tenantId }: { tenantId: number }) => (
    <div data-testid="lazy-analytics-tab">Analytics for tenant #{tenantId}</div>
  ),
}));

vi.mock('./tenant-portal/TenantAiTab', () => ({
  TenantAiTab: ({ tenantId }: { tenantId: number }) => (
    <div data-testid="lazy-ai-tab">AI config for tenant #{tenantId}</div>
  ),
}));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
});

async function flushUi(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

describe('Bundle splitting, URL-synced Tenant Portal tabs & snappy WebGPU transition', () => {
  it('keeps WebGPU galaxy transition snappy (<= 1.5s) instead of blocking interaction for 3.4s', () => {
    expect(galaxyEffect.duration).toBeLessThanOrEqual(1500);
    expect(galaxyEffect.coveredAt).toBeLessThanOrEqual(0.5);
  });

  it('restores active tenant and tab from URL query params and lazy-loads only the requested tab', async () => {
    vi.mocked(tenantPortalApi.listTenants).mockResolvedValue({
      tenants: [
        {
          id: 10,
          name: 'Alpha Org',
          slug: 'alpha',
          enabled: true,
          rolePreset: 'tenant_admin',
          permissions: ['tenant_ai_config', 'tenant_analytics'],
        },
        {
          id: 22,
          name: 'Beta Org',
          slug: 'beta',
          enabled: true,
          rolePreset: 'tenant_admin',
          permissions: ['tenant_ai_config', 'tenant_analytics'],
        },
      ] as any,
      availableModels: [],
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider initialLocale="en">
            <MemoryRouter initialEntries={['/tenant-portal?tenant=22&tab=tenant_analytics']}>
              <TenantPortalApp />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });

    await flushUi();

    expect(container.querySelector('[data-testid="lazy-analytics-tab"]')?.textContent).toContain(
      'Analytics for tenant #22',
    );
    expect(container.querySelector('[data-testid="lazy-ai-tab"]')).toBeNull();
  });
});
