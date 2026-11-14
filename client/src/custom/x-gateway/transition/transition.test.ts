// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectFor } from './effects'
import { galaxyEffect } from './galaxy'
import { blackholeEffect } from './blackhole'
import { prelude } from './effect'

const overlay = vi.hoisted(() => ({
  playEffect: vi.fn(async (_effect: unknown, options: { onCovered: () => void }) => { options.onCovered() }),
}))
vi.mock('./overlay', () => ({
  overlaySupported: () => true,
  warmEffect: vi.fn(),
  playEffect: overlay.playEffect,
}))

describe('effects', () => {
  it('uses a different effect going in than coming back', () => {
    expect(effectFor(true)).toBe(galaxyEffect)
    expect(effectFor(false)).toBe(blackholeEffect)
    expect(galaxyEffect.wgsl).not.toBe(blackholeEffect.wgsl)
  })

  it('hides the page before the route changes and well before the end', () => {
    for (const effect of [galaxyEffect, blackholeEffect]) {
      expect(effect.coveredAt).toBeGreaterThan(0.2)
      expect(effect.coveredAt).toBeLessThan(0.7)
      expect(effect.duration).toBeGreaterThan(1500)
    }
  })

  it('shares one uniform block and entry points, so the runner can drive either', () => {
    for (const effect of [galaxyEffect, blackholeEffect]) {
      expect(effect.wgsl.startsWith(prelude)).toBe(true)
      expect(effect.wgsl).toContain('@vertex')
      expect(effect.wgsl).toContain('fn vs(')
      expect(effect.wgsl).toContain('fn fs(')
    }
  })

  it('gives every palette four RGBA colours in range, for both themes', () => {
    for (const effect of [galaxyEffect, blackholeEffect]) {
      for (const dark of [true, false]) {
        const colours = effect.palette(dark)
        expect(colours).toHaveLength(4)
        for (const colour of colours) {
          expect(colour).toHaveLength(4)
          for (const channel of colour) expect(channel >= 0 && channel <= 1).toBe(true)
        }
      }
    }
  })

  it('draws star sprites in both, with a vertex entry point to place them', () => {
    for (const effect of [galaxyEffect, blackholeEffect]) {
      expect(effect.particles).toBeGreaterThan(10_000)
      expect(effect.wgsl).toContain('fn vsStar(')
      expect(effect.wgsl).toContain('fn fsStar(')
    }
  })

  it('declares the sprite count in the shader the same as in the effect', () => {
    expect(galaxyEffect.wgsl).toContain('const NG: u32 = 70000u;')
    expect(galaxyEffect.wgsl).toContain('const NW: u32 = 1500u;')
    expect(galaxyEffect.particles).toBe(70000 + 1500)
    expect(blackholeEffect.wgsl).toContain('const NK: u32 = 9000u;')
    expect(blackholeEffect.wgsl).toContain('const NP: u32 = 36000u;')
    expect(blackholeEffect.particles).toBe(9000 + 36000)
  })
})

describe('page transition install', () => {
  // The module installs document-level listeners once, so load it once for the whole file.
  beforeAll(async () => { await import('./install') })
  beforeEach(() => {
    overlay.playEffect.mockClear()
    document.body.innerHTML = ''
    window.history.replaceState(null, '', '/keys')
  })
  afterEach(() => { document.body.innerHTML = '' })

  function addLink(href: string, attrs: Record<string, string> = {}) {
    const a = document.createElement('a')
    a.href = href
    for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v)
    a.getBoundingClientRect = () => ({ left: 1000, top: 11, width: 148, height: 32, right: 1148, bottom: 43, x: 1000, y: 11, toJSON() {} })
    a.addEventListener('click', e => e.preventDefault()) // jsdom cannot navigate; the capture listener still runs first
    document.body.append(a)
    return a
  }
  const click = (el: Element, init: MouseEventInit = {}) =>
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }))

  it('plays the galaxy when a link enters Thruline, starting from the centre of the switch', async () => {
    const a = addLink('/thruline/providers', { 'data-page-switch': 'to-thruline' })
    const navigated = vi.fn((e: Event) => e.preventDefault())
    a.addEventListener('click', navigated) // the replayed click, once the page is hidden
    click(a, { clientX: 1003, clientY: 14 })
    await vi.waitFor(() => expect(overlay.playEffect).toHaveBeenCalledTimes(1))
    const [effect, options] = overlay.playEffect.mock.calls[0] as unknown as [{ id: string }, { x: number; y: number }]
    expect(effect.id).toBe('galaxy')
    expect(options.x).toBe(1074)
    expect(options.y).toBe(27)
    await vi.waitFor(() => expect(navigated).toHaveBeenCalled())
  })

  it('plays the black hole when a link leaves Thruline', async () => {
    window.history.replaceState(null, '', '/thruline/combos')
    const a = addLink('/models/chat', { 'data-page-switch': 'to-freellmapi' })
    click(a)
    await vi.waitFor(() => expect(overlay.playEffect).toHaveBeenCalledTimes(1))
    expect((overlay.playEffect.mock.calls[0] as unknown as [{ id: string }])[0].id).toBe('blackhole')
  })

  it('leaves links that stay on one side alone', () => {
    const a = addLink('/thruline/logs')
    window.history.replaceState(null, '', '/thruline/home')
    click(a)
    expect(overlay.playEffect).not.toHaveBeenCalled()
  })

  it('never animates the account sign-in callback', () => {
    const a = addLink('/thruline/accounts/callback?code=1')
    click(a)
    expect(overlay.playEffect).not.toHaveBeenCalled()
  })

  it('lets modified clicks open in a new tab untouched', () => {
    const a = addLink('/thruline/providers')
    click(a, { ctrlKey: true })
    expect(overlay.playEffect).not.toHaveBeenCalled()
  })
})
