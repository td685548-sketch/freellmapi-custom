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
import { assertProviderUrlAllowed } from '../../lib/url-guard.js';
import type { CompletionOptions, KeyValidationResult } from '../../providers/base.js';
import { looksLikeCookieHeader, looksLikeHtmlDocument } from './cookie-format.js';
import {
  downloadProviderImage,
  playgroundMediaUrl,
  storePlaygroundMedia,
} from '../x-gateway/playground-media.js';

const DEFAULT_BASE_URL = 'https://gemini.google.com';
const GEMINI_PLATFORM = 'gemini-web' as Platform;
const GEMINI_ROTATE_COOKIES_URL = 'https://accounts.google.com/RotateCookies';
const ROTATE_COOKIES_BODY = '[000,"-0000000000000000000"]';
const GEMINI_UPLOAD_URL = 'https://push.clients6.google.com/upload/';
const GEMINI_PUSH_ID = 'feeds/mcudyrk2a4khkz';
const REQUEST_TIMEOUT_MS = 30_000;
const BOOTSTRAP_TIMEOUT_MS = 15_000;
const STREAM_CONNECT_TIMEOUT_MS = 15_000;
const STREAM_TTFT_TIMEOUT_MS = 25_000;
const STREAM_READ_STALL_TIMEOUT_MS = 20_000;
const COMPLETION_TIMEOUT_MS = 120_000;
const IMAGE_FETCH_TIMEOUT_TEXT_MS = 2_500;
const IMAGE_FETCH_TIMEOUT_PRIMARY_MS = 6_000;
const MAX_INLINE_TEXT_IMAGES = 4;
const SESSION_CACHE_TTL_MS = 15 * 60_000;
const ROTATE_COOLDOWN_MS = 60_000;
const PROACTIVE_ROTATE_INTERVAL_MS = 9 * 60_000;
const MAX_REDIRECTS = 5;
const CACHE_MAX_SIZE = 100;

const AUTH_REDIRECT_HOSTS = new Set([
  'accounts.google.com',
  'consent.google.com',
]);

const TRUSTED_GOOGLE_DOMAINS = [
  'google.com',
  'googleusercontent.com',
  'gstatic.com',
  'ggpht.com',
] as const;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface GeminiWebSession {
  snlm0e: string;
  cfb2h?: string;
  fdrfje?: string;
  expiresAt: number;
}

export interface RotateGeminiCookiesResult {
  cookieHeader: string;
  rotated: boolean;
  status?: number;
}

interface PendingSessionFetch {
  promise: Promise<{ session: GeminiWebSession; cookieHeader: string }>;
  waiters: number;
  abort: () => void;
}

interface RotateCookiesRawResult {
  ok: boolean;
  status?: number;
  setCookies: string[];
}

const sessionCache = new Map<string, GeminiWebSession>();
const pendingSessionFetches = new Map<string, PendingSessionFetch>();
const rotatedCookieMap = new Map<string, string>();
const rotateInFlight = new Map<string, Promise<RotateCookiesRawResult>>();
const rotateCooldownUntil = new Map<string, number>();
const lastSuccessRotateByPsid = new Map<string, number>();

/** Clear in-memory Gemini Web session and cookie-rotation caches (used by tests). */
export function clearGeminiWebCaches(): void {
  sessionCache.clear();
  pendingSessionFetches.clear();
  rotatedCookieMap.clear();
  rotateInFlight.clear();
  rotateCooldownUntil.clear();
  lastSuccessRotateByPsid.clear();
}

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

function sanitizeCookiePart(raw: string): string {
  return raw.replace(/[\r\n\0]+/g, '');
}

function isGoogleCookieDomain(domain: unknown): boolean {
  if (domain === undefined || domain === null) return true;
  if (typeof domain !== 'string') return false;
  const host = domain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  if (!host) return true;
  return host === 'google.com' || host.endsWith('.google.com');
}

function isExpiredCookie(cookie: Record<string, unknown>, nowMs: number): boolean {
  const rawExpiry = cookie.expirationDate ?? cookie.expires;
  if (rawExpiry === undefined || rawExpiry === null || rawExpiry === '') return false;
  let expiryMs: number | undefined;
  if (typeof rawExpiry === 'number') {
    if (!Number.isFinite(rawExpiry) || rawExpiry <= 0) return false;
    expiryMs = rawExpiry > 1e12 ? rawExpiry : rawExpiry * 1000;
  } else if (typeof rawExpiry === 'string') {
    const s = rawExpiry.trim();
    if (!s) return false;
    if (/^-?\d+(?:\.\d+)?$/.test(s)) {
      const num = Number(s);
      if (!Number.isFinite(num) || num <= 0) return false;
      expiryMs = num > 1e12 ? num : num * 1000;
    } else {
      const parsedMs = Date.parse(s);
      if (Number.isFinite(parsedMs)) expiryMs = parsedMs;
    }
  }
  return expiryMs !== undefined && expiryMs <= nowMs;
}

function cookieSpecificity(cookie: Record<string, unknown>): number {
  const domainStr = typeof cookie.domain === 'string' ? cookie.domain.trim().toLowerCase() : '';
  const hostPart = domainStr.replace(/^\.+/, '').replace(/\.+$/, '');
  const domainScore = !hostPart ? 0 : hostPart.length * 2 + (domainStr.startsWith('.') ? 0 : 1);
  const pathScore = typeof cookie.path === 'string' ? cookie.path.length : 0;
  return domainScore * 1000 + pathScore;
}

function parseCookieHeader(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = sanitizeCookiePart(part.slice(0, eq)).trim();
    const value = sanitizeCookiePart(part.slice(eq + 1));
    if (!name || /[=;]/.test(name)) continue;
    cookies.set(name, value);
  }
  return cookies;
}

