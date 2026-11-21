// ChatGPT Web image generation (port of 9Router's picture_v2 HTTP flow).
//
// The web cookie alone is not enough for chatgpt.com/backend-api: the browser
// exchanges it for a session access token, solves the Sentinel challenge, then
// runs prepare -> conversation SSE -> conversation poll -> file download. This
// module keeps that whole chain on plain HTTP so no browser is needed.
import crypto from 'node:crypto';
import type { Platform } from '@freellmapi/shared/types.js';
import { proxyFetch } from '../../lib/proxy.js';
import { looksLikeCookieHeader } from './cookie-format.js';

const DEFAULT_BASE_URL = 'https://chatgpt.com';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MAX_SSE_BYTES = 16 * 1024 * 1024;
const MAX_CONVERSATION_BYTES = 32 * 1024 * 1024;
const SSE_DEADLINE_MS = 90_000;
const POLL_INITIAL_WAIT_MS = 5_000;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 240_000;
const DOWNLOAD_TIMEOUT_MS = 90_000;

const CONTENT_POLICY_RE =
  /(content policy|violat(?:es|ed|ion)|can't create|cannot create|i can't generate|i cannot generate|not able to create|unable to create|safety)/i;

/** A token expiring within this margin is treated as expired: Sentinel would 401 it mid-turn. */
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 120_000;

/** Actionable message surfaced when the web session can no longer mint a usable token. */
const SESSION_EXPIRED_MESSAGE = 'ChatGPT Web session expired — refresh the web session cookie';

/** Upstream markers for an expired access token (401 body from Sentinel). */
const TOKEN_EXPIRED_RE = /token_expired|authentication token is expired/i;

const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_TZ_OFFSET_MIN = 0;
const CACHE_MAX_SIZE = 100;

const rotatedCookieMap = new Map<string, string>();
const rotateInFlight = new Map<string, Promise<RotateChatGptWebSessionResult>>();

/** Clear in-memory ChatGPT Web cookie rotation caches (used by tests). */
export function clearChatGptWebCaches(): void {
  rotatedCookieMap.clear();
  rotateInFlight.clear();
}

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= CACHE_MAX_SIZE && !map.has(key)) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, value);
}

const SENTINEL_HEADERS = {
  prepare: 'OpenAI-Sentinel-Chat-Requirements-Prepare-Token',
  requirements: 'OpenAI-Sentinel-Chat-Requirements-Token',
  proof: 'OpenAI-Sentinel-Proof-Token',
  turnstile: 'OpenAI-Sentinel-Turnstile-Token',
} as const;

const PREPARE_PREFIX = 'gAAAAAC';
const PROOF_PREFIX = 'gAAAAAB';
const PROOF_SUFFIX = '~S';
const MAX_POW_ITERATIONS = 500_000;

export interface ChatGptWebImage {
  b64_json: string;
  mime_type?: string;
}

export interface ChatGptWebImageResult {
  created: number;
  data: ChatGptWebImage[];
}

export interface ChatGptWebImageOptions {
  /** Stored account credential: cookie header, bare session token, or storage-state JSON. */
  credential: string;
  prompt: string;
  n?: number;
  size?: string;
  baseUrl?: string;
  platform?: Platform;
  userAgent?: string;
  signal?: AbortSignal;
  onCredentialUpdate?: (next: string) => void;
}

export interface RotateChatGptWebSessionResult {
  cookieHeader: string;
  accessToken: string;
  rotated: boolean;
}

interface ImageContext {
  baseUrl: string;
  accessToken: string;
  cookie: string;
  userAgent: string;
  platform: Platform;
  sentinel: Record<string, string>;
}

class ChatGptWebImageError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ChatGptWebImageError';
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Upstream HTTP status carried by a chatgpt-web image failure, if any.
 *
 * The route handlers report `err.status` instead of a blanket 502 so callers
 * see 401 (expired cookie), 429 (image quota) or 400 (content policy) exactly
 * like 9Router's image handler does.
 */
export function chatGptWebImageErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600
    ? status
    : undefined;
}

function sanitizeCookiePart(raw: string): string {
  return raw.replace(/[\r\n\0]+/g, '');
}

function isChatGptCookieDomain(domain: unknown): boolean {
  if (domain === undefined || domain === null) return true;
  if (typeof domain !== 'string') return false;
  const host = domain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  if (!host) return true;
  return (
    host === 'chatgpt.com'
    || host.endsWith('.chatgpt.com')
    || host === 'openai.com'
    || host.endsWith('.openai.com')
  );
}

function isSessionTokenCookieName(name: string): boolean {
  return name === '__Secure-next-auth.session-token' || name.startsWith('__Secure-next-auth.session-token.');
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
    const value = sanitizeCookiePart(part.slice(eq + 1)).trim();
    if (!name || /[=;]/.test(name)) continue;
    cookies.set(name, value);
  }
  return cookies;
}

function formatCookieHeader(cookies: Map<string, string>): string {
  return Array.from(cookies.entries(), ([name, value]) => `${name}=${value}`).join('; ');
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

function getSetCookieValues(headers: Headers | undefined | null): string[] {
  if (!headers) return [];
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    const list = withGetSetCookie.getSetCookie();
    if (Array.isArray(list) && list.length > 0) {
      return list.flatMap(splitCombinedSetCookie);
    }
  }
  const single = typeof headers.get === 'function' ? headers.get('set-cookie') : null;
  return single ? splitCombinedSetCookie(single) : [];
}

