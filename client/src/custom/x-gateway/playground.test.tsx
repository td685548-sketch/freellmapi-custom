// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import Playground from './pages/Playground';
import { PlaygroundMessageContent } from './PlaygroundMessage';

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
    if (url.includes('/api/thruline/playground/models')) {
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

  it('renders messages container with independent scroll and bottom composer', async () => {
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
      const messagesContainer = container.querySelector('.x-chat-messages');
      expect(messagesContainer).not.toBeNull();
      expect(messagesContainer?.classList.contains('overflow-y-auto')).toBe(true);

      const composer = container.querySelector('.x-chat-composer');
      expect(composer).not.toBeNull();

      const page = container.querySelector('.x-playground-page');
      expect(page).not.toBeNull();
    });
  });

  it('renders markdown headers, html tags and custom components in assistant message', async () => {
    const rawContent = `## 1. Chấm điểm

<row align="center" gap={2}>
  <title size="2xl" color="success" tabularNums>6/10</title>
  <badge color="success">Khá tốt</badge>
</row>

<box border radius="lg" padding={3} gap={2}>
  **Although it is raining heavily today, we decided to go camping anyway.**

  <row justify="end">
    <button size="sm" variant="ghost">Copy</button>
  </row>
</box>

## 2. Câu tiếng Anh chuẩn`;

    act(() => {
      root.render(<PlaygroundMessageContent content={rawContent} />);
    });

    expect(container.textContent).toContain('1. Chấm điểm');
    expect(container.textContent).toContain('2. Câu tiếng Anh chuẩn');
    expect(container.textContent).toContain('6/10');
    expect(container.textContent).toContain('Khá tốt');
    expect(container.textContent).toContain('Although it is raining heavily today');

    const h2Elements = container.querySelectorAll('h2');
    expect(h2Elements.length).toBe(2);

    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toContain('Although it is raining heavily today');

    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain('Copy');
  });

  it('supports pasting and drag-dropping image attachments into chat composer', async () => {
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
      const textarea = container.querySelector('textarea');
      expect(textarea).not.toBeNull();
    });

    const textarea = container.querySelector('textarea')!;
    const composer = container.querySelector('.x-chat-composer')!;

    // Test dragover and dragleave states
    act(() => {
      composer.dispatchEvent(
        new Event('dragover', { bubbles: true, cancelable: true })
      );
    });
    act(() => {
      composer.dispatchEvent(
        new Event('dragleave', { bubbles: true, cancelable: true })
      );
    });

    // Test paste event with image data
    const mockFile = new File(['fake-image-content'], 'screenshot.png', { type: 'image/png' });
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true }) as any;
    pasteEvent.clipboardData = {
      items: [
        {
          type: 'image/png',
          getAsFile: () => mockFile,
        },
      ],
    };

    act(() => {
      textarea.dispatchEvent(pasteEvent);
    });

    // FileReader in optimizeImageFile should resolve and render attachment preview
    await vi.waitFor(() => {
      const attachments = container.querySelector('.x-chat-attachments');
      expect(attachments).not.toBeNull();
    });
  });

  it('supports toggling full width and expanding input textarea', async () => {
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
      const thread = container.querySelector('.x-chat-thread');
      expect(thread).not.toBeNull();
      expect(thread?.classList.contains('x-thread-standard')).toBe(true);
    });

    // Find full width toggle button
    const fullWidthBtn = container.querySelector('button[title="Full width"]');
    expect(fullWidthBtn).not.toBeNull();

    act(() => {
      fullWidthBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Thread switches to full width
    await vi.waitFor(() => {
      const thread = container.querySelector('.x-chat-thread');
      expect(thread?.classList.contains('x-thread-full')).toBe(true);
    });

    // Find expand input button
    const expandBtn = container.querySelector('button[title="Expand input box"]');
    expect(expandBtn).not.toBeNull();

    act(() => {
      expandBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() => {
      const textarea = container.querySelector('textarea');
      expect(textarea?.style.height).toBe('180px');
    });
  });
});
