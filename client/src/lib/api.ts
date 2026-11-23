import { getSessionRevision, notifySessionChanged } from '@/custom/session-state';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

// Dashboard session token — Phase 2 of the httpOnly-cookie move
// (server/src/services/session-cookie.ts, services/csrf.ts).
//
// The session token lives ONLY in the httpOnly `flm_session` cookie now. It
// is never stored in sessionStorage or localStorage, never returned to JS in
// a login JSON body, and never sent as an Authorization header by this
// client. A successful XSS in the dashboard therefore cannot steal the
// session: there is nothing readable to steal — the cookie is invisible to
// document.cookie, and no token value ever passes through JS memory.
//
// What replaced the header:
//  - authentication rides the cookie (apiFetch and every direct fetch send
//    `credentials: 'same-origin'`, forced after the options spread so no
//    caller can downgrade it);
//  - mutations additionally send the double-submit CSRF token
//    (csrfHeaders() below): the readable `flm_csrf` cookie value, echoed
//    back as the X-CSRF-Token header. A cross-site page cannot read that
//    cookie, so it cannot forge the header.
//  - a token left in storage by a pre-Phase-2 build is purged on first
//    import: without the purge the stale readable token would linger next
//    to the cookie and defeat the whole point.
//
// The server still accepts the Authorization header from non-browser
// callers (curl scripts, server tests, server-side loopback forwards) —
// that fallback is Phase 3's to remove, and it does not weaken the XSS
// guarantee: page JS cannot obtain a token to put in a header.
const LEGACY_TOKEN_KEY = 'freellmapi_dashboard_token';
try { sessionStorage.removeItem(LEGACY_TOKEN_KEY); } catch { /* ignore */ }
try { localStorage.removeItem(LEGACY_TOKEN_KEY); } catch { /* ignore */ }

export const CSRF_COOKIE_NAME = 'flm_csrf';
export const CSRF_HEADER_NAME = 'X-CSRF-Token';

/** Read the double-submit CSRF value from the readable cookie the server
 *  sets at login (and refreshes on /api/auth/status when missing). */
export function getCsrfToken(): string | null {
  try {
    const item = document.cookie
      .split(';')
      .map(part => part.trim())
      .find(part => part.startsWith(`${CSRF_COOKIE_NAME}=`));
    return item ? decodeURIComponent(item.slice(CSRF_COOKIE_NAME.length + 1)) : null;
  } catch {
    return null;
  }
}

/** Headers a mutation must carry so the server accepts cookie auth for it.
 *  Empty when the CSRF cookie is absent — the server then answers
 *  403 csrf_required, and the next /api/auth/status call mints a fresh one. */
export function csrfHeaders(): Record<string, string> {
  const token = getCsrfToken();
  return token ? { [CSRF_HEADER_NAME]: token } : {};
}

function isSafeMethod(method: string | undefined): boolean {
  const m = (method ?? 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
}

export const UNAUTHORIZED_EVENT = 'freellmapi:unauthorized';

// Error thrown by apiFetch on a non-2xx response. Carries the HTTP status and
// the server's machine-readable `error.type` so callers can branch on them.
export interface ApiError extends Error {
  status?: number;
  code?: string;
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const revision = getSessionRevision();
  const assertCurrentSession = () => {
    if (revision !== getSessionRevision()) {
      throw new DOMException('The dashboard session changed', 'AbortError');
    }
  };
  const headers = new Headers(options?.headers);
  const isFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData;
  if (!isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  // Cookie-only mutations need the CSRF token (services/csrf.ts); safe
  // methods and header-authed calls do not. The cookie itself rides along
  // via `credentials: 'same-origin'`, forced after the spread so no caller
  // can downgrade it.
  if (!isSafeMethod(options?.method) && !headers.has(CSRF_HEADER_NAME)) {
    const csrf = getCsrfToken();
    if (csrf) headers.set(CSRF_HEADER_NAME, csrf);
  }
  const res = await fetch(`${BASE}${path}`, {
    // `...options` first so an explicit method/body/signal applies, but headers
    // are merged last — otherwise an options.headers would clobber the
    // Content-Type and CSRF token we set here.
    ...options,
    headers,
    credentials: 'same-origin',
  });
  assertCurrentSession();
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    assertCurrentSession();
    // A 401 ends the dashboard session ONLY when it is OUR auth saying so.
    // Discover/probe endpoints deliberately relay an upstream provider's 401
    // ("the endpoint rejected the key") with its status intact; treating those
    // as session-expired signed the operator out every time they tested a bad
    // provider key. The auth middleware and every session 401 carry
    // type 'authentication_error'; upstream relays never do.
    if (res.status === 401 && body.error?.type === 'authentication_error') {
      notifySessionChanged();
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    // Surface the HTTP status and the machine-readable error type on the thrown
    // Error so callers can branch on them (e.g. the setup form reveals a code
    // field on a `setup_code_required` 403). `.message` behaviour is unchanged.
    // Most routes send { error: { message, type } }; some (e.g. /api/premium)
    // send { error: '...' }. Without the string case those users only saw
    // "HTTP 502".
    const message = typeof body.error === 'string' ? body.error : body.error?.message;
    const err = new Error(message || `HTTP ${res.status}`) as ApiError;
    err.status = res.status;
    err.code = body.error?.type;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  // A 200 whose body isn't JSON means this request never reached the API — the
  // usual cause is a reverse proxy (or static host) serving the dashboard's
  // index.html for /api/* instead of forwarding it to the backend. Without this
  // guard the raw res.json() throws an opaque "Unexpected token '<'", which on
  // the setup/login form surfaces as "sign up page cannot work". Say what's
  // actually wrong. (#257)
  const text = await res.text();
  assertCurrentSession();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Expected JSON from ${path} but got a non-JSON response. The API isn't reachable at this origin — ` +
      `make sure the backend is running and that /api is forwarded to it, not served as the dashboard's static files.`,
    );
  }
}

export async function logout(): Promise<void> {
  const request = apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => { /* ignore */ });
  notifySessionChanged();
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  await request;
}
