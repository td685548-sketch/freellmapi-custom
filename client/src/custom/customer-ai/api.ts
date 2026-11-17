import { apiFetch } from '@/lib/api';
import type {
  AdminAiAssistant,
  AdminAnomalyRadarReport,
  AssistantAudience,
  AssistantCategory,
  CustomerAiAssistant,
  CustomerQuotaCoachReport,
  KeyRoutingMode,
  UserAiPreferences,
} from '../../../../shared/customer-ai';

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

export function patchUserKeyAiConfig(
  keyId: number,
  patch: { routingMode?: KeyRoutingMode; assistantId?: number | null },
): Promise<{
  key: {
    id: number;
    routingMode: KeyRoutingMode;
    assistantId: number | null;
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

export interface AssistantChatResponse {
  reply: string;
  model: string | null;
  routingMode: KeyRoutingMode;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export function postAssistantChat(
  slug: string,
  body: {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    routingMode?: KeyRoutingMode;
    maxTokens?: number;
  },
): Promise<AssistantChatResponse> {
  return apiFetch(`/api/user/ai-hub/assistants/${encodeURIComponent(slug)}/chat`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
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
