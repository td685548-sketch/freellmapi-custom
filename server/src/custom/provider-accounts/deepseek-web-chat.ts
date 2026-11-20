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
const STREAM_IDLE_TIMEOUT_MS = 45_000;
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

/** Clears the in-memory DeepSeek `userToken -> accessToken` exchange cache (for tests). */
export function clearDeepSeekWebTokenCache(): void {
  tokenCache.clear();
}

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

export type DeepSeekCredential =
  | { mode: 'token'; userToken: string }
  | { mode: 'cookie'; cookieHeader: string };

interface DeepSeekAuthContext {
  cacheKey: string;
  cookieHeader?: string;
  accessToken?: string;
  fromCache?: boolean;
}

function unwrapUserTokenCandidate(parsed: unknown): string | null {
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (!trimmed) return null;
    try {
      return unwrapUserTokenCandidate(JSON.parse(trimmed)) ?? trimmed;
    } catch (err) {
      if (err instanceof DeepSeekWebChatError) throw err;
      return trimmed;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.value === 'string' && obj.value.trim()) {
    return unwrapUserTokenCandidate(obj.value) ?? obj.value.trim();
  }
  if (obj.value && typeof obj.value === 'object' && typeof (obj.value as Record<string, unknown>).id === 'string') {
    throw new DeepSeekWebChatError(
      'DeepSeek Local Storage `userToken` only contains a user id; paste the Cookie Editor JSON (containing `ds_session_id`) instead.',
      401,
    );
  }
  if (typeof obj.userToken === 'string' && obj.userToken.trim()) {
    return unwrapUserTokenCandidate(obj.userToken) ?? obj.userToken.trim();
  }
  if (Array.isArray(obj.origins)) {
    for (const origin of obj.origins) {
      const items = (origin as { localStorage?: Array<{ name?: unknown; value?: unknown }> } | null)?.localStorage;
      if (!Array.isArray(items)) continue;
      const hit = items.find(entry => entry?.name === 'userToken' && typeof entry.value === 'string');
      if (hit && typeof hit.value === 'string') {
        return unwrapUserTokenCandidate(hit.value) ?? hit.value.trim();
      }
    }
  }
  return null;
}

function extractCookieArrayCredential(cookies: unknown[]): DeepSeekCredential | null {
  let deferredError: DeepSeekWebChatError | null = null;
  const tokenCookie = cookies.find(
    (c: any) => Boolean(c) && typeof c === 'object' && c.name === 'userToken' && typeof c.value === 'string',
  ) as { name: string; value: string } | undefined;
  if (tokenCookie) {
    try {
      const tok = unwrapUserTokenCandidate(tokenCookie.value) ?? tokenCookie.value.trim();
      if (tok) return { mode: 'token', userToken: tok };
    } catch (err) {
      if (err instanceof DeepSeekWebChatError) {
        deferredError = err;
      } else {
        throw err;
      }
    }
  }
  const pairs = cookies
    .filter((c: any) => Boolean(c) && typeof c === 'object' && typeof c.name === 'string' && c.name && typeof c.value === 'string')
    .map((c: any) => `${c.name}=${c.value}`);
  if (pairs.some(p => p.startsWith('ds_session_id='))) {
    return { mode: 'cookie', cookieHeader: pairs.join('; ') };
  }
  if (deferredError) throw deferredError;
  return null;
}

