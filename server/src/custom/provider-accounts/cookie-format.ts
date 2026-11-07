/**
 * Shape detection for web-session credentials.
 *
 * Operators paste three things into a "cookie" field: a full Cookie header
 * (`sso=abc; sso-rw=def`), a bare token (`eyJ...`), or a browser storage-state
 * JSON export. The bare token can itself contain `=` as base64 padding, so a
 * naive `includes('=')` check misreads `abc==` as a Cookie header.
 */

const COOKIE_NAME_CHARS = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BASE64_BLOB = /^[A-Za-z0-9+/\-_]+={0,2}$/;

/** True when `value` is one or more `name=value` pairs rather than a token. */
export function looksLikeCookieHeader(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  // A semicolon-separated list is unambiguously a Cookie header.
  if (trimmed.includes(';')) return /(?:^|;\s*)[!#$%&'*+\-.^_`|~0-9A-Za-z]+=/.test(trimmed);

  const eq = trimmed.indexOf('=');
  if (eq <= 0) return false;

  if (!COOKIE_NAME_CHARS.test(trimmed.slice(0, eq))) return false;

  // `QUJDRA==`-style blobs are padded tokens, not `name=value` pairs: the only
  // `=` in a real pair is the separator, so padding at the tail gives it away.
  if (BASE64_BLOB.test(trimmed)) return false;

  return true;
}

const HTML_DOCUMENT = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

/** True when an upstream body is an HTML page (Cloudflare/Turnstile challenge). */
export function looksLikeHtmlDocument(text: string): boolean {
  return HTML_DOCUMENT.test(text);
}
