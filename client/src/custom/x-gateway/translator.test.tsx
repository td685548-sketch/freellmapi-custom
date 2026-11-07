// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import TranslatorInspector from './pages/TranslatorInspector';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }));

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
    if (url.includes('/api/x-gateway/translator/templates')) {
      return {
        templates: [
          {
            id: 'openai-chat-simple',
            name: 'OpenAI Chat (Simple)',
            protocol: 'openai_chat',
            description: 'Basic multi-turn conversation',
            payload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }] },
          },
        ],
      };
    }
    if (url.includes('/api/x-gateway/translator/inspect')) {
      return {
        success: true,
        sourceProtocol: 'openai_chat',
        targetProtocol: 'anthropic',
        transformed: {
          model: 'claude-3-7-sonnet',
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 1024,
        },
        steps: [
          {
            step: 1,
            name: 'Protocol Ingestion & Validation',
            status: 'ok',
            title: 'OpenAI Chat Completions Schema Parsed',
            details: 'Parsed payload with 1 message.',
          },
          {
            step: 2,
            name: 'System Message Extraction',
            status: 'ok',
            title: 'Extracted System Instructions',
            details: 'No system instructions present in payload.',
          },
        ],
        stats: {
          sourceTokens: 10,
          targetTokens: 12,
          delta: 2,
          warnings: [],
          lossyFields: [],
        },
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

describe('TranslatorInspector component', () => {
  it('renders title, source/target protocol selectors and editor', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <TranslatorInspector />
          </QueryClientProvider>
        </MemoryRouter>
      );
    });

    expect(container.textContent).toContain('Protocol Translator Inspector');
    expect(container.textContent).toContain('Source Protocol');
    expect(container.textContent).toContain('Target Protocol');
    expect(container.textContent).toContain('Valid JSON');
  });

  it('renders pipeline steps trace tab', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <TranslatorInspector />
          </QueryClientProvider>
        </MemoryRouter>
      );
    });

    // Wait for debounced inspect query with vi.waitFor
    await vi.waitFor(
      () => {
        expect(container.textContent).toContain('Protocol Ingestion & Validation');
        expect(container.textContent).toContain('System Message Extraction');
      },
      { timeout: 2000 }
    );
  });

  it('switches between tabs: JSON and Dispatch', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <TranslatorInspector />
          </QueryClientProvider>
        </MemoryRouter>
      );
    });

    // Click JSON tab
    const buttons = Array.from(container.querySelectorAll('button'));
    const jsonTabButton = buttons.find((b) => b.textContent?.includes('Transformed JSON'));
    expect(jsonTabButton).toBeDefined();

    await act(async () => {
      jsonTabButton?.click();
    });

    expect(container.textContent).toContain('Copy JSON');

    // Click Dispatch tab
    const dispatchTabButton = buttons.find((b) => b.textContent?.includes('Gateway Dispatch Test'));
    expect(dispatchTabButton).toBeDefined();

    await act(async () => {
      dispatchTabButton?.click();
    });

    expect(container.textContent).toContain('Verify Gateway Route');
  });
});
