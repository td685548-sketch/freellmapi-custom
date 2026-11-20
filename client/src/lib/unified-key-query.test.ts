import { describe, expect, it } from 'vitest'
import { UNIFIED_KEY_GC_TIME_MS, UNIFIED_KEY_QUERY_KEY } from './unified-key-query'

// The unified key must live under exactly one cache entry, evicted soon after
// it stops being rendered: two keys meant the secret was fetched twice and
// held in two entries, and the React Query default gcTime (5 minutes) kept
// the plaintext key around long after the operator navigated away.
describe('unified key query', () => {
  it('uses a single shared query key', () => {
    expect([...UNIFIED_KEY_QUERY_KEY]).toEqual(['unified-key'])
  })

  it('evicts the cached key a minute after it stops being rendered', () => {
    expect(UNIFIED_KEY_GC_TIME_MS).toBe(60_000)
  })
})
