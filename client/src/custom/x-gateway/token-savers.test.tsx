// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import TokenSavers from './pages/TokenSavers';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }));
vi.mock('../use-session', () => ({
  useUserSession: () => ({
    hasPermission: () => true,
    session: { userId: 1, isPrimary: true, email: 'admin@example.com' },
  }),
}));
vi.mock('../session-state', () => ({
  useSessionRevision: () => 1,
}));
vi.mock('recharts', () => ({
  AreaChart: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
}));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/savers' && (!init || !init.method || init.method === 'GET')) {
      return {
        caveman: 'off',
        ponytail: 'off',
        customPrompt: '',
        sources: { caveman: 'default', ponytail: 'default' },
        injectedChars: 0,
      };
    }
    if (url === '/api/savers' && init?.method === 'PUT') {
      return {
        ...JSON.parse(String(init.body)),
        sources: { caveman: 'setting', ponytail: 'default' },
        injectedChars: 42,
      };
    }
    if (url === '/api/savers/rtk') {
      return { enabled: false, stats: { totalCompressions: 0, bytesBefore: 0, bytesAfter: 0, tokensSavedEst: 0, filterHits: {} } };
    }
    if (url === '/api/savers/pxpipe') {
      return { enabled: false, minChars: 1000, timeoutMs: 2000, status: { installed: false, version: '', running: false, mode: 'off' } };
    }
    if (url === '/api/savers/pxpipe/stats') {
      return { windows: {}, timeline: [] };
    }
    if (url === '/api/savers/headroom') {
      return { enabled: false, url: '', timeoutMs: 2000, compressUserMessages: false };
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

describe('TokenSavers save payload', () => {
  it('strips read-only GET fields (sources, injectedChars) when saving via PUT /api/savers', async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <TokenSavers />
        </QueryClientProvider>,
      );
    });

    // Wait for initial GET /api/savers to resolve and render the form
    await vi.waitFor(() => {
      const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"][name="caveman"]');
      expect(radios.length).toBeGreaterThanOrEqual(3);
    });

    const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"][name="caveman"]'));

    // Select 'full' (index 2: off=0, lite=1, full=2)
    await act(async () => {
      radios[2]!.click();
    });

    const form = container.querySelector('form');
    expect(form).not.toBeNull();

    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await vi.waitFor(() => {
      const putCall = vi.mocked(apiFetch).mock.calls.find(
        ([url, init]) => url === '/api/savers' && init?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      expect(JSON.parse(String(putCall![1]!.body))).toEqual({
        caveman: 'full',
        ponytail: 'off',
        customPrompt: '',
      });
    });
  });
});
