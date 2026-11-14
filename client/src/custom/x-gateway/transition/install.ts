
/**
 * Plays a WebGPU transition when a link crosses between the FreeLLMAPI
 * dashboard and Thruline (/thruline). Installed once as a document-level listener so
 * no upstream component has to know about it. Going in and coming back use
 * different effects (see effects.ts). Browsers without WebGPU, and people who
 * prefer reduced motion, get the normal instant navigation.
 */
// The shaders and the GPU runner are a separate download, fetched on first intent (hover or
// focus on the switch) or, failing that, at the click.
const loadEngine = () => import('./engine')

/** Cheap guess made without loading anything; the engine makes the real decision. */
function webgpuLikely() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const base = import.meta.env.BASE_URL.replace(/\/$/, '')
const inGateway = (pathname: string) => {
  const path = pathname.startsWith(base) ? pathname.slice(base.length) : pathname
  return path === '/thruline' || path.startsWith('/thruline/')
}

let running = false
let replaying = false

function crossingLink(target: EventTarget | null) {
  const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null
  if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return null
  const url = new URL(anchor.href, window.location.href)
  if (url.origin !== window.location.origin || url.pathname.includes('/thruline/accounts/callback')) return null
  const entering = inGateway(url.pathname)
  return entering === inGateway(window.location.pathname) ? null : { anchor, url, entering }
}

function navigate(anchor: HTMLAnchorElement, url: URL) {
  if (anchor.isConnected) {
    // Re-dispatch so the router and the link's own handlers run as usual.
    replaying = true
    try { anchor.click() } finally { replaying = false }
  } else {
    window.history.pushState(null, '', url)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
}

/**
 * Where the effect starts. The page switch always starts from its own centre, so
 * a click on its edge and a keyboard press look the same; any other link starts
 * from the pointer (or from the link itself when activated by keyboard).
 */
function originOf(event: MouseEvent, anchor: HTMLAnchorElement) {
  const box = anchor.getBoundingClientRect()
  const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  if (anchor.hasAttribute('data-page-switch')) return centre
  const fromKeyboard = event.clientX === 0 && event.clientY === 0
  return fromKeyboard ? centre : { x: event.clientX, y: event.clientY }
}

function onClick(event: MouseEvent) {
  if (replaying || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  if (!webgpuLikely()) return
  const link = crossingLink(event.target)
  if (!link) return
  event.preventDefault()
  event.stopPropagation()
  if (running) return
  running = true
  let navigated = false
  const go = () => { if (!navigated) { navigated = true; navigate(link.anchor, link.url) } }
  const origin = originOf(event, link.anchor)
  const dark = document.documentElement.classList.contains('dark')
  loadEngine()
    .then(engine => engine.overlaySupported()
      ? engine.playEffect(engine.effectFor(link.entering), { ...origin, dark, onCovered: go })
      : go())
    .catch(go)
    .finally(() => { running = false })
}

/** Start building the GPU pipeline as soon as the pointer or focus reaches a crossing link. */
function onIntent(event: Event) {
  if (!webgpuLikely()) return
  const link = crossingLink(event.target)
  if (link) void loadEngine().then(engine => engine.warmEffect(engine.effectFor(link.entering))).catch(() => { /* optional */ })
}

let installed = false
export function installGatewayTransition() {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('click', onClick, true)
  document.addEventListener('pointerover', onIntent, { capture: true, passive: true })
  document.addEventListener('focusin', onIntent, true)
}

installGatewayTransition()
