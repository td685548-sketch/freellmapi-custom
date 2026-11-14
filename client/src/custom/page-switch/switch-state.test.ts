// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { readMemory, remember, sideOf, switchTarget } from './switch-state'

afterEach(() => sessionStorage.clear())

describe('sideOf', () => {
  it('puts every /thruline path on the Thruline side', () => {
    expect(sideOf('/thruline')).toBe('thruline')
    expect(sideOf('/thruline/providers/openai')).toBe('thruline')
  })
  it('puts everything else on the FreeLLMAPI side, including look-alikes', () => {
    expect(sideOf('/models/chat')).toBe('freellmapi')
    expect(sideOf('/thrulines')).toBe('freellmapi')
    expect(sideOf('/')).toBe('freellmapi')
  })
})

describe('switchTarget', () => {
  it('opens each side at its home page the first time', () => {
    expect(switchTarget('thruline', {})).toBe('/thruline/providers')
    expect(switchTarget('freellmapi', {})).toBe('/models/chat')
  })
  it('returns to the page that side was last left on', () => {
    expect(switchTarget('thruline', { thruline: '/thruline/combos?tab=1' })).toBe('/thruline/combos?tab=1')
    expect(switchTarget('freellmapi', { freellmapi: '/keys' })).toBe('/keys')
  })
  it('ignores a remembered path that belongs to the other side', () => {
    expect(switchTarget('thruline', { thruline: '/keys' })).toBe('/thruline/providers')
    expect(switchTarget('freellmapi', { freellmapi: '/thruline/home' })).toBe('/models/chat')
  })
})

describe('memory', () => {
  it('keeps one path per side', () => {
    remember('thruline', '/thruline/home')
    remember('freellmapi', '/keys')
    remember('thruline', '/thruline/logs')
    expect(readMemory()).toEqual({ thruline: '/thruline/logs', freellmapi: '/keys' })
  })
  it('survives corrupt storage', () => {
    sessionStorage.setItem('page-switch.last', '{not json')
    expect(readMemory()).toEqual({})
  })
})
