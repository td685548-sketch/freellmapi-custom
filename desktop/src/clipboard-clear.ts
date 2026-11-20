// The unified API key copied from the desktop tray popover used to sit in the
// system clipboard indefinitely — any app on the machine could read it long
// after the operator pasted it once. Clear it after a short delay, but only
// if the clipboard still holds exactly what we wrote: wiping unconditionally
// would destroy whatever the operator copied next.

export const API_KEY_CLIPBOARD_CLEAR_DELAY_MS = 45_000;

export interface ClipboardLike {
  readText(): string;
  clear(): void;
}

/**
 * Schedule clearing `text` from `clipboard` after `delayMs`. Returns a
 * cancel function; call it (and schedule again) when the key is copied a
 * second time so the timer restarts instead of clearing the fresh copy early.
 * The timer is unref'd where the platform supports it so it never keeps the
 * main process alive on its own.
 */
export function scheduleClipboardClear(
  clipboard: ClipboardLike,
  text: string,
  delayMs: number = API_KEY_CLIPBOARD_CLEAR_DELAY_MS,
): () => void {
  const timer = setTimeout(() => {
    try {
      if (clipboard.readText() === text) clipboard.clear();
    } catch {
      // Clipboard unavailable — nothing to clear.
    }
  }, delayMs);
  if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
    (timer as unknown as { unref(): void }).unref();
  }
  return () => clearTimeout(timer);
}
