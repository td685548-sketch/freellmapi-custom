import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';

/**
 * First-content peek and stream reconstruction (9Router `peekStreamForContent` / `reconstructStream` pattern).
 *
 * Buffers head chunks until the upstream emits actual client-visible output (`delta.content` or
 * `delta.tool_calls`), enforcing a tight TTFT deadline when fallback candidates exist. If the
 * stream closes empty or times out before emitting content, the caller can fail over cleanly
 * before committing SSE response headers.
 */

export const DEFAULT_AUTO_STREAM_PEEK_TIMEOUT_MS = 7_000;
export const DEFAULT_WEB_COOKIE_STREAM_PEEK_TIMEOUT_MS = 25_000;

let autoStreamPeekTimeoutOverrideMs: number | null = null;

export function getAutoStreamPeekTimeoutMs(options?: { webCookie?: boolean }): number {
  if (autoStreamPeekTimeoutOverrideMs !== null) {
    return autoStreamPeekTimeoutOverrideMs;
  }
  return options?.webCookie
    ? DEFAULT_WEB_COOKIE_STREAM_PEEK_TIMEOUT_MS
    : DEFAULT_AUTO_STREAM_PEEK_TIMEOUT_MS;
}

export function setAutoStreamPeekTimeoutMs(ms: number | null): void {
  autoStreamPeekTimeoutOverrideMs = ms !== null && Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : null;
}

export class EmptyStreamError extends Error {
  constructor(message = 'Provider returned an empty stream.') {
    super(message);
    this.name = 'EmptyStreamError';
  }
}

export class StreamPeekTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider stream timed out after ${timeoutMs}ms waiting for first content.`);
    this.name = 'StreamPeekTimeoutError';
  }
}

export interface StreamPeekResult {
  headChunks: ChatCompletionChunk[];
  iterator: AsyncIterator<ChatCompletionChunk>;
  hasMore: boolean;
}

export function chunkHasClientContent(chunk: ChatCompletionChunk): boolean {
  if (!Array.isArray(chunk?.choices)) return false;
  for (const choice of chunk.choices) {
    const delta = choice?.delta;
    if (typeof delta?.content === 'string' && delta.content.length > 0) return true;
    if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) return true;
    if (choice?.finish_reason === 'content_filter') return true;
  }
  return false;
}

export function chunkHasReasoningContent(chunk: ChatCompletionChunk): boolean {
  if (!Array.isArray(chunk?.choices)) return false;
  return chunk.choices.some(choice =>
    typeof choice?.delta?.reasoning_content === 'string' && choice.delta.reasoning_content.length > 0,
  );
}

async function readNextWithDeadline(
  iterator: AsyncIterator<ChatCompletionChunk>,
  deadlineMs: number | null,
  signal?: AbortSignal,
  onTimeout?: () => void,
  timeoutBudgetMs?: number,
): Promise<IteratorResult<ChatCompletionChunk>> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Request aborted');
  }
  const nextPromise = iterator.next();
  const racers: Array<Promise<IteratorResult<ChatCompletionChunk>>> = [nextPromise];

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  if (deadlineMs !== null) {
    const remaining = Math.max(1, deadlineMs - Date.now());
    racers.push(new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new StreamPeekTimeoutError(timeoutBudgetMs ?? remaining));
      }, remaining);
    }));
  }

  if (signal) {
    racers.push(new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }));
  }

  try {
    return await Promise.race(racers);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export async function peekStreamForContent(
  stream: AsyncIterable<ChatCompletionChunk>,
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    allowReasoningOnlyOnClose?: boolean;
    onTimeout?: () => void;
  },
): Promise<StreamPeekResult> {
  const iterator = stream[Symbol.asyncIterator]();
  const headChunks: ChatCompletionChunk[] = [];
  const timeoutMs = options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 0;
  let deadlineMs = timeoutMs > 0 ? Date.now() + timeoutMs : null;
  let sawReasoning = false;

  try {
    while (true) {
      const step = await readNextWithDeadline(
        iterator,
        deadlineMs,
        options?.signal,
        options?.onTimeout,
        timeoutMs,
      );
      if (step.done) {
        if (options?.allowReasoningOnlyOnClose && sawReasoning && headChunks.length > 0) {
          return { headChunks, iterator, hasMore: false };
        }
        throw new EmptyStreamError('Provider returned an empty stream.');
      }
      const chunk = step.value;
      headChunks.push(chunk);
      if (chunkHasReasoningContent(chunk)) {
        sawReasoning = true;
        // Active thinking/reasoning progress extends the first-content peek window
        // so reasoning models do not falsely time out before emitting answer content.
        if (timeoutMs > 0) {
          deadlineMs = Date.now() + timeoutMs;
        }
      }
      if (chunkHasClientContent(chunk)) {
        return { headChunks, iterator, hasMore: true };
      }
    }
  } catch (err) {
    await iterator.return?.().catch(() => {});
    throw err;
  }
}

export async function* reconstructStream(peek: StreamPeekResult): AsyncGenerator<ChatCompletionChunk> {
  try {
    for (const chunk of peek.headChunks) {
      yield chunk;
    }
    if (!peek.hasMore) return;
    while (true) {
      const step = await peek.iterator.next();
      if (step.done) break;
      yield step.value;
    }
  } finally {
    await peek.iterator.return?.().catch(() => {});
  }
}
