// UC (uncensored.com) web-session provider — image generation via the
// un-metered internal API (`internal.chatuncensored.ai/v2/image-gen`).
// Ported from 9Router's `uc-web` executor.
//
// Credential: the full uncensored.com Cookie header (must include the durable
// Clerk `__client` cookie), Cookie-Editor JSON, or Playwright storage state.
// A short-lived `__session` JWT is minted from Clerk per request and any
// rotated `__client` cookie is handed back via `onCredentialUpdate`.
import type { Platform } from '@freellmapi/shared/types.js';
import { proxyFetch } from '../../lib/proxy.js';
import { looksLikeCookieHeader } from './cookie-format.js';

const UC_ORIGIN = 'https://uncensored.com';
const UC_CLERK_FAPI = 'https://clerk.uncensored.com';
const UC_CLERK_JS_VERSION = '5.127.1';
const UC_IMAGE_URL = 'https://internal.chatuncensored.ai/v2/image-gen';
const UC_DEFAULT_IMAGE_MODEL = 'seedream-v4.5';
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 30_000;

const UC_IMAGE_MODE = 'dev';
const UC_MODERATION_MODE = 'SUPER_LIGHT';
const UC_COUNTRY = 'US';

const UC_ASPECT_SIZES: Record<string, { imageWidth: string; imageHeight: string }> = {
  '1:1': { imageWidth: '1024', imageHeight: '1024' },
  '16:9': { imageWidth: '1024', imageHeight: '576' },
  '9:16': { imageWidth: '576', imageHeight: '1024' },
  '4:3': { imageWidth: '1024', imageHeight: '768' },
  '3:4': { imageWidth: '768', imageHeight: '1024' },
  '3:2': { imageWidth: '1152', imageHeight: '768' },
  '2:3': { imageWidth: '768', imageHeight: '1152' },
  '4:5': { imageWidth: '896', imageHeight: '1120' },
  '5:4': { imageWidth: '1120', imageHeight: '896' },
  '21:9': { imageWidth: '1344', imageHeight: '576' },
};

interface UcImageModelSpec {
  upstream?: string;
  aspects: string[];
  resolutions?: string[];
}

const UC_IMAGE_MODELS: Record<string, UcImageModelSpec> = {
  'seedream-v4.5': { aspects: ['1:1', '16:9', '9:16', '4:3', '3:4'] },
  'seedream-v5': { aspects: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] },
  'seedream-v5-flash': { aspects: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'], resolutions: ['1k', '1.5k', '2k'] },
  'nano-banana-pro-ultra': { aspects: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'], resolutions: ['4k', '8k'] },
  'nano-banana-pro': { aspects: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'], resolutions: ['1k', '2k', '4k'] },
  'nano-banana': { aspects: ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9'] },
  'nano-banana-2': { aspects: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'], resolutions: ['1k', '2k', '4k'] },
  'gpt-image': { aspects: ['1:1', '2:3', '3:2'] },
  'gpt-image-2': { aspects: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] },
  'gpt-image-2.5-flare': { aspects: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '2:1', '1:2', '3:1', '1:3', '9:21'] },
  'gpt-image-2.5-sunburst': { aspects: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '2:1', '1:2', '3:1', '1:3', '9:21'] },
  'wan-2.6': { aspects: ['1:1', '4:3', '3:4', '3:2', '2:3'] },
  'wan-2.6-image': { upstream: 'wan-2.6', aspects: ['1:1', '4:3', '3:4', '3:2', '2:3'] },
  'wan-2.7-text-to-image': { aspects: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] },
  'wan-2.7-text-to-image-pro': { aspects: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] },
  'prefect-pony-xl': { aspects: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] },
  '1.0': { aspects: [] },
  '1.1': { aspects: [] },
  '1.2': { aspects: [] },
  '2.0': { aspects: [] },
  'flux-2-max': { aspects: [] },
  SDXL: { aspects: [] },
  realism: { aspects: [] },
  'realism-2': { aspects: [] },
  'z-image-turbo': { aspects: [] },
};

