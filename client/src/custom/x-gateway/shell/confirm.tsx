import { useEffect, useRef, useSyncExternalStore } from 'react'
import { PencilLine, TriangleAlert } from 'lucide-react'
import { useShellStrings } from '../shell-strings'
import { close, dismiss, getRequest, subscribe, trackHost } from './confirm-store'

export function ConfirmHost() {
  const sh = useShellStrings()
  const request = useSyncExternalStore(subscribe, getRequest)
  const cancel = useRef<HTMLButtonElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const opener = useRef<Element | null>(null)
  useEffect(() => trackHost(), [])
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
