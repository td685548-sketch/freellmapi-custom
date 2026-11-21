// Plain (non-component) module for web-cookie credential extraction.
// Moved out of ConnectAccountDialog.tsx so that component file exports
// only the component (react-refresh/only-export-components), while the
// deepseek-web token helpers from #174 stay available to the dialog and
// to client/src/App.test.ts.

function sanitizeCookiePart(raw: string): string {
  return raw.replace(/[\r\n\0]+/g, '')
}

function isGoogleCookieDomain(domain: unknown): boolean {
  if (domain === undefined || domain === null) return true
  if (typeof domain !== 'string') return false
  const host = domain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
  if (!host) return true
  return host === 'google.com' || host.endsWith('.google.com')
}

function isChatGptCookieDomain(domain: unknown): boolean {
  if (domain === undefined || domain === null) return true
  if (typeof domain !== 'string') return false
  const host = domain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
  if (!host) return true
  return (
    host === 'chatgpt.com' ||
    host.endsWith('.chatgpt.com') ||
    host === 'openai.com' ||
    host.endsWith('.openai.com')
  )
}

function isDurableSessionCookieName(name: string): boolean {
  return (
    name === '__Secure-1PSID' ||
    name === '__Secure-next-auth.session-token' ||
    name.startsWith('__Secure-next-auth.session-token.') ||
    name === '__client' ||
    name === 'ds_session_id'
  )
}

function isExpiredCookie(cookie: Record<string, unknown>, nowMs: number): boolean {
  const rawExpiry = cookie.expirationDate ?? cookie.expires
  if (rawExpiry === undefined || rawExpiry === null || rawExpiry === '') return false
  let expiryMs: number | undefined
  if (typeof rawExpiry === 'number') {
    if (!Number.isFinite(rawExpiry) || rawExpiry <= 0) return false
    expiryMs = rawExpiry > 1e12 ? rawExpiry : rawExpiry * 1000
  } else if (typeof rawExpiry === 'string') {
    const s = rawExpiry.trim()
    if (!s) return false
    if (/^-?\d+(?:\.\d+)?$/.test(s)) {
      const num = Number(s)
      if (!Number.isFinite(num) || num <= 0) return false
      expiryMs = num > 1e12 ? num : num * 1000
    } else {
      const parsedMs = Date.parse(s)
      if (Number.isFinite(parsedMs)) expiryMs = parsedMs
    }
  }
  return expiryMs !== undefined && expiryMs <= nowMs
}

function cookieSpecificity(cookie: Record<string, unknown>): number {
  const domainStr = typeof cookie.domain === 'string' ? cookie.domain.trim().toLowerCase() : ''
  const hostPart = domainStr.replace(/^\.+/, '').replace(/\.+$/, '')
  const domainScore = !hostPart ? 0 : hostPart.length * 2 + (domainStr.startsWith('.') ? 0 : 1)
  const pathScore = typeof cookie.path === 'string' ? cookie.path.length : 0
  return domainScore * 1000 + pathScore
}

function unwrapNestedTokenValue(raw: string, depth = 0): string {
  const trimmed = raw.trim()
  if (!trimmed || depth >= 4) return trimmed
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      const inner = JSON.parse(trimmed) as unknown
      if (typeof inner === 'string' && inner.trim()) {
        return unwrapNestedTokenValue(inner, depth + 1)
      }
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        const innerObj = inner as Record<string, unknown>
        if (typeof innerObj.value === 'string' && innerObj.value.trim()) {
          return unwrapNestedTokenValue(innerObj.value, depth + 1)
        }
      }
    } catch {
      // Fall through to trimmed token
    }
  }
  return trimmed
}

