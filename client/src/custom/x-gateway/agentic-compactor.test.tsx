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
    if (url === '/api/savers') {
      return {
        caveman: 'off',
        ponytail: 'off',
        customPrompt: '',
        sources: { caveman: 'default', ponytail: 'default' },
        injectedChars: 0,
      };
    }
    if (url === '/api/savers/rtk') {
      return { enabled: true, stats: { totalCompressions: 0, bytesBefore: 0, bytesAfter: 0, tokensSavedEst: 0, filterHits: {} } };
    }
    if (url === '/api/savers/pxpipe') {
      return { enabled: false, minChars: 25000, timeoutMs: 2000, status: { installed: false, version: '', running: false, mode: 'off' } };
    }
    if (url === '/api/savers/pxpipe/stats') {
      return { windows: {}, timeline: [] };
    }
    if (url === '/api/savers/headroom') {
      return {
        config: { enabled: false, url: '', maskedUrl: '', timeoutMs: 3000, compressUserMessages: false, source: 'default' },
        stats: { requests: 0, compressed: 0, bypassed: 0, errors: 0, bytesBefore: 0, bytesAfter: 0, tokensBeforeEst: 0, tokensAfterEst: 0, tokensSavedEst: 0, proxyReportedTokensSaved: 0, lastSuccessAt: null, lastError: null, lastErrorAt: null },
        status: { ok: false, state: 'unconfigured', reachable: false, ready: false, endpoint: '', latencyMs: 0, checkedAt: '' },
        envVars: [],
      };
    }
    if (url === '/api/savers/agentic' && (!init?.method || init.method === 'GET')) {
      return {
        config: {
          enabled: false,
          toolCompaction: true,
          toolResultMaxChars: 12000,
          jsonMinChars: 2000,
          proseMode: 'standard',
          prefixFreezeEnabled: true,
          prefixFreezeThreshold: 3,
          dedupTools: true,
          source: 'default',
        },
        stats: {
          requestsProcessed: 4,
          requestsCompressed: 3,
          bytesBefore: 12000,
          bytesAfter: 4800,
          tokensSavedEst: 1800,
          strategyHits: {
            source_code: 1,
            grep_search: 0,
            terminal_ansi: 0,
            json_payload: 1,
            stack_trace: 1,
            evidence_digest: 0,
            prose_caveman: 2,
            tools_dedup: 1,
          },
          frozenPrefixesSkipped: 1,
          fidelityRollbacks: 0,
          trackedPrefixes: 2,
          frozenPrefixes: 1,
        },
      };
    }
    if (url === '/api/savers/agentic' && init?.method === 'PUT') {
      const parsed = JSON.parse(String(init.body));
      return {
        config: { ...parsed, source: 'setting' },
        stats: {
          requestsProcessed: 4,
          requestsCompressed: 3,
          bytesBefore: 12000,
          bytesAfter: 4800,
          tokensSavedEst: 1800,
          strategyHits: {
            source_code: 1,
            grep_search: 0,
            terminal_ansi: 0,
            json_payload: 1,
            stack_trace: 1,
            evidence_digest: 0,
            prose_caveman: 2,
            tools_dedup: 1,
          },
          frozenPrefixesSkipped: 1,
          fidelityRollbacks: 0,
          trackedPrefixes: 2,
          frozenPrefixes: 1,
        },
      };
    }
    if (url === '/api/savers/agentic/preview' && init?.method === 'POST') {
      return {
        ok: true,
        originalChars: 1600,
        compressedChars: 420,
        savedChars: 1180,
        tokensBeforeEst: 400,
        tokensAfterEst: 105,
        tokensSavedEst: 295,
        savedPct: 73.8,
        strategiesApplied: ['stack_trace'],
        protectedSpansCount: 0,
        prefixFrozen: false,
        fidelityRolledBack: false,
        originalPreview: 'orig',
        compressedPreview: 'TypeError\n… [10 frames elided] …',
      };
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

describe('AgenticCompactorPanel inside TokenSavers', () => {
  it('renders telemetry, toggles enabled config via PUT /api/savers/agentic, and runs dry-run preview', async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <TokenSavers />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      const panel = container.querySelector('[data-testid="agentic-compactor-panel"]');
      expect(panel).not.toBeNull();
      expect(panel?.textContent).toContain('1,800');
    });

    const toggleSwitch = container.querySelector<HTMLButtonElement>(
      '[data-testid="agentic-compactor-panel"] button[role="switch"]',
    );
    expect(toggleSwitch).not.toBeNull();

    await act(async () => {
      toggleSwitch!.click();
    });

    await vi.waitFor(() => {
      const putCall = vi.mocked(apiFetch).mock.calls.find(
        ([url, init]) => url === '/api/savers/agentic' && init?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(String(putCall![1]!.body));
      expect(body.enabled).toBe(true);
      expect(body.source).toBeUndefined();
    });

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="agentic-compactor-panel"] button'),
    );
    const openSandboxBtn = buttons.find(btn => btn.textContent?.includes('Open Live Compression Sandbox'));
    expect(openSandboxBtn).toBeDefined();

    await act(async () => {
      openSandboxBtn!.click();
    });

    await vi.waitFor(() => {
      const runBtn = Array.from(
        container.querySelectorAll<HTMLButtonElement>('[data-testid="agentic-compactor-panel"] button'),
      ).find(btn => btn.textContent?.includes('Run Compression Preview'));
      expect(runBtn).toBeDefined();
    });

    const runBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="agentic-compactor-panel"] button'),
    ).find(btn => btn.textContent?.includes('Run Compression Preview'))!;

    await act(async () => {
      runBtn.click();
    });

    await vi.waitFor(() => {
      const previewResult = container.querySelector('[data-testid="agentic-preview-result"]');
      expect(previewResult).not.toBeNull();
      expect(previewResult?.textContent).toContain('400 → 105');
      expect(previewResult?.textContent).toContain('73.8%');
      expect(previewResult?.textContent).toContain('[10 frames elided]');
    });
  });
});
