// ChatGPT Web chat over plain HTTP (port of 9Router's chatHttp.js).
//
// The stored cookie alone is not accepted by /backend-api. The browser exchanges
// it for an access token, solves Sentinel, calls `/f/conversation/prepare` and
// only then opens the `/f/conversation` SSE. That SSE also closes before the turn
// is finished, so the conversation document has to be polled until
// `metadata.is_complete` — doing otherwise truncates long answers.
//
// Tool calling is not ported here: 9Router routes it through the shared `<tool>`
// prompt contract (translator/webTools.js). Without it ChatGPT answers in prose.
import { randomUUID } from 'node:crypto';
import type { ChatMessage, Platform } from '@freellmapi/shared/types.js';
import { contentToString } from '../../lib/content.js';
import { proxyFetch } from '../../lib/proxy.js';
import {
  fetchChatGptWebAccessToken,
  fetchSentinelHeaders,
  normalizeChatGptWebCookie,
} from './chatgpt-web-image.js';
import { looksLikeHtmlDocument } from './cookie-format.js';

const DEFAULT_BASE_URL = 'https://chatgpt.com';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PREPARE_TIMEOUT_MS = 60_000;
const CONVERSATION_TIMEOUT_MS = 120_000;
const SSE_READ_DEADLINE_MS = 135_000;
const MAX_SSE_BYTES = 16 * 1024 * 1024;
const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 180_000;
const POLL_REQUEST_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class ChatGptWebChatError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ChatGptWebChatError';
    this.status = status;
  }
}

/** Upstream HTTP status carried by a chatgpt-web chat failure, if any. */
export function chatGptWebChatErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600
    ? status
    : undefined;
}

export interface ChatGptWebChatOptions {
  /** Stored account credential: cookie header, bare session token, or storage-state JSON. */
  credential: string;
  messages: ChatMessage[];
  baseUrl?: string;
  platform?: Platform;
  userAgent?: string;
  signal?: AbortSignal;
}

