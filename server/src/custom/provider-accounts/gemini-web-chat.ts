// Gemini Web chat over plain HTTP (`gemini.google.com`).
//
// gemini.google.com requires:
//   1. Fetching the `/app` page with the user's Google session cookies
//      (`__Secure-1PSID`, `__Secure-1PSIDTS`, etc.) to extract `SNlM0e` (CSRF `at` token),
//      `cfb2h` (build label `bl`), and `FdrFJe` (`f.sid`).
//   2. Posting a `StreamGenerate` RPC to `/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`
//      with `rt=c` and `f.req` form-encoded.
//   3. Parsing the `)]}'` batchexecute length-prefixed JSON frames (`wrb.fr`) and
//      emitting incremental text deltas from cumulative candidate responses.
import type { ChatMessage, Platform } from '@freellmapi/shared/types.js';
import { contentToString } from '../../lib/content.js';
import { proxyFetch } from '../../lib/proxy.js';
import type { CompletionOptions } from '../../providers/base.js';
import { looksLikeCookieHeader, looksLikeHtmlDocument } from './cookie-format.js';

const DEFAULT_BASE_URL = 'https://gemini.google.com';
const REQUEST_TIMEOUT_MS = 30_000;
const COMPLETION_TIMEOUT_MS = 120_000;
const SESSION_CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_SIZE = 100;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface GeminiWebSession {
  snlm0e: string;
  cfb2h?: string;
  fdrfje?: string;
  expiresAt: number;
}

const sessionCache = new Map<string, GeminiWebSession>();

let reqCounter = Math.floor(100_000 + Math.random() * 800_000);
function nextReqId(): number {
  reqCounter = reqCounter >= 9_999_999 ? 100_000 : reqCounter + 100_000;
  return reqCounter;
}

export class GeminiWebChatError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GeminiWebChatError';
    this.status = status;
  }
}

export function geminiWebChatErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600
    ? status
    : undefined;
}

/** Normalize raw `__Secure-1PSID` token, Cookie header, Cookie-Editor JSON, or storage state into a Cookie header. */
export function normalizeGeminiWebCookie(rawCredential: string): string {
  const trimmed = rawCredential
    .trim()
    .replace(/^(?:Cookie|Authorization):\s*/i, '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  if (!trimmed) {
    throw new GeminiWebChatError('Gemini Web credential is empty.', 401);
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new GeminiWebChatError('Gemini Web storage state JSON is invalid.', 400);
    }
    const cookies = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { cookies?: unknown }).cookies)
        ? (parsed as { cookies: unknown[] }).cookies
        : null);
    if (!cookies) {
      throw new GeminiWebChatError('Gemini Web storage state JSON contains no cookies.', 400);
    }
    const header = cookies
      .filter((cookie): cookie is { name: string; value: string } =>
        Boolean(cookie) && typeof cookie === 'object'
        && typeof (cookie as { name?: unknown }).name === 'string'
        && Boolean((cookie as { name: string }).name)
        && typeof (cookie as { value?: unknown }).value === 'string')
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');
    if (!header) {
      throw new GeminiWebChatError('Gemini Web credential contains no cookies.', 401);
    }
    return header;
  }

  if (!looksLikeCookieHeader(trimmed)) {
    return `__Secure-1PSID=${trimmed}`;
  }

  return trimmed;
}

function resolveOrigin(baseUrl?: string): string {
  const raw = (baseUrl ?? DEFAULT_BASE_URL).trim();
  if (!raw) return DEFAULT_BASE_URL;
  try {
    return new URL(raw).origin;
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

function createRequestSignal(timeoutMs: number, externalSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  timer.unref?.();
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    },
  };
}

function setCachedSession(key: string, session: GeminiWebSession): void {
  if (sessionCache.size >= CACHE_MAX_SIZE) {
    const oldestKey = sessionCache.keys().next().value;
    if (oldestKey !== undefined) sessionCache.delete(oldestKey);
  }
  sessionCache.set(key, session);
}

