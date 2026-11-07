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

const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_TZ_OFFSET_MIN = 0;

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

/** Normalize whatever the operator pasted into a Cookie header. */
export function normalizeChatGptWebCookie(rawCredential: string): string {
  const trimmed = rawCredential
    .trim()
    .replace(/^(?:Cookie|Authorization):\s*/i, '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  if (!trimmed) throw new ChatGptWebImageError('ChatGPT Web credential is empty', 401);

  // Full Playwright storage state ({ cookies: [...] }) or cookie-editor JSON array.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ChatGptWebImageError('ChatGPT Web storage state JSON is invalid', 400);
    }
    const cookies = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { cookies?: unknown }).cookies)
        ? (parsed as { cookies: unknown[] }).cookies
        : null);
    if (!cookies) {
      throw new ChatGptWebImageError('ChatGPT Web storage state JSON contains no cookies', 400);
    }
    const header = cookies
      .filter((cookie): cookie is { name: string; value: string } =>
        Boolean(cookie) && typeof cookie === 'object'
        && typeof (cookie as { name?: unknown }).name === 'string'
        && typeof (cookie as { value?: unknown }).value === 'string')
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');
    if (!header) throw new ChatGptWebImageError('ChatGPT Web credential contains no cookies', 401);
    return header;
  }

  // Bare session-token value — no `name=` prefix. Base64 padding is not a
  // cookie pair, so only real `name=value` shapes pass through untouched.
  if (!looksLikeCookieHeader(trimmed)) {
    return `__Secure-next-auth.session-token=${trimmed}`;
  }

  // Full Cookie header, including chunked (`...session-token.0=`, `.1=`).
  return trimmed;
}

