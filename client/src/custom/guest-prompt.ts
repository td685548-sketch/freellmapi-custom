/** Ask the signed-out visitor to sign in or request access (opens the guest popup). */
export const GUEST_PROMPT_EVENT = 'freellmapi:guest-prompt'

export function askToSignIn(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(GUEST_PROMPT_EVENT))
}

/** The popup opens on its own this long after a visitor arrives, once per browser tab. */
export const GUEST_PROMPT_DELAY_MS = 5_000
export const GUEST_PROMPT_SEEN_KEY = 'freellmapi.guestPromptSeen'