function isSetCookieDeletion(attrs: string[], value: string, nowMs: number): boolean {
  if (!value || value.toLowerCase() === 'deleted') return true;
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

/** Merge rotated `Set-Cookie` headers from a ChatGPT response into `cookieHeader`. */
export function mergeChatGptWebResponseCookies(
  cookieHeader: string,
  res: Pick<Response, 'headers'>,
): { nextHeader: string; changed: boolean } {
  const setCookies = getSetCookieValues(res?.headers);
  if (setCookies.length === 0) {
    return { nextHeader: cookieHeader, changed: false };
  }

  const cookies = parseCookieHeader(cookieHeader);
  const nowMs = Date.now();
  const parsedEntries: Array<{ name: string; value: string; deleted: boolean }> = [];
  const setSessionNames = new Set<string>();
  let sawUnchunkedSession = false;
  let sawChunkedSession = false;

  for (const raw of setCookies) {
    const segments = raw.split(';');
    const pair = segments[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = sanitizeCookiePart(pair.slice(0, eq)).trim();
    const value = sanitizeCookiePart(pair.slice(eq + 1)).trim();
    if (!name || /[=;]/.test(name)) continue;

    const attrs = segments.slice(1);
    const domain = getSetCookieDomain(attrs);
    if (domain !== undefined && !isChatGptCookieDomain(domain)) continue;

    const deleted = isSetCookieDeletion(attrs, value, nowMs);
    parsedEntries.push({ name, value, deleted });
    if (!deleted && isSessionTokenCookieName(name)) {
      setSessionNames.add(name);
      if (name === '__Secure-next-auth.session-token') {
        sawUnchunkedSession = true;
      } else {
        sawChunkedSession = true;
      }
    }
  }

  if (parsedEntries.length === 0) {
    return { nextHeader: cookieHeader, changed: false };
  }

  let changed = false;
  for (const entry of parsedEntries) {
    if (entry.deleted) {
      if (isSessionTokenCookieName(entry.name)) {
        const hasOtherSessionCookie =
          Array.from(cookies.keys()).some(k => k !== entry.name && isSessionTokenCookieName(k))
          || Array.from(setSessionNames).some(k => k !== entry.name);
        if (hasOtherSessionCookie && cookies.delete(entry.name)) {
          changed = true;
        }
      } else if (cookies.delete(entry.name)) {
        changed = true;
      }
      continue;
    }

    if (cookies.get(entry.name) !== entry.value) {
      cookies.set(entry.name, entry.value);
      changed = true;
    }
  }

  if (sawUnchunkedSession && !sawChunkedSession) {
    for (const name of Array.from(cookies.keys())) {
      if (name.startsWith('__Secure-next-auth.session-token.') && cookies.delete(name)) {
        changed = true;
      }
    }
  } else if (sawChunkedSession && !sawUnchunkedSession) {
    if (cookies.delete('__Secure-next-auth.session-token')) {
      changed = true;
    }
  }

  return {
    nextHeader: changed ? formatCookieHeader(cookies) : cookieHeader,
    changed,
  };
}

/** Resolve the latest rotated cookie header known in-process for `cookieHeader`. */
export function resolveLiveChatGptWebCookie(cookieHeader: string): string {
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

/** Record an in-process cookie rotation and notify persistence without aborting active calls. */
export function recordRotatedChatGptWebCookie(
  prevHeader: string,
  nextHeader: string,
  onCredentialUpdate?: (next: string) => void,
): void {
  if (!nextHeader || prevHeader === nextHeader) return;
  setBoundedMap(rotatedCookieMap, prevHeader, nextHeader);
  if (onCredentialUpdate) {
    try {
      onCredentialUpdate(nextHeader);
    } catch {
      // Persistence failures must never abort an active ChatGPT Web request.
    }
  }
}

/** Normalize whatever the operator pasted into a Cookie header. */
export function normalizeChatGptWebCookie(rawCredential: string): string {
  const trimmed = sanitizeCookiePart(rawCredential)
    .trim()
    .replace(/^(?:Cookie|Authorization):\s*/i, '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  if (!trimmed) throw new ChatGptWebImageError('ChatGPT Web credential is empty', 401);

  // Full Playwright storage state ({ cookies: [...] }), cookie-editor JSON array,
  // flat { name: value } cookie maps, or { sessionToken } / { accessToken } JSON.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ChatGptWebImageError('ChatGPT Web storage state JSON is invalid', 400);
    }

    let rawCookies: Array<Record<string, unknown>> | null = null;
    if (Array.isArray(parsed)) {
      rawCookies = parsed.filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && !Array.isArray(c));
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.cookies)) {
        rawCookies = obj.cookies.filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && !Array.isArray(c));
      } else if (typeof obj.sessionToken === 'string' && obj.sessionToken.trim()) {
        return `__Secure-next-auth.session-token=${sanitizeCookiePart(obj.sessionToken.trim())}`;
      } else {
        const kvEntries = Object.entries(obj).filter(([, val]) => typeof val === 'string');
        const hasSessionCookieKey = Object.keys(obj).some(k => isSessionTokenCookieName(k));
        if (!hasSessionCookieKey && typeof obj.accessToken === 'string' && obj.accessToken.trim() && kvEntries.length === 1) {
          return `__Secure-next-auth.session-token=${sanitizeCookiePart(obj.accessToken.trim())}`;
        }
        if (kvEntries.length > 0 && kvEntries.length === Object.keys(obj).length) {
          rawCookies = kvEntries.map(([name, value]) => ({ name, value }));
        } else if (typeof obj.accessToken === 'string' && obj.accessToken.trim()) {
          return `__Secure-next-auth.session-token=${sanitizeCookiePart(obj.accessToken.trim())}`;
        }
      }
    }

    if (!rawCookies) {
      throw new ChatGptWebImageError('ChatGPT Web storage state JSON contains no cookies', 400);
    }

    const nowMs = Date.now();
    const deduped = new Map<string, { value: string; specificity: number }>();
    for (const cookie of rawCookies) {
      if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue;
      const name = sanitizeCookiePart(cookie.name).trim();
      const value = sanitizeCookiePart(cookie.value).trim();
      if (!name || /[=;]/.test(name)) continue;
      if (!isChatGptCookieDomain(cookie.domain)) continue;
      if (!isSessionTokenCookieName(name) && isExpiredCookie(cookie, nowMs)) continue;

      const specificity = cookieSpecificity(cookie);
      const existing = deduped.get(name);
      if (!existing || specificity >= existing.specificity) {
        deduped.set(name, { value, specificity });
      }
    }

    const header = Array.from(deduped.entries(), ([name, entry]) => `${name}=${entry.value}`).join('; ');
    if (!header) throw new ChatGptWebImageError('ChatGPT Web credential contains no cookies', 401);
    return header;
  }

  // Bare session-token value — no `name=` prefix. Base64 padding is not a
  // cookie pair, so only real `name=value` shapes pass through untouched.
  if (!looksLikeCookieHeader(trimmed)) {
    return `__Secure-next-auth.session-token=${trimmed}`;
  }

  // Full Cookie header, including chunked (`...session-token.0=`, `.1=`).
  const parsedJar = parseCookieHeader(trimmed);
  const header = formatCookieHeader(parsedJar);
  if (!header) throw new ChatGptWebImageError('ChatGPT Web credential contains no cookies', 401);
  return header;
}

