import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { resetTimeoutWarnings } from '../../lib/provider-timeout.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

afterEach(() => {
  delete process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS;
  resetTimeoutWarnings();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function makeProvider(timeoutMs: number): OpenAICompatProvider {
  return new OpenAICompatProvider({
    platform: 'groq',
    name: 'TestProvider',
    baseUrl: 'https://api.test.com/v1',
    timeoutMs,
  });
}

/**
 * A mocked upstream that behaves like undici: the response body stream errors
 * the moment the fetch signal aborts. Real undici ties the body to the
 * request signal; a bare `new Response(stream)` does not, so the mock has to
 * reproduce that link for the bounds to be observable at all.
 */
function mockFetch(signalAwareBody: (signal: AbortSignal | undefined) => ReadableStream<Uint8Array>): void {
  vi.spyOn(global, 'fetch').mockImplementation((async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined;
    return new Response(signalAwareBody(signal), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);
}

function abortableStream(signal: AbortSignal | undefined, enqueue: (controller: ReadableStreamDefaultController<Uint8Array>) => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal?.aborted) {
        controller.error(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', () => {
        try {
          controller.error(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
        } catch { /* already closed */ }
      }, { once: true });
      enqueue(controller);
    },
  });
}

describe('fetchWithTimeout timeoutBounds default', () => {
  it('non-streaming chat aborts a body that never finishes (default = request bounds)', async () => {
    const provider = makeProvider(100);
    // Body never yields a byte: res.json() would hang forever under the old
    // headers-only default, because the timer died when headers arrived.
    mockFetch((signal) => abortableStream(signal, () => { /* never enqueue */ }));
    const started = Date.now();
    await expect(provider.chatCompletion('k', MESSAGES, 'm')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('streaming chat is NOT cut off by the chat timeout (explicit headers bounds)', async () => {
    // Stall watchdog 10s, chat timeout 100ms: the first byte arrives at
    // 300ms — past the chat timeout, inside the first-byte grace budget
    // max(chat, stall). Under whole-request bounds the fetch signal would
    // abort at 100ms and the stream would die before its first chunk.
    vi.stubEnv('PROVIDER_STREAM_STALL_TIMEOUT_MS', '10000');
    const provider = makeProvider(100);
    const chunk = 'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    mockFetch((signal) => abortableStream(signal, (controller) => {
      const bytes = new TextEncoder().encode(chunk);
      setTimeout(() => {
        try { controller.enqueue(bytes); controller.close(); } catch { /* aborted */ }
      }, 300);
    }));
    const out: string[] = [];
    for await (const c of provider.streamChatCompletion('k', MESSAGES, 'm')) {
      out.push(c.choices?.[0]?.delta?.content ?? '');
    }
    expect(out.join('')).toBe('hello');
  });
});
