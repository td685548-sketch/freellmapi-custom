// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import ConsoleLog from './pages/ConsoleLog';

let mockIsPrimary = true;

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getToken: () => 'test-token',
}));
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }));
vi.mock('../use-session', () => ({
  useUserSession: () => ({
    isPrimary: mockIsPrimary,
    hasPermission: () => true,
    session: { userId: mockIsPrimary ? 1 : 2, isPrimary: mockIsPrimary, email: 'admin@example.com' },
  }),
}));
vi.mock('../session-state', () => ({
  useSessionRevision: () => 1,
}));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockIsPrimary = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/thruline/usage/logs') && init?.method === 'DELETE') {
      return { ok: true, deleted: 1 };
    }
    if (url.includes('/api/thruline/usage/logs')) {
      return { logs: [] };
    }
    if (url.includes('/api/thruline/usage/hourly')) {
      return { buckets: [] };
    }
    if (url.includes('/api/thruline/pricing')) {
      return { pricing: {} };
    }
    return {};
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
});

async function renderConsoleLog() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ConsoleLog />
      </QueryClientProvider>,
    );
  });
}

describe('ConsoleLog primary admin clear button', () => {
  it('shows the clear logs button on both tabs when user is primary admin and calls DELETE on click', async () => {
    mockIsPrimary = true;
    await renderConsoleLog();

    const clearBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Clear logs'));
    expect(clearBtn).toBeDefined();

    await act(async () => {
      clearBtn!.click();
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/thruline/usage/logs', { method: 'DELETE' });

    // Switch to terminal tab
    const terminalTab = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Terminal Live Stream'));
    expect(terminalTab).toBeDefined();
    await act(async () => {
      terminalTab!.click();
    });

    const terminalClearBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Clear logs'));
    expect(terminalClearBtn).toBeDefined();
  });

  it('hides the clear logs button on both tabs when user is not primary admin', async () => {
    mockIsPrimary = false;
    await renderConsoleLog();

    expect(Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Clear logs'))).toBeUndefined();

    const terminalTab = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Terminal Live Stream'));
    await act(async () => {
      terminalTab!.click();
    });

    expect(Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Clear logs'))).toBeUndefined();
  });
});