/** Exchange the web cookie for the access token /backend-api expects. */
export async function fetchChatGptWebAccessToken(
  cookie: string,
  userAgent: string,
  baseUrl: string,
  platform: Platform,
  signal?: AbortSignal,
  onCredentialUpdate?: (next: string) => void,
): Promise<string> {
  const liveCookie = resolveLiveChatGptWebCookie(cookie);
  let res: Response;
  try {
    res = await webFetch(
      `${baseUrl}/api/auth/session`,
      {
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/json',
          Referer: `${baseUrl}/`,
          ...(liveCookie ? { Cookie: liveCookie } : {}),
        },
      },
      30_000,
      platform,
      signal,
    );
  } catch (err) {
    // A signed-out session redirects to /auth/login. proxyFetch refuses to
    // follow redirects for `custom` accounts, so surface that as expired auth
    // instead of a generic transport failure.
    if (err instanceof Error && /upstream redirected/i.test(err.message)) {
      throw new ChatGptWebImageError('ChatGPT Web session expired (auth redirect)', 401);
    }
    throw err;
  }
  if (!res.ok) {
    throw new ChatGptWebImageError(
      `ChatGPT session unavailable (HTTP ${res.status})`,
      res.status === 403 ? 401 : res.status || 502,
    );
  }
  const body = await res.json().catch(() => null) as { accessToken?: unknown } | null;
  if (typeof body?.accessToken !== 'string' || !body.accessToken) {
    throw new ChatGptWebImageError('ChatGPT session is not signed in', 401);
  }
  const merged = mergeChatGptWebResponseCookies(liveCookie, res);
  if (merged.changed) {
    recordRotatedChatGptWebCookie(liveCookie, merged.nextHeader, onCredentialUpdate);
  }
  return body.accessToken;
}

/**
 * `exp` (ms since epoch) of a JWT access token, or null when the token is
 * opaque / has no numeric `exp`. Only reads the expiry — never verifies the
 * signature, the token is already trusted because it came from /api/auth/session.
 */
export function getChatGptWebAccessTokenExpiryMs(accessToken: string): number | null {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** True when the token is already expired or expires within `marginMs`. Unknown expiry never counts as expiring. */
export function isChatGptWebAccessTokenExpiringSoon(
  accessToken: string,
  marginMs: number = ACCESS_TOKEN_EXPIRY_MARGIN_MS,
): boolean {
  const expiresAt = getChatGptWebAccessTokenExpiryMs(accessToken);
  return expiresAt !== null && expiresAt - Date.now() < marginMs;
}

/**
 * Exchange the cookie for an access token that is still usable. The session
 * endpoint can hand back a token that is already expired (or about to be), so
 * a token expiring within the safety margin triggers exactly one re-exchange;
 * if the session still only mints near-expiry tokens, the session itself is
 * dead and the caller gets an actionable error instead of a Sentinel 401.
 */
export async function fetchUsableChatGptWebAccessToken(
  cookie: string,
  userAgent: string,
  baseUrl: string,
  platform: Platform,
  signal?: AbortSignal,
  onCredentialUpdate?: (next: string) => void,
): Promise<string> {
  const first = await fetchChatGptWebAccessToken(
    resolveLiveChatGptWebCookie(cookie),
    userAgent,
    baseUrl,
    platform,
    signal,
    onCredentialUpdate,
  );
  if (!isChatGptWebAccessTokenExpiringSoon(first)) return first;
  const second = await fetchChatGptWebAccessToken(
    resolveLiveChatGptWebCookie(cookie),
    userAgent,
    baseUrl,
    platform,
    signal,
    onCredentialUpdate,
  );
  if (!isChatGptWebAccessTokenExpiringSoon(second)) return second;
  throw new ChatGptWebImageError(SESSION_EXPIRED_MESSAGE, 401);
}

/** True when an error is a Sentinel 401 caused by an expired access token (as opposed to any other 401). */
function isTokenExpiredError(error: unknown): boolean {
  const err = error as { status?: unknown; message?: unknown } | null;
  return err?.status === 401 && typeof err.message === 'string' && TOKEN_EXPIRED_RE.test(err.message);
}

/** Sentinel's 32-bit hash: FNV-1a with three avalanche rounds, 8 hex chars. */
export function sentinelHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x1000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0).toString(16).padStart(8, '0');
}

const encodeFingerprint = (slots: unknown[]) => Buffer.from(JSON.stringify(slots), 'utf8').toString('base64');

