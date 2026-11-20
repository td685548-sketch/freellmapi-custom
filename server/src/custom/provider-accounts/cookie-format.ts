/**
 * Shape detection for web-session credentials.
 *
 * Operators paste three things into a "cookie" field: a full Cookie header
 * (`sso=abc; sso-rw=def`), a bare token (`eyJ...`), or a browser storage-state
 * JSON export. The bare token can itself contain `=` as base64 padding, so a
 * naive `includes('=')` check misreads `abc==` as a Cookie header.
 */

const COOKIE_NAME_CHARS = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BASE64_BLOB = /^[A-Za-z0-9+/\-_.]+={0,2}$/;
const META_LLAMA_KEY = /^LLM\|[^|\s]+\|[^|\s]+$/;

/** True when `value` is a Meta Llama API credential (`LLM|app_id|secret`). */
export function isMetaLlamaKey(value: string): boolean {
  return META_LLAMA_KEY.test(value.trim());
}

/** True when `value` is one or more `name=value` pairs rather than a token. */
export function looksLikeCookieHeader(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || isMetaLlamaKey(trimmed)) return false;

  // A semicolon-separated list is unambiguously a Cookie header.
  if (trimmed.includes(';')) return /(?:^|;\s*)[!#$%&'*+\-.^_`|~0-9A-Za-z]+=/.test(trimmed);

  const eq = trimmed.indexOf('=');
  if (eq <= 0) return false;

  if (!COOKIE_NAME_CHARS.test(trimmed.slice(0, eq))) return false;

  // `QUJDRA==` and `g.a000...=` blobs are padded tokens, not `name=value`
  // pairs: a real pair has a non-empty value after the separator `=`.
  if (BASE64_BLOB.test(trimmed) || /^=*$/.test(trimmed.slice(eq + 1))) return false;

  return true;
}

function sanitizeCookieSegment(value: unknown): string {
  return String(value ?? '').replace(/[\r\n;]+/g, ' ').trim();
}

function unwrapNestedValueString(raw: string, depth = 0): string {
  const trimmed = raw.trim();
  if (!trimmed || depth >= 4) return trimmed;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      const inner = JSON.parse(trimmed) as unknown;
      if (typeof inner === 'string' && inner.trim()) {
        return unwrapNestedValueString(inner, depth + 1);
      }
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        const innerObj = inner as Record<string, unknown>;
        if (typeof innerObj.value === 'string' && innerObj.value.trim()) {
          return unwrapNestedValueString(innerObj.value, depth + 1);
        }
      }
    } catch {
      // Not nested JSON; return trimmed string
    }
  }
  return trimmed;
}

/**
 * Extracts a Local Storage `userToken` wrapper (`{ value, __version }`,
 * `{ userToken, __version }`, or Playwright `storageState` `origins[].localStorage`)
 * before `normalizeCookieInput` treats flat `{ name: value }` objects as cookie maps.
 */
function unwrapLocalStorageTokenObject(obj: Record<string, unknown>, rawTrimmed: string): string | null {
  const keys = Object.keys(obj);
  if (keys.length > 0 && keys.every(k => k === 'value' || k === '__version') && 'value' in obj) {
    if (typeof obj.value === 'string' && obj.value.trim()) {
      return unwrapNestedValueString(obj.value);
    }
    if (obj.value && typeof obj.value === 'object') {
      return rawTrimmed;
    }
  }
  if (keys.length > 0 && keys.every(k => k === 'userToken' || k === '__version') && 'userToken' in obj) {
    if (typeof obj.userToken === 'string' && obj.userToken.trim()) {
      return unwrapNestedValueString(obj.userToken);
    }
  }
  if (Array.isArray(obj.origins)) {
    const hasDsSessionCookie =
      Array.isArray(obj.cookies) &&
      obj.cookies.some(
        c => Boolean(c) && typeof c === 'object' && (c as Record<string, unknown>).name === 'ds_session_id',
      );
    if (!hasDsSessionCookie) {
      for (const origin of obj.origins) {
        const items = (origin as { localStorage?: Array<{ name?: unknown; value?: unknown }> } | null)?.localStorage;
        if (!Array.isArray(items)) continue;
        const hit = items.find(entry => entry?.name === 'userToken' && typeof entry.value === 'string');
        if (hit && typeof hit.value === 'string' && hit.value.trim()) {
          try {
            const parsedHit = JSON.parse(hit.value) as unknown;
            if (
              parsedHit &&
              typeof parsedHit === 'object' &&
              !Array.isArray(parsedHit) &&
              (parsedHit as Record<string, unknown>).value &&
              typeof (parsedHit as Record<string, unknown>).value === 'object'
            ) {
              return rawTrimmed;
            }
          } catch {
            // Fall through to unwrap string token
          }
          return unwrapNestedValueString(hit.value);
        }
      }
    }
  }
  return null;
}

/**
 * Normalizes a Cookie-Editor JSON array, storage-state `{ cookies }` JSON,
 * flat `{ name: value }` object, or raw Cookie header into a clean `k=v; ...`
 * string while preserving Meta Llama keys (`LLM|id|secret`) and bare tokens.
 */
export function normalizeCookieInput(raw: string): string {
  const trimmed = raw
    .trim()
    .replace(/^(?:Cookie|Authorization):\s*/i, '')
    .trim();
  if (!trimmed) return '';
  if (isMetaLlamaKey(trimmed)) return trimmed;

  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      let rawCookies: Array<Record<string, unknown>> | null = null;
      if (Array.isArray(parsed)) {
        rawCookies = parsed.filter(
          (c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && !Array.isArray(c),
        );
      } else if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const unwrappedToken = unwrapLocalStorageTokenObject(obj, trimmed);
        if (unwrappedToken !== null) {
          return unwrappedToken;
        }
        if (Array.isArray(obj.cookies)) {
          rawCookies = obj.cookies.filter(
            (c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && !Array.isArray(c),
          );
        } else {
          const kvEntries = Object.entries(obj).filter(([, val]) => typeof val === 'string');
          if (kvEntries.length > 0 && kvEntries.length === Object.keys(obj).length) {
            rawCookies = kvEntries.map(([name, value]) => ({ name, value }));
          }
        }
      }

      if (rawCookies && rawCookies.length > 0) {
        const nowSec = Date.now() / 1000;
        const deduped = new Map<string, string>();
        for (const entry of rawCookies) {
          if (typeof entry.name !== 'string' || typeof entry.value !== 'string') continue;
          const name = sanitizeCookieSegment(entry.name);
          const value = String(entry.value).replace(/[\r\n]+/g, '').trim();
          if (!name || !COOKIE_NAME_CHARS.test(name) || name.includes('=')) continue;
          const exp = entry.expirationDate ?? entry.expires;
          if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0) {
            const expSec = exp > 1e12 ? exp / 1000 : exp;
            if (expSec <= nowSec) continue;
          }
          deduped.set(name, value);
        }
        if (deduped.size > 0) {
          return Array.from(deduped.entries(), ([k, v]) => `${k}=${v}`).join('; ');
        }
      }
    } catch {
      // Fall through to raw string
    }
  }

  return trimmed;
}

const HTML_DOCUMENT = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

/** True when an upstream body is an HTML page (Cloudflare/Turnstile challenge). */
export function looksLikeHtmlDocument(text: string): boolean {
  return HTML_DOCUMENT.test(text);
}
