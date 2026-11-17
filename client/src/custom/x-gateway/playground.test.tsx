// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import { readChatStream, StreamTimeoutError } from '@/lib/playground-stream';
import { streamPlayground } from './playground-api';
import { historyKey } from './playground-state';
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
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

  it('opens an HTML preview popup from HTML code blocks and returns to code via the Code button', () => {
    const htmlReply = [
      'Here is your page:',
      '',
      '```html',
      '<!DOCTYPE html>',
      '<html><head><title>Cafe Nha Go</title></head><body><h1>Xin chao</h1></body></html>',
      '```',
    ].join('\n');

    act(() => {
      root.render(<PlaygroundMessageContent content={htmlReply} />);
    });

    const previewBtn = container.querySelector('button[aria-label="Preview"]') as HTMLButtonElement | null;
    expect(previewBtn).not.toBeNull();

    act(() => {
      previewBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const dialog = document.body.querySelector('div[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Cafe Nha Go');

    const iframe = dialog?.querySelector('iframe') as HTMLIFrameElement | null;
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('sandbox')).toContain('allow-scripts');
    expect(iframe?.getAttribute('srcdoc')).toContain('<h1>Xin chao</h1>');

    const backToCodeBtn = dialog?.querySelector('button[aria-label="Code"]') as HTMLButtonElement | null;
    expect(backToCodeBtn).not.toBeNull();

    act(() => {
      backToCodeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.querySelector('div[role="dialog"]')).toBeNull();
  });

  it('does not show the Preview button for non-HTML code blocks', () => {
    const jsReply = ['```javascript', 'console.log("hello");', '```'].join('\n');

    act(() => {
      root.render(<PlaygroundMessageContent content={jsReply} />);
    });

    expect(container.querySelector('button[aria-label="Preview"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Copy"]')).not.toBeNull();
  });

  it('renders inline data:image URLs as img tags in assistant messages', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const reply = `![watermarked_img_1.png](${dataUrl})`;

    act(() => {
      root.render(<PlaygroundMessageContent content={reply} />);
    });

    const img = container.querySelector('img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(dataUrl);
    expect(img?.getAttribute('alt')).toBe('watermarked_img_1.png');
  });

  it('ignores non-function ref and unsafe HTML attributes in assistant messages without crashing React', () => {
    const reply = [
      '<div ref="card">\n  Card content\n  <button ref={btnRef} onClick="alert(1)">Copy me</button>\n  <a href="https://example.com" ref="noopener">External link</a>\n</div>',
      'Inline <span ref="inline-ref">span</span> with <wbr>wordbreak',
      'Latency is <100ms> on average.',
      '<script>window.__xss = true;</script>',
    ].join('\n\n');

    act(() => {
      root.render(<PlaygroundMessageContent content={reply} />);
    });

    expect(container.textContent).toContain('Card content');
    expect(container.querySelector('button')?.textContent).toContain('Copy me');
    const link = container.querySelector('a[href="https://example.com"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe('External link');
    expect(container.querySelector('wbr')).not.toBeNull();
    expect(container.textContent).toContain('wordbreak');
    expect(container.textContent).toContain('<100ms>');
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { __xss?: boolean }).__xss).toBeUndefined();
  });

  it('loads saved Playground history containing ref attributes in HTML without crashing', async () => {
    window.localStorage.setItem(
      'x-playground.history.1',
      JSON.stringify([
        {
          id: 'chat-ref-1',
          title: 'Saved React chat',
          model: 'auto',
          updatedAt: Date.now(),
          messages: [
            { id: 'u1', role: 'user', content: 'Show a button' },
            { id: 'a1', role: 'assistant', content: '<div ref="wrapper"><button ref={myRef}>Click</button></div>' },
          ],
        },
      ]),
    );

    try {
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
        expect(container.textContent).toContain('Saved React chat');
        expect(container.textContent).toContain('Click');
      });
    } finally {
      window.localStorage.removeItem('x-playground.history.1');
    }
  });

  it('keeps dark theme intact and does not throw removeChild when assistant returns an unfenced HTML document', () => {
    document.documentElement.classList.add('dark');
    document.body.style.background = '';

    const rawHtmlDoc = [
      '<!DOCTYPE html>',
      '<html lang="vi" class="light">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <title>Bánh Mì Nhà</title>',
      '  <style>body { background: #ffffff; }</style>',
      '</head>',
      '<body style="background: #ffffff">',
      '  <!-- ABOUT -->',
      '  <h2>❤️ Câu Chuyện Bánh Mì Nhà</h2>',
      '',
      '    <p>Nội dung bánh mì.</p>',
      '</body>',
      '</html>',
    ].join('\n');

    try {
      act(() => {
        root.render(<PlaygroundMessageContent content={rawHtmlDoc} />);
      });

      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.body.style.background).toBe('');
      expect(container.querySelector('button[aria-label="Preview"]')).not.toBeNull();

      // Navigating away unmounts PlaygroundMessageContent — must not throw NotFoundError (removeChild).
      act(() => {
        root.render(<div>Next page</div>);
      });
      expect(container.textContent).toBe('Next page');
    } finally {
      document.documentElement.classList.remove('dark');
      document.body.style.background = '';
    }
  });

  it('never renders document/executable tags or fixed overlays from raw HTML fragments', () => {
    document.documentElement.classList.add('dark');

    const fragment = [
      '<body style="background: white">',
      '<style>body { background: white !important; }</style>',
      '<div style="position: fixed; inset: 0; background: white; z-index: 9999" class="fixed inset-0 x-sidebar">Safe text</div>',
      '<svg onload="window.__svgXss = true"><script>window.__svgScript = true</script></svg>',
      '<form action="https://evil.example"><input value="secret" /></form>',
      '</body>',
    ].join('\n');

    try {
      act(() => {
        root.render(<PlaygroundMessageContent content={fragment} />);
      });

      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.body.style.background).toBe('');
      expect(container.textContent).toContain('Safe text');
      expect(container.querySelector('svg')).toBeNull();
      expect(container.querySelector('style')).toBeNull();
      expect(container.querySelector('form')).toBeNull();
      expect(container.querySelector('input')).toBeNull();
      const div = Array.from(container.querySelectorAll('.x-playground-content div')).find((el) =>
        el.textContent?.includes('Safe text'),
      );
      expect(div).toBeDefined();
      expect(div?.getAttribute('style')).toBeNull();
      expect(div?.className ?? '').not.toContain('fixed');
      expect(div?.className ?? '').not.toContain('x-sidebar');
      expect((window as unknown as { __svgXss?: boolean }).__svgXss).toBeUndefined();
      expect((window as unknown as { __svgScript?: boolean }).__svgScript).toBeUndefined();

      act(() => {
        root.render(<div>Unmounted cleanly</div>);
      });
      expect(container.textContent).toBe('Unmounted cleanly');
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });

  it('sends X-Session-Id, debounces localStorage writes during streaming, and flushes on finish', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const sseStream = new ReadableStream<Uint8Array>({
      start(c) {
        streamController = c;
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sseStream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-routed-via': 'openai/gpt-4o',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <Playground />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(container.querySelector('textarea')).not.toBeNull();
    });

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      valueSetter.call(textarea, 'Ping');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const sendBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Send'),
    ) as HTMLButtonElement;
    expect(sendBtn).toBeTruthy();

    await act(async () => {
      sendBtn.click();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchOpts = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = fetchOpts.headers as Record<string, string>;
    expect(headers['X-Session-Id']).toMatch(/^[0-9a-f-]+$/i);

    setItemSpy.mockClear();

    // Emit rapid token deltas within the debounce window
    await act(async () => {
      streamController.enqueue(
        encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n'),
      );
      await Promise.resolve();
    });
    await act(async () => {
      streamController.enqueue(
        encoder.encode('data: {"choices":[{"index":0,"delta":{"content":" world"}}]}\n\n'),
      );
      await Promise.resolve();
    });

    // Must not synchronously write localStorage on every delta
    const chatKey = historyKey(1);
    const syncHistoryWrites = setItemSpy.mock.calls.filter(([key]) => key === chatKey);
    expect(syncHistoryWrites).toHaveLength(0);

    // Finish stream -> flushes immediately
    await act(async () => {
      streamController.enqueue(encoder.encode('data: [DONE]\n\n'));
      streamController.close();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Hello world');
      expect(localStorage.getItem(chatKey)).toContain('Hello world');
    });
  });

  it('aborts hung TTFT, clears loading dots, and retries without duplicating the user turn', async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new StreamTimeoutError('ttft', 25_000))
      .mockImplementationOnce(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Recovered reply"}}]}\n\n'),
            );
            c.enqueue(encoder.encode('data: [DONE]\n\n'));
            c.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-routed-via': 'openai/gpt-4o' },
        });
      });
    vi.stubGlobal('fetch', fetchMock);

    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <Playground />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(container.querySelector('textarea')).not.toBeNull();
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      valueSetter.call(textarea, 'Explain closures');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const sendBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Send'),
    ) as HTMLButtonElement;

    await act(async () => {
      sendBtn.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('timed out');
      expect(container.textContent).not.toContain('Generating…');
      const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Retry'),
      );
      expect(retryBtn).toBeTruthy();
    });

    const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Retry'),
    ) as HTMLButtonElement;

    await act(async () => {
      retryBtn.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Recovered reply');
    });

    // User turn was not duplicated across retry
    const userTurns = container.querySelectorAll('.x-basic-user');
    expect(userTurns).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('playground stream watchdogs & session stickiness', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects with StreamTimeoutError("ttft") when no SSE data event arrives before deadline', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Only an SSE comment keepalive arrives, never a data frame
        controller.enqueue(encoder.encode(': keepalive\n\n'));
      },
    });

    const promise = readChatStream(stream, {}, { ttftTimeoutMs: 500, stallTimeoutMs: 1000 });
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'StreamTimeoutError',
      kind: 'ttft',
    });

    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it('rejects with StreamTimeoutError("stall") when mid-stream chunks stall', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n'),
        );
      },
    });

    const promise = readChatStream(stream, {}, { ttftTimeoutMs: 500, stallTimeoutMs: 800 });
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'StreamTimeoutError',
      kind: 'stall',
    });

    await vi.advanceTimersByTimeAsync(800);
    await assertion;
  });

  it('streamPlayground sends X-Session-Id header and aborts on TTFT timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const promise = streamPlayground(
      { model: 'auto', messages: [{ role: 'user', content: 'Hi' }] },
      controller.signal,
      () => {},
      undefined,
      { sessionId: 'conv-123', ttftTimeoutMs: 400, stallTimeoutMs: 800 },
    );
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'StreamTimeoutError',
      kind: 'ttft',
    });

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Session-Id']).toBe('conv-123');

    await vi.advanceTimersByTimeAsync(400);
    await assertion;
  });
});
