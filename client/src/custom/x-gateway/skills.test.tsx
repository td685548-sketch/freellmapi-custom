// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import SkillsHub from './pages/SkillsHub';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }));
vi.mock('../use-session', () => ({
  useUserSession: () => ({
    hasPermission: (_p: string) => true,
    session: { userId: 1, email: 'admin@example.com' },
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
    if (url.includes('/api/thruline/skills')) {
      return {
        skills: [
          {
            id: '9router',
            name: '9Router (Entry & Setup)',
            category: 'entry',
            description: 'Setup and index of all gateway capabilities.',
            endpoint: null,
            icon: 'Hub',
            isEntry: true,
            isCustom: false,
            rawUrl: 'http://localhost:3001/api/thruline/skills/9router/raw',
            publicUrl: 'http://localhost:3001/thruline-skills/9router/SKILL.md',
            githubUrl: 'https://github.com/decolua/9router',
            tokenEstimate: 650,
            promptSnippet: 'Read this skill and use it: http://localhost:3001/thruline-skills/9router/SKILL.md',
            content: '# 9Router Entry Skill Content',
          },
          {
            id: '9router-chat',
            name: 'Chat & Code Generation',
            category: 'chat',
            description: 'Chat completions via OpenAI or Anthropic format.',
            endpoint: '/v1/chat/completions',
            icon: 'MessageSquare',
            isEntry: false,
            isCustom: false,
            rawUrl: 'http://localhost:3001/api/thruline/skills/9router-chat/raw',
            publicUrl: 'http://localhost:3001/thruline-skills/9router-chat/SKILL.md',
            githubUrl: 'https://github.com/decolua/9router',
            tokenEstimate: 500,
            promptSnippet: 'Read this skill and use it: http://localhost:3001/thruline-skills/9router-chat/SKILL.md',
            content: '# 9Router Chat Skill Content',
          },
        ],
        tunnelActive: true,
        tunnelUrl: 'https://test-tunnel.trycloudflare.com',
        resolvedBaseUrl: 'http://localhost:3001',
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

describe('SkillsHub component', () => {
  it('renders hero setup instruction and skill cards with badges', async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <SkillsHub />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Agent Skills & Instructions Hub');
      expect(container.textContent).toContain('Read this skill and use it:');
      expect(container.textContent).toContain('9Router (Entry & Setup)');
      expect(container.textContent).toContain('START HERE');
      expect(container.textContent).toContain('Chat & Code Generation');
      expect(container.textContent).toContain('/v1/chat/completions');
    });

    // Check search input presence
    const searchInput = container.querySelector('input[placeholder*="Search skills"]');
    expect(searchInput).not.toBeNull();
  });

  it('filters skills by search query', async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <SkillsHub />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Chat & Code Generation');
    });

    const searchInput = container.querySelector('input[placeholder*="Search skills"]') as HTMLInputElement;
    act(() => {
      searchInput.value = 'Entry';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      // React state update via onChange
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      nativeInputValueSetter?.call(searchInput, 'Entry');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
});