const SCRIPT_CANDIDATES = [
  'https://chatgpt.com/cdn/assets/685809.dec86dcdc1.js',
  'https://chatgpt.com/cdn/assets/399565.a1117ca8b4.js',
];
const DOCUMENT_KEYS = ['cookie', 'domain', 'readyState', 'title', 'URL', 'charset', 'location'];
const WINDOW_KEYS = ['caches', 'crypto', 'fetch', 'indexedDB', 'localStorage', 'origin'];
const NAV_PROTOTYPE = ['userAgent', 'language', 'hardwareConcurrency'];

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];

/** Build the 24-slot fingerprint array the bundle hashes. */
function buildFingerprint(userAgent: string): unknown[] {
  const navKey = pick(NAV_PROTOTYPE);
  return [
    1280 + 800,
    new Date().toString(),
    null,
    0,
    userAgent,
    pick(SCRIPT_CANDIDATES),
    null,
    'en-US',
    'en-US,en',
    0,
    `${navKey}\u2212${userAgent}`,
    pick(DOCUMENT_KEYS),
    pick(WINDOW_KEYS),
    0,
    crypto.randomUUID(),
    '',
    8,
    0,
    0, 0, 0, 0, 0, 0, 0,
  ];
}

/** `gAAAAAC…` — the prepare-token header value. */
export function buildPrepareToken(userAgent: string): string {
  const slots = buildFingerprint(userAgent);
  slots[3] = 1;
  slots[9] = 0;
  return `${PREPARE_PREFIX}${encodeFingerprint(slots)}`;
}

/** Solve a proof-of-work challenge. Returns `gAAAAAB<base64>~S`. */
export function solveProofOfWork({ seed, difficulty, userAgent }: {
  seed: string;
  difficulty: string;
  userAgent: string;
}): string {
  if (!seed || !difficulty) {
    throw new ChatGptWebImageError('ChatGPT sentinel asked for proof of work without seed/difficulty', 502);
  }
  const started = Date.now();
  const slots = buildFingerprint(userAgent);
  for (let counter = 0; counter < MAX_POW_ITERATIONS; counter++) {
    slots[3] = counter;
    slots[9] = Date.now() - started;
    const encoded = encodeFingerprint(slots);
    if (sentinelHash(`${seed}${encoded}`).slice(0, difficulty.length) <= difficulty) {
      return `${PROOF_PREFIX}${encoded}${PROOF_SUFFIX}`;
    }
  }
  throw new ChatGptWebImageError('ChatGPT sentinel proof of work exhausted its iteration budget', 502);
}

function sentinelRequest(
  url: string,
  headers: Record<string, string>,
  platform: Platform,
  signal?: AbortSignal,
): Promise<Response> {
  return webFetch(
    url,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({}),
    },
    60_000,
    platform,
    signal,
  );
}

/** Read a Sentinel JSON response, translating blocks and failures into typed errors. */
async function readSentinelJson(res: Response, path: string): Promise<Record<string, any>> {
  const text = await res.text().catch(() => '');
  if (res.status === 403 || /<!doctype|<html/i.test(text.trimStart())) {
    throw new ChatGptWebImageError(
      `ChatGPT ${path} was blocked by Cloudflare/Sentinel (HTTP ${res.status || 403}); configure a residential/SOCKS5 proxy on this account or refresh your cf_clearance/session cookies`,
      403,
    );
  }
  if (!res.ok) {
    throw new ChatGptWebImageError(`ChatGPT ${path} failed (HTTP ${res.status}) ${text.slice(0, 200)}`, res.status || 502);
  }
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw new ChatGptWebImageError(`ChatGPT ${path} returned invalid JSON`, 502);
  }
}

/** Run the Sentinel prepare step once and return its prepare_token. */
async function runSentinelPrepare({
  baseUrl,
  accessToken,
  cookie,
  userAgent,
  platform,
  signal,
  onCredentialUpdate,
}: {
  baseUrl: string;
  accessToken: string;
  cookie?: string;
  userAgent: string;
  platform: Platform;
  signal?: AbortSignal;
  onCredentialUpdate?: (next: string) => void;
}): Promise<string> {
  const activeCookie = cookie ? resolveLiveChatGptWebCookie(cookie) : undefined;
  const res = await sentinelRequest(
    `${baseUrl}/backend-api/sentinel/chat-requirements/prepare`,
    {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': userAgent,
      Origin: baseUrl,
      Referer: `${baseUrl}/`,
      ...(activeCookie ? { Cookie: activeCookie } : {}),
      [SENTINEL_HEADERS.prepare]: buildPrepareToken(userAgent),
    },
    platform,
    signal,
  );
  const prepared = await readSentinelJson(res, '/backend-api/sentinel/chat-requirements/prepare');
  if (activeCookie) {
    const merged = mergeChatGptWebResponseCookies(activeCookie, res);
    if (merged.changed) {
      recordRotatedChatGptWebCookie(activeCookie, merged.nextHeader, onCredentialUpdate);
    }
  }
  if (typeof prepared.prepare_token !== 'string' || !prepared.prepare_token) {
    throw new ChatGptWebImageError('ChatGPT sentinel prepare returned no prepare_token', 502);
  }
  return prepared.prepare_token;
}

/**
 * Lightweight Sentinel probe for health checks: only the prepare step, no
 * conversation and no proof-of-work. On a 401 `token_expired`, re-exchanges
 * `/api/auth/session` once and retries Sentinel prepare before reporting the
 * session expired so `validateKey` stays consistent with `fetchSentinelHeaders`.
 */
