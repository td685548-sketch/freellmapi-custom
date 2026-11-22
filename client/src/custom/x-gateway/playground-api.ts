import { apiFetch, clearToken, getToken, UNAUTHORIZED_EVENT } from '@/lib/api';
import { getSessionRevision } from '../session-state';
import { readChatStream, StreamTimeoutError } from '@/lib/playground-stream';
import type { PlaygroundCatalog, PlaygroundRequest, PlaygroundContent } from '../../../../shared/x-playground';

export type { PlaygroundCatalog, PlaygroundRequest, PlaygroundContent };
export { StreamTimeoutError };

export const PLAYGROUND_TTFT_TIMEOUT_MS = 25_000;
export const PLAYGROUND_STALL_TIMEOUT_MS = 30_000;

export interface StreamPlaygroundOptions {
  /** Conversation ID sent as `X-Session-Id` so gateway auto routing can stick to a healthy route. */
  sessionId?: string;
  ttftTimeoutMs?: number;
  stallTimeoutMs?: number;
}

export const loadPlaygroundModels = (signal?: AbortSignal) =>
  apiFetch<PlaygroundCatalog>('/api/thruline/playground/models', { signal });

export async function streamPlayground(
  body: PlaygroundRequest,
  signal: AbortSignal,
  onDelta: (text: string) => void,
  onReasoning?: (text: string) => void,
  options: StreamPlaygroundOptions = {},
) {
  const token = getToken();
  const revision = getSessionRevision();
  const assertSession = () => {
    if (revision !== getSessionRevision() || token !== getToken()) throw new DOMException('Session changed', 'AbortError');
  };
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
  }

  const ttftTimeoutMs = options.ttftTimeoutMs ?? PLAYGROUND_TTFT_TIMEOUT_MS;
  const stallTimeoutMs = options.stallTimeoutMs ?? PLAYGROUND_STALL_TIMEOUT_MS;
  const streamController = new AbortController();
  let timedOutError: StreamTimeoutError | null = null;
  const onExternalAbort = () => {
    streamController.abort(signal.reason);
  };
  signal.addEventListener('abort', onExternalAbort, { once: true });

  const started = performance.now();
  let ttftTimer: ReturnType<typeof setTimeout> | null = null;
  const clearTtftTimer = () => {
    if (ttftTimer !== null) {
      clearTimeout(ttftTimer);
      ttftTimer = null;
    }
  };
  if (ttftTimeoutMs > 0) {
    ttftTimer = setTimeout(() => {
      timedOutError = new StreamTimeoutError('ttft', ttftTimeoutMs);
      streamController.abort(timedOutError);
    }, ttftTimeoutMs);
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.sessionId ? { 'X-Session-Id': options.sessionId } : {}),
    };
    const response = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/thruline/playground/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: streamController.signal,
      // Phase 1 of the httpOnly-cookie move: send the session cookie.
      credentials: 'same-origin',
    });
    assertSession();
    if (!response.ok) {
      clearTtftTimer();
      const result = await response.json().catch(() => null);
      assertSession();
      if (response.status === 401 && result?.error?.type === 'authentication_error') {
        clearToken(); window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
      }
      throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      clearTtftTimer();
      throw new Error('Expected a chat stream.');
    }

    // Hand the remaining TTFT budget to the SSE reader so fetch + first-event wait share one deadline.
    clearTtftTimer();
    const elapsedBeforeStream = Math.round(performance.now() - started);
    const remainingTtftMs = ttftTimeoutMs > 0 ? Math.max(1, ttftTimeoutMs - elapsedBeforeStream) : 0;

    const result = await readChatStream(
      response.body,
      {
        onDelta: text => { assertSession(); onDelta(text); },
        onReasoning: onReasoning ? text => { assertSession(); onReasoning(text); } : undefined,
      },
      {
        signal: streamController.signal,
        ttftTimeoutMs: remainingTtftMs > 0 ? remainingTtftMs : undefined,
        stallTimeoutMs,
      },
    );
    assertSession();
    if (result.error || !result.done) throw new Error(result.error ?? 'Response interrupted. Please try again.');
    return { ...result, route: response.headers.get('x-routed-via') ?? body.model, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    if (timedOutError) throw timedOutError;
    if (err instanceof StreamTimeoutError && err.kind === 'ttft' && ttftTimeoutMs > 0) {
      throw new StreamTimeoutError('ttft', ttftTimeoutMs);
    }
    throw err;
  } finally {
    clearTtftTimer();
    signal.removeEventListener('abort', onExternalAbort);
  }
}
