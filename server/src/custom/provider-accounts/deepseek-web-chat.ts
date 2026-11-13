// DeepSeek Web chat over plain HTTP (port of 9Router's open-sse/executors/deepseek-web.js).
//
// chat.deepseek.com requires:
//   1. Exchanging the stored `userToken` (from localStorage) at /api/v0/users/current
//      for a short-lived Bearer access token.
//   2. Creating a chat session at /api/v0/chat_session/create.
//   3. Requesting a DeepSeekHashV1 PoW challenge at /api/v0/chat/create_pow_challenge
//      and sending the solved `X-Ds-Pow-Response` header.
//   4. Parsing DeepSeek's JSON-patch SSE format (response/fragments, p/o/v).
import type { ChatMessage, Platform } from '@freellmapi/shared/types.js';
import { contentToString } from '../../lib/content.js';
import { proxyFetch } from '../../lib/proxy.js';
import type { CompletionOptions } from '../../providers/base.js';
import { looksLikeHtmlDocument } from './cookie-format.js';
import { solveDeepSeekPowHeader, type DeepSeekPowChallenge } from './deepseek-pow.js';

const DEFAULT_BASE_URL = 'https://chat.deepseek.com';
const REQUEST_TIMEOUT_MS = 30_000;
const COMPLETION_TIMEOUT_MS = 120_000;
const CACHE_MAX_SIZE = 100;

const FAKE_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: DEFAULT_BASE_URL,
  Referer: `${DEFAULT_BASE_URL}/`,
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'X-Client-Bundle-Id': 'com.deepseek.chat',
  'X-Client-Locale': 'en-US',
  'X-Client-Platform': 'web',
  'X-Client-Version': '2.0.0',
};

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

export class DeepSeekWebChatError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DeepSeekWebChatError';
    this.status = status;
  }
}

export function deepSeekWebChatErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600
    ? status
    : undefined;
}

export function extractDeepSeekUserToken(credential: string): string {
  let raw = credential.trim();
  if (/^bearer\s+/i.test(raw)) {
    raw = raw.replace(/^bearer\s+/i, '').trim();
  }
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed?.value === 'string' && parsed.value.trim()) {
      return parsed.value.trim();
    }
    if (typeof parsed?.userToken === 'string' && parsed.userToken.trim()) {
      return parsed.userToken.trim();
    }
  } catch {
    // not JSON
  }
  const cookieMatch = raw.match(/(?:^|;\s*)userToken=([^;]+)/);
  if (cookieMatch?.[1]) return cookieMatch[1].trim();
  return raw;
}

function generateFakeCookie(): string {
  const ts = Date.now();
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const uid = () =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  return `intercom-HWWAFSESTIME=${ts}; HWWAFSESID=${hex(18)}; Hm_lvt_${uid()}=${Math.floor(ts / 1000)}; _frid=${uid()}`;
}