const UC_VIDEO_ONLY_MODELS = new Set([
  'default',
  'turbo',
  'wan-2.2-uncensored',
  'wan-2.2-uncensored-v2',
  'wan-2.6-ultra',
  'wan-2.7',
  'wan-2.7-pro',
  'wan-2.7-uncensored',
  'wan-2.7-uncensored-v2',
  'wan-3.0',
  'wan-3.0-uncensored',
  'wan-3.0-uncensored-pro',
  'sora-2',
  'sora-2-pro',
  'grok-imagine-video',
  'bytedance-seedance-2.0',
  'seedance-2.0-fast',
  'seedance-2.0-uncensored',
  'seedance-2.0-fast-uncensored',
  'seedance-2.0-mini-uncensored',
  'seedance-2.0-mini-turbo',
  'seedance-v1.5-pro-uncensored',
  'seedance-2.5-uncensored',
  'seedance-2.5',
  'vidu-q3-uncensored',
  'av-gen-v2',
  'cosmos-predict',
  'minimax-h3',
  'happyhorse-1.0',
  'wan/v2.2-a14b',
]);

export class UcWebError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'UcWebError';
    this.status = status;
  }
}

export function normalizeUcWebCookie(rawCredential: string): string {
  const trimmed = rawCredential
    .trim()
    .replace(/^(?:Cookie|Authorization):\s*/i, '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  if (!trimmed) {
    throw new UcWebError('UC Web credential is empty.', 401);
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new UcWebError('UC Web storage state JSON is invalid.', 400);
    }
    const cookies = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { cookies?: unknown }).cookies)
          ? (parsed as { cookies: unknown[] }).cookies
          : null);
    if (!cookies) {
      throw new UcWebError('UC Web storage state JSON contains no cookies.', 400);
    }
    const header = cookies
      .filter(
        (cookie): cookie is { name: string; value: string } =>
          Boolean(cookie) &&
          typeof cookie === 'object' &&
          typeof (cookie as { name?: unknown }).name === 'string' &&
          Boolean((cookie as { name: string }).name) &&
          typeof (cookie as { value?: unknown }).value === 'string',
      )
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
    if (!header) {
      throw new UcWebError('UC Web credential contains no cookies.', 401);
    }
    return header;
  }

  if (!looksLikeCookieHeader(trimmed)) {
    return `__client=${trimmed}`;
  }

  return trimmed;
}

function parseCookieJar(header: string): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
  return jar;
}

function formatCookieJar(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readSetCookie(res: Response, name: string): string {
  const withGetSetCookie = res.headers as Headers & { getSetCookie?: () => string[] };
  const list =
    typeof withGetSetCookie.getSetCookie === 'function'
      ? withGetSetCookie.getSetCookie()
      : (() => {
          const single = res.headers.get('set-cookie');
          return single ? [single] : [];
        })();
  for (const entry of list) {
    const pair = String(entry).split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq).trim() === name) {
      return pair.slice(eq + 1).trim();
    }
  }
  return '';
}

function withRotatedClient(cookieHeader: string, rotatedClient: string): string {
  if (!rotatedClient) return '';
  const jar = parseCookieJar(cookieHeader);
  if (jar.get('__client') === rotatedClient) return '';
  jar.set('__client', rotatedClient);
  return formatCookieJar(jar);
}

async function resolveClerkSessionId(
  clientJwt: string,
  clerkHeaders: Record<string, string>,
  platform: Platform,
  signal?: AbortSignal,
): Promise<{ sid: string; rotatedClient: string }> {
  const legacySid = decodeJwtPayload(clientJwt)?.sid;
  if (typeof legacySid === 'string' && legacySid) {
    return { sid: legacySid, rotatedClient: '' };
  }

  const res = await proxyFetch(
    `${UC_CLERK_FAPI}/v1/client?_clerk_js_version=${UC_CLERK_JS_VERSION}`,
    { headers: clerkHeaders, signal },
    platform,
    'image',
    REQUEST_TIMEOUT_MS,
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { sid: '', rotatedClient: '' };
  }
  const rotatedClient = readSetCookie(res, '__client');
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const payload = (body?.response ?? body?.client ?? body) as Record<string, unknown> | null;
  const sessions = Array.isArray(payload?.sessions) ? (payload.sessions as Array<Record<string, unknown>>) : [];
  const active = sessions.find((s) => s?.status === 'active') ?? sessions[0];
  return {
    sid: typeof active?.id === 'string' ? active.id : '',
    rotatedClient,
  };
}