/** Extract `SNlM0e`, `cfb2h`, and `FdrFJe` tokens from Gemini's `/app` HTML. */
export function extractGeminiSessionTokens(html: string): Omit<GeminiWebSession, 'expiresAt'> | null {
  const snlm0e = html.match(/"SNlM0e":"([^"]+)"/)?.[1];
  if (!snlm0e) return null;
  const cfb2h = html.match(/"cfb2h":"([^"]+)"/)?.[1];
  const fdrfje = html.match(/"FdrFJe":"([^"]+)"/)?.[1];
  return { snlm0e, cfb2h, fdrfje };
}

async function fetchGeminiSession(
  cookieHeader: string,
  origin: string,
  platform: Platform,
  externalSignal?: AbortSignal,
): Promise<GeminiWebSession> {
  const cacheKey = `${origin}::${cookieHeader}`;
  const cached = sessionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  const { signal, cleanup } = createRequestSignal(REQUEST_TIMEOUT_MS, externalSignal);
  try {
    const res = await proxyFetch(
      `${origin}/app`,
      {
        method: 'GET',
        headers: {
          Cookie: cookieHeader,
          'User-Agent': BROWSER_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal,
      },
      platform,
      'chat',
    );

    if (res.status === 401 || res.status === 403 || res.url.includes('accounts.google.com')) {
      await res.body?.cancel();
      throw new GeminiWebChatError(
        'Gemini Web session is not signed in; refresh your __Secure-1PSID / __Secure-1PSIDTS cookies.',
        401,
      );
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new GeminiWebChatError(
        `Gemini Web session bootstrap failed (HTTP ${res.status}): ${errText.slice(0, 200) || res.statusText}`,
        res.status,
      );
    }

    const html = await res.text();
    const tokens = extractGeminiSessionTokens(html);
    if (!tokens) {
      throw new GeminiWebChatError(
        'Gemini Web session token (SNlM0e) not found; ensure your __Secure-1PSID / __Secure-1PSIDTS cookies are valid and signed in.',
        401,
      );
    }

    const session: GeminiWebSession = {
      ...tokens,
      expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
    };
    setCachedSession(cacheKey, session);
    return session;
  } finally {
    cleanup();
  }
}

/** Parse a single `wrb.fr` or batchexecute JSON line and extract cumulative candidate text if present. */
export function extractGeminiStreamText(line: string): { text?: string; errorCode?: number } {
  const trimmed = line.trim();
  if (!trimmed || trimmed === ")]}'" || /^\d+$/.test(trimmed)) {
    return {};
  }

  let frames: unknown;
  try {
    frames = JSON.parse(trimmed);
  } catch {
    return {};
  }
  if (!Array.isArray(frames)) return {};

  for (const frame of frames) {
    if (!Array.isArray(frame) || frame[0] !== 'wrb.fr') continue;

    if (typeof frame[2] === 'string') {
      try {
        const inner = JSON.parse(frame[2]) as unknown[];
        const candidates = Array.isArray(inner?.[4]) ? (inner[4] as unknown[]) : null;
        const firstCandidate = Array.isArray(candidates?.[0]) ? (candidates[0] as unknown[]) : null;
        const textParts = Array.isArray(firstCandidate?.[1]) ? (firstCandidate[1] as unknown[]) : null;
        if (typeof textParts?.[0] === 'string') {
          return { text: textParts[0] };
        }
      } catch {
        // Ignore malformed inner payload
      }
    } else if (frame[2] === null && Array.isArray(frame[5])) {
      const code = typeof frame[5][0] === 'number' ? frame[5][0] : undefined;
      if (code !== undefined) return { errorCode: code };
    }
  }

  return {};
}

export interface GeminiWebChatOptions {
  credential: string;
  messages: ChatMessage[];
  modelId?: string;
  baseUrl?: string;
  platform?: Platform;
  options?: CompletionOptions;
}

export async function* streamGeminiWebChat(
  opts: GeminiWebChatOptions,
): AsyncGenerator<{ content?: string }> {
  const cookieHeader = normalizeGeminiWebCookie(opts.credential);
  const origin = resolveOrigin(opts.baseUrl);
  const platform: Platform = opts.platform && opts.platform !== 'custom' ? opts.platform : 'custom';
  const prompt = buildConversationPrompt(opts.messages) || 'Hello';

  const session = await fetchGeminiSession(cookieHeader, origin, platform, opts.options?.signal);
  const query = new URLSearchParams({
    hl: 'en',
    _reqid: String(nextReqId()),
    rt: 'c',
  });
  if (session.cfb2h) query.set('bl', session.cfb2h);
  if (session.fdrfje) query.set('f.sid', session.fdrfje);

  const streamUrl = `${origin}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${query.toString()}`;
  const reqPayload = [null, JSON.stringify([[prompt], null, null])];
  const formBody = new URLSearchParams({
    'f.req': JSON.stringify(reqPayload),
    at: session.snlm0e,
  }).toString();

  const { signal, cleanup } = createRequestSignal(
    opts.options?.timeoutMs ?? COMPLETION_TIMEOUT_MS,
    opts.options?.signal,
  );

  try {
    const res = await proxyFetch(
      streamUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Cookie: cookieHeader,
          Origin: origin,
          Referer: `${origin}/`,
          'User-Agent': BROWSER_USER_AGENT,
          'X-Same-Domain': '1',
        },
        body: formBody,
        signal,
      },
      platform,
      'chat',
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        sessionCache.delete(`${origin}::${cookieHeader}`);
      }
      throw new GeminiWebChatError(
        `Gemini Web stream error (HTTP ${res.status}): ${errText.slice(0, 240) || res.statusText}`,
        res.status,
      );
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      sessionCache.delete(`${origin}::${cookieHeader}`);
      throw new GeminiWebChatError(
        'Gemini Web returned an HTML page instead of a stream; refresh your __Secure-1PSID / __Secure-1PSIDTS cookies.',
        403,
      );
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw new GeminiWebChatError('Gemini Web: empty response body.', 502);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let emittedText = '';
    let sawRpcError: number | undefined;

    const processLine = (rawLine: string): string | null => {
      const trimmed = rawLine.trim();
      if (!trimmed) return null;
      if (!emittedText && looksLikeHtmlDocument(trimmed)) {
        sessionCache.delete(`${origin}::${cookieHeader}`);
        throw new GeminiWebChatError(
          'Gemini Web returned an HTML page instead of a stream; refresh your __Secure-1PSID / __Secure-1PSIDTS cookies.',
          403,
        );
      }
      const { text, errorCode } = extractGeminiStreamText(trimmed);
      if (errorCode !== undefined) {
        sawRpcError = errorCode;
      }
      if (text && text.length > emittedText.length) {
        const delta = text.startsWith(emittedText) ? text.slice(emittedText.length) : text;
        emittedText = text;
        return delta;
      }
      return null;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const delta = processLine(line);
          if (delta) yield { content: delta };
        }
      }

      if (buffer.trim()) {
        const delta = processLine(buffer);
        if (delta) yield { content: delta };
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    if (!emittedText) {
      if (sawRpcError !== undefined) {
        sessionCache.delete(`${origin}::${cookieHeader}`);
        throw new GeminiWebChatError(
          `Gemini Web RPC error (code ${sawRpcError}); refresh your __Secure-1PSID / __Secure-1PSIDTS cookies or try again.`,
          sawRpcError === 16 ? 401 : 502,
        );
      }
      throw new GeminiWebChatError(
        'Gemini Web returned no response text; refresh your __Secure-1PSID / __Secure-1PSIDTS cookies.',
        502,
      );
    }
  } finally {
    cleanup();
  }
}

export async function runGeminiWebChat(opts: GeminiWebChatOptions): Promise<string> {
  let combined = '';
  for await (const delta of streamGeminiWebChat(opts)) {
    if (delta.content) combined += delta.content;
  }
  return combined;
}