function resolveOrigin(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return DEFAULT_BASE_URL;
  try {
    return new URL(trimmed).origin;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function buildConversationPrompt(messages: ChatMessage[]): string {
  if (messages.length === 1) {
    return contentToString(messages[0].content);
  }
  return messages
    .map(m => {
      const text = contentToString(m.content);
      if (!text) return '';
      if (m.role === 'system') return `[System]\n${text}`;
      if (m.role === 'assistant') return `[Assistant]\n${text}`;
      if (m.role === 'tool') return `[Tool Result]\n${text}`;
      return text;
    })
    .filter(Boolean)
    .join('\n\n');
}

function isThinkingModel(modelId: string): boolean {
  const m = modelId.toLowerCase();
  return m.includes('think') || m.includes('r1') || m.includes('reason');
}

function isSearchModel(modelId: string): boolean {
  const m = modelId.toLowerCase();
  return m.includes('search') || m.includes('fold');
}

function cleanDeepSeekToken(text: string): string {
  return text.replace(/FINISHED/g, '').replace(/^(SEARCH|WEB_SEARCH|SEARCHING)\s*/i, '');
}

function formatStreamContent(raw: string, modelId: string): string {
  const text = cleanDeepSeekToken(raw);
  if (!isSearchModel(modelId)) return text;
  if (modelId.toLowerCase().includes('search-silent')) {
    return text.replace(/\[citation:(\d+)\]/g, '');
  }
  return text.replace(/\[citation:(\d+)\]/g, '[$1]');
}

interface SearchResultEntry {
  cite_index?: number;
  title?: string;
  url?: string;
}

function appendSearchCitations(searchResults: SearchResultEntry[], modelId: string): string {
  if (searchResults.length === 0 || modelId.toLowerCase().includes('search-silent')) {
    return '';
  }
  return searchResults
    .filter(r => r.cite_index)
    .sort((a, b) => (a.cite_index || 0) - (b.cite_index || 0))
    .map(r => `[${r.cite_index}]: [${r.title ?? r.url ?? 'source'}](${r.url ?? ''})`)
    .join('\n');
}

async function dsFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  platform: Platform,
  outerSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await proxyFetch(url, { ...init, signal: controller.signal }, platform, 'chat', timeoutMs);
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

async function acquireAccessToken(
  origin: string,
  userToken: string,
  platform: Platform,
  signal?: AbortSignal,
): Promise<string> {
  const cached = tokenCache.get(userToken);
  if (cached && cached.expiresAt > Math.floor(Date.now() / 1000)) {
    return cached.accessToken;
  }

  const resp = await dsFetch(
    `${origin}/api/v0/users/current`,
    {
      method: 'GET',
      headers: {
        ...FAKE_HEADERS,
        Authorization: `Bearer ${userToken}`,
      },
    },
    REQUEST_TIMEOUT_MS,
    platform,
    signal,
  );

  if (resp.status === 401 || resp.status === 403) {
    throw new DeepSeekWebChatError(
      'DeepSeek token invalid or expired — get a fresh userToken from DeepSeek localStorage.',
      resp.status,
    );
  }
  if (!resp.ok) {
    throw new DeepSeekWebChatError(`DeepSeek users/current HTTP ${resp.status}`, resp.status);
  }

  const json = (await resp.json()) as Record<string, any>;
  if (json?.code && json.code !== 0) {
    tokenCache.delete(userToken);
    const errMsg = json.msg || json?.data?.biz_msg || `error code ${json.code}`;
    throw new DeepSeekWebChatError(`DeepSeek rejected token: ${errMsg}`, 401);
  }
  const bizData = json?.data?.biz_data || json?.biz_data;
  const accessToken = bizData?.token;
  if (typeof accessToken !== 'string' || !accessToken) {
    const errMsg = json?.msg || json?.data?.biz_msg || 'Unknown error';
    throw new DeepSeekWebChatError(`DeepSeek failed to acquire access token: ${errMsg}`, 401);
  }

  if (tokenCache.size >= CACHE_MAX_SIZE) {
    const oldest = tokenCache.keys().next().value;
    if (oldest) tokenCache.delete(oldest);
  }
  tokenCache.set(userToken, {
    accessToken,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  return accessToken;
}

async function createSession(
  origin: string,
  accessToken: string,
  platform: Platform,
  signal?: AbortSignal,
): Promise<string> {
  const resp = await dsFetch(
    `${origin}/api/v0/chat_session/create`,
    {
      method: 'POST',
      headers: {
        ...FAKE_HEADERS,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        Cookie: generateFakeCookie(),
      },
      body: JSON.stringify({}),
    },
    REQUEST_TIMEOUT_MS,
    platform,
    signal,
  );

  if (!resp.ok) {
    throw new DeepSeekWebChatError(`DeepSeek chat_session/create HTTP ${resp.status}`, resp.status);
  }
  const json = (await resp.json()) as Record<string, any>;
  if (json?.code && json.code !== 0) {
    throw new DeepSeekWebChatError(
      `DeepSeek chat_session/create error ${json.code}: ${json.msg || json?.data?.biz_msg || ''}`,
      400,
    );
  }
  const bizData = json?.data?.biz_data || json?.biz_data;
  const id = bizData?.chat_session?.id;
  if (typeof id !== 'string' || !id) {
    throw new DeepSeekWebChatError('DeepSeek chat_session/create returned no session id');
  }
  return id;
}

async function deleteSession(
  origin: string,
  accessToken: string,
  sessionId: string,
  platform: Platform,
): Promise<void> {
  try {
    await dsFetch(
      `${origin}/api/v0/chat_session/delete`,
      {
        method: 'POST',
        headers: {
          ...FAKE_HEADERS,
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ chat_session_id: sessionId }),
      },
      REQUEST_TIMEOUT_MS,
      platform,
    );
  } catch {
    // best-effort cleanup
  }
}

async function requestPowChallenge(
  origin: string,
  accessToken: string,
  platform: Platform,
  signal?: AbortSignal,
): Promise<DeepSeekPowChallenge> {
  const resp = await dsFetch(
    `${origin}/api/v0/chat/create_pow_challenge`,
    {
      method: 'POST',
      headers: {
        ...FAKE_HEADERS,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
    },
    REQUEST_TIMEOUT_MS,
    platform,
    signal,
  );
  if (!resp.ok) {
    throw new DeepSeekWebChatError(`DeepSeek create_pow_challenge HTTP ${resp.status}`, resp.status);
  }
  const json = (await resp.json()) as Record<string, any>;
  const challenge = json?.data?.biz_data?.challenge ?? json?.biz_data?.challenge;
  if (!challenge || typeof challenge !== 'object') {
    throw new DeepSeekWebChatError('DeepSeek create_pow_challenge returned invalid challenge');
  }
  return { ...challenge, target_path: '/api/v0/chat/completion' } as DeepSeekPowChallenge;
}

export interface DeepSeekWebChatOptions {
  credential: string;
  messages: ChatMessage[];
  modelId: string;
  baseUrl?: string;
  platform?: Platform;
  options?: CompletionOptions;
}

export interface DeepSeekWebDelta {
  content?: string;
  reasoning_content?: string;
}

export async function* streamDeepSeekWebChat(
  opts: DeepSeekWebChatOptions,
): AsyncGenerator<DeepSeekWebDelta> {
  const userToken = extractDeepSeekUserToken(opts.credential);
  if (!userToken) {
    throw new DeepSeekWebChatError('Missing DeepSeek userToken credential.', 401);
  }

  const origin = resolveOrigin(opts.baseUrl);
  const platform = opts.platform ?? 'custom';
  const signal = opts.options?.signal;
  const timeoutMs = opts.options?.timeoutMs ?? COMPLETION_TIMEOUT_MS;

  const accessToken = await acquireAccessToken(origin, userToken, platform, signal);
  const sessionId = await createSession(origin, accessToken, platform, signal);

  try {
    const powChallenge = await requestPowChallenge(origin, accessToken, platform, signal);
    const powHeader = solveDeepSeekPowHeader(powChallenge);

    const m = opts.modelId.toLowerCase();
    const modelType = m.includes('pro') || m.includes('expert') ? 'expert' : 'default';
    const thinkingEnabled = isThinkingModel(opts.modelId) || Boolean(opts.options?.reasoning_effort);
    const searchEnabled = isSearchModel(opts.modelId);
    const prompt = buildConversationPrompt(opts.messages);

    const resp = await dsFetch(
      `${origin}/api/v0/chat/completion`,
      {
        method: 'POST',
        headers: {
          ...FAKE_HEADERS,
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Ds-Pow-Response': powHeader,
          'X-Client-Timezone-Offset': String(new Date().getTimezoneOffset() * -60),
          Cookie: generateFakeCookie(),
        },
        body: JSON.stringify({
          chat_session_id: sessionId,
          parent_message_id: null,
          model_type: modelType,
          prompt,
          ref_file_ids: [],
          thinking_enabled: thinkingEnabled,
          search_enabled: searchEnabled,
          preempt: false,
        }),
      },
      timeoutMs,
      platform,
      signal,
    );

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        tokenCache.delete(userToken);
      }
      let errMsg = `DeepSeek API error (HTTP ${resp.status})`;
      const errText = await resp.text().catch(() => '');
      try {
        const errJson = JSON.parse(errText) as Record<string, any>;
        if (errJson?.code && errJson.code !== 0) {
          errMsg = `DeepSeek error ${errJson.code}: ${errJson.msg || errJson?.data?.biz_msg || ''}`;
        }
      } catch {
        if (errText && !looksLikeHtmlDocument(errText)) {
          errMsg = `${errMsg}: ${errText.slice(0, 200)}`;
        }
      }
      throw new DeepSeekWebChatError(errMsg, resp.status);
    }

    const contentType = resp.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      throw new DeepSeekWebChatError('DeepSeek returned an HTML challenge page.', 502);
    }

    const reader = resp.body?.getReader();
    if (!reader) {
      throw new DeepSeekWebChatError('DeepSeek returned an empty response body.', 502);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let currentPath: '' | 'thinking' | 'content' = '';
    let emittedAny = false;
    const searchResults: SearchResultEntry[] = [];

    const emitText = (raw: string): DeepSeekWebDelta | null => {
      const text = formatStreamContent(raw, opts.modelId);
      if (!text) return null;
      let path = currentPath;
      if (!path && thinkingEnabled) path = 'thinking';
      else if (!path && searchEnabled) path = 'content';
      emittedAny = true;
      return path === 'thinking' ? { reasoning_content: text } : { content: text };
    };

    const handleFragment = (frag: Record<string, any>): DeepSeekWebDelta | null => {
      const type = String(frag?.type || '').toUpperCase();
      if (type === 'THINK') currentPath = 'thinking';
      else if (type === 'ANSWER' || type === 'RESPONSE') currentPath = 'content';
      if (typeof frag?.content !== 'string' || frag.content.length === 0) return null;
      return emitText(frag.content);
    };

    const processLine = (line: string): DeepSeekWebDelta[] => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return [];
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') return [];

      let data: Record<string, any>;
      try {
        data = JSON.parse(payload);
      } catch {
        return [];
      }

      if (typeof data.code === 'number' && data.code !== 0) {
        const msg = data.msg || data?.data?.biz_msg || `DeepSeek stream error ${data.code}`;
        throw new DeepSeekWebChatError(String(msg), 502);
      }

      const out: DeepSeekWebDelta[] = [];
      const p = data.p;
      const o = data.o;
      const v = data.v;

      if (v && typeof v === 'object' && !Array.isArray(v) && v.response) {
        if (v.response.thinking_enabled === true) currentPath = 'thinking';
        else if (v.response.thinking_enabled === false) currentPath = 'content';
        if (Array.isArray(v.response.fragments)) {
          for (const frag of v.response.fragments) {
            const delta = handleFragment(frag);
            if (delta) out.push(delta);
          }
        }
      }

      if (p === 'response/fragments') {
        if (Array.isArray(v)) {
          for (const frag of v) {
            const delta = handleFragment(frag);
            if (delta) out.push(delta);
          }
        } else if (v && typeof v === 'object') {
          const delta = handleFragment(v);
          if (delta) out.push(delta);
        }
      }

      if (p === 'response' && Array.isArray(v)) {
        for (const entry of v) {
          if (entry?.p === 'response' && entry?.v?.thinking_enabled === true) {
            currentPath = 'thinking';
          }
        }
      }

      if (p === 'response/search_status') return out;

      if (p === 'response/search_results' && Array.isArray(v)) {
        if (o !== 'BATCH') {
          searchResults.length = 0;
          searchResults.push(...v);
        } else {
          for (const op of v) {
            const match = String(op?.p || '').match(/^(\d+)\/cite_index$/);
            if (match) {
              const index = parseInt(match[1], 10);
              if (searchResults[index]) searchResults[index].cite_index = op.v;
            }
          }
        }
        return out;
      }

      if (typeof v === 'string') {
        const delta = emitText(v);
        if (delta) out.push(delta);
      } else if (Array.isArray(v) && p === 'response') {
        for (const entry of v) {
          if (Array.isArray(entry?.v)) {
            const joined = entry.v.map((item: any) => item?.content || '').join('');
            if (joined) {
              const delta = emitText(joined);
              if (delta) out.push(delta);
            }
          }
        }
      }

      return out;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          for (const delta of processLine(line)) {
            yield delta;
          }
        }
      }
      if (buffer.trim()) {
        for (const delta of processLine(buffer)) {
          yield delta;
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    const citations = appendSearchCitations(searchResults, opts.modelId);
    if (citations) {
      emittedAny = true;
      yield { content: `\n\n${citations}` };
    }

    if (!emittedAny) {
      throw new DeepSeekWebChatError(
        'DeepSeek Web returned an empty completion (check that userToken is valid and not expired).',
        502,
      );
    }
  } finally {
    void deleteSession(origin, accessToken, sessionId, platform);
  }
}

export async function runDeepSeekWebChat(
  opts: DeepSeekWebChatOptions,
): Promise<{ content: string; reasoning_content?: string }> {
  let content = '';
  let reasoning = '';
  for await (const delta of streamDeepSeekWebChat(opts)) {
    if (delta.content) content += delta.content;
    if (delta.reasoning_content) reasoning += delta.reasoning_content;
  }
  return {
    content,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
  };
}
