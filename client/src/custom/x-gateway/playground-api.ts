import { apiFetch, clearToken, getToken, UNAUTHORIZED_EVENT } from '@/lib/api';
import { getSessionRevision } from '../session-state';
import { readChatStream } from '@/lib/playground-stream';
import type { PlaygroundCatalog, PlaygroundRequest, PlaygroundContent } from '../../../../shared/x-playground';

export type { PlaygroundCatalog, PlaygroundRequest, PlaygroundContent };

export const loadPlaygroundModels = (signal?: AbortSignal) =>
  apiFetch<PlaygroundCatalog>('/api/x-gateway/playground/models', { signal });

export async function streamPlayground(body: PlaygroundRequest, signal: AbortSignal, onDelta: (text: string) => void) {
  const token = getToken();
  const revision = getSessionRevision();
  const assertSession = () => {
    if (revision !== getSessionRevision() || token !== getToken()) throw new DOMException('Session changed', 'AbortError');
  };
  const started = performance.now();
  const response = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/x-gateway/playground/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal,
  });
  assertSession();
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    assertSession();
    if (response.status === 401 && result?.error?.type === 'authentication_error') {
      clearToken(); window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Expected a chat stream.');
  const result = await readChatStream(response.body, { onDelta: text => { assertSession(); onDelta(text); } });
  assertSession();
  if (result.error || !result.done) throw new Error(result.error ?? 'Response interrupted. Please try again.');
  return { ...result, route: response.headers.get('x-routed-via') ?? body.model, latencyMs: Math.round(performance.now() - started) };
}