export async function probeChatGptWebSentinelPrepare({
  baseUrl,
  accessToken,
  cookie,
  userAgent,
  platform,
  signal,
  onCredentialUpdate,
  onAccessTokenUpdate,
}: {
  baseUrl: string;
  accessToken: string;
  cookie?: string;
  userAgent: string;
  platform: Platform;
  signal?: AbortSignal;
  onCredentialUpdate?: (next: string) => void;
  onAccessTokenUpdate?: (token: string) => void;
}): Promise<void> {
  try {
    await runSentinelPrepare({ baseUrl, accessToken, cookie, userAgent, platform, signal, onCredentialUpdate });
  } catch (err) {
    if (!isTokenExpiredError(err)) throw err;
    if (!cookie) throw new ChatGptWebImageError(SESSION_EXPIRED_MESSAGE, 401);
    const freshAccessToken = await fetchUsableChatGptWebAccessToken(
      resolveLiveChatGptWebCookie(cookie),
      userAgent,
      baseUrl,
      platform,
      signal,
      onCredentialUpdate,
    );
    onAccessTokenUpdate?.(freshAccessToken);
    try {
      await runSentinelPrepare({
        baseUrl,
        accessToken: freshAccessToken,
        cookie: resolveLiveChatGptWebCookie(cookie),
        userAgent,
        platform,
        signal,
        onCredentialUpdate,
      });
    } catch (retryErr) {
      if (isTokenExpiredError(retryErr)) {
        throw new ChatGptWebImageError(SESSION_EXPIRED_MESSAGE, 401);
      }
      throw retryErr;
    }
  }
}

/**
 * Run Sentinel prepare -> requirements and return the headers /backend-api needs.
 *
 * A 401 `token_expired` from either step means the access token the session
 * just minted was already dead (or died between the exchange and prepare).
 * In that case the token is re-exchanged once from the same cookie and the
 * whole prepare -> requirements sequence runs once more — never more, and
 * never for other 401s, 403 Cloudflare blocks, or 429s. If the retry also
 * fails with an expired token, the caller gets an actionable session-expired
 * error (still status 401, so the failover/cooldown layers keep recognising
 * it as an auth failure) instead of the raw upstream body.
 */
export async function fetchSentinelHeaders({
  baseUrl,
  accessToken,
  cookie,
  userAgent,
  platform,
  signal,
  onCredentialUpdate,
  onAccessTokenUpdate,
}: {
  baseUrl: string;
  accessToken: string;
  cookie?: string;
  userAgent: string;
  platform: Platform;
  signal?: AbortSignal;
  onCredentialUpdate?: (next: string) => void;
  onAccessTokenUpdate?: (token: string) => void;
}): Promise<Record<string, string>> {
  const attempt = async (token: string): Promise<Record<string, string>> => {
    const prepareToken = await runSentinelPrepare({
      baseUrl,
      accessToken: token,
      cookie,
      userAgent,
      platform,
      signal,
      onCredentialUpdate,
    });

    const activeCookie = cookie ? resolveLiveChatGptWebCookie(cookie) : undefined;
    const reqRes = await sentinelRequest(
      `${baseUrl}/backend-api/sentinel/chat-requirements`,
      {
        Authorization: `Bearer ${token}`,
        'User-Agent': userAgent,
        Origin: baseUrl,
        Referer: `${baseUrl}/`,
        ...(activeCookie ? { Cookie: activeCookie } : {}),
        [SENTINEL_HEADERS.prepare]: prepareToken,
      },
      platform,
      signal,
    );
    const requirements = await readSentinelJson(reqRes, '/backend-api/sentinel/chat-requirements');
    if (activeCookie) {
      const merged = mergeChatGptWebResponseCookies(activeCookie, reqRes);
      if (merged.changed) {
        recordRotatedChatGptWebCookie(activeCookie, merged.nextHeader, onCredentialUpdate);
      }
    }

    const tokens: Record<string, string> = {};
    if (typeof requirements.token === 'string') tokens[SENTINEL_HEADERS.requirements] = requirements.token;
    if (requirements.proofofwork?.required) {
      tokens[SENTINEL_HEADERS.proof] = solveProofOfWork({
        seed: String(requirements.proofofwork.seed ?? ''),
        difficulty: String(requirements.proofofwork.difficulty ?? ''),
        userAgent,
      });
    }
    return tokens;
  };

  try {
    return await attempt(accessToken);
  } catch (err) {
    if (!isTokenExpiredError(err)) throw err;
    if (!cookie) throw new ChatGptWebImageError(SESSION_EXPIRED_MESSAGE, 401);
    const freshAccessToken = await fetchUsableChatGptWebAccessToken(
      resolveLiveChatGptWebCookie(cookie),
      userAgent,
      baseUrl,
      platform,
      signal,
      onCredentialUpdate,
    );
    onAccessTokenUpdate?.(freshAccessToken);
    try {
      return await attempt(freshAccessToken);
    } catch (retryErr) {
      if (isTokenExpiredError(retryErr)) {
        throw new ChatGptWebImageError(SESSION_EXPIRED_MESSAGE, 401);
      }
      throw retryErr;
    }
  }
}

function authHeaders(ctx: ImageContext): Record<string, string> {
  return {
    ...ctx.sentinel,
    Authorization: `Bearer ${ctx.accessToken}`,
    'User-Agent': ctx.userAgent,
    Cookie: ctx.cookie,
  };
}

function request(url: string, init: RequestInit, timeoutMs: number, ctx: ImageContext, signal?: AbortSignal): Promise<Response> {
  return webFetch(url, init, timeoutMs, ctx.platform, signal);
}

/** proxyFetch plus a real timeout for the no-proxy path (which ignores timeoutMs). */
async function webFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  platform: Platform | undefined,
  outerSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await proxyFetch(url, { ...init, signal: controller.signal }, platform, 'image', timeoutMs);
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

