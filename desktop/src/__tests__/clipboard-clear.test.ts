import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { API_KEY_CLIPBOARD_CLEAR_DELAY_MS, scheduleClipboardClear } from '../clipboard-clear.js';

// The unified key copied from the desktop tray popover used to sit in the
// system clipboard indefinitely. It is cleared after a delay — but only if
// the clipboard still holds exactly what was copied, so the operator's next
// copy is never destroyed.

function stubClipboard(initial = '') {
  let text = initial;
  return {
    clipboard: {
      readText: () => text,
      clear: vi.fn(() => { text = ''; }),
    },
    setText: (next: string) => { text = next; },
    getText: () => text,
  };
}

describe('scheduleClipboardClear', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the copied key after the delay', () => {
    expect(API_KEY_CLIPBOARD_CLEAR_DELAY_MS).toBe(45_000);
    const { clipboard, getText } = stubClipboard('sk-test-key');
    scheduleClipboardClear(clipboard, 'sk-test-key');
    vi.advanceTimersByTime(44_000);
    expect(getText()).toBe('sk-test-key');
    expect(clipboard.clear).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(clipboard.clear).toHaveBeenCalledTimes(1);
    expect(getText()).toBe('');
  });

  it('leaves the clipboard alone when the operator copied something else meanwhile', () => {
    const { clipboard, setText } = stubClipboard('sk-test-key');
    scheduleClipboardClear(clipboard, 'sk-test-key');
    setText('something the operator copied next');
    vi.advanceTimersByTime(60_000);
    expect(clipboard.clear).not.toHaveBeenCalled();
  });

  it('cancelling prevents the clear (a second copy restarts the timer)', () => {
    const { clipboard } = stubClipboard('sk-test-key');
    const cancel = scheduleClipboardClear(clipboard, 'sk-test-key');
    cancel();
    vi.advanceTimersByTime(60_000);
    expect(clipboard.clear).not.toHaveBeenCalled();
  });
});
