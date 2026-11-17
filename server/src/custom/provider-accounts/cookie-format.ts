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
