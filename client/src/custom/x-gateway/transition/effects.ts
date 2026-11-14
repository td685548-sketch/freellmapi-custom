import type { Effect } from './effect'
import { galaxyEffect } from './galaxy'
import { inkEffect } from './ink'

/**
 * The two directions look nothing alike on purpose, so you can tell where you
 * are heading before the new page shows: into Thruline a galaxy blooms out of
 * the switch and the page opens along a lit line; back to FreeLLMAPI an ink
 * ring collapses onto the switch and detonates as a single dot.
 */
export const effectFor = (entering: boolean): Effect => (entering ? galaxyEffect : inkEffect)
