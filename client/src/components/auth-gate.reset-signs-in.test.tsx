// @vitest-environment jsdom
//
// A password reset used to end on "Please sign in", but the login form needs
// the account email, which an operator who forgot the password may not
// remember either (#1477). The server now signs them in after a valid reset
// code; the form must open the dashboard — with the session arriving as the
// httpOnly cookie, never as a token in JS (Phase 2 of the cookie move).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { AuthGate } from './auth-gate'

let root: Root
let container: HTMLDivElement
let authenticated: boolean
let resetResponse: { status: number; body: unknown }
let posts: { url: string; body: Record<string, string> | null }[]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <AuthGate><div data-testid="app">dashboard</div></AuthGate>
        </I18nProvider>
      </QueryClientProvider>,
    )
  })
}

function type(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function clickButton(label: string) {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === label)!
  act(() => { button.click() })
  await flush()
}

async function resetWithCode() {
  mount()
  await flush()
  await clickButton('Forgot password?')
  await clickButton('Send reset code')
  type('#reset-code', 'ABCDEFGHIJ')
  type('#reset-new-password', 'brand-new-password')
  const form = container.querySelector('form')!
  act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  await flush()
}

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  authenticated = false
  posts = []
  resetResponse = { status: 200, body: { success: true, email: 'owner@example.test' } }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/auth/status')) {
      return json({ needsSetup: false, authenticated, email: authenticated ? 'owner@example.test' : null })
    }
    if (init?.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
      if (url.endsWith('/api/auth/forgot-password')) return json({ success: true })
      if (url.endsWith('/api/auth/reset-password')) {
        if (resetResponse.status === 200) authenticated = true
        return json(resetResponse.body, resetResponse.status)
      }
    }
    return json({ error: { message: `unexpected ${url}` } }, 404)
  }))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('AuthGate password reset', () => {
  it('signs in with the session the reset sets instead of asking for the email', async () => {
    await resetWithCode()

    expect(posts.map(p => p.url.replace(/^.*\/api/, '/api'))).toEqual(['/api/auth/forgot-password', '/api/auth/reset-password'])
    expect(posts[1].body).toEqual({ resetCode: 'ABCDEFGHIJ', newPassword: 'brand-new-password' })
    // Phase 2: no token ever reaches JS storage — the session is the
    // httpOnly cookie the server set on the reset response.
    expect(sessionStorage.getItem('freellmapi_dashboard_token')).toBeNull()
    expect(localStorage.getItem('freellmapi_dashboard_token')).toBeNull()
    expect(container.querySelector('[data-testid="app"]')).not.toBeNull()
  })

  it('stays on the reset form with the error when the code is wrong', async () => {
    resetResponse = { status: 403, body: { error: { message: 'Invalid or expired reset code' } } }
    await resetWithCode()

    expect(sessionStorage.getItem('freellmapi_dashboard_token')).toBeNull()
    expect(container.querySelector('[data-testid="app"]')).toBeNull()
    expect(container.textContent).toContain('Invalid or expired reset code')
  })
})
