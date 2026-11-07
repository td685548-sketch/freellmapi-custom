// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import TunnelManager from './pages/TunnelManager';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }));
vi.mock('../use-session', () => ({
  useUserSession: () => ({
    hasPermission: (_p: string) => true,
    session: { email: 'admin@example.com' },
  }),
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

  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    if (url.includes('/api/x-gateway/tunnel/status')) {
      return {
        state: 'stopped',
        url: null,
        port: 3001,
        startedAt: null,
        uptimeSeconds: 0,
        cloudflaredInstalled: true,
        cloudflaredPath: '/usr/local/bin/cloudflared',
        error: null,
        logTail: ['[12:00:00] Service ready.'],
        metrics: { reconnectCount: 0 },
      };
    }
    if (url.includes('/api/x-gateway/tunnel/logs')) {
      return { logs: ['[12:00:00] Service ready.'] };
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

describe('TunnelManager component', () => {
  it('renders title, status and start tunnel button when stopped', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <TunnelManager />
          </QueryClientProvider>
        </MemoryRouter>
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Installed & Ready');
    });

    expect(container.textContent).toContain('Cloudflare Quick Tunnel');
    expect(container.textContent).toContain('Tunnel Stopped');
    expect(container.textContent).toContain('Start Quick Tunnel');
    expect(container.textContent).toContain('3001');
  });

  it('renders active public URL and stop button when tunnel is active', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url.includes('/api/x-gateway/tunnel/status')) {
        return {
          state: 'active',
          url: 'https://sample-quick-tunnel.trycloudflare.com',
          port: 3001,
          startedAt: Date.now() - 60000,
          uptimeSeconds: 60,
          cloudflaredInstalled: true,
          cloudflaredPath: '/usr/local/bin/cloudflared',
          error: null,
          logTail: ['[12:00:01] Tunnel active!'],
          metrics: { reconnectCount: 0 },
        };
      }
      return { logs: ['[12:00:01] Tunnel active!'] };
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <TunnelManager />
          </QueryClientProvider>
        </MemoryRouter>
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Active & Connected');
    });

    expect(container.textContent).toContain('sample-quick-tunnel.trycloudflare.com');
    expect(container.textContent).toContain('Stop Tunnel');
  });

  it('renders integration snippets and allows switching tabs', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <TunnelManager />
          </QueryClientProvider>
        </MemoryRouter>
      );
    });

    expect(container.textContent).toContain('ANTHROPIC_BASE_URL');

    const buttons = Array.from(container.querySelectorAll('button'));
    const codexButton = buttons.find((b) => b.textContent?.includes('OpenAI Codex CLI'));
    expect(codexButton).toBeDefined();

    await act(async () => {
      codexButton?.click();
    });

    expect(container.textContent).toContain('OPENAI_BASE_URL');
  });
});
