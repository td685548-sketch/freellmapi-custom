import type { Effect } from './effect'
import { galaxyEffect } from './galaxy'
import { blackholeEffect } from './blackhole'

/**
 * The two directions look nothing alike on purpose, so you can tell where you
 * are heading before the new page shows. Into Thruline: cold blue, outward — a
 * galaxy blooms out of the switch, you dive into it and jump to light speed.
 * Back to FreeLLMAPI: warm and dark — the switch becomes a black hole that
 * swallows the page, then goes off as a burst of light.
 */
export const effectFor = (entering: boolean): Effect => (entering ? galaxyEffect : blackholeEffect)
