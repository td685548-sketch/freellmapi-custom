import { useEffect, useRef, useSyncExternalStore } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useShellStrings } from '../shell-strings'

/**
 * In-app replacement for window.confirm. Call `askConfirm(message)` anywhere
 * and await the answer; <ConfirmHost /> (mounted once in the console shell)
 * renders the dialog.
 */
interface Request { message: string; resolve: (ok: boolean) => void }

let current: Request | null = null
let hosts = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(listener => listener())
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

export function askConfirm(message: string): Promise<boolean> {
  // Without a mounted host (a page rendered on its own) fall back to the browser's dialog.
  if (hosts === 0) return Promise.resolve(window.confirm(message))
  current?.resolve(false)
  return new Promise(resolve => { current = { message, resolve }; emit() })
}

function settle(ok: boolean) {
  const request = current
  current = null
  emit()
  request?.resolve(ok)
}

export function ConfirmHost() {
  const sh = useShellStrings()
  const request = useSyncExternalStore(subscribe, () => current)
  const cancel = useRef<HTMLButtonElement>(null)
  const opener = useRef<Element | null>(null)
  useEffect(() => { hosts += 1; return () => { hosts -= 1; settle(false) } }, [])
  useEffect(() => {
    if (!request) return
    opener.current = document.activeElement
    cancel.current?.focus() // the safe choice is the default
    return () => { if (opener.current instanceof HTMLElement) opener.current.focus() }
  }, [request])
  if (!request) return null
  return <div className="x-confirm-scrim" onMouseDown={event => { if (event.target === event.currentTarget) settle(false) }}>
    <div className="x-confirm" role="alertdialog" aria-modal="true" aria-labelledby="x-confirm-title" aria-describedby="x-confirm-message"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); settle(false) }
        if (event.key === 'Tab') {
          // Two buttons: keep focus inside the dialog.
          const buttons = event.currentTarget.querySelectorAll('button')
          const first = buttons[0]
          const last = buttons[buttons.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
      }}>
      <span className="x-confirm-icon" aria-hidden="true"><TriangleAlert size={18} /></span>
      <div className="x-confirm-body">
        <h2 id="x-confirm-title">{sh.confirmTitle}</h2>
        <p id="x-confirm-message">{request.message}</p>
      </div>
      <div className="x-confirm-actions">
        <button ref={cancel} type="button" className="x-button" onClick={() => settle(false)}>{sh.confirmCancel}</button>
        <button type="button" className="x-button x-destructive" onClick={() => settle(true)}>{sh.confirmOk}</button>
      </div>
    </div>
  </div>
}