export function parseDeepSeekCredential(credential: string): DeepSeekCredential {
  let raw = credential.trim().replace(/^(?:cookie|authorization):\s*/i, '').trim();
  if (/^bearer\s+/i.test(raw)) {
    raw = raw.replace(/^bearer\s+/i, '').trim();
  }
  if (!raw) {
    throw new DeepSeekWebChatError('Missing DeepSeek credential.', 401);
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const fromArray = extractCookieArrayCredential(parsed);
      if (fromArray) return fromArray;
      throw new DeepSeekWebChatError(
        'Cookie Editor JSON does not contain `ds_session_id` or `userToken`.',
        401,
      );
    }
    let deferredError: DeepSeekWebChatError | null = null;
    try {
      const extracted = unwrapUserTokenCandidate(parsed);
      if (extracted) return { mode: 'token', userToken: extracted };
    } catch (err) {
      if (err instanceof DeepSeekWebChatError) {
        deferredError = err;
      } else {
        throw err;
      }
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.cookies)) {
        const fromCookies = extractCookieArrayCredential(obj.cookies);
        if (fromCookies) return fromCookies;
      }
      if (typeof obj.ds_session_id === 'string' && obj.ds_session_id.trim()) {
        const cookieHeader = Object.entries(obj)
          .filter(([k, v]) => Boolean(k) && typeof v === 'string')
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');
        return { mode: 'cookie', cookieHeader };
      }
    }
    if (deferredError) throw deferredError;
  } catch (err) {
    if (err instanceof DeepSeekWebChatError) throw err;
  }

  if (/(?:^|;\s*)ds_session_id=[^;]+/.test(raw)) {
    return { mode: 'cookie', cookieHeader: raw };
  }
  const cookieMatch = raw.match(/(?:^|;\s*)userToken=([^;]+)/);
  if (cookieMatch?.[1]) {
    const tok = unwrapUserTokenCandidate(cookieMatch[1]) ?? cookieMatch[1].trim();
    if (tok) return { mode: 'token', userToken: tok };
  }
  const valueMatch = raw.match(/(?:^|;\s*)value=([^;]+)/);
  if (valueMatch?.[1]) {
    const tok = unwrapUserTokenCandidate(valueMatch[1]) ?? valueMatch[1].trim();
    if (tok) return { mode: 'token', userToken: tok };
  }
  return { mode: 'token', userToken: raw };
}

