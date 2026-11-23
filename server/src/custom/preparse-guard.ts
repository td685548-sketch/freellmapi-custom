import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { isGeminiQueryKeyAllowed, resolveAuth } from '../lib/system-prompt.js';
import { extractApiToken } from '../routes/proxy.js';
import { validateSession } from '../services/auth.js';
import { getSessionCookie } from '../services/session-cookie.js';

// A request body is parsed BEFORE authentication and before any rate limit (the
// JSON parsers are mounted first). Parsing is synchronous, so an anonymous caller
// who POSTs a few megabytes of JSON stalls the whole process while it is read:
// measured here at 0.64 s for 10 MB and 1.16 s for 25 MB, and slower on a small
// instance. This runs ahead of the parsers and refuses LARGE bodies from callers
// who hold no valid credential, so only a signed-in user or a holder of a real
// API key can make the server do that work. Small bodies are untouched: login,
// registration and every ordinary API call stay far below the threshold.

const DEFAULT_THRESHOLD_BYTES = 256 * 1024;

export function largeBodyThresholdBytes(): number {
  const kb = Number(process.env.UNAUTH_BODY_LIMIT_KB);
  return Number.isFinite(kb) && kb > 0 ? Math.floor(kb * 1024) : DEFAULT_THRESHOLD_BYTES;
}

function isDirectLoopback(req: Request): boolean {
  let addr = (req.socket.remoteAddress ?? '').trim();
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  const local = addr === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
  // A local reverse proxy is a loopback socket too; its forwarded client is not.
  return local && !req.headers['x-forwarded-for'];
}

function bodyBytes(req: Request): number | null {
  const raw = req.headers['content-length'];
  if (raw !== undefined) {
    const n = Number(Array.isArray(raw) ? raw[0] : raw);
    return Number.isFinite(n) && n >= 0 ? n : Infinity;
  }
  // No length: a chunked body can be any size, so treat it as large.
  return req.headers['transfer-encoding'] ? Infinity : null;
}

function sessionToken(req: Request): string | undefined {
  // Phase 3: the dashboard session arrives only as the httpOnly cookie
  // now (the header fallback is gone). A large dashboard upload (e.g. an
  // STT audio file) still passes this guard on the cookie. SameSite=Lax
  // already means a cross-site POST does not carry the cookie, so
  // accepting it here cannot let a remote caller force the server to
  // parse a large body — the real auth + CSRF check still runs after
  // parsing.
  return getSessionCookie(req);
}

/** Read-only check of a `/v1/t/<token>/...` URL token (no last_used_at write). */
/* Mirrors validateUrlToken() in services/url-tokens.ts, including expiry:
 * expires_at IS NULL only for pre-expiry-migration tokens (grandfathered). */
function validUrlToken(token: string): boolean {
  if (!token) return false;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = getDb().prepare(
    'SELECT id FROM url_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime(\'now\'))',
  ).get(hash);
  return Boolean(row);
}

type Route = 'public' | 'url-token' | 'credentialed';

function classify(path: string): Route {
  if (path.startsWith('/v1/t/')) return 'url-token';
  if (path === '/api/auth' || path.startsWith('/api/auth/')) return 'public';
  if (path.startsWith('/v1') || path.startsWith('/thruline/v1') || path.startsWith('/mcp') || path.startsWith('/api/')) return 'credentialed';
  return 'public';
}

function hasCredential(req: Request, route: Route): boolean {
  try {
    if (route === 'url-token') return validUrlToken(req.path.split('/')[3] ?? '');
    // ?key= counts as a credential here only when the Gemini query-key
    // escape hatch is explicitly enabled (GEMINI_ALLOW_QUERY_KEY=1); the
    // Gemini router itself ignores ?key= by default (routes/gemini.ts).
    const apiToken = extractApiToken(req)
      ?? (isGeminiQueryKeyAllowed() && req.path.startsWith('/v1beta') && typeof req.query.key === 'string' ? req.query.key.trim() : undefined);
    if (apiToken && resolveAuth(apiToken)) return true;
    // The dashboard and the Ollama wire share /api; accept either credential.
    return validateSession(sessionToken(req)) !== null;
  } catch {
    return false;
  }
}

const INTERNAL_HEADER = 'x-ai-platform-internal';

/**
 * T014 — Strip the internal loopback header from any request that did NOT
 * arrive on a direct loopback socket.  This prevents an external caller from
 * forging `x-ai-platform-internal` to influence platform-internal behaviour.
 * The request is still processed normally (auth check is NOT skipped).
 * Must be called BEFORE the credential/auth check.
 */
export function stripInternalHeaders(req: Request): void {
  if (!isDirectLoopback(req)) {
    delete req.headers[INTERNAL_HEADER];
  }
}

export function preparseGuard(req: Request, res: Response, next: NextFunction): void {
  stripInternalHeaders(req);
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') { next(); return; }
  const size = bodyBytes(req);
  if (size === null || size <= largeBodyThresholdBytes()) { next(); return; }
  if (isDirectLoopback(req)) { next(); return; }

  const route = classify(req.path);
  if (route !== 'public' && hasCredential(req, route)) { next(); return; }

  // Refuse without reading the body, and drop the connection so the unread
  // upload is not drained.
  res.setHeader('Connection', 'close');
  if (route === 'public') {
    res.status(413).json({ error: { message: 'Request body too large for an unauthenticated endpoint.', type: 'invalid_request_error', code: 'request_too_large' } });
  } else {
    res.status(401).json({ error: { message: 'Authentication required for a request body this large.', type: 'authentication_error' } });
  }
}