function formatCookieHeader(cookies: Map<string, string>): string {
  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/** Normalize raw `__Secure-1PSID` token, Cookie header, Cookie-Editor JSON, key-value map, or storage state into a Cookie header. */
export function normalizeGeminiWebCookie(rawCredential: string): string {
  const trimmed = sanitizeCookiePart(rawCredential)
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

    let rawCookies: Array<Record<string, unknown>> | null = null;
    if (Array.isArray(parsed)) {
      rawCookies = parsed.filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && !Array.isArray(c));
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.cookies)) {
        rawCookies = obj.cookies.filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && !Array.isArray(c));
      } else {
        const kvEntries = Object.entries(obj).filter(([, val]) => typeof val === 'string');
        if (kvEntries.length > 0 && kvEntries.length === Object.keys(obj).length) {
          rawCookies = kvEntries.map(([name, value]) => ({ name, value }));
        }
      }
    }

    if (!rawCookies) {
      throw new GeminiWebChatError('Gemini Web storage state JSON contains no cookies.', 400);
    }

    const nowMs = Date.now();
    const deduped = new Map<string, { value: string; specificity: number }>();
    for (const c of rawCookies) {
      if (typeof c.name !== 'string' || typeof c.value !== 'string') continue;
      const name = sanitizeCookiePart(c.name).trim();
      const value = sanitizeCookiePart(c.value);
      if (!name || /[=;]/.test(name)) continue;
      if (!isGoogleCookieDomain(c.domain)) continue;
      if (name !== '__Secure-1PSID' && isExpiredCookie(c, nowMs)) continue;

      const specificity = cookieSpecificity(c);
      const existing = deduped.get(name);
      if (!existing || specificity >= existing.specificity) {
        deduped.set(name, { value, specificity });
      }
    }

    const header = Array.from(deduped.entries(), ([name, entry]) => `${name}=${entry.value}`).join('; ');
    if (!header) {
      throw new GeminiWebChatError('Gemini Web credential contains no cookies.', 401);
    }
    return header;
  }

  if (!looksLikeCookieHeader(trimmed)) {
    return `__Secure-1PSID=${trimmed}`;
  }

  const parsedJar = parseCookieHeader(trimmed);
  const header = formatCookieHeader(parsedJar);
  if (!header) {
    throw new GeminiWebChatError('Gemini Web credential contains no cookies.', 401);
  }
  return header;
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

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= CACHE_MAX_SIZE && !map.has(key)) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, value);
}

function pruneExpiredSessions(now = Date.now()): void {
  for (const [key, session] of sessionCache) {
    if (session.expiresAt <= now) {
      sessionCache.delete(key);
    }
  }
}

function setCachedSession(key: string, session: GeminiWebSession): void {
  pruneExpiredSessions();
  setBoundedMap(sessionCache, key, session);
}

function splitCombinedSetCookie(headerValue: string): string[] {
  const cookies: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let i = 0; i < headerValue.length; i++) {
    const ch = headerValue[i];
    if (ch === ',') {
      if (inExpires) {
        inExpires = false;
        continue;
      }
      const rest = headerValue.slice(i + 1);
      if (/^\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=/.test(rest)) {
        const piece = headerValue.slice(start, i).trim();
        if (piece) cookies.push(piece);
        start = i + 1;
      }
    } else if (ch === ';') {
      inExpires = false;
    } else if (headerValue.slice(i, i + 8).toLowerCase() === 'expires=') {
      inExpires = true;
    }
  }
  const tail = headerValue.slice(start).trim();
  if (tail) cookies.push(tail);
  return cookies;
}

function getSetCookieValues(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    const list = withGetSetCookie.getSetCookie();
    if (Array.isArray(list) && list.length > 0) {
      return list.flatMap(splitCombinedSetCookie);
    }
  }
  const single = headers.get('set-cookie');
  return single ? splitCombinedSetCookie(single) : [];
}

function isSetCookieDeletion(attrs: string[], value: string, nowMs: number): boolean {
  if (value.toLowerCase() === 'deleted') return true;
  for (const rawAttr of attrs) {
    const eq = rawAttr.indexOf('=');
    if (eq <= 0) continue;
    const attrName = rawAttr.slice(0, eq).trim().toLowerCase();
    const attrVal = rawAttr.slice(eq + 1).trim();
    if (attrName === 'max-age') {
      const num = Number(attrVal);
      if (Number.isFinite(num) && num <= 0) return true;
    } else if (attrName === 'expires') {
      const parsed = Date.parse(attrVal);
      if (Number.isFinite(parsed) && parsed <= nowMs) return true;
    }
  }
  return false;
}

function getSetCookieDomain(attrs: string[]): string | undefined {
  for (const rawAttr of attrs) {
    const eq = rawAttr.indexOf('=');
    if (eq <= 0) continue;
    if (rawAttr.slice(0, eq).trim().toLowerCase() === 'domain') {
      return rawAttr.slice(eq + 1).trim();
    }
  }
  return undefined;
}