export async function mintUcSession(opts: {
  credential: string;
  platform?: Platform;
  signal?: AbortSignal;
  onCredentialUpdate?: (next: string) => void;
}): Promise<{ jwt: string; uid: string; cookieHeader: string }> {
  const platform = opts.platform ?? 'custom';
  const cookieHeader = normalizeUcWebCookie(opts.credential);
  const jar = parseCookieJar(cookieHeader);
  const client = jar.get('__client');
  if (!client) {
    throw new UcWebError(
      'UC Web credential missing the __client cookie — paste the full uncensored.com Cookie header from a logged-in session.',
      401,
    );
  }

  const clerkHeaders: Record<string, string> = {
    Cookie: formatCookieJar(jar),
    Origin: UC_ORIGIN,
    Referer: `${UC_ORIGIN}/`,
    Accept: 'application/json',
  };

  const resolved = await resolveClerkSessionId(client, clerkHeaders, platform, opts.signal);
  if (!resolved.sid) {
    throw new UcWebError(
      'UC Web Clerk session not found — the __client cookie has no active session; refresh your uncensored.com cookies.',
      401,
    );
  }

  const res = await proxyFetch(
    `${UC_CLERK_FAPI}/v1/client/sessions/${encodeURIComponent(resolved.sid)}/tokens?_clerk_js_version=${UC_CLERK_JS_VERSION}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: UC_ORIGIN,
        Referer: `${UC_ORIGIN}/`,
        Cookie: formatCookieJar(jar),
      },
      body: '',
      signal: opts.signal,
    },
    platform,
    'image',
    REQUEST_TIMEOUT_MS,
  );

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new UcWebError(
      `UC Web Clerk token mint failed (HTTP ${res.status}): ${detail || res.statusText}`,
      res.status,
    );
  }

  const rotatedClient = readSetCookie(res, '__client') || resolved.rotatedClient;
  const nextCookie = withRotatedClient(cookieHeader, rotatedClient);
  if (nextCookie && opts.onCredentialUpdate) {
    try {
      opts.onCredentialUpdate(nextCookie);
    } catch {
      // Persistence failures must never abort an active request.
    }
  }

  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const jwt = body?.jwt;
  if (typeof jwt !== 'string' || !jwt) {
    throw new UcWebError('UC Web Clerk token mint returned no jwt.', 502);
  }
  const jwtPayload = decodeJwtPayload(jwt);
  const uid = jwtPayload?.uid ?? jwtPayload?.sub;
  return {
    jwt,
    uid: typeof uid === 'string' ? uid : '',
    cookieHeader: nextCookie || cookieHeader,
  };
}

function aspectFor(
  size: string | undefined,
  allowedAspects: string[],
): { aspect_ratio: string; imageWidth: string; imageHeight: string } {
  const raw = String(size ?? '').trim();
  const allowed = allowedAspects.length > 0 ? allowedAspects : null;
  const pick = (candidate: string) => {
    const dims = UC_ASPECT_SIZES[candidate];
    if (!dims) return null;
    if (allowed && !allowed.includes(candidate)) return null;
    return { aspect_ratio: candidate, ...dims };
  };

  const direct = pick(raw);
  if (direct) return direct;

  if (raw.includes('x')) {
    const [w, h] = raw.split('x').map(Number);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      let best: string | null = null;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (const [aspect, dims] of Object.entries(UC_ASPECT_SIZES)) {
        if (allowed && !allowed.includes(aspect)) continue;
        const delta = Math.abs(Number(dims.imageWidth) / Number(dims.imageHeight) - w / h);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = aspect;
        }
      }
      if (best && UC_ASPECT_SIZES[best]) {
        return { aspect_ratio: best, ...UC_ASPECT_SIZES[best]! };
      }
    }
  }

  const fallback = allowed?.[0] ?? '1:1';
  return { aspect_ratio: fallback, ...(UC_ASPECT_SIZES[fallback] ?? UC_ASPECT_SIZES['1:1']!) };
}

async function pollResultUrl(
  url: string,
  platform: Platform,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new UcWebError('Request aborted.', 499);

    let status = 0;
    try {
      const res = await proxyFetch(
        url,
        { method: 'HEAD', headers: { Referer: `${UC_ORIGIN}/` }, signal },
        platform,
        'image',
        REQUEST_TIMEOUT_MS,
      );
      status = res.status;
    } catch {
      status = 0;
    }
    if (status === 200) return;

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new UcWebError('Request aborted.', 499));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, POLL_INTERVAL_MS);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
  throw new UcWebError('UC Web image result did not become available in time.', 504);
}

export async function generateUcWebImages(opts: {
  credential: string;
  prompt: string;
  modelId?: string;
  size?: string;
  resolution?: string;
  platform?: Platform;
  signal?: AbortSignal;
  onCredentialUpdate?: (next: string) => void;
}): Promise<{ created: number; data: Array<{ b64_json: string; mimeType: string }> }> {
  const platform = opts.platform ?? 'custom';
  const prompt = opts.prompt.trim();
  if (!prompt) {
    throw new UcWebError('Prompt is required for UC Web image generation.', 400);
  }

  const requestedModel = opts.modelId?.trim() || UC_DEFAULT_IMAGE_MODEL;
  if (UC_VIDEO_ONLY_MODELS.has(requestedModel)) {
    throw new UcWebError(
      `UC Web model "${requestedModel}" is video-only and cannot be used for image or chat requests.`,
      400,
    );
  }

  const spec = UC_IMAGE_MODELS[requestedModel];
  if (!spec) {
    throw new UcWebError(
      `Unknown UC Web image model "${requestedModel}". Choose a UC image model such as ${UC_DEFAULT_IMAGE_MODEL}.`,
      400,
    );
  }

  const { jwt } = await mintUcSession({
    credential: opts.credential,
    platform,
    signal: opts.signal,
    onCredentialUpdate: opts.onCredentialUpdate,
  });

  const body: Record<string, unknown> = {
    prompt,
    mode: UC_IMAGE_MODE,
    model_version: spec.upstream ?? requestedModel,
    m_n_user: true,
    moderationMode: UC_MODERATION_MODE,
    country: UC_COUNTRY,
    vdiscount: false,
    ...aspectFor(opts.size, spec.aspects),
  };
  if (spec.resolutions?.length) {
    const want = String(opts.resolution ?? '').toLowerCase();
    body.resolution = spec.resolutions.includes(want) ? want : spec.resolutions[0];
  }

  const genRes = await proxyFetch(
    UC_IMAGE_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Origin: UC_ORIGIN,
        Referer: `${UC_ORIGIN}/`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    },
    platform,
    'image',
    REQUEST_TIMEOUT_MS,
  );

  if (!genRes.ok) {
    const detail = (await genRes.text().catch(() => '')).slice(0, 200);
    throw new UcWebError(
      `UC Web image request failed (HTTP ${genRes.status}): ${detail || genRes.statusText}`,
      genRes.status,
    );
  }

  const genJson = (await genRes.json().catch(() => null)) as Record<string, unknown> | null;
  const resultUrl = typeof genJson?.url === 'string' ? genJson.url : '';
  if (!resultUrl) {
    throw new UcWebError('UC Web image response carried no result url.', 502);
  }

  await pollResultUrl(resultUrl, platform, opts.signal);

  const dlRes = await proxyFetch(
    resultUrl,
    { headers: { Referer: `${UC_ORIGIN}/` }, signal: opts.signal },
    platform,
    'image',
    REQUEST_TIMEOUT_MS,
  );
  if (!dlRes.ok) {
    throw new UcWebError(`UC Web result download failed (HTTP ${dlRes.status}).`, dlRes.status);
  }
  const bytes = Buffer.from(await dlRes.arrayBuffer());
  const mimeType = (dlRes.headers.get('content-type') || 'image/png').split(';')[0]!.trim() || 'image/png';

  return {
    created: Math.floor(Date.now() / 1000),
    data: [{ b64_json: bytes.toString('base64'), mimeType }],
  };
}
