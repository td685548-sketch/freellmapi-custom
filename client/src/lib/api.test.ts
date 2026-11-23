import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A 401 must end the dashboard session ONLY when it is our auth saying so.
// Discover/probe endpoints relay an upstream provider's 401 with its status
// intact ("the endpoint rejected the key"); treating any 401 as session-expired
// signed the operator out every time they tested a bad provider key.

const TOKEN_KEY = 'freellmapi_dashboard_token'

function makeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size },
  } as Storage
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubStorages() {
  vi.stubGlobal('localStorage', makeStorage())
  vi.stubGlobal('sessionStorage', makeStorage())
  vi.stubGlobal('window', { addEventListener: () => {}, dispatchEvent: (e: Event) => { events.push(e.type); return true } })
  // Node's CustomEvent (>=19) works; make sure it exists either way.
  if (typeof globalThis.CustomEvent === 'undefined') {
    vi.stubGlobal('CustomEvent', class extends Event {})
  }
}

let events: string[]

describe('apiFetch 401 handling', () => {
  beforeEach(() => {
    events = []
    stubStorages()
    sessionStorage.setItem(TOKEN_KEY, 'session-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('clears the token and fires the unauthorized event on a session 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, {
      error: { message: 'Authentication required', type: 'authentication_error' },
    })))
    const { apiFetch } = await import('./api')

    await expect(apiFetch('/api/keys')).rejects.toMatchObject({ status: 401, code: 'authentication_error' })
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(events).toContain('freellmapi:unauthorized')
  })

  it('keeps the session when a discover/probe relays an upstream 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, {
      error: { message: 'The endpoint rejected the key (HTTP 401)', type: 'upstream_error' },
    })))
    const { apiFetch } = await import('./api')

    await expect(apiFetch('/api/keys/custom/discover-models', { method: 'POST', body: '{}' }))
      .rejects.toMatchObject({ status: 401, code: 'upstream_error' })
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('session-token')
    expect(events).toHaveLength(0)
  })

  it('keeps the session on an untyped 401 rather than guessing it expired', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: { message: 'nope' } })))
    const { apiFetch } = await import('./api')

    await expect(apiFetch('/api/whatever')).rejects.toMatchObject({ status: 401 })
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('session-token')
    expect(events).toHaveLength(0)
  })
})

describe('apiFetch error messages', () => {
  beforeEach(() => {
    events = []
    stubStorages()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('shows a plain-string error body instead of the bare status (Premium activation)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(502, {
      error: 'Could not reach the license service. Check your connection and try again.',
    })))
    const { apiFetch } = await import('./api')
    await expect(apiFetch('/api/premium/key', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      status: 502,
      message: 'Could not reach the license service. Check your connection and try again.',
    })
  })

  it('still reads { error: { message } } bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: { message: 'Bad input', type: 'invalid_request_error' } })))
    const { apiFetch } = await import('./api')
    await expect(apiFetch('/api/keys')).rejects.toMatchObject({ status: 400, message: 'Bad input', code: 'invalid_request_error' })
  })

  it('falls back to the HTTP status when the body has no message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, {})))
    const { apiFetch } = await import('./api')
    await expect(apiFetch('/api/keys')).rejects.toMatchObject({ status: 500, message: 'HTTP 500' })
  })
})

// Phase 1 of the httpOnly-cookie move: the server also sets the session as
// an httpOnly cookie, and apiFetch must send it on same-origin calls — while
// still sending the Authorization header, which stays the only way to write
// until a later phase.
describe('apiFetch session cookie (Phase 1)', () => {
  beforeEach(() => {
    events = []
    stubStorages()
    sessionStorage.setItem(TOKEN_KEY, 'session-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends credentials: same-origin so the httpOnly session cookie rides along', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (...args: [string, RequestInit?]) => {
      capturedInit = args[1];
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal('fetch', fetchMock)
    const { apiFetch } = await import('./api')

    await apiFetch('/api/keys')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(capturedInit?.credentials).toBe('same-origin')
    expect(new Headers(capturedInit?.headers).get('Authorization')).toBe('Bearer session-token')
  })
})

// Session mitigations: the dashboard token lives in sessionStorage (dies with
// the tab) instead of localStorage (persists indefinitely). A token left in
// localStorage by an older build must never be read back — it is purged.
describe('dashboard token storage', () => {
  beforeEach(() => {
    events = []
    stubStorages()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('stores the token in sessionStorage, never in localStorage', async () => {
    const { setToken } = await import('./api')
    setToken('session-token')
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('session-token')
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
  })

  it('ignores and purges a legacy token left in localStorage', async () => {
    localStorage.setItem(TOKEN_KEY, 'legacy-persistent-token')
    const { getToken } = await import('./api')
    expect(getToken()).toBeNull()
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
  })

  it('clearToken removes the token from sessionStorage', async () => {
    const { setToken, clearToken, getToken } = await import('./api')
    setToken('session-token')
    clearToken()
    expect(getToken()).toBeNull()
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull()
  })
})