/** Exchange the web cookie for the access token /backend-api expects. */
export async function fetchChatGptWebAccessToken(
  cookie: string,
  userAgent: string,
  baseUrl: string,
  platform: Platform,
  signal?: AbortSignal,
): Promise<string> {
  let res: Response;
  try {
    res = await webFetch(
      `${baseUrl}/api/auth/session`,
      {
        headers: { 'User-Agent': userAgent, Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
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
  return body.accessToken;
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

/** Run Sentinel prepare -> requirements and return the headers /backend-api needs. */
export async function fetchSentinelHeaders({
  baseUrl,
  accessToken,
  userAgent,
  platform,
  signal,
}: {
  baseUrl: string;
  accessToken: string;
  userAgent: string;
  platform: Platform;
  signal?: AbortSignal;
}): Promise<Record<string, string>> {
  const base = { Authorization: `Bearer ${accessToken}`, 'User-Agent': userAgent };
  const readJson = async (res: Response, path: string): Promise<Record<string, any>> => {
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new ChatGptWebImageError(`ChatGPT ${path} failed (HTTP ${res.status}) ${text.slice(0, 200)}`, res.status || 502);
    }
    try {
      return JSON.parse(text) as Record<string, any>;
    } catch {
      throw new ChatGptWebImageError(`ChatGPT ${path} returned invalid JSON`, 502);
    }
  };

  const prepared = await readJson(
    await sentinelRequest(
      `${baseUrl}/backend-api/sentinel/chat-requirements/prepare`,
      { ...base, [SENTINEL_HEADERS.prepare]: buildPrepareToken(userAgent) },
      platform,
      signal,
    ),
    '/backend-api/sentinel/chat-requirements/prepare',
  );
  if (typeof prepared.prepare_token !== 'string' || !prepared.prepare_token) {
    throw new ChatGptWebImageError('ChatGPT sentinel prepare returned no prepare_token', 502);
  }

  const requirements = await readJson(
    await sentinelRequest(
      `${baseUrl}/backend-api/sentinel/chat-requirements`,
      { ...base, [SENTINEL_HEADERS.prepare]: prepared.prepare_token },
      platform,
      signal,
    ),
    '/backend-api/sentinel/chat-requirements',
  );

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
    for (const match of unescaped.matchAll(/https:\/\/files\.oaiusercontent\.com\/[^\s"')>]+/g)) {
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

/** Poll the conversation document until an image_gen record shows up. */
async function pollConversationImages(
  ctx: ImageContext,
  conversationId: string,
  initial: ConversationIds,
  signal?: AbortSignal,
): Promise<{ fileIds: string[]; sedimentIds: string[]; directUrls: string[] }> {
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
    const validFileIds = fileIds.filter(id => id !== 'file_upload');
    if (validFileIds.length > 0 || sedimentIds.length > 0 || directUrls.length > 0) {
      return { fileIds: validFileIds, sedimentIds, directUrls };
    }
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
    await sleep(POLL_INTERVAL_MS);
  }
  throw new ChatGptWebImageError('ChatGPT image generation timed out', 504);
}

/** Signed asset URLs come from ChatGPT itself, so let normal redirects (CDN) work. */
async function downloadUrl(url: string, signal?: AbortSignal): Promise<{ b64: string; mime: string } | null> {
  const res = await webFetch(url, {}, DOWNLOAD_TIMEOUT_MS, ('chatgpt-web' as Platform), signal);
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) return null;
  return {
    b64: buffer.toString('base64'),
    mime: (res.headers.get('content-type') || 'image/png').split(';')[0],
  };
}

/** Resolve one generated id into `{ b64, mime }`. */
async function downloadGeneratedImage(
  ctx: ImageContext,
  conversationId: string,
  { fileIds, sedimentIds, directUrls }: { fileIds: string[]; sedimentIds: string[]; directUrls?: string[] },
  signal?: AbortSignal,
): Promise<{ b64: string; mime: string }> {
  if (directUrls) {
    for (const url of directUrls) {
      const media = await downloadUrl(url, signal);
      if (media) return media;
    }
  }

  const jsonHeaders = { ...authHeaders(ctx), Accept: 'application/json' };

  for (const fileId of fileIds) {
    if (fileId === 'file_upload') continue;
    const res = await request(
      `${ctx.baseUrl}/backend-api/files/${fileId}/download`,
      { headers: jsonHeaders, redirect: 'manual' },
      60_000,
      ctx,
      signal,
    ).catch(() => null);
    if (!res) continue;

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (loc) {
        const media = await downloadUrl(loc, signal);
        if (media) return media;
      }
    }

    if (res.ok) {
      const body = await res.json().catch(() => null) as { download_url?: unknown; url?: unknown } | null;
      const url = typeof body?.download_url === 'string' ? body.download_url : (typeof body?.url === 'string' ? body.url : '');
      if (url) {
        const media = await downloadUrl(url, signal);
        if (media) return media;
      }
    }
  }

  for (const sedimentId of sedimentIds) {
    const res = await request(
      `${ctx.baseUrl}/backend-api/conversation/${conversationId}/attachment/${sedimentId}/download`,
      { headers: jsonHeaders, redirect: 'manual' },
      60_000,
      ctx,
      signal,
    ).catch(() => null);
    if (!res) continue;

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (loc) {
        const media = await downloadUrl(loc, signal);
        if (media) return media;
      }
    }

    if (res.ok) {
      const body = await res.json().catch(() => null) as { download_url?: unknown; url?: unknown } | null;
      const url = typeof body?.download_url === 'string' ? body.download_url : (typeof body?.url === 'string' ? body.url : '');
      if (url) {
        const media = await downloadUrl(url, signal);
        if (media) return media;
      }
    }
  }

  throw new ChatGptWebImageError('ChatGPT image generation produced no downloadable file', 502);
}

/** Generate one image through the picture_v2 pipeline. Plain HTTP, no browser. */
export async function generateChatGptWebImage(opts: ChatGptWebImageOptions): Promise<{ b64: string; mime: string }> {
  if (!opts.prompt?.trim()) throw new ChatGptWebImageError('prompt is required for image generation', 400);

  const baseUrl = (opts.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const userAgent = opts.userAgent?.trim() || DEFAULT_USER_AGENT;
  const platform: Platform = (opts.platform && opts.platform !== 'custom') ? opts.platform : ('chatgpt-web' as Platform);
  const cookie = normalizeChatGptWebCookie(opts.credential);

  const accessToken = await fetchChatGptWebAccessToken(cookie, userAgent, baseUrl, platform, opts.signal);
  if (opts.signal?.aborted) throw new Error('Request aborted');

  const sentinel = await fetchSentinelHeaders({ baseUrl, accessToken, userAgent, platform, signal: opts.signal });
  const ctx: ImageContext = { baseUrl, accessToken, cookie, userAgent, platform, sentinel };

  const initial = await runImageConversation(ctx, opts.prompt, opts.size, opts.signal);
  const initialValidFiles = initial.fileIds.filter(id => id !== 'file_upload');
  const hasInitialMedia = initialValidFiles.length > 0 || initial.sedimentIds.length > 0 || ((initial.directUrls?.length ?? 0) > 0);

  if (!initial.conversationId && !hasInitialMedia) {
    throw new ChatGptWebImageError('ChatGPT image conversation produced no conversation id', 502);
  }
  const ids = hasInitialMedia
    ? { ...initial, fileIds: initialValidFiles, directUrls: initial.directUrls ?? [] }
    : await pollConversationImages(ctx, initial.conversationId, initial, opts.signal);

  return downloadGeneratedImage(ctx, initial.conversationId, ids, opts.signal);
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
