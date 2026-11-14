import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/**
 * A route component that is downloaded the first time it is shown, not with the app.
 *
 * `preload()` starts the same download early (on hover, or at start-up for the page being
 * opened) and shares it with the render, so the file is fetched once whichever comes first.
 */
export type LazyPage<P = object> = LazyExoticComponent<ComponentType<P>> & { preload: () => void }

const RELOAD_FLAG = 'route-splitting.reloaded'

/** True when the failure looks like a chunk that no longer exists on the server. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError/i.test(message)
}

/**
 * After a deploy, a tab that is still running the old build asks for chunks whose hashed
 * names are gone. One reload fetches the new build; the flag stops a reload loop if the
 * failure has some other cause. Never throws: storage and reload are both best effort.
 */
function reloadOnce(): boolean {
  try {
    if (window.sessionStorage.getItem(RELOAD_FLAG)) return false
    window.sessionStorage.setItem(RELOAD_FLAG, '1')
    window.location.reload()
    return true
  } catch {
    return false
  }
}

/** A page that loaded successfully clears the guard, so a later deploy can reload once again. */
function clearReloadGuard(): void {
  try { window.sessionStorage.removeItem(RELOAD_FLAG) } catch { /* optional */ }
}

export function lazyPage<P = object>(load: () => Promise<{ default: ComponentType<P> }>): LazyPage<P> {
  let pending: Promise<{ default: ComponentType<P> }> | undefined
  const start = () => {
    pending ??= load().then(
      module => { clearReloadGuard(); return module },
      (error: unknown) => {
        pending = undefined // a failed download must not be remembered; the next try asks again
        if (isChunkLoadError(error) && reloadOnce()) return new Promise<never>(() => { /* the page is reloading */ })
        throw error
      },
    )
    return pending
  }
  const component = lazy(start) as LazyPage<P>
  component.preload = () => { void start().catch(() => { /* surfaced when the page is actually opened */ }) }
  return component
}

/** For modules that export the page under a name rather than as the default. */
export function lazyNamed<M extends Record<string, unknown>, K extends keyof M & string>(
  load: () => Promise<M>,
  name: K,
): LazyPage<M[K] extends ComponentType<infer P> ? P : object> {
  return lazyPage(() => load().then(module => ({ default: module[name] as ComponentType<never> }))) as never
}