/** Read an SSE body up to a byte cap, stopping at the deadline. */
async function readSse(response: Response, limit: number, deadlineMs: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + deadlineMs;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      text += decoder.decode(value, { stream: true });
      if (text.length > limit) break;
    }
  } catch {
    // A deadline abort lands here — the partial text is what we want.
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

function collectIds(text: string, fileIds: string[], sedimentIds: string[], directUrls?: string[]): void {
  const addUnique = (list: string[], value: string) => {
    if (value && !list.includes(value) && value !== 'file_upload') list.push(value);
  };
  for (const match of text.matchAll(/file-service:\/\/([A-Za-z0-9_-]+)/g)) addUnique(fileIds, match[1]);
  for (const match of text.matchAll(/\bfile-[A-Za-z0-9_-]{18,}\b/g)) addUnique(fileIds, match[0]);
  for (const match of text.matchAll(/\bfile_00000000[a-f0-9]{24}\b/g)) addUnique(fileIds, match[0]);
  for (const match of text.matchAll(/sediment:\/\/([A-Za-z0-9_-]+)/g)) addUnique(sedimentIds, match[1]);
  if (directUrls) {
    const unescaped = text.replace(/\\\//g, '/');
    for (const match of unescaped.matchAll(/https:\/\/[A-Za-z0-9.-]*oaiusercontent\.com\/[^\s"')>\\\]}]+/g)) {
      addUnique(directUrls, match[0]);
    }
  }
}

interface ConversationIds {
  conversationId: string;
  fileIds: string[];
  sedimentIds: string[];
  directUrls?: string[];
}

/** prepare -> conversation SSE. Returns the conversation id plus any ids seen. */
async function runImageConversation(
  ctx: ImageContext,
  prompt: string,
  sizeHint: string | undefined,
  signal?: AbortSignal,
): Promise<ConversationIds> {
  const headers = authHeaders(ctx);

  const prepare = await request(
    `${ctx.baseUrl}/backend-api/f/conversation/prepare`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        action: 'next',
        fork_from_shared_post: false,
        parent_message_id: crypto.randomUUID(),
        model: 'auto',
        client_prepare_state: 'success',
        timezone_offset_min: DEFAULT_TZ_OFFSET_MIN,
        timezone: DEFAULT_TIMEZONE,
        conversation_mode: { kind: 'primary_assistant' },
        system_hints: ['picture_v2'],
        partial_query: {
          id: crypto.randomUUID(),
          author: { role: 'user' },
          content: { content_type: 'text', parts: [prompt] },
        },
        supports_buffering: true,
        supported_encodings: ['v1'],
        client_contextual_info: { app_name: 'chatgpt.com' },
      }),
    },
    60_000,
    ctx,
    signal,
  );
  if (!prepare.ok) {
    throw new ChatGptWebImageError(`ChatGPT prepare failed (HTTP ${prepare.status})`, prepare.status || 502);
  }
  const prepareJson = await prepare.json().catch(() => null) as { conduit_token?: unknown } | null;
  const conduitToken = typeof prepareJson?.conduit_token === 'string' ? prepareJson.conduit_token : '';

  const text = sizeHint ? `${prompt} (aspect ratio ${sizeHint})` : prompt;
  const conversation = await request(
    `${ctx.baseUrl}/backend-api/f/conversation`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Conduit-Token': conduitToken,
        'X-Oai-Turn-Trace-Id': crypto.randomUUID(),
      },
      body: JSON.stringify({
        action: 'next',
        messages: [{
          id: crypto.randomUUID(),
          author: { role: 'user' },
          create_time: Date.now() / 1000,
          content: { content_type: 'text', parts: [text] },
          metadata: {
            developer_mode_connector_ids: [],
            selected_github_repos: [],
            selected_all_github_repos: false,
            system_hints: ['picture_v2'],
            serialization_metadata: { custom_symbol_offsets: [] },
          },
        }],
        parent_message_id: crypto.randomUUID(),
        model: 'auto',
        client_prepare_state: 'sent',
        timezone_offset_min: DEFAULT_TZ_OFFSET_MIN,
        timezone: DEFAULT_TIMEZONE,
        conversation_mode: { kind: 'primary_assistant' },
        enable_message_followups: true,
        system_hints: ['picture_v2'],
        supports_buffering: true,
        supported_encodings: ['v1'],
        client_contextual_info: {
          is_dark_mode: false,
          time_since_loaded: 1200,
          page_height: 1072,
          page_width: 1724,
          pixel_ratio: 1.2,
          screen_height: 1440,
          screen_width: 2560,
          app_name: 'chatgpt.com',
        },
        paragen_cot_summary_display_override: 'allow',
        force_parallel_switch: 'auto',
      }),
    },
    SSE_DEADLINE_MS + 15_000,
    ctx,
    signal,
  );
  if (!conversation.ok) {
    throw new ChatGptWebImageError(`ChatGPT conversation failed (HTTP ${conversation.status})`, conversation.status || 502);
  }
  const sseText = await readSse(conversation, MAX_SSE_BYTES, SSE_DEADLINE_MS);

  const conversationId = (sseText.match(/"conversation_id"\s*:\s*"([0-9a-f-]{36})"/) || [])[1] || '';
  const fileIds: string[] = [];
  const sedimentIds: string[] = [];
  const directUrls: string[] = [];
  collectIds(sseText, fileIds, sedimentIds, directUrls);
  return { conversationId, fileIds, sedimentIds, directUrls };
}

