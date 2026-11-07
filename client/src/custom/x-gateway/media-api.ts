import { apiFetch, getToken } from '@/lib/api';

const base = '/api/x-gateway/media';

export type MediaKind = 'image' | 'tts' | 'stt' | 'embedding';

export interface MediaProviderItem {
  id: string;
  name: string;
  alias: string;
  category?: string;
  connectedAccounts: number;
  isConnected: boolean;
  models: { id: string; name: string }[];
}

export interface MediaKindSpec {
  label: string;
  endpoint: string;
  defaultProviders: string[];
  suggestedModels: string[];
  providers: MediaProviderItem[];
  sizes?: string[];
  voices?: string[];
  formats?: string[];
  suggestedDimensions?: number[];
}

export interface MediaDefaults {
  image?: { defaultModel?: string };
  tts?: { defaultModel?: string; defaultVoice?: string; defaultFormat?: string };
  stt?: { defaultModel?: string; defaultLanguage?: string };
  embedding?: { defaultModel?: string; defaultDimensions?: number | null };
}

export interface MediaConfigResponse {
  defaults: MediaDefaults;
  kinds: Record<MediaKind, MediaKindSpec>;
}

export interface ImageTestResult {
  ok: boolean;
  data: Array<{ url?: string; b64_json?: string }>;
  provider: string;
  accountLabel?: string;
  model: string;
  latencyMs: number;
}

export interface TtsTestResult {
  ok: boolean;
  audioBase64: string;
  contentType: string;
  provider: string;
  accountLabel?: string;
  model: string;
  latencyMs: number;
}

export interface SttTestResult {
  ok: boolean;
  text: string;
  raw?: Record<string, unknown>;
  provider: string;
  accountLabel?: string;
  model: string;
  latencyMs: number;
}

export interface EmbeddingTestResult {
  ok: boolean;
  dimensions: number;
  embeddingSample: number[];
  usage: { prompt_tokens?: number; total_tokens?: number } | null;
  provider: string;
  accountLabel?: string;
  model: string;
  latencyMs: number;
}

export const mediaApi = {
  getConfig: (signal?: AbortSignal) =>
    apiFetch<MediaConfigResponse>(`${base}/config`, { signal }),

  saveConfig: (body: MediaDefaults) =>
    apiFetch<{ ok: true; defaults: MediaDefaults }>(`${base}/config`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  testImage: (body: { model?: string; prompt: string; size?: string; n?: number }) =>
    apiFetch<ImageTestResult>(`${base}/test/image`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  testTts: (body: { model?: string; input: string; voice?: string; speed?: number; response_format?: string }) =>
    apiFetch<TtsTestResult>(`${base}/test/tts`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  testStt: async (form: FormData): Promise<SttTestResult> => {
    const token = getToken();
    const res = await fetch(`${base}/test/stt`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  testEmbedding: (body: { model?: string; input: string; dimensions?: number }) =>
    apiFetch<EmbeddingTestResult>(`${base}/test/embedding`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

