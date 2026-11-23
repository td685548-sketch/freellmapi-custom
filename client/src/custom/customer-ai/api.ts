import { apiFetch, csrfHeaders, UNAUTHORIZED_EVENT } from '@/lib/api';
import { notifySessionChanged } from '../session-state';
import type {
  AdminAiAssistant,
  AdminAnomalyRadarReport,
  AssistantAudience,
  AssistantCategory,
  AssistantThreadDetail,
  AssistantThreadMessage,
  AssistantThreadSummary,
  CustomerAiAssistant,
  CustomerQuotaCoachReport,
  KeyRoutingMode,
  UserAiPreferences,
  UserCustomAssistant,
  UserCustomAssistantInput,
  UserKeyCustomBinding,
} from '../../../../shared/customer-ai';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export function fetchCustomerAssistants(): Promise<{ assistants: CustomerAiAssistant[] }> {
  return apiFetch('/api/user/ai-hub/catalog');
}

export function fetchUserAiPreferences(): Promise<{ preferences: UserAiPreferences }> {
  return apiFetch('/api/user/ai-hub/preferences');
}

export function putUserAiPreferences(body: {
  customInstructions: string;
  applyCustomInstructionsToKeys: boolean;
}): Promise<{ preferences: UserAiPreferences }> {
  return apiFetch('/api/user/ai-hub/preferences', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function fetchCustomerQuotaCoach(days = 14): Promise<{ report: CustomerQuotaCoachReport }> {
  return apiFetch(`/api/user/ai-hub/coach?days=${days}`);
}

export function fetchUserKeyCustomBindings(): Promise<{ bindings: UserKeyCustomBinding[] }> {
  return apiFetch('/api/user/ai-hub/key-bindings');
}

export function patchUserKeyAiConfig(
  keyId: number,
  patch: {
    routingMode?: KeyRoutingMode;
    assistantId?: number | string | null;
    userAssistantId?: number | null;
    assistantRef?: string | null;
  },
): Promise<{
  key: {
    id: number;
    routingMode: KeyRoutingMode;
    assistantId: number | null;
    userAssistantId?: number | null;
    assistantRef?: string | null;
    assistantSlug: string | null;
    assistantName: string | null;
  };
}> {
  return apiFetch(`/api/user/ai-hub/keys/${keyId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function postApplyEcoToKeys(keyId?: number): Promise<{ updatedCount: number }> {
  return apiFetch('/api/user/ai-hub/keys/apply-eco', {
    method: 'POST',
    body: JSON.stringify(keyId !== undefined ? { keyId } : {}),
  });
}

// ─── User-Created Custom Assistants ──────────────────────────────────────────

export function fetchUserCustomAssistants(): Promise<{ assistants: UserCustomAssistant[] }> {
  return apiFetch('/api/user/ai-hub/custom-assistants');
}

export function postCreateUserCustomAssistant(
  body: UserCustomAssistantInput,
): Promise<{ assistant: UserCustomAssistant }> {
  return apiFetch('/api/user/ai-hub/custom-assistants', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function patchUpdateUserCustomAssistant(
  id: number,
  body: Partial<UserCustomAssistantInput>,
): Promise<{ assistant: UserCustomAssistant }> {
  return apiFetch(`/api/user/ai-hub/custom-assistants/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteUserCustomAssistantApi(id: number): Promise<{ success: boolean }> {
  return apiFetch(`/api/user/ai-hub/custom-assistants/${id}`, {
    method: 'DELETE',
  });
}

// ─── Persistent Threads & Branching ──────────────────────────────────────────

export function fetchAssistantThreads(assistantRef?: string): Promise<{ threads: AssistantThreadSummary[] }> {
  const qs = assistantRef ? `?assistantRef=${encodeURIComponent(assistantRef)}` : '';
  return apiFetch(`/api/user/ai-hub/threads${qs}`);
}

export function postCreateAssistantThread(body: {
  assistantRef: string;
  title?: string;
  routingMode?: KeyRoutingMode;
}): Promise<{ thread: AssistantThreadDetail }> {
  return apiFetch('/api/user/ai-hub/threads', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function fetchAssistantThreadDetail(threadId: number): Promise<{ thread: AssistantThreadDetail }> {
  return apiFetch(`/api/user/ai-hub/threads/${threadId}`);
}

export function patchAssistantThread(
  threadId: number,
  body: { title?: string; routingMode?: KeyRoutingMode },
): Promise<{ thread: AssistantThreadSummary }> {
  return apiFetch(`/api/user/ai-hub/threads/${threadId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteAssistantThreadApi(threadId: number): Promise<{ success: boolean }> {
  return apiFetch(`/api/user/ai-hub/threads/${threadId}`, {
    method: 'DELETE',
  });
}

export function postBranchAssistantThread(
  threadId: number,
  body: { fromMessageIndex?: number; fromMessageId?: number; title?: string },
): Promise<{ thread: AssistantThreadDetail }> {
  return apiFetch(`/api/user/ai-hub/threads/${threadId}/branch`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ─── Assistant Chat & SSE Streaming ──────────────────────────────────────────

export interface AssistantChatResponse {
  reply: string;
  model: string | null;
  routingMode: KeyRoutingMode;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  threadId?: number | null;
  thread?: AssistantThreadSummary | null;
  userMessage?: AssistantThreadMessage | null;
  assistantMessage?: AssistantThreadMessage | null;
}

export function postAssistantChat(
  slug: string,
  body: {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    routingMode?: KeyRoutingMode;
    maxTokens?: number;
    threadId?: number;
  },
): Promise<AssistantChatResponse> {
  return apiFetch(`/api/user/ai-hub/assistants/${encodeURIComponent(slug)}/chat`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface StreamAssistantChatCallbacks {
  onMeta?: (meta: { threadId: number | null; assistantRef: string; routingMode: KeyRoutingMode }) => void;
  onDelta?: (delta: string) => void;
}

export async function streamAssistantChat(
  body: {
    assistantRef?: string;
    threadId?: number;
    createThread?: boolean;
    threadTitle?: string;
    message?: string;
    messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    routingMode?: KeyRoutingMode;
    maxTokens?: number;
  },
  callbacks?: StreamAssistantChatCallbacks,
  signal?: AbortSignal,
): Promise<AssistantChatResponse> {
  // Phase 2: cookie auth for the mutation needs the CSRF token.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
    ...csrfHeaders(),
  };

  const res = await fetch(`${BASE}/api/user/ai-hub/chat/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
    credentials: 'same-origin',
  });

  if (!res.ok) {
    const errPayload = (await res.json().catch(() => null)) as {
      error?: string | { message?: string; type?: string };
    } | null;
    if (
      res.status === 401 &&
      typeof errPayload?.error === 'object' &&
      errPayload?.error?.type === 'authentication_error'
    ) {
      notifySessionChanged();
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    const message =
      typeof errPayload?.error === 'string'
        ? errPayload.error
        : errPayload?.error?.message || `HTTP ${res.status}`;
    throw new Error(message);
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('text/event-stream') || !res.body) {
    const json = (await res.json()) as AssistantChatResponse;
    if (json.reply) callbacks?.onDelta?.(json.reply);
    return json;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = 'message';
  let accumulatedReply = '';
  let finalDone: AssistantChatResponse | null = null;
  let streamError: string | null = null;

  const handleEventBlock = (rawBlock: string) => {
    const lines = rawBlock.split('\n');
    let eventName = currentEvent;
    const dataLines: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    currentEvent = 'message';

    if (dataLines.length === 0) return;
    const joined = dataLines.join('\n').trim();
    if (!joined || joined === '[DONE]') return;

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(joined) as Record<string, unknown>;
    } catch {
      return;
    }

    if (eventName === 'meta' && parsed) {
      callbacks?.onMeta?.({
        threadId: typeof parsed.threadId === 'number' ? parsed.threadId : null,
        assistantRef: typeof parsed.assistantRef === 'string' ? parsed.assistantRef : '',
        routingMode: (parsed.routingMode as KeyRoutingMode) ?? 'balanced',
      });
    } else if (eventName === 'delta' && parsed) {
      const piece = typeof parsed.delta === 'string' ? parsed.delta : '';
      if (piece) {
        accumulatedReply += piece;
        callbacks?.onDelta?.(piece);
      }
    } else if (eventName === 'error' && parsed) {
      streamError = typeof parsed.message === 'string' ? parsed.message : 'Assistant stream failed';
    } else if (eventName === 'done' && parsed) {
      finalDone = parsed as unknown as AssistantChatResponse;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      if (block.trim()) handleEventBlock(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const block of buffer.split(/\r?\n\r?\n/)) {
      if (block.trim()) handleEventBlock(block);
    }
  }

  if (streamError && !accumulatedReply && !finalDone) {
    throw new Error(streamError);
  }

  if (finalDone) return finalDone;

  return {
    reply: accumulatedReply,
    model: null,
    routingMode: body.routingMode ?? 'balanced',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

// ─── Admin APIs (/api/ai-platform/*) ─────────────────────────────────────────

export function fetchAdminAssistants(): Promise<{ assistants: AdminAiAssistant[] }> {
  return apiFetch('/api/ai-platform/customer-assistants');
}

export interface AdminAssistantPayload {
  slug: string;
  name: string;
  description?: string;
  category?: AssistantCategory;
  icon?: string;
  systemPrompt: string;
  recommendedRoutingMode?: KeyRoutingMode;
  starterPrompts?: string[];
  audience?: AssistantAudience;
  enabled?: boolean;
  sortOrder?: number;
}

export function postCreateAdminAssistant(body: AdminAssistantPayload): Promise<{ assistant: AdminAiAssistant }> {
  return apiFetch('/api/ai-platform/customer-assistants', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function patchUpdateAdminAssistant(
  id: number,
  body: Partial<AdminAssistantPayload>,
): Promise<{ assistant: AdminAiAssistant }> {
  return apiFetch(`/api/ai-platform/customer-assistants/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteAdminAssistant(id: number): Promise<{ success: boolean }> {
  return apiFetch(`/api/ai-platform/customer-assistants/${id}`, {
    method: 'DELETE',
  });
}

export function fetchAdminAnomalyRadar(hours = 24): Promise<{ report: AdminAnomalyRadarReport }> {
  return apiFetch(`/api/ai-platform/anomaly-radar?hours=${hours}`);
}

export function postAdminApplyEcoForUser(userId: number): Promise<{ updatedCount: number }> {
  return apiFetch(`/api/ai-platform/anomaly-radar/users/${userId}/apply-eco`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