export function extractDeepSeekUserToken(credential: string): string {
  const parsed = parseDeepSeekCredential(credential);
  return parsed.mode === 'token' ? parsed.userToken : '';
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

/**
 * Read one SSE chunk while enforcing both per-chunk idle timeout, total stream
 * deadline, and caller abort signals (since `dsFetch` clears its timer once
 * response headers arrive).
 */
async function readDeepSeekStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  deadlineAt: number,
  signal?: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  if (signal?.aborted) {
    void reader.cancel().catch(() => {});
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    void reader.cancel().catch(() => {});
    throw new DeepSeekWebChatError('DeepSeek Web stream timed out.', 504);
  }
  const waitMs = Math.max(1, Math.min(idleTimeoutMs, remainingMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const msg = remainingMs <= idleTimeoutMs
            ? 'DeepSeek Web stream timed out.'
            : 'DeepSeek Web stream timed out waiting for data.';
          reject(new DeepSeekWebChatError(msg, 504));
          void reader.cancel().catch(() => {});
        }, waitMs);
        timer.unref?.();
        if (signal) {
          onAbort = () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
            void reader.cancel().catch(() => {});
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function buildAuthHeaders(auth: DeepSeekAuthContext, includeFakeCookie = false): Record<string, string> {
  const headers: Record<string, string> = { ...FAKE_HEADERS };
  if (auth.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`;
  if (auth.cookieHeader) headers.Cookie = auth.cookieHeader;
  else if (includeFakeCookie) headers.Cookie = generateFakeCookie();
  return headers;
}

async function acquireAuth(
  origin: string,
  cred: DeepSeekCredential,
  platform: Platform,
  signal?: AbortSignal,
  options?: { skipCache?: boolean },
): Promise<DeepSeekAuthContext> {
  if (cred.mode === 'cookie') {
    const resp = await dsFetch(
      `${origin}/api/v0/users/current`,
      {
        method: 'GET',
        headers: { ...FAKE_HEADERS, Cookie: cred.cookieHeader },
      },
      REQUEST_TIMEOUT_MS,
      platform,
      signal,
    );
    if (resp.status === 401 || resp.status === 403) {
      throw new DeepSeekWebChatError(
        'DeepSeek session cookie (`ds_session_id`) is invalid or expired — refresh https://chat.deepseek.com and export cookies again.',
        resp.status,
      );
    }
    if (!resp.ok) {
      throw new DeepSeekWebChatError(`DeepSeek users/current HTTP ${resp.status}`, resp.status);
    }
    const json = (await resp.json()) as Record<string, any>;
    if (json?.code && json.code !== 0) {
      if (Number(json.code) === 40003) {
        throw new DeepSeekWebChatError(
          'DeepSeek session cookie (`ds_session_id`) is invalid or expired — refresh https://chat.deepseek.com and export cookies again.',
          401,
        );
      }
      const errMsg = json.msg || json?.data?.biz_msg || `error code ${json.code}`;
      throw new DeepSeekWebChatError(`DeepSeek rejected session: ${errMsg}`, 401);
    }
    const bizData = json?.data?.biz_data || json?.biz_data;
    const accessToken = typeof bizData?.token === 'string' && bizData.token ? bizData.token : undefined;
    return {
      cacheKey: cred.cookieHeader,
      cookieHeader: cred.cookieHeader,
      ...(accessToken ? { accessToken } : {}),
    };
  }

  const userToken = cred.userToken;
  if (!options?.skipCache) {
    const cached = tokenCache.get(userToken);
    if (cached && cached.expiresAt > Math.floor(Date.now() / 1000)) {
      return { cacheKey: userToken, accessToken: cached.accessToken, fromCache: true };
    }
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
    tokenCache.delete(userToken);
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
    if (Number(json.code) === 40003) {
      throw new DeepSeekWebChatError(
        'DeepSeek userToken is invalid or expired — copy a fresh `userToken` from https://chat.deepseek.com Local Storage (or Cookie Editor JSON with `ds_session_id`).',
        401,
      );
    }
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
  return { cacheKey: userToken, accessToken };
}

export interface DeepSeekWebProbeOptions {
  credential: string;
  baseUrl?: string;
  platform?: Platform;
  signal?: AbortSignal;
  onCredentialUpdate?: (credential: string) => void;
}

/**
 * Validates a DeepSeek Web credential by forcing a live `/api/v0/users/current`
 * exchange and persists unwrapped token form when a wrapped/mangled value succeeds.
 */
export async function probeDeepSeekWebSession(opts: DeepSeekWebProbeOptions): Promise<void> {
  const cred = parseDeepSeekCredential(opts.credential);
  const origin = resolveOrigin(opts.baseUrl);
  const platform = opts.platform ?? 'custom';
  await acquireAuth(origin, cred, platform, opts.signal, { skipCache: true });
  if (cred.mode === 'token' && opts.credential.trim() !== cred.userToken) {
    opts.onCredentialUpdate?.(cred.userToken);
  }
}

async function createSession(
  origin: string,
  auth: DeepSeekAuthContext,
  platform: Platform,
  signal?: AbortSignal,
): Promise<string> {
  const resp = await dsFetch(
    `${origin}/api/v0/chat_session/create`,
    {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(auth, true),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    },
    REQUEST_TIMEOUT_MS,
    platform,
    signal,
  );

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      tokenCache.delete(auth.cacheKey);
    }
    throw new DeepSeekWebChatError(`DeepSeek chat_session/create HTTP ${resp.status}`, resp.status);
  }
  const json = (await resp.json()) as Record<string, any>;
  if (json?.code && json.code !== 0) {
    if (Number(json.code) === 40003) {
      tokenCache.delete(auth.cacheKey);
      throw new DeepSeekWebChatError(
        'DeepSeek userToken is invalid or expired — copy a fresh `userToken` from https://chat.deepseek.com Local Storage (or Cookie Editor JSON with `ds_session_id`).',
        401,
      );
    }
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
  auth: DeepSeekAuthContext,
  sessionId: string,
  platform: Platform,
): Promise<void> {
  try {
    await dsFetch(
      `${origin}/api/v0/chat_session/delete`,
      {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(auth, false),
          'Content-Type': 'application/json',
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
  auth: DeepSeekAuthContext,
  platform: Platform,
  signal?: AbortSignal,
  targetPath = '/api/v0/chat/completion',
): Promise<DeepSeekPowChallenge> {
  const resp = await dsFetch(
    `${origin}/api/v0/chat/create_pow_challenge`,
    {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(auth, false),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ target_path: targetPath }),
    },
    REQUEST_TIMEOUT_MS,
    platform,
    signal,
  );
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      tokenCache.delete(auth.cacheKey);
    }
    throw new DeepSeekWebChatError(`DeepSeek create_pow_challenge HTTP ${resp.status}`, resp.status);
  }
  const json = (await resp.json()) as Record<string, any>;
  if (json?.code && json.code !== 0) {
    if (Number(json.code) === 40003) {
      tokenCache.delete(auth.cacheKey);
      throw new DeepSeekWebChatError(
        'DeepSeek userToken is invalid or expired — copy a fresh `userToken` from https://chat.deepseek.com Local Storage (or Cookie Editor JSON with `ds_session_id`).',
        401,
      );
    }
    throw new DeepSeekWebChatError(
      `DeepSeek create_pow_challenge error ${json.code}: ${json.msg || json?.data?.biz_msg || ''}`,
      400,
    );
  }
  const challenge = json?.data?.biz_data?.challenge ?? json?.biz_data?.challenge;
  if (!challenge || typeof challenge !== 'object') {
    throw new DeepSeekWebChatError('DeepSeek create_pow_challenge returned invalid challenge');
  }
  return { ...challenge, target_path: targetPath } as DeepSeekPowChallenge;
}

interface ExtractedDeepSeekImage {
  fileName: string;
  mimeType: string;
  data: Buffer;
}

function extractDeepSeekImages(messages: ChatMessage[]): ExtractedDeepSeekImage[] {
  const images: ExtractedDeepSeekImage[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as unknown as Record<string, unknown>;
      const type = typeof p.type === 'string' ? p.type.toLowerCase() : '';
      let url: string | undefined;
      if (type === 'image_url') {
        url = typeof p.image_url === 'string'
          ? p.image_url
          : (p.image_url as { url?: unknown } | undefined)?.url as string | undefined;
      } else if (type === 'input_image') {
        url = typeof p.image_url === 'string' ? p.image_url : (typeof p.url === 'string' ? p.url : undefined);
      } else if (type === 'image' && typeof p.source === 'string') {
        url = p.source;
      }
      if (!url) continue;
      const match = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
      if (!match) {
        throw new DeepSeekWebChatError('DeepSeek Web images must be base64 data URLs (PNG, JPEG, WebP, or GIF)', 400);
      }
      const rawExt = match[1].toLowerCase();
      const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
      const mimeType = `image/${rawExt === 'jpg' ? 'jpeg' : rawExt}`;
      images.push({
        fileName: `image-${images.length + 1}.${ext}`,
        mimeType,
        data: Buffer.from(match[2].replace(/\s/g, ''), 'base64'),
      });
    }
  }
  return images;
}

async function uploadDeepSeekFiles(
  images: ExtractedDeepSeekImage[],
  origin: string,
  auth: DeepSeekAuthContext,
  platform: Platform,
  signal?: AbortSignal,
): Promise<string[]> {
  const fileIds: string[] = [];
  for (const image of images) {
    const powChallenge = await requestPowChallenge(origin, auth, platform, signal, '/api/v0/file/upload_file');
    const powHeader = solveDeepSeekPowHeader(powChallenge);
    const boundary = `----freellmapiDs${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${image.fileName}"\r\nContent-Type: ${image.mimeType}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, image.data, tail]);

    const uploadResp = await dsFetch(
      `${origin}/api/v0/file/upload_file`,
      {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(auth, true),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'X-Ds-Pow-Response': powHeader,
          'X-Client-Timezone-Offset': String(new Date().getTimezoneOffset() * -60),
        },
        body,
      },
      REQUEST_TIMEOUT_MS,
      platform,
      signal,
    );
    if (!uploadResp.ok) {
      throw new DeepSeekWebChatError(`DeepSeek file upload failed (HTTP ${uploadResp.status})`, uploadResp.status);
    }
    const uploadJson = (await uploadResp.json().catch(() => null)) as Record<string, any> | null;
    const biz = uploadJson?.data?.biz_data ?? uploadJson?.biz_data;
    const fileId = typeof biz?.id === 'string' ? biz.id : '';
    if (!fileId) {
      throw new DeepSeekWebChatError('DeepSeek file upload returned no file id', 502);
    }

    let status = String(biz?.status ?? '').toUpperCase();
    for (let attempt = 0; attempt < 15 && status !== 'SUCCESS'; attempt++) {
      if (status === 'ERROR' || status === 'FAILED') {
        throw new DeepSeekWebChatError('DeepSeek failed to process uploaded image', 502);
      }
      await new Promise<void>(resolve => setTimeout(resolve, 1_000));
      const pollResp = await dsFetch(
        `${origin}/api/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`,
        { method: 'GET', headers: buildAuthHeaders(auth, false) },
        REQUEST_TIMEOUT_MS,
        platform,
        signal,
      );
      if (pollResp.ok) {
        const pollJson = (await pollResp.json().catch(() => null)) as Record<string, any> | null;
        const files = pollJson?.data?.biz_data?.files ?? pollJson?.biz_data?.files;
        if (Array.isArray(files) && files[0]) {
          status = String(files[0].status ?? '').toUpperCase();
        }
      }
    }
    fileIds.push(fileId);
  }
  return fileIds;
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
  const cred = parseDeepSeekCredential(opts.credential);

  const origin = resolveOrigin(opts.baseUrl);
  const platform = opts.platform ?? 'custom';
  const signal = opts.options?.signal;
  const timeoutMs = opts.options?.timeoutMs ?? COMPLETION_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeoutMs;

  const images = extractDeepSeekImages(opts.messages);
  let auth = await acquireAuth(origin, cred, platform, signal);
  if (cred.mode === 'token' && opts.credential.trim() !== cred.userToken) {
    opts.options?.onCredentialUpdate?.(cred.userToken);
  }
  let sessionId: string;
  try {
    sessionId = await createSession(origin, auth, platform, signal);
  } catch (err) {
    const status = deepSeekWebChatErrorStatus(err);
    if (auth.fromCache && (status === 401 || status === 403)) {
      auth = await acquireAuth(origin, cred, platform, signal, { skipCache: true });
      sessionId = await createSession(origin, auth, platform, signal);
    } else {
      throw err;
    }
  }

  try {
    const refFileIds = images.length > 0
      ? await uploadDeepSeekFiles(images, origin, auth, platform, signal)
      : [];
    const powChallenge = await requestPowChallenge(origin, auth, platform, signal);
    const powHeader = solveDeepSeekPowHeader(powChallenge);

    const m = opts.modelId.toLowerCase();
    const modelType = m.includes('pro') || m.includes('expert') ? 'expert' : 'default';
    const thinkingEnabled = isThinkingModel(opts.modelId) || Boolean(opts.options?.reasoning_effort);
    const searchEnabled = isSearchModel(opts.modelId);
    const rawPrompt = buildConversationPrompt(opts.messages);
    const prompt = rawPrompt.trim() || (refFileIds.length > 0 ? 'Describe or analyze this image.' : '');

    const resp = await dsFetch(
      `${origin}/api/v0/chat/completion`,
      {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(auth, true),
          'Content-Type': 'application/json',
          'X-Ds-Pow-Response': powHeader,
          'X-Client-Timezone-Offset': String(new Date().getTimezoneOffset() * -60),
        },
        body: JSON.stringify({
          chat_session_id: sessionId,
          parent_message_id: null,
          model_type: modelType,
          prompt,
          ref_file_ids: refFileIds,
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
        tokenCache.delete(auth.cacheKey);
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
        const { done, value } = await readDeepSeekStreamChunk(
          reader,
          STREAM_IDLE_TIMEOUT_MS,
          deadlineAt,
          signal,
        );
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
    void deleteSession(origin, auth, sessionId, platform);
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
