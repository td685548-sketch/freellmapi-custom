import { useEffect, useRef, useSyncExternalStore } from 'react'
import { PencilLine, TriangleAlert } from 'lucide-react'
import { useShellStrings } from '../shell-strings'

/**
 * In-app replacements for window.confirm and window.prompt. Call
 * `askConfirm(message)` or `askPrompt(message, initial)` anywhere and await the
 * answer; <ConfirmHost /> (mounted once per app shell) renders the dialog.
 */
type Request =
  | { kind: 'confirm'; message: string; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; message: string; initial: string; resolve: (value: string | null) => void }

let current: Request | null = null
let hosts = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(listener => listener())
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

function dismiss(request: Request | null) {
  if (request?.kind === 'confirm') request.resolve(false)
  else request?.resolve(null)
}

/** Resolves true when the person agrees, false when they cancel. */
export function askConfirm(message: string): Promise<boolean> {
  // Without a mounted host (a page rendered on its own) fall back to the browser's dialog.
  if (hosts === 0) return Promise.resolve(window.confirm(message))
  dismiss(current)
  return new Promise(resolve => { current = { kind: 'confirm', message, resolve }; emit() })
}

/** Resolves the entered text, or null when the person cancels. */
export function askPrompt(message: string, initial = ''): Promise<string | null> {
  if (hosts === 0) return Promise.resolve(window.prompt(message, initial))
  dismiss(current)
  return new Promise(resolve => { current = { kind: 'prompt', message, initial, resolve }; emit() })
}

function close() {
  const request = current
  current = null
  emit()
  return request
}

export function ConfirmHost() {
  const sh = useShellStrings()
  const request = useSyncExternalStore(subscribe, () => current)
  const cancel = useRef<HTMLButtonElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const opener = useRef<Element | null>(null)
  useEffect(() => { hosts += 1; return () => { hosts -= 1; dismiss(close()) } }, [])
  useEffect(() => {
    if (!request) return
    opener.current = document.activeElement
    if (request.kind === 'prompt') {
      field.current?.focus()
      field.current?.select()
    } else {
      cancel.current?.focus() // the safe choice is the default
    }
    return () => { if (opener.current instanceof HTMLElement) opener.current.focus() }
  }, [request])
  if (!request) return null
  const reject = () => dismiss(close())
  const accept = () => {
    const done = close()
    if (done?.kind === 'confirm') done.resolve(true)
    else done?.resolve(field.current?.value ?? '')
  }
  const isPrompt = request.kind === 'prompt'
  // `x-console` supplies the theme tokens when the host sits outside the gateway console.
  return <div className="x-console x-dialog-root">
    <div className="x-confirm-scrim" onMouseDown={event => { if (event.target === event.currentTarget) reject() }}>
      <form className="x-confirm" role={isPrompt ? 'dialog' : 'alertdialog'} aria-modal="true" aria-labelledby="x-confirm-title" aria-describedby="x-confirm-message"
        onSubmit={event => { event.preventDefault(); accept() }}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.stopPropagation(); reject() }
          if (event.key === 'Tab') {
            // Keep focus inside the dialog.
            const stops = event.currentTarget.querySelectorAll<HTMLElement>('input, button')
            const first = stops[0]
            const last = stops[stops.length - 1]
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
          }
        }}>
        <span className={`x-confirm-icon ${isPrompt ? 'x-confirm-icon-neutral' : ''}`} aria-hidden="true">{isPrompt ? <PencilLine size={18} /> : <TriangleAlert size={18} />}</span>
        <div className="x-confirm-body">
          <h2 id="x-confirm-title">{isPrompt ? sh.promptTitle : sh.confirmTitle}</h2>
          <p id="x-confirm-message">{request.message}</p>
          {isPrompt && <input ref={field} className="x-confirm-input" defaultValue={request.initial} aria-labelledby="x-confirm-message" />}
        </div>
        <div className="x-confirm-actions">
          <button ref={cancel} type="button" className="x-button" onClick={reject}>{sh.confirmCancel}</button>
          <button type="submit" className={`x-button ${isPrompt ? 'x-primary' : 'x-destructive'}`}>{isPrompt ? sh.promptOk : sh.confirmOk}</button>
        </div>
      </form>
    </div>
  </div>
}
