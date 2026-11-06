import { describe, expect, it } from 'vitest'
import { SNIPPET_LANGUAGES, integrationSnippet, testHint, type TestResultView } from './integration-snippets'

const fail = (over: Partial<TestResultView>): TestResultView => ({
  status: 403, ok: false, latencyMs: 5, model: null, platform: null, reply: null, usage: null, retryAfter: null,
  error: { message: 'm', code: null, type: null }, ...over,
})

describe('integration snippets', () => {
  it('put the server address in every language and never a key', () => {
    for (const { value } of SNIPPET_LANGUAGES) {
      const text = integrationSnippet(value, 'https://gateway.example.com/v1/')
      expect(text).toContain('https://gateway.example.com/v1')
      expect(text).not.toContain('v1//')
      expect(text).toContain('FREELLM_KEY')
      expect(text).not.toMatch(/sk-cp-[0-9a-f]{8}/)
      expect(text).toContain('auto')
    }
  })

  it('show where the system prompt, page data and chat history go', () => {
    const node = integrationSnippet('node', 'https://g/v1')
    expect(node).toContain('...history')
    expect(node).toContain('pageData')
    expect(node).toContain('role: "system"')
    expect(integrationSnippet('python', 'https://g/v1')).toContain('*history')
    expect(integrationSnippet('curl', 'https://g/v1')).toContain('"role": "system"')
  })
})

describe('testHint', () => {
  it('says nothing for a success', () => {
    expect(testHint(fail({ ok: true, status: 200 }))).toBeNull()
  })
  it('explains each refusal and what to change', () => {
    expect(testHint(fail({ error: { message: '', code: 'model_not_allowed', type: null } }))).toContain('Restrictions')
    expect(testHint(fail({ error: { message: '', code: 'model_required', type: null } }))).toContain('Restrictions')
    expect(testHint(fail({ status: 429, retryAfter: 30, error: { message: '', code: 'profile_rate_limit_exceeded', type: null } }))).toContain('30 s')
    expect(testHint(fail({ status: 429, retryAfter: 3600, error: { message: '', code: 'profile_quota_exceeded', type: null } }))).toContain('Allowances')
    expect(testHint(fail({ status: 404, error: { message: '', code: 'model_not_found', type: null } }))).toContain('catalog')
    expect(testHint(fail({ status: 401 }))).toContain('rotated')
    expect(testHint(fail({ status: 400, error: { message: 'None of the models this key may use is enabled.', code: null, type: null } }))).toContain('Models page')
    expect(testHint(fail({ status: 0 }))).toContain('own API')
    expect(testHint(fail({ status: 502 }))).toContain('provider')
    expect(testHint(fail({ status: 404 }))).toBeNull()
  })
})
