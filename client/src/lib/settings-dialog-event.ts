/** Fired to open the Settings dialog from anywhere (it is a dialog, not a route). */
export const OPEN_SETTINGS_EVENT = 'freellmapi:open-settings'

export function openSettingsDialog(): void {
  window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT))
}
