import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A 401 must end the dashboard session ONLY when it is our auth saying so.
// Discover/probe endpoints relay an upstream provider's 401 with its status
// intact ("the endpoint rejected the key"); treating any 401 as session-expired
// signed the operator out every time they tested a bad provider key.

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
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('fires the unauthorized event and bumps the session revision on a session 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, {
      error: { message: 'Authentication required', type: 'authentication_error' },
    })))
    const { apiFetch } = await import('./api')
    const { getSessionRevision } = await import('../custom/session-state')
    const before = getSessionRevision()

    await expect(apiFetch('/api/keys')).rejects.toMatchObject({ status: 401, code: 'authentication_error' })
    expect(getSessionRevision()).toBeGreaterThan(before)
    expect(events).toContain('freellmapi:unauthorized')
  })

  it('keeps the session when a discover/probe relays an upstream 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, {
      error: { message: 'The endpoint rejected the key (HTTP 401)', type: 'upstream_error' },
    })))
    const { apiFetch } = await import('./api')
    const { getSessionRevision } = await import('../custom/session-state')
    const before = getSessionRevision()

    await expect(apiFetch('/api/keys/custom/discover-models', { method: 'POST', body: '{}' }))
      .rejects.toMatchObject({ status: 401, code: 'upstream_error' })
    expect(getSessionRevision()).toBe(before)
    expect(events).toHaveLength(0)
  })

  it('keeps the session on an untyped 401 rather than guessing it expired', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: { message: 'nope' } })))
    const { apiFetch } = await import('./api')
    const { getSessionRevision } = await import('../custom/session-state')
    const before = getSessionRevision()

    await expect(apiFetch('/api/whatever')).rejects.toMatchObject({ status: 401 })
    expect(getSessionRevision()).toBe(before)
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

// Phase 2 of the httpOnly-cookie move: the session lives only in the
// httpOnly cookie, so apiFetch sends no Authorization header at all — the
// cookie rides along via credentials: 'same-origin', and mutations
// additionally carry the double-submit CSRF token from the readable cookie.
describe('apiFetch session cookie + CSRF (Phase 2)', () => {
  beforeEach(() => {
    events = []
    stubStorages()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends credentials: same-origin and no Authorization header', async () => {
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
    expect(new Headers(capturedInit?.headers).get('Authorization')).toBeNull()
  })

  it('attaches the CSRF token on mutations, not on reads', async () => {
    vi.stubGlobal('document', { cookie: 'flm_csrf=csrf-value-123; flm_session=opaque' })
    const seen: Array<{ url: string; headers: Headers }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: new Headers(init?.headers) })
      return jsonResponse(200, { ok: true })
    }))
    const { apiFetch } = await import('./api')

    await apiFetch('/api/keys')
    await apiFetch('/api/keys', { method: 'POST', body: '{}' })
    expect(seen[0].headers.get('X-CSRF-Token')).toBeNull()
    expect(seen[1].headers.get('X-CSRF-Token')).toBe('csrf-value-123')
  })

  it('sends no CSRF header when the CSRF cookie is absent', async () => {
    vi.stubGlobal('document', { cookie: '' })
    let capturedInit: RequestInit | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedInit = init
      return jsonResponse(200, { ok: true })
    }))
    const { apiFetch } = await import('./api')

    await apiFetch('/api/keys', { method: 'POST', body: '{}' })
    expect(new Headers(capturedInit?.headers).get('X-CSRF-Token')).toBeNull()
  })
})

// Phase 2: the dashboard token lives ONLY in the httpOnly cookie. A token
// left in storage by a pre-Phase-2 build must be purged on import, or the
// stale readable token would linger next to the cookie and defeat the
// whole point.
describe('no dashboard token in JS storage (Phase 2)', () => {
  beforeEach(() => {
    events = []
    stubStorages()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('purges a legacy token from sessionStorage and localStorage on import', async () => {
    sessionStorage.setItem('freellmapi_dashboard_token', 'stale-session-token')
    localStorage.setItem('freellmapi_dashboard_token', 'stale-persistent-token')
    vi.resetModules()
    await import('./api')
    expect(sessionStorage.getItem('freellmapi_dashboard_token')).toBeNull()
    expect(localStorage.getItem('freellmapi_dashboard_token')).toBeNull()
  })

  it('never writes a token to storage on any apiFetch call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ok: true })))
    const { apiFetch } = await import('./api')
    await apiFetch('/api/keys')
    await apiFetch('/api/keys', { method: 'POST', body: '{}' })
    expect(sessionStorage.getItem('freellmapi_dashboard_token')).toBeNull()
    expect(localStorage.getItem('freellmapi_dashboard_token')).toBeNull()
  })
})