function unwrapLocalStorageCookieInput(obj: Record<string, unknown>, rawTrimmed: string): string | null {
  const keys = Object.keys(obj)
  if (keys.length > 0 && keys.every(k => k === 'value' || k === '__version') && 'value' in obj) {
    if (typeof obj.value === 'string' && obj.value.trim()) {
      return unwrapNestedTokenValue(obj.value)
    }
    if (obj.value && typeof obj.value === 'object') {
      return rawTrimmed
    }
  }
  if (keys.length > 0 && keys.every(k => k === 'userToken' || k === '__version') && 'userToken' in obj) {
    if (typeof obj.userToken === 'string' && obj.userToken.trim()) {
      return unwrapNestedTokenValue(obj.userToken)
    }
  }
  if (Array.isArray(obj.origins)) {
    const hasDsSessionCookie =
      Array.isArray(obj.cookies) &&
      obj.cookies.some(c => Boolean(c) && typeof c === 'object' && (c as Record<string, unknown>).name === 'ds_session_id')
    if (!hasDsSessionCookie) {
      for (const origin of obj.origins) {
        const items = (origin as { localStorage?: Array<{ name?: unknown; value?: unknown }> } | null)?.localStorage
        if (!Array.isArray(items)) continue
        const hit = items.find(entry => entry?.name === 'userToken' && typeof entry.value === 'string')
        if (hit && typeof hit.value === 'string' && hit.value.trim()) {
          try {
            const parsedHit = JSON.parse(hit.value) as unknown
            if (
              parsedHit &&
              typeof parsedHit === 'object' &&
              !Array.isArray(parsedHit) &&
              (parsedHit as Record<string, unknown>).value &&
              typeof (parsedHit as Record<string, unknown>).value === 'object'
            ) {
              return rawTrimmed
            }
          } catch {
            // Fall through to string extraction
          }
          return unwrapNestedTokenValue(hit.value)
        }
      }
    }
  }
  return null
}

export function extractCookieCredential(raw: string, providerId?: string): string {
  let trimmed = raw.trim()
  if (/^LLM\|[^|\s]+\|[^|\s]+$/.test(trimmed)) {
    return sanitizeCookiePart(trimmed)
  }
  if (/^(?:Cookie|Authorization):\s*/i.test(trimmed)) {
    trimmed = trimmed.replace(/^(?:Cookie|Authorization):\s*/i, '').replace(/^Bearer\s+/i, '').trim()
  }
  if (/^LLM\|[^|\s]+\|[^|\s]+$/.test(trimmed)) {
    return sanitizeCookiePart(trimmed)
  }
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      let rawCookies: Array<Record<string, unknown>> | null = null
      if (Array.isArray(parsed)) {
        rawCookies = parsed.filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && !Array.isArray(c))
      } else if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>
        const unwrappedToken = unwrapLocalStorageCookieInput(obj, trimmed)
        if (unwrappedToken !== null) {
          return sanitizeCookiePart(unwrappedToken)
        }
        if (Array.isArray(obj.cookies)) {
          rawCookies = obj.cookies.filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && !Array.isArray(c))
        } else {
          const kvEntries = Object.entries(obj).filter(([, val]) => typeof val === 'string')
          if (kvEntries.length > 0 && kvEntries.length === Object.keys(obj).length) {
            rawCookies = kvEntries.map(([name, value]) => ({ name, value }))
          }
        }
      }

      if (rawCookies && rawCookies.length > 0) {
        const nowMs = Date.now()
        const deduped = new Map<string, { value: string; specificity: number }>()
        for (const c of rawCookies) {
          if (typeof c.name !== 'string' || typeof c.value !== 'string') continue
          const name = sanitizeCookiePart(c.name).trim()
          const value = sanitizeCookiePart(c.value)
          if (!name || /[=;]/.test(name)) continue
          if (providerId === 'gemini-web' && !isGoogleCookieDomain(c.domain)) continue
          if (providerId === 'chatgpt-web' && !isChatGptCookieDomain(c.domain)) continue
          if (!isDurableSessionCookieName(name) && isExpiredCookie(c, nowMs)) continue

          const specificity = cookieSpecificity(c)
          const existing = deduped.get(name)
          if (!existing || specificity >= existing.specificity) {
            deduped.set(name, { value, specificity })
          }
        }
        if (deduped.size > 0) {
          return Array.from(deduped.entries(), ([name, entry]) => `${name}=${entry.value}`).join('; ')
        }
      }
    } catch {
      // Fall through and return raw trimmed string
    }
  }
  return sanitizeCookiePart(trimmed)
}