function applySetCookieLinesToHeader(
  cookieHeader: string,
  setCookies: string[],
): { nextHeader: string; changed: boolean } {
  if (setCookies.length === 0) {
    return { nextHeader: cookieHeader, changed: false };
  }

  const cookies = parseCookieHeader(cookieHeader);
  const nowMs = Date.now();
  let changed = false;

  for (const raw of setCookies) {
    const segments = raw.split(';');
    const pair = segments[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = sanitizeCookiePart(pair.slice(0, eq)).trim();
    const value = sanitizeCookiePart(pair.slice(eq + 1));
    if (!name || /[=;]/.test(name)) continue;

    const attrs = segments.slice(1);
    const domain = getSetCookieDomain(attrs);
    if (domain !== undefined && !isGoogleCookieDomain(domain)) continue;

    if (isSetCookieDeletion(attrs, value, nowMs)) {
      if (name !== '__Secure-1PSID' && cookies.delete(name)) {
        changed = true;
      }
      continue;
    }

    if (!value) continue;

    if (cookies.get(name) !== value) {
      cookies.set(name, value);
      changed = true;
    }
  }

  return {
    nextHeader: changed ? formatCookieHeader(cookies) : cookieHeader,
    changed,
  };
}

/** Merge any non-empty `Set-Cookie` values from `res` into `cookieHeader`. */
export function mergeResponseCookies(
  cookieHeader: string,
  res: Response,
): { nextHeader: string; changed: boolean } {
  return applySetCookieLinesToHeader(cookieHeader, getSetCookieValues(res.headers));
}

function resolveLiveCookieHeader(cookieHeader: string): string {
  let current = cookieHeader;
  const seen = new Set<string>([current]);
  for (let i = 0; i < 16; i++) {
    const next = rotatedCookieMap.get(current);
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current;
}

function recordRotatedCookie(
  prevHeader: string,
  nextHeader: string,
  origin?: string,
  onCredentialUpdate?: (next: string) => void,
): void {
  if (prevHeader === nextHeader) return;
  setBoundedMap(rotatedCookieMap, prevHeader, nextHeader);
  if (origin) {
    const prevKey = `${origin}::${prevHeader}`;
    const cached = sessionCache.get(prevKey);
    if (cached) {
      sessionCache.delete(prevKey);
      setCachedSession(`${origin}::${nextHeader}`, cached);
    }
  }
  if (onCredentialUpdate) {
    try {
      onCredentialUpdate(nextHeader);
    } catch {
      // Persistence failures must never abort an active Gemini Web request.
    }
  }
}

function extractPsid(cookieHeader: string): string | undefined {
  return parseCookieHeader(cookieHeader).get('__Secure-1PSID');
}

/**
 * Call Google's `RotateCookies` endpoint to mint a fresh `__Secure-1PSIDTS`
 * cookie from an active `__Secure-1PSID` session. Single-flighted per account.
 */
export async function rotateGeminiCookies(
  rawCookieHeader: string,
  platform: Platform = GEMINI_PLATFORM,
  externalSignal?: AbortSignal,
  opts?: { force?: boolean },
): Promise<RotateGeminiCookiesResult> {
  const cookieHeader = resolveLiveCookieHeader(rawCookieHeader);
  const effectivePlatform: Platform = platform && platform !== 'custom' ? platform : GEMINI_PLATFORM;
  const psid = extractPsid(cookieHeader);
  const rotationKey = psid || cookieHeader;

  const cooldown = rotateCooldownUntil.get(rotationKey) ?? 0;
  if (!opts?.force && cooldown > Date.now()) {
    return { cookieHeader, rotated: false };
  }

  let inflight = rotateInFlight.get(rotationKey);
  if (!inflight) {
    const task = (async (): Promise<RotateCookiesRawResult> => {
      const { signal, cleanup } = createRequestSignal(REQUEST_TIMEOUT_MS, externalSignal);
      try {
        await assertProviderUrlAllowed(GEMINI_ROTATE_COOKIES_URL);
        const res = await proxyFetch(
          GEMINI_ROTATE_COOKIES_URL,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json;charset=UTF-8',
              Cookie: cookieHeader,
              Origin: 'https://accounts.google.com',
              Referer: 'https://accounts.google.com/',
              'User-Agent': BROWSER_USER_AGENT,
            },
            body: ROTATE_COOKIES_BODY,
            redirect: 'manual',
            signal,
          },
          effectivePlatform,
          'chat',
        );
        const setCookies = getSetCookieValues(res.headers);
        await res.body?.cancel().catch(() => {});

        if (res.ok) {
          rotateCooldownUntil.delete(rotationKey);
          if (psid) setBoundedMap(lastSuccessRotateByPsid, psid, Date.now());
        } else {
          setBoundedMap(rotateCooldownUntil, rotationKey, Date.now() + ROTATE_COOLDOWN_MS);
        }
        return { ok: res.ok, status: res.status, setCookies };
      } catch {
        setBoundedMap(rotateCooldownUntil, rotationKey, Date.now() + ROTATE_COOLDOWN_MS);
        return { ok: false, setCookies: [] };
      } finally {
        cleanup();
      }
    })().finally(() => {
      if (rotateInFlight.get(rotationKey) === task) {
        rotateInFlight.delete(rotationKey);
      }
    });

    rotateInFlight.set(rotationKey, task);
    inflight = task;
  }

  const rawResult = await raceWithSignal(inflight, externalSignal);
  const { nextHeader, changed } = applySetCookieLinesToHeader(cookieHeader, rawResult.setCookies);
  if (rawResult.ok && changed) {
    recordRotatedCookie(cookieHeader, nextHeader);
    return { cookieHeader: nextHeader, rotated: true, status: rawResult.status };
  }

  return { cookieHeader, rotated: false, status: rawResult.status };
}

function extractWizToken(html: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`),
    new RegExp(`'${escaped}'\\s*:\\s*'([^']+)'`),
    new RegExp(`\\\\"${escaped}\\\\"\\s*:\\s*\\\\"([^"\\\\]+)\\\\"`),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern)?.[1];
    if (match) return match;
  }
  return undefined;
}

/** Extract `SNlM0e`, `cfb2h`, and `FdrFJe` tokens from Gemini's `/app` HTML. */
export function extractGeminiSessionTokens(html: string): Omit<GeminiWebSession, 'expiresAt'> | null {
  const snlm0e = extractWizToken(html, 'SNlM0e');
  if (!snlm0e) return null;
  const cfb2h = extractWizToken(html, 'cfb2h');
  const fdrfje = extractWizToken(html, 'FdrFJe');
  return { snlm0e, cfb2h, fdrfje };
}

function abortReasonError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError') as unknown as Error;
}

function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(abortReasonError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortReasonError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isTrustedGoogleHost(hostname: string, origin?: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host) return false;
  if (origin) {
    try {
      const originHost = normalizeHostname(new URL(origin).hostname);
      if (originHost && host === originHost) return true;
    } catch {
      // Ignore invalid origin
    }
  }
  return TRUSTED_GOOGLE_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function isTrustedGoogleUrl(rawUrl: string, origin?: string): boolean {
  try {
    return isTrustedGoogleHost(new URL(rawUrl).hostname, origin);
  } catch {
    return false;
  }
}

function isGoogleCookieUrl(rawUrl: string, origin?: string): boolean {
  try {
    const host = normalizeHostname(new URL(rawUrl).hostname);
    if (!host) return false;
    if (origin) {
      try {
        const originHost = normalizeHostname(new URL(origin).hostname);
        if (originHost && host === originHost) return true;
      } catch {
        // Ignore invalid origin
      }
    }
    return host === 'google.com' || host.endsWith('.google.com');
  } catch {
    return false;
  }
}

function isGoogleAuthRedirectHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return AUTH_REDIRECT_HOSTS.has(host)
    || host.endsWith('.accounts.google.com')
    || host.endsWith('.consent.google.com');
}