function isSameOriginUrl(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/** Signed asset URLs come from ChatGPT itself, so let normal redirects (CDN) work. */
async function downloadUrl(
  url: string,
  ctx: ImageContext,
  signal?: AbortSignal,
): Promise<{ b64: string; mime: string } | null> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': ctx.userAgent,
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    };
    if (isSameOriginUrl(url, ctx.baseUrl)) {
      headers.Authorization = `Bearer ${ctx.accessToken}`;
      if (ctx.cookie) headers.Cookie = ctx.cookie;
    }
    const res = await webFetch(
      url,
      { headers },
      DOWNLOAD_TIMEOUT_MS,
      ctx.platform,
      signal,
    );
    if (!res.ok) return null;
    const rawContentType = (res.headers.get('content-type') || '').toLowerCase();
    if (
      rawContentType &&
      !rawContentType.startsWith('image/') &&
      !rawContentType.startsWith('application/octet-stream')
    ) {
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) return null;
    return {
      b64: buffer.toString('base64'),
      mime: (res.headers.get('content-type') || 'image/png').split(';')[0],
    };
  } catch {
    return null;
  }
}

/** Query a ChatGPT download endpoint, following 30x redirects, direct image bodies, or JSON download_url. */
async function tryDownloadEndpoint(
  endpointUrl: string,
  ctx: ImageContext,
  signal?: AbortSignal,
): Promise<{ b64: string; mime: string } | null> {
  const jsonHeaders = { ...authHeaders(ctx), Accept: 'application/json' };
  const res = await request(
    endpointUrl,
    { headers: jsonHeaders, redirect: 'manual' },
    60_000,
    ctx,
    signal,
  ).catch(() => null);
  if (!res) return null;

  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.get('location');
    if (loc) {
      const targetUrl = loc.startsWith('/') ? `${ctx.baseUrl}${loc}` : loc;
      const media = await downloadUrl(targetUrl, ctx, signal);
      if (media) return media;
    }
  }

  if (res.ok) {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.startsWith('image/')) {
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length) {
        return {
          b64: buffer.toString('base64'),
          mime: contentType.split(';')[0],
        };
      }
    }
    const body = await res.json().catch(() => null) as { download_url?: unknown; url?: unknown } | null;
    const rawUrl = typeof body?.download_url === 'string' ? body.download_url : (typeof body?.url === 'string' ? body.url : '');
    if (rawUrl) {
      const targetUrl = rawUrl.startsWith('/') ? `${ctx.baseUrl}${rawUrl}` : rawUrl;
      const media = await downloadUrl(targetUrl, ctx, signal);
      if (media) return media;
    }
  }

  return null;
}

/** Try to resolve one generated id or URL into `{ b64, mime }`, or return null if not ready yet. */
async function tryDownloadGeneratedImage(
  ctx: ImageContext,
  conversationId: string,
  { fileIds, sedimentIds, directUrls }: { fileIds: string[]; sedimentIds: string[]; directUrls?: string[] },
  signal?: AbortSignal,
): Promise<{ b64: string; mime: string } | null> {
  if (directUrls) {
    for (const rawUrl of directUrls) {
      const targetUrl = rawUrl.startsWith('/') ? `${ctx.baseUrl}${rawUrl}` : rawUrl;
      const media = await downloadUrl(targetUrl, ctx, signal);
      if (media) return media;
    }
  }

  for (const fileId of fileIds) {
    if (fileId === 'file_upload') continue;
    const media = await tryDownloadEndpoint(`${ctx.baseUrl}/backend-api/files/${fileId}/download`, ctx, signal);
    if (media) return media;
  }

  for (const sedimentId of sedimentIds) {
    const media = await tryDownloadEndpoint(
      `${ctx.baseUrl}/backend-api/conversation/${conversationId}/attachment/${sedimentId}/download`,
      ctx,
      signal,
    );
    if (media) return media;
  }

  return null;
}