/** proxyFetch plus a timeout, with auth redirects reported as expired sessions. */
async function chatFetch(
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
  } catch (err) {
    // A signed-out session redirects to /auth/login; `custom` accounts never
    // follow redirects, so translate that into an auth failure.
    if (err instanceof Error && /upstream redirected/i.test(err.message)) {
      throw new ChatGptWebChatError('ChatGPT Web session expired (auth redirect)', 401);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

async function readJsonResponse(res: Response, label: string): Promise<Record<string, any>> {
  const text = await res.text().catch(() => '');
  if (looksLikeHtmlDocument(text)) {
    throw new ChatGptWebChatError(
      `ChatGPT ${label} returned an HTML challenge page (Cloudflare/Turnstile); refresh the web session cookie`,
      403,
    );
  }
  if (!res.ok) {
    throw new ChatGptWebChatError(
      `ChatGPT ${label} failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
      res.status || 502,
    );
  }
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw new ChatGptWebChatError(`ChatGPT ${label} returned invalid JSON`, 502);
  }
}

/** Flatten OpenAI messages into the single prompt turn the web app understands. */
function flattenMessages(messages: ChatMessage[]): string {
  const systemLines: string[] = [];
  const lines: string[] = [];

  for (const message of messages) {
    const parts: string[] = [];
    const text = contentToString(message.content);
    if (text) parts.push(text);

    for (const call of message.tool_calls ?? []) {
      const name = call.function?.name;
      if (!name) continue;
      let args: unknown = call.function.arguments;
      try {
        args = typeof args === 'string' ? JSON.parse(args) : args;
      } catch {
        // Keep the raw string when it is not JSON.
      }
      parts.push(`<tool>${JSON.stringify({ name, arguments: args })}</tool>`);
    }

    const joined = parts.join('\n').trim();
    if (!joined) continue;
    if (message.role === 'system') systemLines.push(joined);
    else if (message.role === 'tool') {
      lines.push(`Tool result${message.tool_call_id ? ` (${message.tool_call_id})` : ''}: ${joined}`);
    } else if (message.role === 'assistant') lines.push(`Assistant: ${joined}`);
    else lines.push(joined);
  }

  // System first: the client-tool contract loses authority when it trails the
  // conversation and the model answers in prose instead.
  return [...systemLines, ...lines].join('\n\n');
}

/** Read the SSE body up to a byte cap / deadline; partial text is expected. */
async function readSseText(response: Response, signal?: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      text += decoder.decode(value, { stream: true });
      if (text.length > MAX_SSE_BYTES) break;
    }
  } catch {
    // A deadline abort lands here — the partial text is what we want.
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

/** Text of a finished assistant turn, or null while the turn is still running. */
function finishedAssistantText(document: Record<string, any>): { text: string; errorText: string } | null {
  const mapping = document?.mapping as Record<string, any> | undefined;
  let text = '';
  let complete = false;
  let errorText = '';

  for (const node of Object.values(mapping ?? {})) {
    const message = node?.message;
    if (!message) continue;
    const role = String(message.author?.role ?? '').toLowerCase();
    if (role !== 'assistant') continue;
    if (message.metadata?.is_complete === true) complete = true;
    if (message.content?.content_type === 'text') {
      const parts = Array.isArray(message.content.parts) ? message.content.parts : [];
      text += parts.filter((part: unknown): part is string => typeof part === 'string').join('');
    }
    if (message.metadata?.is_error) {
      const parts = Array.isArray(message.content?.parts) ? message.content.parts : [];
      const joined = parts.filter((part: unknown): part is string => typeof part === 'string').join('');
      if (joined) errorText = joined;
    }
  }

  return complete ? { text, errorText } : null;
}

/**
 * Run one chat turn over HTTP: session -> Sentinel -> prepare -> conversation
 * SSE -> poll until `is_complete`.
 */
export async function runChatGptWebChat(opts: ChatGptWebChatOptions): Promise<string> {
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  if (messages.length === 0) throw new ChatGptWebChatError('ChatGPT Web requires messages', 400);

  const prompt = flattenMessages(messages);
  if (!prompt.trim()) throw new ChatGptWebChatError('ChatGPT Web requires non-empty text', 400);

  const baseUrl = (opts.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const userAgent = opts.userAgent?.trim() || DEFAULT_USER_AGENT;
  const platform: Platform = opts.platform ?? 'custom';
  const cookie = normalizeChatGptWebCookie(opts.credential);

  const accessToken = await fetchChatGptWebAccessToken(cookie, userAgent, baseUrl, platform, opts.signal);
  if (opts.signal?.aborted) throw new ChatGptWebChatError('Request aborted', 499);

  const sentinel = await fetchSentinelHeaders({ baseUrl, accessToken, userAgent, platform, signal: opts.signal });
  const headers: Record<string, string> = {
    ...sentinel,
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': userAgent,
    ...(cookie ? { Cookie: cookie } : {}),
    'Content-Type': 'application/json',
  };

  const parentMessageId = randomUUID();
  const prepare = await chatFetch(
    `${baseUrl}/backend-api/f/conversation/prepare`,
    {
      method: 'POST',
      headers: { ...headers, Accept: 'application/json' },
      body: JSON.stringify({
        action: 'next',
        parent_message_id: parentMessageId,
        model: 'auto',
        client_prepare_state: 'success',
        timezone_offset_min: 0,
        timezone: 'UTC',
        conversation_mode: { kind: 'primary_assistant' },
        partial_query: {
          id: randomUUID(),
          author: { role: 'user' },
          content: { content_type: 'text', parts: [prompt] },
        },
        supports_buffering: true,
        supported_encodings: ['v1'],
        client_contextual_info: { app_name: 'chatgpt.com' },
      }),
    },
    PREPARE_TIMEOUT_MS,
    platform,
    opts.signal,
  );
  const prepared = await readJsonResponse(prepare, 'prepare');

  const turnSignal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(SSE_READ_DEADLINE_MS)])
    : AbortSignal.timeout(SSE_READ_DEADLINE_MS);

  const conversation = await chatFetch(
    `${baseUrl}/backend-api/f/conversation`,
    {
      method: 'POST',
      headers: {
        ...headers,
        Accept: 'text/event-stream',
        'X-Conduit-Token': typeof prepared.conduit_token === 'string' ? prepared.conduit_token : '',
        'X-Oai-Turn-Trace-Id': randomUUID(),
      },
      body: JSON.stringify({
        action: 'next',
        messages: [{
          id: randomUUID(),
          author: { role: 'user' },
          create_time: Date.now() / 1000,
          content: { content_type: 'text', parts: [prompt] },
          metadata: { serialization_metadata: { custom_symbol_offsets: [] } },
        }],
        parent_message_id: parentMessageId,
        model: 'auto',
        client_prepare_state: 'sent',
        timezone_offset_min: 0,
        timezone: 'UTC',
        conversation_mode: { kind: 'primary_assistant' },
        enable_message_followups: true,
        supports_buffering: true,
        supported_encodings: ['v1'],
        client_contextual_info: { app_name: 'chatgpt.com' },
        force_parallel_switch: 'auto',
      }),
    },
    CONVERSATION_TIMEOUT_MS,
    platform,
    turnSignal,
  );

  if (!conversation.ok) {
    const detail = (await conversation.text().catch(() => '')).slice(0, 200);
    throw new ChatGptWebChatError(
      `ChatGPT conversation failed (HTTP ${conversation.status})${detail ? `: ${detail}` : ''}`,
      conversation.status || 502,
    );
  }

  const sseText = await readSseText(conversation, turnSignal);
  if (looksLikeHtmlDocument(sseText)) {
    throw new ChatGptWebChatError(
      'ChatGPT conversation returned an HTML challenge page (Cloudflare/Turnstile); refresh the web session cookie',
      403,
    );
  }

  const conversationId = (sseText.match(/"conversation_id"\s*:\s*"([0-9a-f-]{36})"/) || [])[1] || '';
  if (!conversationId) {
    throw new ChatGptWebChatError('ChatGPT conversation produced no conversation id', 502);
  }

  const started = Date.now();
  while (Date.now() - started <= POLL_TIMEOUT_MS) {
    if (opts.signal?.aborted) throw new ChatGptWebChatError('Request aborted', 499);

    let res: Response | null = null;
    try {
      res = await chatFetch(
        `${baseUrl}/backend-api/conversation/${conversationId}`,
        { headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': userAgent, Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) } },
        POLL_REQUEST_TIMEOUT_MS,
        platform,
        opts.signal,
      );
    } catch (err) {
      // Poll failures are transient; only an auth redirect is terminal.
      if (chatGptWebChatErrorStatus(err) === 401) throw err;
    }

    if (res?.ok) {
      if ((res.headers.get('content-type') ?? '').includes('text/html')) {
        throw new ChatGptWebChatError(
          'ChatGPT conversation poll returned an HTML challenge page; refresh the web session cookie',
          403,
        );
      }
      const document = await res.json().catch(() => null) as Record<string, any> | null;
      const finished = document ? finishedAssistantText(document) : null;
      if (finished) {
        if (!finished.text.trim() && finished.errorText) {
          throw new ChatGptWebChatError(`ChatGPT refused the turn: ${finished.errorText.slice(0, 200)}`, 400);
        }
        return finished.text;
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new ChatGptWebChatError('ChatGPT chat turn timed out', 504);
}
