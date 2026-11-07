// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { UsageRow } from '../../../shared/usage-overview'
import { DEFAULT_FILTERS, applyFilters, changeOf, loadFilters, rankRows, saveFilters, successRate, totalsOf } from './usage-ranking'

const row = (over: Partial<UsageRow>): UsageRow => ({
  kind: 'account', id: 1, name: 'a', requests: 0, success: 0, errors: 0, canceled: 0, inputTokens: 0, outputTokens: 0,
  avgLatencyMs: null, p95LatencyMs: null, lastRequestAt: null, rpmLimit: null,
  previous: { requests: 0, errors: 0, tokens: 0 }, allowance: null, ...over,
})
const rows = [
  row({ id: 1, name: 'alice@x.com', requests: 100, success: 90, errors: 10, inputTokens: 500, outputTokens: 100, avgLatencyMs: 800, p95LatencyMs: 2000, lastRequestAt: '2026-11-06 10:00:00' }),
  row({ id: 2, name: 'bob@x.com', requests: 40, success: 40, errors: 0, inputTokens: 90, outputTokens: 10, avgLatencyMs: 300, p95LatencyMs: 500, lastRequestAt: '2026-11-05 10:00:00' }),
  row({ id: 3, name: 'idle@x.com' }),
  row({ kind: 'profile', id: 9, name: 'Shop widget', enabled: true, requests: 100, success: 50, errors: 50, inputTokens: 5, outputTokens: 5, avgLatencyMs: 1200, p95LatencyMs: 4000, rpmLimit: 60 }),
]
const names = (rs: UsageRow[]) => rs.map(r => r.name)

describe('usage ranking helpers', () => {
  it('expresses change against the previous period', () => {
    expect(changeOf(150, 100)).toBe(0.5)
    expect(changeOf(50, 100)).toBe(-0.5)
    expect(changeOf(5, 0)).toBe('new')
    expect(changeOf(0, 0)).toBeNull()
    expect(changeOf(5, undefined)).toBeNull()
  })

  it('ranks by a column in either direction, ties by name, missing values last both ways', () => {
    expect(names(rankRows(rows, { column: 'requests', direction: 'desc' }))).toEqual(['alice@x.com', 'Shop widget', 'bob@x.com', 'idle@x.com'])
    expect(names(rankRows(rows, { column: 'requests', direction: 'asc' }))).toEqual(['idle@x.com', 'bob@x.com', 'alice@x.com', 'Shop widget'])
    expect(names(rankRows(rows, { column: 'avgLatency', direction: 'asc' }))).toEqual(['bob@x.com', 'alice@x.com', 'Shop widget', 'idle@x.com'])
    expect(names(rankRows(rows, { column: 'avgLatency', direction: 'desc' }))).toEqual(['Shop widget', 'alice@x.com', 'bob@x.com', 'idle@x.com'])
    expect(names(rankRows(rows, { column: 'successRate', direction: 'desc' }))).toEqual(['bob@x.com', 'alice@x.com', 'Shop widget', 'idle@x.com'])
    expect(names(rankRows(rows, { column: 'tokens', direction: 'desc' }))[0]).toBe('alice@x.com')
    expect(names(rankRows(rows, { column: 'name', direction: 'asc' }))[0]).toBe('alice@x.com')
    expect(names(rankRows(rows, { column: 'lastRequest', direction: 'desc' }))).toEqual(['alice@x.com', 'bob@x.com', 'idle@x.com', 'Shop widget'])
  })

  it('filters by kind, name, idleness, errors and a minimum request count', () => {
    expect(names(applyFilters(rows, { ...DEFAULT_FILTERS, kind: 'profile' }))).toEqual(['Shop widget'])
    expect(names(applyFilters(rows, { ...DEFAULT_FILTERS, kind: 'account' }))).toHaveLength(3)
    expect(names(applyFilters(rows, { ...DEFAULT_FILTERS, search: '  BOB ' }))).toEqual(['bob@x.com'])
    expect(names(applyFilters(rows, { ...DEFAULT_FILTERS, hideIdle: true }))).not.toContain('idle@x.com')
    expect(names(applyFilters(rows, { ...DEFAULT_FILTERS, onlyErrors: true }))).toEqual(['alice@x.com', 'Shop widget'])
    expect(names(applyFilters(rows, { ...DEFAULT_FILTERS, minRequests: 100 }))).toEqual(['alice@x.com', 'Shop widget'])
    expect(applyFilters(rows, { ...DEFAULT_FILTERS, search: 'zzz' })).toEqual([])
    expect(names(applyFilters(rows, { ...DEFAULT_FILTERS, hideIdle: true, onlyErrors: true, search: 'shop' }))).toEqual(['Shop widget'])
  })

  it('computes the success rate and the totals of what is shown', () => {
    expect(successRate(rows[0]!)).toBe(0.9)
    expect(successRate(rows[2]!)).toBeNull()
    expect(totalsOf(rows)).toEqual({ requests: 240, errors: 60, tokens: 710 })
    expect(totalsOf([])).toEqual({ requests: 0, errors: 0, tokens: 0 })
  })

  describe('saved filters', () => {
    beforeEach(() => localStorage.clear())
    it('round-trips and rejects junk', () => {
      const f = { kind: 'profile' as const, search: 'shop', hideIdle: true, onlyErrors: false, minRequests: 5 }
      saveFilters('k', f)
      expect(loadFilters('k')).toEqual(f)
      localStorage.setItem('k', '{"kind":"nope","search":3,"minRequests":-4,"hideIdle":"yes"}')
      expect(loadFilters('k')).toEqual(DEFAULT_FILTERS)
      localStorage.setItem('k', 'not json')
      expect(loadFilters('k')).toEqual(DEFAULT_FILTERS)
      expect(loadFilters('missing')).toEqual(DEFAULT_FILTERS)
    })
  })
})
