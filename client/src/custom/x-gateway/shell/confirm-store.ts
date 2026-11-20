/**
 * In-app replacements for window.confirm and window.prompt. Call
 * `askConfirm(message)` or `askPrompt(message, initial)` anywhere and await the
 * answer; <ConfirmHost /> (in confirm.tsx, mounted once per app shell) renders
 * the dialog. Split out of confirm.tsx so that file only exports the component
 * (react-refresh rule).
 */
type Request =
  | { kind: 'confirm'; message: string; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; message: string; initial: string; resolve: (value: string | null) => void }

let current: Request | null = null
let hosts = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(listener => listener())
export const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** Current pending request, for useSyncExternalStore's getSnapshot. */
export function getRequest(): Request | null {
  return current
}

/** Register a mounted <ConfirmHost />; cleanup unregisters it. */
export function trackHost(): () => void {
  hosts += 1
  return () => { hosts -= 1; dismiss(close()) }
}

export function dismiss(request: Request | null) {
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

export function close() {
  const request = current
  current = null
  emit()
  return request
}
