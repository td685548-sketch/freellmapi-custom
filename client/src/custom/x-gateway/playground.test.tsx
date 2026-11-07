// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import Playground from './pages/Playground';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getToken: () => 'test-token',
  clearToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'unauthorized',
}));
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }));
vi.mock('../use-session', () => ({
  useUserSession: () => ({
    hasPermission: (_p: string) => true,
    session: { userId: 1, email: 'admin@example.com' },
  }),
}));
vi.mock('../session-state', () => ({
  useSessionRevision: () => 1,
  getSessionRevision: () => 1,
}));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    if (url.includes('/api/x-gateway/playground/models')) {
      return {
        enabled: true,
        models: [
          { id: 'auto', name: 'Auto', provider: 'X Gateway' },
          { id: 'combo:fast', name: 'Fast Coding', provider: 'Combos' },
          { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'OpenAI' },
        ],
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

describe('Playground component', () => {
  it('renders playground layout with conversations sidebar and model selector', async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <Playground />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Basic Chat / Playground');
      expect(container.textContent).toContain('New chat');
      expect(container.textContent).toContain('Conversations');
      const select = container.querySelector('select');
      expect(select).not.toBeNull();
      expect(select?.textContent).toContain('auto');
      expect(select?.textContent).toContain('Fast Coding');
    });

    // Check textarea placeholder
    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    expect(textarea?.getAttribute('placeholder')).toBe('Ask anything…');
  });

  it('renders settings details element and image attachment button', async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <Playground />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Chat settings');
      expect(container.textContent).toContain('Attach images');
    });
  });
});
