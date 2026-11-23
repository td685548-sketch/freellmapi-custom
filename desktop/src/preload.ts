// Built to build/preload.cjs (CommonJS — the reliable preload format).
// Runs in the renderer before any page script. Phase 2 of the httpOnly-cookie
// move: the dashboard signs in by calling POST /api/auth/desktop-session,
// which sets the httpOnly session cookie on the loopback origin — no token is
// ever handed to this world, so there is nothing to seed into sessionStorage.
import { contextBridge, ipcRenderer } from 'electron';

// Lets the client adapt its chrome (drag region, traffic-light padding,
// no Sign out) when running inside the desktop shell.
contextBridge.exposeInMainWorld('__FREEAPI_DESKTOP__', true);
contextBridge.exposeInMainWorld('__FREEAPI_PLATFORM__', process.platform);

// "Start on system startup" for the dashboard's Settings dialog. Mirrors the
// popover's login-item toggle, but as a narrow get/set pair the dashboard can
// call. Reads the OS-level "open at login" flag so the switch reflects reality
// (and stays in sync with the popover's own toggle). Electron's login items
// only work on macOS and Windows; on Linux setLoginItemSettings is a no-op, so
// the bridge is not exposed there and the dashboard hides the switch.
if (process.platform === 'darwin' || process.platform === 'win32') {
  contextBridge.exposeInMainWorld('__FREEAPI_LOGIN_ITEM__', {
    get: () => ipcRenderer.invoke('freeapi:get-login-item'),
    set: (open: boolean) => ipcRenderer.invoke('freeapi:set-login-item', open),
  });
}

// The running build's version, so the dashboard can show which one it is and
// offer a check against the published releases (#703). Arrives the same way the
// token does; absent in a browser, where the dashboard simply omits the row
// rather than guessing from the server's own (unrelated) package version.
const versionArg = process.argv.find((a) => a.startsWith('--freeapi-version='));
contextBridge.exposeInMainWorld(
  '__FREEAPI_VERSION__',
  versionArg ? versionArg.slice('--freeapi-version='.length) : null,
);

// The in-app updater (the Settings update dialog and the update reminder). Deliberately
// narrow: it can only check for, download and install the release published at
// td685548-sketch/freellmapi-custom — the feed URL and signature checks live in the main
// process and nothing here can point them anywhere else.
contextBridge.exposeInMainWorld('__FREEAPI_UPDATER__', {
  state: () => ipcRenderer.invoke('freeapi:update-state'),
  check: () => ipcRenderer.invoke('freeapi:update-check'),
  download: () => ipcRenderer.invoke('freeapi:update-download'),
  install: () => ipcRenderer.invoke('freeapi:update-install'),
  subscribe: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on('freeapi:update-state', handler);
    return () => { ipcRenderer.removeListener('freeapi:update-state', handler); };
  },
});

// `desktop` class on <html> identifies the desktop shell. On macOS, `desktop-mac`
// activates the translucent glass backdrop that pairs with native vibrancy;
// on Windows and Linux, the solid theme background is preserved so contrast and
// readability remain intact.
function applyDesktopClass() {
  document.documentElement?.classList.add('desktop');
  if (process.platform === 'darwin') {
    document.documentElement?.classList.add('desktop-mac');
  }
}
try {
  applyDesktopClass();
} catch {
  // Document not ready — DOMContentLoaded below covers it.
}

// Mirror the dashboard's theme to the main process so the tray popover
// matches. The dashboard expresses its resolved theme as the `dark` class
// and the underlying choice (dark/light/system) as `data-theme-choice`,
// both on documentElement — observe those rather than reaching across
// worlds into localStorage. The choice lets the main process hand
// nativeTheme.themeSource back to the OS when the user picks System.
function reportTheme() {
  ipcRenderer.send('freeapi:theme-changed', {
    resolved: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    choice: document.documentElement.dataset.themeChoice,
  });
}

// Mirror the dashboard's locale to the main process so the native tray menu and
// the popover match. The I18nProvider sets `<html lang>` on every locale change,
// so observe that attribute rather than reaching into the dashboard's
// localStorage from this preload world.
function reportLocale() {
  const lang = document.documentElement.lang;
  if (lang) ipcRenderer.send('freeapi:locale-changed', lang);
}
window.addEventListener('DOMContentLoaded', () => {
  applyDesktopClass();
  reportTheme();
  reportLocale();
  new MutationObserver(() => {
    reportTheme();
    reportLocale();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'lang', 'data-theme-choice'],
  });
});
