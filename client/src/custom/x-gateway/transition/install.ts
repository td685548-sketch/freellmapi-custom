import { playPortal, portalSupported, warmPortal } from './portal'

/**
 * Plays the WebGPU transition when a link crosses between the FreeLLMAPI
 * dashboard and Xwitch (/x). Installed once as a document-level listener so
 * no upstream component has to know about it. Browsers without WebGPU, and
 * people who prefer reduced motion, get the normal instant navigation.
 */
const base = import.meta.env.BASE_URL.replace(/\/$/, '')
const inGateway = (pathname: string) => {
  const path = pathname.startsWith(base) ? pathname.slice(base.length) : pathname
  return path === '/x' || path.startsWith('/x/')
}

let running = false
let replaying = false

function crossingLink(target: EventTarget | null) {
  const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null
  if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return null
  const url = new URL(anchor.href, window.location.href)
  if (url.origin !== window.location.origin || url.pathname.includes('/x/accounts/callback')) return null
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

function onClick(event: MouseEvent) {
  if (replaying || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  if (!portalSupported()) return
  const link = crossingLink(event.target)
  if (!link) return
  event.preventDefault()
  event.stopPropagation()
  if (running) return
  running = true
  let navigated = false
  const go = () => { if (!navigated) { navigated = true; navigate(link.anchor, link.url) } }
  // A keyboard-activated link reports 0,0; start from the link itself then.
  const box = link.anchor.getBoundingClientRect()
  const fromKeyboard = event.clientX === 0 && event.clientY === 0
  playPortal({
    x: fromKeyboard ? box.left + box.width / 2 : event.clientX,
    y: fromKeyboard ? box.top + box.height / 2 : event.clientY,
    entering: link.entering,
    dark: document.documentElement.classList.contains('dark'),
    onCovered: go,
  }).catch(go).finally(() => { running = false })
}

/** Start building the GPU pipeline as soon as the pointer or focus reaches a crossing link. */
function onIntent(event: Event) {
  if (portalSupported() && crossingLink(event.target)) void warmPortal()
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
