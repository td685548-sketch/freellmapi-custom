// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import CLITools from './pages/CLITools';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }));
vi.mock('../use-session', () => ({
  useUserSession: () => ({
    hasPermission: (_p: string) => true,
    session: { email: 'admin@example.com' },
  }),
}));
vi.mock('../session-state', () => ({ useSessionRevision: () => 1 }));

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
    if (url.includes('/api/thruline/keys')) {
      return {
        keys: [
          {
            id: 1,
            userId: 1,
            name: 'Primary Key',
            keyPrefix: 'sk-xgw-abc1',
            rpmLimit: 60,
            revoked: false,
            createdAt: '2026-11-07T00:00:00Z',
            lastUsedAt: null,
          },
        ],
      };
    }
    if (url.includes('/api/thruline/tools')) {
      return {
        enabled: true,
        usableAccounts: 2,
        tools: [
          { id: 'claude', name: 'Claude Code', protocol: 'anthropic-messages' },
          { id: 'codex', name: 'OpenAI Codex CLI', protocol: 'openai-responses' },
        ],
      };
    }
    return {};
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

async function renderView() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <CLITools />
        </QueryClientProvider>
      </MemoryRouter>
    );
  });
}

describe('CLITools component', () => {
  it('renders title, key selector and tools directory', async () => {
    await renderView();
    expect(container.textContent).toContain('CLI Tools & IDE Setup');
    expect(container.textContent).toContain('Claude Code');
    expect(container.textContent).toContain('OpenAI Codex CLI');
    expect(container.textContent).toContain('Cursor IDE');
  });

  it('generates bash export snippet with active key and url', async () => {
    await renderView();
    expect(container.textContent).toContain('export ANTHROPIC_BASE_URL=');
    expect(container.textContent).toContain('export ANTHROPIC_API_KEY=');
  });

  it('switches shell tabs to PowerShell and updates syntax', async () => {
    await renderView();
    const psBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('PowerShell')
    );
    expect(psBtn).toBeDefined();
    await act(async () => {
      psBtn?.click();
    });
    expect(container.textContent).toContain('$env:ANTHROPIC_BASE_URL =');
    expect(container.textContent).toContain('$env:ANTHROPIC_API_KEY =');
  });
});