function isGoogleAuthRedirectUrl(rawUrl: string): boolean {
  try {
    return isGoogleAuthRedirectHost(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

async function fetchWithGoogleRedirects(
  initialUrl: string,
  makeInit: (targetUrl: string) => RequestInit,
  state: { cookieHeader: string },
  origin: string,
  platform: Platform,
  onCredentialUpdate?: (next: string) => void,
  options?: { requireTrustedRedirectHost?: boolean },
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertProviderUrlAllowed(currentUrl);
    const res = await proxyFetch(
      currentUrl,
      { ...makeInit(currentUrl), redirect: 'manual' },
      platform,
      'chat',
    );
    const canAcceptCookies = isGoogleCookieUrl(currentUrl, origin)
      && (!res.url || isGoogleCookieUrl(res.url, origin));
    if (canAcceptCookies) {
      const { nextHeader, changed } = mergeResponseCookies(state.cookieHeader, res);
      if (changed) {
        recordRotatedCookie(state.cookieHeader, nextHeader, origin, onCredentialUpdate);
        state.cookieHeader = nextHeader;
      }
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location) {
        throw new GeminiWebChatError(`Gemini Web redirect (${res.status}) missing Location header.`, 502);
      }
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new GeminiWebChatError(`Gemini Web redirect (${res.status}) has invalid Location header.`, 502);
      }
      if (isGoogleAuthRedirectUrl(nextUrl)) {
        throw new GeminiWebChatError(
          'Gemini Web session is not signed in; refresh your __Secure-1PSID / __Secure-1PSIDTS cookies.',
          401,
        );
      }
      if (options?.requireTrustedRedirectHost && !isTrustedGoogleUrl(nextUrl, origin)) {
        throw new GeminiWebChatError('Gemini Web redirected to an untrusted host.', 502);
      }
      await assertProviderUrlAllowed(nextUrl);
      if (hop === MAX_REDIRECTS) {
        throw new GeminiWebChatError(`Gemini Web exceeded maximum redirects (${MAX_REDIRECTS}).`, 502);
      }
      currentUrl = nextUrl;
      continue;
    }

    if (res.url && isGoogleAuthRedirectUrl(res.url)) {
      await res.body?.cancel().catch(() => {});
      throw new GeminiWebChatError(
        'Gemini Web session is not signed in; refresh your __Secure-1PSID / __Secure-1PSIDTS cookies.',
        401,
      );
    }

    return res;
  }

  throw new GeminiWebChatError(`Gemini Web exceeded maximum redirects (${MAX_REDIRECTS}).`, 502);
}

function shouldProactivelyRotate(cookieHeader: string): boolean {
  const jar = parseCookieHeader(cookieHeader);
  const psid = jar.get('__Secure-1PSID');
  if (!psid) return false;
  if (!jar.has('__Secure-1PSIDTS')) return true;
  const lastRotatedAt = lastSuccessRotateByPsid.get(psid);
  return lastRotatedAt !== undefined && Date.now() - lastRotatedAt >= PROACTIVE_ROTATE_INTERVAL_MS;
}

async function fetchGeminiSession(
  cookieHeader: string,
  origin: string,
  platform: Platform,
  externalSignal?: AbortSignal,
  opts?: { forceRefresh?: boolean; timeoutMs?: number; onCredentialUpdate?: (next: string) => void },
): Promise<{ session: GeminiWebSession; cookieHeader: string; fromCache: boolean }> {
  pruneExpiredSessions();
  let initialCookie = resolveLiveCookieHeader(cookieHeader);
  const forceRefresh = opts?.forceRefresh === true;

  if (!forceRefresh) {
    const cacheKey = `${origin}::${initialCookie}`;
    const cached = sessionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (!shouldProactivelyRotate(initialCookie)) {
        return { session: cached, cookieHeader: initialCookie, fromCache: true };
      }
      const rotated = await rotateGeminiCookies(initialCookie, platform, externalSignal);
      if (rotated.rotated) {
        recordRotatedCookie(initialCookie, rotated.cookieHeader, origin, opts?.onCredentialUpdate);
        initialCookie = rotated.cookieHeader;
      } else {
        return { session: cached, cookieHeader: initialCookie, fromCache: true };
      }
    }
  } else {
    sessionCache.delete(`${origin}::${initialCookie}`);
  }

  const cacheKey = `${origin}::${initialCookie}`;
  const timeoutBudgetMs = opts?.timeoutMs && opts.timeoutMs > 0
    ? Math.min(BOOTSTRAP_TIMEOUT_MS, opts.timeoutMs)
    : BOOTSTRAP_TIMEOUT_MS;
  const { signal: waiterSignal, cleanup: cleanupWaiter } = createRequestSignal(timeoutBudgetMs, externalSignal);

  let entry = forceRefresh ? undefined : pendingSessionFetches.get(cacheKey);
  if (!entry) {
    const controller = new AbortController();
    const { signal: internalSignal, cleanup } = createRequestSignal(BOOTSTRAP_TIMEOUT_MS, controller.signal);
    const fetchPromise = (async (): Promise<{ session: GeminiWebSession; cookieHeader: string }> => {
      try {
        const state = { cookieHeader: initialCookie };
        let attemptedProactive = false;
        if (shouldProactivelyRotate(state.cookieHeader)) {
          const rotated = await rotateGeminiCookies(state.cookieHeader, platform, internalSignal);
          if (rotated.rotated) {
            recordRotatedCookie(state.cookieHeader, rotated.cookieHeader, origin, opts?.onCredentialUpdate);
            state.cookieHeader = rotated.cookieHeader;
            attemptedProactive = true;
          } else if (rotated.status !== undefined) {
            attemptedProactive = true;
          }
        }

        for (let attempt = 0; attempt < 2; attempt++) {
          let shouldRotateAndRetry = false;
          let pendingError: GeminiWebChatError | null = null;

          try {
            const res = await fetchWithGoogleRedirects(
              `${origin}/app`,
              (targetUrl) => ({
                method: 'GET',
                headers: {
                  ...(isTrustedGoogleUrl(targetUrl, origin) ? { Cookie: state.cookieHeader } : {}),
                  'User-Agent': BROWSER_USER_AGENT,
                  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                  'Accept-Language': 'en-US,en;q=0.9',
                },
                signal: internalSignal,
              }),
              state,
              origin,
              platform,
              opts?.onCredentialUpdate,
              { requireTrustedRedirectHost: true },
            );

            if (res.status === 401 || res.status === 403) {
              await res.body?.cancel().catch(() => {});
              shouldRotateAndRetry = attempt === 0 && !attemptedProactive;
              pendingError = new GeminiWebChatError(
                'Gemini Web session is not signed in; refresh your __Secure-1PSID / __Secure-1PSIDTS cookies.',
                401,
              );
            } else if (!res.ok) {
              const errText = await res.text().catch(() => '');
              throw new GeminiWebChatError(
                `Gemini Web session bootstrap failed (HTTP ${res.status}): ${errText.slice(0, 200) || res.statusText}`,
                res.status,
              );
            } else {
              const html = await res.text();
              const tokens = extractGeminiSessionTokens(html);
              if (!tokens) {
                shouldRotateAndRetry = attempt === 0 && !attemptedProactive;
                pendingError = new GeminiWebChatError(
                  'Gemini Web session token (SNlM0e) not found; ensure your __Secure-1PSID / __Secure-1PSIDTS cookies are valid and signed in.',
                  401,
                );
              } else {
                const jar = parseCookieHeader(state.cookieHeader);
                const psid = jar.get('__Secure-1PSID');
                if (psid && jar.has('__Secure-1PSIDTS') && lastSuccessRotateByPsid.get(psid) === undefined) {
                  setBoundedMap(lastSuccessRotateByPsid, psid, Date.now());
                }
                const session: GeminiWebSession = {
                  ...tokens,
                  expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
                };
                setCachedSession(`${origin}::${state.cookieHeader}`, session);
                return { session, cookieHeader: state.cookieHeader };
              }
            }
          } catch (err) {
            const authStatus = geminiWebChatErrorStatus(err);
            if (err instanceof GeminiWebChatError && (authStatus === 401 || authStatus === 403)) {
              shouldRotateAndRetry = attempt === 0 && !attemptedProactive;
              pendingError = err;
            } else {
              throw err;
            }
          }

          if (shouldRotateAndRetry && !internalSignal.aborted) {
            sessionCache.delete(`${origin}::${state.cookieHeader}`);
            const rotated = await rotateGeminiCookies(state.cookieHeader, platform, internalSignal, { force: true });
            if (rotated.rotated) {
              recordRotatedCookie(state.cookieHeader, rotated.cookieHeader, origin, opts?.onCredentialUpdate);
              state.cookieHeader = rotated.cookieHeader;
              continue;
            }
          }

          throw pendingError!;
        }

        throw new GeminiWebChatError(
          'Gemini Web session token (SNlM0e) not found; ensure your __Secure-1PSID / __Secure-1PSIDTS cookies are valid and signed in.',
          401,
        );
      } finally {
        cleanup();
        if (pendingSessionFetches.get(cacheKey) === entry) {
          pendingSessionFetches.delete(cacheKey);
        }
      }
    })();
    fetchPromise.catch(() => {});
    entry = {
      promise: fetchPromise,
      waiters: 0,
      abort: () => controller.abort(new DOMException('All callers aborted.', 'AbortError')),
    };
    if (!forceRefresh) {
      pendingSessionFetches.set(cacheKey, entry);
    }
  }

  entry.waiters += 1;
  let released = false;
  const releaseWaiter = () => {
    if (released) return;
    released = true;
    waiterSignal.removeEventListener('abort', releaseWaiter);
    entry!.waiters = Math.max(0, entry!.waiters - 1);
    if (entry!.waiters === 0) {
      entry!.abort();
    }
  };
  waiterSignal.addEventListener('abort', releaseWaiter, { once: true });

  try {
    const result = await raceWithSignal(entry.promise, waiterSignal);
    return { ...result, fromCache: false };
  } catch (err) {
    if (!externalSignal?.aborted && waiterSignal.aborted) {
      throw new GeminiWebChatError(`Gemini Web session bootstrap timed out after ${timeoutBudgetMs}ms.`, 504);
    }
    throw err;
  } finally {
    releaseWaiter();
    cleanupWaiter();
  }
}