/** Poll the conversation document until an image_gen record is actually downloadable. */
async function pollAndDownloadConversationImages(
  ctx: ImageContext,
  conversationId: string,
  initial: ConversationIds,
  signal?: AbortSignal,
): Promise<{ b64: string; mime: string }> {
  const started = Date.now();
  const fileIds = [...initial.fileIds].filter(id => id !== 'file_upload');
  const sedimentIds = [...initial.sedimentIds];
  const directUrls = [...(initial.directUrls ?? [])];
  const headers = { ...authHeaders(ctx), Accept: 'application/json' };

  await sleep(POLL_INITIAL_WAIT_MS);
  while (Date.now() - started <= POLL_TIMEOUT_MS) {
    if (signal?.aborted) throw new Error('Request aborted');

    const res = await request(
      `${ctx.baseUrl}/backend-api/conversation/${conversationId}`,
      { headers },
      30_000,
      ctx,
      signal,
    ).catch(() => null);
    if (!res?.ok) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_CONVERSATION_BYTES) {
      throw new ChatGptWebImageError('ChatGPT conversation document is unexpectedly large', 502);
    }
    const text = await res.text().catch(() => '');
    if (text.length > MAX_CONVERSATION_BYTES) {
      throw new ChatGptWebImageError('ChatGPT conversation document is unexpectedly large', 502);
    }

    collectIds(text, fileIds, sedimentIds, directUrls);
    if (CONTENT_POLICY_RE.test(text) && /"is_error"\s*:\s*true/.test(text)) {
      throw new ChatGptWebImageError('ChatGPT refused the image request (content policy)', 400);
    }
    // A depleted account reports a tool-level rate limit instead of an image:
    // fail fast so the fallback loop can try the next account.
    if (/ChatGPTAgentToolRateLimitException|Free plan limit for image generation|image creation limit/i.test(text)) {
      throw new ChatGptWebImageError(
        'ChatGPT account has hit its image generation quota — add another account or wait for the reset',
        429,
      );
    }

    const validFileIds = fileIds.filter(id => id !== 'file_upload');
    if (validFileIds.length > 0 || sedimentIds.length > 0 || directUrls.length > 0) {
      const media = await tryDownloadGeneratedImage(
        ctx,
        conversationId,
        { fileIds: validFileIds, sedimentIds, directUrls },
        signal,
      );
      if (media) return media;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  const validFileIds = fileIds.filter(id => id !== 'file_upload');
  if (validFileIds.length > 0 || sedimentIds.length > 0 || directUrls.length > 0) {
    throw new ChatGptWebImageError('ChatGPT image generation produced no downloadable file', 502);
  }
  throw new ChatGptWebImageError('ChatGPT image generation timed out', 504);
}

/**
 * Exchange and validate a ChatGPT Web session cookie, persisting any rotated
 * `Set-Cookie` headers and fresh access token. Single-flighted per cookie.
 */
export async function rotateChatGptWebSession(
  rawCredential: string,
  opts?: {
    baseUrl?: string;
    userAgent?: string;
    platform?: Platform;
    signal?: AbortSignal;
    onCredentialUpdate?: (next: string) => void;
  },
): Promise<RotateChatGptWebSessionResult> {
  if (opts?.signal?.aborted) {
    throw new ChatGptWebImageError('Request aborted', 499);
  }
  const baseUrl = (opts?.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const userAgent = opts?.userAgent?.trim() || DEFAULT_USER_AGENT;
  const platform: Platform = (opts?.platform && opts.platform !== 'custom') ? opts.platform : ('chatgpt-web' as Platform);
  const initialCookie = resolveLiveChatGptWebCookie(normalizeChatGptWebCookie(rawCredential));
  const flightKey = `${baseUrl}::${initialCookie}`;

  let inflight = rotateInFlight.get(flightKey);
  if (!inflight) {
    const task = (async (): Promise<RotateChatGptWebSessionResult> => {
      let accessToken = await fetchUsableChatGptWebAccessToken(
        initialCookie,
        userAgent,
        baseUrl,
        platform,
        opts?.signal,
        opts?.onCredentialUpdate,
      );
      await probeChatGptWebSentinelPrepare({
        baseUrl,
        accessToken,
        cookie: resolveLiveChatGptWebCookie(initialCookie),
        userAgent,
        platform,
        signal: opts?.signal,
        onCredentialUpdate: opts?.onCredentialUpdate,
        onAccessTokenUpdate: (nextToken) => {
          accessToken = nextToken;
        },
      });
      const finalCookie = resolveLiveChatGptWebCookie(initialCookie);
      return {
        cookieHeader: finalCookie,
        accessToken,
        rotated: finalCookie !== initialCookie,
      };
    })().finally(() => {
      if (rotateInFlight.get(flightKey) === task) {
        rotateInFlight.delete(flightKey);
      }
    });
    rotateInFlight.set(flightKey, task);
    inflight = task;
  }

  return inflight;
}

/** Generate one image through the picture_v2 pipeline. Plain HTTP, no browser. */
export async function generateChatGptWebImage(opts: ChatGptWebImageOptions): Promise<{ b64: string; mime: string }> {
  if (!opts.prompt?.trim()) throw new ChatGptWebImageError('prompt is required for image generation', 400);

  const baseUrl = (opts.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const userAgent = opts.userAgent?.trim() || DEFAULT_USER_AGENT;
  const platform: Platform = (opts.platform && opts.platform !== 'custom') ? opts.platform : ('chatgpt-web' as Platform);
  let cookie = resolveLiveChatGptWebCookie(normalizeChatGptWebCookie(opts.credential));

  let accessToken = await fetchUsableChatGptWebAccessToken(
    cookie,
    userAgent,
    baseUrl,
    platform,
    opts.signal,
    opts.onCredentialUpdate,
  );
  if (opts.signal?.aborted) throw new Error('Request aborted');
  cookie = resolveLiveChatGptWebCookie(cookie);

  const sentinel = await fetchSentinelHeaders({
    baseUrl,
    accessToken,
    cookie,
    userAgent,
    platform,
    signal: opts.signal,
    onCredentialUpdate: opts.onCredentialUpdate,
    onAccessTokenUpdate: (next) => {
      accessToken = next;
    },
  });
  cookie = resolveLiveChatGptWebCookie(cookie);
  const ctx: ImageContext = { baseUrl, accessToken, cookie, userAgent, platform, sentinel };

  const initial = await runImageConversation(ctx, opts.prompt, opts.size, opts.signal);
  const initialValidFiles = initial.fileIds.filter(id => id !== 'file_upload');
  const hasInitialMedia = initialValidFiles.length > 0 || initial.sedimentIds.length > 0 || ((initial.directUrls?.length ?? 0) > 0);

  if (!initial.conversationId && !hasInitialMedia) {
    throw new ChatGptWebImageError('ChatGPT image conversation produced no conversation id', 502);
  }
  if (hasInitialMedia) {
    const media = await tryDownloadGeneratedImage(
      ctx,
      initial.conversationId,
      { ...initial, fileIds: initialValidFiles, directUrls: initial.directUrls ?? [] },
      opts.signal,
    );
    if (media) return media;
  }
  if (!initial.conversationId) {
    throw new ChatGptWebImageError('ChatGPT image generation produced no downloadable file', 502);
  }

  return pollAndDownloadConversationImages(ctx, initial.conversationId, initial, opts.signal);
}

/** Generate `n` images and shape the result like OpenAI's images API. */
export async function generateChatGptWebImages(opts: ChatGptWebImageOptions): Promise<ChatGptWebImageResult> {
  const count = Math.max(1, Math.min(4, Math.floor(opts.n ?? 1)));
  const data: ChatGptWebImage[] = [];
  for (let i = 0; i < count; i++) {
    const media = await generateChatGptWebImage(opts);
    data.push({ b64_json: media.b64, ...(media.mime ? { mime_type: media.mime } : {}) });
  }
  return { created: Math.floor(Date.now() / 1000), data };
}
