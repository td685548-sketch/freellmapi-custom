// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectFor } from './effects'
import { galaxyEffect } from './galaxy'
import { inkEffect } from './ink'
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
    expect(effectFor(false)).toBe(inkEffect)
    expect(galaxyEffect.wgsl).not.toBe(inkEffect.wgsl)
  })

  it('hides the page before the route changes and well before the end', () => {
    for (const effect of [galaxyEffect, inkEffect]) {
      expect(effect.coveredAt).toBeGreaterThan(0.2)
      expect(effect.coveredAt).toBeLessThan(0.7)
      expect(effect.duration).toBeGreaterThan(1500)
    }
  })

  it('shares one uniform block and entry points, so the runner can drive either', () => {
    for (const effect of [galaxyEffect, inkEffect]) {
      expect(effect.wgsl.startsWith(prelude)).toBe(true)
      expect(effect.wgsl).toContain('@vertex')
      expect(effect.wgsl).toContain('fn vs(')
      expect(effect.wgsl).toContain('fn fs(')
    }
  })

  it('gives every palette four RGBA colours in range, for both themes', () => {
    for (const effect of [galaxyEffect, inkEffect]) {
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

  it('draws the ink in the light theme paler than in the dark one', () => {
    const luminance = (c: number[]) => c[0] + c[1] + c[2]
    expect(luminance(inkEffect.palette(false)[0])).toBeGreaterThan(luminance(inkEffect.palette(true)[0]))
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

  it('plays the ink when a link leaves Thruline', async () => {
    window.history.replaceState(null, '', '/thruline/combos')
    const a = addLink('/models/chat', { 'data-page-switch': 'to-freellmapi' })
    click(a)
    await vi.waitFor(() => expect(overlay.playEffect).toHaveBeenCalledTimes(1))
    expect((overlay.playEffect.mock.calls[0] as unknown as [{ id: string }])[0].id).toBe('ink')
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