export interface GeminiWebImage {
  url: string;
  alt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Safe navigation through nested arrays (by index) and objects (by key). */
function nested(value: unknown, path: Array<number | string>): unknown {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === 'number') {
      current = current[key];
    } else if (isRecord(current) && typeof key === 'string') {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Read field `index` of a candidate's `[12]` rich-content block.
 *
 * Gemini's JSPB arrays put low-numbered fields in positional slots and collect
 * sparse high-numbered ones into a dict in the last slot, keyed by the 1-based
 * field number — so field 7 may live at index 7 or under key `"8"`.
 */
function richContentField(candidate: unknown, index: number): unknown {
  const container = nested(candidate, [12]);
  if (!Array.isArray(container) || container.length === 0) return undefined;

  const usable = (value: unknown) => value !== undefined && value !== null
    && !(Array.isArray(value) && value.length === 0)
    && !(isRecord(value) && Object.keys(value).length === 0);

  const positional = container[index];
  if (usable(positional) && !isRecord(positional)) return positional;

  const bundle = container[container.length - 1];
  const sparse = isRecord(bundle) ? bundle[String(index + 1)] : undefined;
  return usable(sparse) ? sparse : undefined;
}

/**
 * Images attached to a reply candidate. Generated images sit in rich-content
 * field 7 (`[0][3][3]` = CDN url, `[0][3][2]` = alt text); images Gemini found
 * on the web sit in field 1 (`[0][0][0]` = url, `[0][4]` = alt text).
 *
 * The reply text only carries a `googleusercontent.com/...` placeholder for
 * each of them, which is not fetchable — the real asset is here.
 */
export function extractGeminiImages(candidate: unknown): GeminiWebImage[] {
  const images: GeminiWebImage[] = [];
  const push = (url: unknown, alt: unknown) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    if (images.some(image => image.url === url)) return;
    images.push({ url, ...(typeof alt === 'string' && alt ? { alt } : {}) });
  };

  const generated = richContentField(candidate, 7);
  if (Array.isArray(nested(generated, [0]))) {
    for (const entry of nested(generated, [0]) as unknown[]) {
      push(nested(entry, [0, 3, 3]), nested(entry, [0, 3, 2]));
    }
  }

  const webImages = richContentField(candidate, 1);
  if (Array.isArray(webImages)) {
    for (const entry of webImages) {
      push(nested(entry, [0, 0, 0]), nested(entry, [0, 4]));
    }
  }

  return images;
}

/**
 * Drop the unfetchable `googleusercontent.com/...` placeholder links Gemini
 * leaves in reply text where a rendered attachment belongs (generated image,
 * web-image collection, canvas card, …).
 */
export function stripGeminiPlaceholders(text: string): string {
  if (!text) return '';
  return text
    .replace(/https?:\/\/googleusercontent\.com\/\S*/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Parse a single `wrb.fr` or batchexecute JSON line and extract the cumulative candidate. */
export function extractGeminiStreamText(
  line: string,
): { text?: string; errorCode?: number; images?: GeminiWebImage[] } {
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
        const text = typeof textParts?.[0] === 'string' ? (textParts[0] as string) : undefined;
        const images = extractGeminiImages(firstCandidate);
        if (text !== undefined || images.length > 0) {
          return { ...(text !== undefined ? { text } : {}), ...(images.length > 0 ? { images } : {}) };
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

interface ExtractedGeminiImage {
  fileName: string;
  mimeType: string;
  data: Buffer;
}

interface UploadedGeminiImage {
  path: string;
  fileName: string;
}

function extractGeminiWebImages(messages: ChatMessage[]): ExtractedGeminiImage[] {
  const images: ExtractedGeminiImage[] = [];
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
        throw new GeminiWebChatError('Gemini Web images must be base64 data URLs (PNG, JPEG, WebP, or GIF).', 400);
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

async function uploadGeminiWebImages(
  images: ExtractedGeminiImage[],
  platform: Platform,
  externalSignal?: AbortSignal,
): Promise<UploadedGeminiImage[]> {
  const uploaded: UploadedGeminiImage[] = [];
  for (const image of images) {
    const boundary = `----freellmapiGemini${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${image.fileName}"\r\nContent-Type: ${image.mimeType}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, image.data, tail]);

    const { signal, cleanup } = createRequestSignal(REQUEST_TIMEOUT_MS, externalSignal);
    try {
      await assertProviderUrlAllowed(GEMINI_UPLOAD_URL);
      const res = await proxyFetch(
        GEMINI_UPLOAD_URL,
        {
          method: 'POST',
          headers: {
            'Push-ID': GEMINI_PUSH_ID,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'User-Agent': BROWSER_USER_AGENT,
          },
          body,
          redirect: 'manual',
          signal,
        },
        platform,
        'chat',
      );
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new GeminiWebChatError(
          `Gemini Web image upload failed (HTTP ${res.status}): ${errText.slice(0, 200) || res.statusText}`,
          res.status,
        );
      }
      const path = (await res.text()).trim();
      if (!path) {
        throw new GeminiWebChatError('Gemini Web image upload returned an empty path.', 502);
      }
      uploaded.push({ path, fileName: image.fileName });
    } finally {
      cleanup();
    }
  }
  return uploaded;
}

function isGeminiImageModel(modelId?: string): boolean {
  return Boolean(modelId && /image/i.test(modelId));
}

/** Read one stream chunk while enforcing TTFT/stall timeout, total deadline, and caller abort. */
async function readWithStallTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  inactivityTimeoutMs: number,
  deadlineAt: number,
  signal?: AbortSignal,
  timeoutMessage = 'Gemini Web stream stalled waiting for data',
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  if (signal?.aborted) {
    void reader.cancel().catch(() => {});
    throw abortReasonError(signal);
  }
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    void reader.cancel().catch(() => {});
    throw new GeminiWebChatError('Gemini Web stream timed out.', 504);
  }
  const waitMs = inactivityTimeoutMs > 0
    ? Math.max(1, Math.min(inactivityTimeoutMs, remainingMs))
    : Math.max(1, remainingMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        if (Number.isFinite(waitMs)) {
          timer = setTimeout(() => {
            const msg = remainingMs <= inactivityTimeoutMs
              ? 'Gemini Web stream timed out.'
              : `${timeoutMessage} (${waitMs}ms).`;
            reject(new GeminiWebChatError(msg, 504));
            void reader.cancel().catch(() => {});
          }, waitMs);
          timer.unref?.();
        }
        if (signal) {
          onAbort = () => {
            reject(abortReasonError(signal));
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

export async function* streamGeminiWebChat(
  opts: GeminiWebChatOptions,
): AsyncGenerator<{ content?: string }> {
  let activeCookie = resolveLiveCookieHeader(normalizeGeminiWebCookie(opts.credential));
  const origin = resolveOrigin(opts.baseUrl);
  const platform: Platform = opts.platform && opts.platform !== 'custom' ? opts.platform : GEMINI_PLATFORM;
  const onCredentialUpdate = opts.options?.onCredentialUpdate;
  const externalSignal = opts.options?.signal;
  const images = extractGeminiWebImages(opts.messages);
  const rawPrompt = buildConversationPrompt(opts.messages);
  const prompt = rawPrompt.trim() || (images.length > 0 ? 'Describe or analyze this image.' : 'Hello');

  const requestedTimeoutMs = opts.options?.timeoutMs;
  const totalTimeoutMs = requestedTimeoutMs === 0
    ? Infinity
    : (requestedTimeoutMs && requestedTimeoutMs > 0 ? requestedTimeoutMs : COMPLETION_TIMEOUT_MS);
  const connectTimeoutMs = Number.isFinite(totalTimeoutMs)
    ? Math.min(STREAM_CONNECT_TIMEOUT_MS, totalTimeoutMs)
    : STREAM_CONNECT_TIMEOUT_MS;
  const ttftTimeoutMs = Number.isFinite(totalTimeoutMs)
    ? Math.min(STREAM_TTFT_TIMEOUT_MS, totalTimeoutMs)
    : STREAM_TTFT_TIMEOUT_MS;
  const stallTimeoutMs = Number.isFinite(totalTimeoutMs)
    ? Math.min(STREAM_READ_STALL_TIMEOUT_MS, totalTimeoutMs)
    : STREAM_READ_STALL_TIMEOUT_MS;
  const deadlineAt = Number.isFinite(totalTimeoutMs) ? Date.now() + totalTimeoutMs : Infinity;

  const initialBudgetMs = Number.isFinite(deadlineAt) ? Math.max(1, deadlineAt - Date.now()) : undefined;
  let sessionResult = await fetchGeminiSession(
    activeCookie,
    origin,
    platform,
    externalSignal,
    { timeoutMs: initialBudgetMs, onCredentialUpdate },
  );
  activeCookie = sessionResult.cookieHeader;
  let session = sessionResult.session;
  let fromCache = sessionResult.fromCache;

  const uploadedImages = images.length > 0
    ? await uploadGeminiWebImages(images, platform, externalSignal)
    : [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const query = new URLSearchParams({
      hl: 'en',
      _reqid: String(nextReqId()),
      rt: 'c',
    });
    if (session.cfb2h) query.set('bl', session.cfb2h);
    if (session.fdrfje) query.set('f.sid', session.fdrfje);

    const streamUrl = `${origin}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${query.toString()}`;
    const messageEntry = uploadedImages.length > 0
      ? [prompt, 0, null, uploadedImages.map(item => [[item.path, 1], item.fileName])]
      : [prompt];
    const reqPayload = [null, JSON.stringify([messageEntry, null, null])];
    const formBody = new URLSearchParams({
      'f.req': JSON.stringify(reqPayload),
      at: session.snlm0e,
    }).toString();

    const attemptConnectMs = Number.isFinite(deadlineAt)
      ? Math.max(1, Math.min(connectTimeoutMs, deadlineAt - Date.now()))
      : connectTimeoutMs;
    const streamController = new AbortController();
    let connectTimedOut = false;
    const connectTimer = setTimeout(() => {
      connectTimedOut = true;
      streamController.abort(new GeminiWebChatError(`Gemini Web StreamGenerate connect timed out after ${attemptConnectMs}ms.`, 504));
    }, attemptConnectMs);
    connectTimer.unref?.();

    const onExternalAbort = () => streamController.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) {
        streamController.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    let shouldRetryWithFreshSession = false;
    let shouldRotateBeforeRetry = false;

    try {
      let res: Response;
      try {
        await assertProviderUrlAllowed(streamUrl);
        res = await proxyFetch(
          streamUrl,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              Cookie: activeCookie,
              Origin: origin,
              Referer: `${origin}/`,
              'User-Agent': BROWSER_USER_AGENT,
              'X-Same-Domain': '1',
            },
            body: formBody,
            redirect: 'manual',
            signal: streamController.signal,
          },
          platform,
          'chat',
        );
      } catch (err) {
        if (connectTimedOut && !externalSignal?.aborted) {
          throw new GeminiWebChatError(`Gemini Web StreamGenerate connect timed out after ${attemptConnectMs}ms.`, 504);
        }
        throw err;
      } finally {
        clearTimeout(connectTimer);
      }

      if (isGoogleCookieUrl(streamUrl, origin) && (!res.url || isGoogleCookieUrl(res.url, origin))) {
        const { nextHeader, changed } = mergeResponseCookies(activeCookie, res);
        if (changed) {
          recordRotatedCookie(activeCookie, nextHeader, origin, onCredentialUpdate);
          activeCookie = nextHeader;
        }
      }

      if ((res.status >= 300 && res.status < 400) || (res.url && isGoogleAuthRedirectUrl(res.url))) {
        await res.body?.cancel().catch(() => {});
        sessionCache.delete(`${origin}::${activeCookie}`);
        if (attempt === 0 && !externalSignal?.aborted) {
          shouldRetryWithFreshSession = true;
          shouldRotateBeforeRetry = true;
        } else {
          throw new GeminiWebChatError(
            'Gemini Web session is not signed in; refresh your __Secure-1PSID / __Secure-1PSIDTS cookies.',
            401,
          );
        }
      } else if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const isAuthStatus = res.status === 401 || res.status === 403;
        const isBootstrapStatus = isAuthStatus || res.status === 400;
        if (isBootstrapStatus) {
          sessionCache.delete(`${origin}::${activeCookie}`);
        }
        if (attempt === 0 && !externalSignal?.aborted && (isAuthStatus || (fromCache && res.status === 400))) {
          shouldRetryWithFreshSession = true;
          shouldRotateBeforeRetry = isAuthStatus;
        } else {
          throw new GeminiWebChatError(
            `Gemini Web stream error (HTTP ${res.status}): ${errText.slice(0, 240) || res.statusText}`,
            res.status,
          );
        }
      }

      if (!shouldRetryWithFreshSession) {
        const contentType = res.headers.get('content-type') ?? '';
        if (contentType.includes('text/html')) {
          sessionCache.delete(`${origin}::${activeCookie}`);
          await res.body?.cancel().catch(() => {});
          if (attempt === 0 && !externalSignal?.aborted) {
            shouldRetryWithFreshSession = true;
            shouldRotateBeforeRetry = true;
          } else {
            throw new GeminiWebChatError(
              'Gemini Web returned an HTML page instead of a stream; refresh your __Secure-1PSID / __Secure-1PSIDTS cookies.',
              403,
            );
          }
        }
      }

      if (!shouldRetryWithFreshSession) {
        const reader = res.body?.getReader();
        if (!reader) {
          throw new GeminiWebChatError('Gemini Web: empty response body.', 502);
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let emittedText = '';
        let sawRpcError: number | undefined;
        const replyImages: GeminiWebImage[] = [];
        const ttftDeadlineAt = Date.now() + ttftTimeoutMs;

        const processLine = (rawLine: string): string | null => {
          const trimmed = rawLine.trim();
          if (!trimmed) return null;
          if (!emittedText && looksLikeHtmlDocument(trimmed)) {
            sessionCache.delete(`${origin}::${activeCookie}`);
            throw new GeminiWebChatError(
              'Gemini Web returned an HTML page instead of a stream; refresh your __Secure-1PSID / __Secure-1PSIDTS cookies.',
              403,
            );
          }
          const { text, errorCode, images: frameImages } = extractGeminiStreamText(trimmed);
          if (errorCode !== undefined) {
            sawRpcError = errorCode;
          }
          for (const image of frameImages ?? []) {
            // The reply text only names the placeholder; remember the real asset and
            // rewrite it once the stream ends.
            if (!replyImages.some(existing => existing.url === image.url)) replyImages.push(image);
          }
          if (text !== undefined) {
            const cumulative = stripGeminiPlaceholders(text);
            if (cumulative.length > emittedText.length) {
              const delta = cumulative.startsWith(emittedText) ? cumulative.slice(emittedText.length) : cumulative;
              emittedText = cumulative;
              return delta;
            }
          }
          return null;
        };

        try {
          while (true) {
            const awaitingFirstContent = !emittedText && replyImages.length === 0 && sawRpcError === undefined;
            const readTimeoutMs = awaitingFirstContent ? ttftTimeoutMs : stallTimeoutMs;
            const readDeadline = awaitingFirstContent ? Math.min(deadlineAt, ttftDeadlineAt) : deadlineAt;
            const { done, value } = await readWithStallTimeout(
              reader,
              readTimeoutMs,
              readDeadline,
              streamController.signal,
              awaitingFirstContent
                ? 'Gemini Web stream TTFT timed out'
                : 'Gemini Web stream stalled waiting for data',
            );
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
        } catch (err) {
          if (
            attempt === 0 &&
            !emittedText &&
            !externalSignal?.aborted &&
            err instanceof GeminiWebChatError &&
            err.status === 403
          ) {
            shouldRetryWithFreshSession = true;
            shouldRotateBeforeRetry = true;
          } else {
            throw err;
          }
        } finally {
          reader.cancel().catch(() => {});
        }

        if (!shouldRetryWithFreshSession) {
          if (replyImages.length > 0 && !externalSignal?.aborted) {
            // The console blocks cross-origin images (CSP `img-src 'self' data:`)
            // and the CDN needs the account's cookies, so re-host the picture and
            // point the markdown at our own origin. Bound text-model turns tightly
            // so slow image CDNs never block text chat; if the download fails or
            // times out, fall back to the provider URL as a plain link.
            const isPrimaryImageTurn = isGeminiImageModel(opts.modelId) || !emittedText;
            const baseImageTimeoutMs = isPrimaryImageTurn
              ? IMAGE_FETCH_TIMEOUT_PRIMARY_MS
              : IMAGE_FETCH_TIMEOUT_TEXT_MS;
            const imageFetchTimeoutMs = Number.isFinite(deadlineAt)
              ? Math.max(1, Math.min(baseImageTimeoutMs, deadlineAt - Date.now()))
              : baseImageTimeoutMs;
            const inlineLimit = isPrimaryImageTurn ? replyImages.length : MAX_INLINE_TEXT_IMAGES;

            const imageMarkdown = await Promise.all(
              replyImages.map(async (image, idx) => {
                const alt = (image.alt?.trim() || 'Generated image').replace(/[[\]]/g, '');
                if (idx >= inlineLimit) {
                  return `[${alt}](${image.url})`;
                }
                const { signal: imgSignal, cleanup: cleanupImg } = createRequestSignal(
                  imageFetchTimeoutMs,
                  externalSignal,
                );
                try {
                  const downloaded = await raceWithSignal(
                    downloadProviderImage(image.url, activeCookie, imgSignal),
                    imgSignal,
                  ).catch(() => null);
                  const id = downloaded
                    ? storePlaygroundMedia(downloaded.bytes, downloaded.contentType)
                    : null;
                  return id
                    ? `![${alt}](${playgroundMediaUrl(id)})`
                    : `[${alt}](${image.url})`;
                } finally {
                  cleanupImg();
                }
              }),
            );
            if (externalSignal?.aborted) return;
            yield { content: `${emittedText ? '\n\n' : ''}${imageMarkdown.join('\n\n')}` };
          }

          if (!emittedText && replyImages.length === 0) {
            if (sawRpcError !== undefined) {
              sessionCache.delete(`${origin}::${activeCookie}`);
              if (attempt === 0 && !externalSignal?.aborted && (sawRpcError === 16 || fromCache)) {
                shouldRetryWithFreshSession = true;
                shouldRotateBeforeRetry = sawRpcError === 16;
              } else {
                throw new GeminiWebChatError(
                  `Gemini Web RPC error (code ${sawRpcError}); refresh your __Secure-1PSID / __Secure-1PSIDTS cookies or try again.`,
                  sawRpcError === 16 ? 401 : 502,
                );
              }
            } else if (attempt === 0 && fromCache && !externalSignal?.aborted) {
              sessionCache.delete(`${origin}::${activeCookie}`);
              shouldRetryWithFreshSession = true;
            } else {
              throw new GeminiWebChatError(
                'Gemini Web returned no response text; refresh your __Secure-1PSID / __Secure-1PSIDTS cookies.',
                502,
              );
            }
          } else {
            return;
          }
        }
      }
    } finally {
      clearTimeout(connectTimer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }

    if (shouldRetryWithFreshSession) {
      if (shouldRotateBeforeRetry) {
        const rotated = await rotateGeminiCookies(activeCookie, platform, externalSignal, { force: true });
        if (rotated.rotated) {
          recordRotatedCookie(activeCookie, rotated.cookieHeader, origin, onCredentialUpdate);
          activeCookie = rotated.cookieHeader;
        }
      }
      const remainingRetryMs = Number.isFinite(deadlineAt) ? Math.max(1, deadlineAt - Date.now()) : undefined;
      sessionResult = await fetchGeminiSession(
        activeCookie,
        origin,
        platform,
        externalSignal,
        { forceRefresh: true, timeoutMs: remainingRetryMs, onCredentialUpdate },
      );
      activeCookie = sessionResult.cookieHeader;
      session = sessionResult.session;
      fromCache = sessionResult.fromCache;
    }
  }
}

export async function probeGeminiWebSession(opts: {
  credential: string;
  baseUrl?: string;
  platform?: Platform;
  signal?: AbortSignal;
  onCredentialUpdate?: (next: string) => void;
}): Promise<void> {
  const cookieHeader = normalizeGeminiWebCookie(opts.credential);
  const origin = resolveOrigin(opts.baseUrl);
  const platform: Platform = opts.platform && opts.platform !== 'custom' ? opts.platform : GEMINI_PLATFORM;
  await fetchGeminiSession(
    cookieHeader,
    origin,
    platform,
    opts.signal,
    { forceRefresh: true, onCredentialUpdate: opts.onCredentialUpdate },
  );
}

/** Validate a Gemini Web cookie credential by normalizing, rotating if needed, and probing `/app` for `SNlM0e`. */
export async function validateGeminiWebSession(
  rawCookie: string,
  options?: {
    baseUrl?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onCredentialUpdate?: (credential: string) => void;
  },
): Promise<KeyValidationResult> {
  let cookieHeader: string;
  try {
    cookieHeader = normalizeGeminiWebCookie(rawCookie);
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'Invalid Gemini Web credential.',
    };
  }
  const origin = resolveOrigin(options?.baseUrl);
  try {
    await fetchGeminiSession(
      cookieHeader,
      origin,
      GEMINI_PLATFORM,
      options?.signal,
      {
        forceRefresh: true,
        timeoutMs: options?.timeoutMs,
        onCredentialUpdate: options?.onCredentialUpdate,
      },
    );
    return true;
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'Gemini Web session validation failed.',
    };
  }
}

export async function runGeminiWebChat(opts: GeminiWebChatOptions): Promise<string> {
  let combined = '';
  for await (const delta of streamGeminiWebChat(opts)) {
    if (delta.content) combined += delta.content;
  }
  return combined;
}
