import type { GuardAction, OutputFilter, OutputFilterSink } from '../wire/interceptor.js';

export const STREAM_GUARD_DEFAULTS = {
  holdChars: 200,
  maxDelayMs: 300,
  maxHoldChars: 2000,
  maxDelayMsCap: 2000,
  defaultReplacementText: 'Response blocked by output guard policy.',
} as const;

export interface StreamGuardCheckResult {
  action: GuardAction;
  text: string;
  reason?: string;
  detector?: string;
}

export interface StreamGuardEvent {
  action: GuardAction | 'bypassed';
  detector?: string;
  reason?: string;
  excerptSource?: string;
}

export interface StreamGuardOptions {
  mode: 'off' | 'log' | 'block';
  holdChars?: number;
  maxDelayMs?: number;
  replacementText?: string;
  buffering?: boolean;
  failClosed?: boolean;
  evaluateLocal: (scanContext: string, opts?: { isFinal?: boolean }) => StreamGuardCheckResult;
  evaluateFinal?: (fullText: string) => Promise<StreamGuardCheckResult> | StreamGuardCheckResult;
  onEvent?: (event: StreamGuardEvent) => void;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** Avoid splitting a UTF-16 surrogate pair or trailing combining mark at `cut`. */
function safeCutIndex(text: string, targetCut: number): number {
  let cut = Math.max(0, Math.min(text.length, targetCut));
  if (cut <= 0 || cut >= text.length) return cut;
  const prev = text.charCodeAt(cut - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) {
    cut -= 1;
  }
  while (cut > 0) {
    const nextCode = text.codePointAt(cut);
    if (nextCode !== undefined && nextCode >= 0x0300 && nextCode <= 0x036f) {
      cut -= 1;
    } else {
      break;
    }
  }
  return cut;
}

export interface StreamGuardFilter extends OutputFilter {
  readonly config: {
    mode: 'off' | 'log' | 'block';
    holdChars: number;
    maxDelayMs: number;
    buffering: boolean;
    failClosed: boolean;
  };
}

/**
 * S0 factory: creates a streaming `OutputFilter` with timer-driven flush,
 * separate scan context vs. unsent buffer, and lifecycle cleanup.
 * Does not import policy runtime, detectors, or external judge modules.
 */
export function createStreamGuard(options: StreamGuardOptions): StreamGuardFilter {
  const mode = options.mode;
  const holdChars = clampInt(
    options.holdChars,
    STREAM_GUARD_DEFAULTS.holdChars,
    0,
    STREAM_GUARD_DEFAULTS.maxHoldChars,
  );
  const maxDelayMs = clampInt(
    options.maxDelayMs,
    STREAM_GUARD_DEFAULTS.maxDelayMs,
    0,
    STREAM_GUARD_DEFAULTS.maxDelayMsCap,
  );
  const replacementText = options.replacementText ?? STREAM_GUARD_DEFAULTS.defaultReplacementText;
  const buffering = Boolean(options.buffering);
  const failClosed = Boolean(options.failClosed);

  let sink: OutputFilterSink | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let stopped = false;
  let emittedPrefix = '';
  let unsentBuffer = '';
  let loggedNotified = false;

  const clearFlushTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const emitEventOnceForLog = (res: StreamGuardCheckResult, source: string) => {
    if (loggedNotified) return;
    loggedNotified = true;
    options.onEvent?.({
      action: 'logged',
      detector: res.detector ?? res.reason,
      reason: res.reason,
      excerptSource: source,
    });
  };

  const flushUnsentOnTimer = () => {
    timer = null;
    if (disposed || stopped || buffering || mode === 'off') return;
    if (unsentBuffer.length === 0) return;

    const scanContext = emittedPrefix + unsentBuffer;
    const check = options.evaluateLocal(scanContext, { isFinal: false });
    if (check.action === 'blocked') {
      if (mode === 'block') {
        stopped = true;
        unsentBuffer = '';
        const detector = check.detector ?? check.reason ?? 'policy';
        options.onEvent?.({
          action: 'blocked',
          detector,
          reason: check.reason ?? detector,
          excerptSource: scanContext,
        });
        sink?.stop(replacementText, check.reason ?? detector, 'blocked');
        return;
      }
      emitEventOnceForLog(check, scanContext);
    }

    let toEmit = unsentBuffer;
    if (check.action === 'masked' && mode !== 'log') {
      if (check.text.length >= emittedPrefix.length && check.text.startsWith(emittedPrefix)) {
        toEmit = check.text.slice(emittedPrefix.length);
      } else {
        const tailCheck = options.evaluateLocal(unsentBuffer, { isFinal: false });
        toEmit = tailCheck.text;
      }
      options.onEvent?.({
        action: 'masked',
        detector: check.detector ?? check.reason ?? 'pii',
        reason: check.reason ?? 'pii',
        excerptSource: scanContext,
      });
    }

    // Keep trailing combining base if unsent ends with a high surrogate
    const cut = safeCutIndex(toEmit, toEmit.length);
    const emitNow = toEmit.slice(0, cut);
    const carry = toEmit.slice(cut);
    if (emitNow.length > 0) {
      emittedPrefix += emitNow;
      unsentBuffer = carry;
      sink?.emitDelta(emitNow);
    }
    if (unsentBuffer.length > 0) {
      scheduleTimer();
    }
  };

  const scheduleTimer = () => {
    if (disposed || stopped || buffering || mode === 'off' || timer !== null) return;
    if (unsentBuffer.length === 0) return;
    timer = setTimeout(flushUnsentOnTimer, maxDelayMs);
  };

  return {
    name: 'output-guard',
    isOutputGuard: true,
    buffering,
    failClosed,
    config: {
      mode,
      holdChars,
      maxDelayMs,
      buffering,
      failClosed,
    },

    attach(nextSink: OutputFilterSink) {
      sink = nextSink;
    },

    dispose() {
      disposed = true;
      clearFlushTimer();
      unsentBuffer = '';
    },

    onDelta(text: string) {
      if (mode === 'off') {
        return { emit: text, action: 'pass' };
      }
      if (stopped || disposed) {
        return { emit: '' };
      }
      if (buffering) {
        unsentBuffer += text;
        return { emit: '' };
      }

      unsentBuffer += text;
      const scanContext = emittedPrefix + unsentBuffer;
      const check = options.evaluateLocal(scanContext, { isFinal: false });

      if (check.action === 'blocked') {
        if (mode === 'block') {
          stopped = true;
          clearFlushTimer();
          unsentBuffer = '';
          const detector = check.detector ?? check.reason ?? 'policy';
          options.onEvent?.({
            action: 'blocked',
            detector,
            reason: check.reason ?? detector,
            excerptSource: scanContext,
          });
          return {
            emit: '',
            stop: {
              replacement: replacementText,
              reason: check.reason ?? detector,
              action: 'blocked',
            },
            action: 'blocked',
            reason: check.reason ?? detector,
          };
        }
        emitEventOnceForLog(check, scanContext);
        // log mode: pass through without rewriting
        const emitAll = unsentBuffer;
        emittedPrefix += emitAll;
        unsentBuffer = '';
        clearFlushTimer();
        return { emit: emitAll, action: 'logged', reason: check.reason ?? check.detector };
      }

      let currentAction: GuardAction = check.action === 'logged' ? 'logged' : 'pass';
      let currentReason = check.reason ?? check.detector;
      if (check.action === 'masked' && mode !== 'log') {
        currentAction = 'masked';
        currentReason = check.reason ?? check.detector ?? 'pii';
        if (check.text.length >= emittedPrefix.length && check.text.startsWith(emittedPrefix)) {
          unsentBuffer = check.text.slice(emittedPrefix.length);
        } else {
          unsentBuffer = options.evaluateLocal(unsentBuffer, { isFinal: false }).text;
        }
      }

      if (unsentBuffer.length > holdChars) {
        const cut = safeCutIndex(unsentBuffer, unsentBuffer.length - holdChars);
        if (cut > 0) {
          const emitNow = unsentBuffer.slice(0, cut);
          emittedPrefix += emitNow;
          unsentBuffer = unsentBuffer.slice(cut);
          if (unsentBuffer.length === 0) {
            clearFlushTimer();
          } else {
            scheduleTimer();
          }
          return { emit: emitNow, action: currentAction, reason: currentReason };
        }
      }

      if (unsentBuffer.length > 0) {
        scheduleTimer();
      }
      return { emit: '', action: currentAction, reason: currentReason };
    },

    onBeforeTerminal() {
      clearFlushTimer();
      if (mode === 'off' || buffering || stopped || disposed) {
        return { emit: '' };
      }
      if (unsentBuffer.length === 0) {
        return { emit: '' };
      }

      const scanContext = emittedPrefix + unsentBuffer;
      const check = options.evaluateLocal(scanContext, { isFinal: true });
      if (check.action === 'blocked') {
        if (mode === 'block') {
          stopped = true;
          unsentBuffer = '';
          const detector = check.detector ?? check.reason ?? 'policy';
          options.onEvent?.({
            action: 'blocked',
            detector,
            reason: check.reason ?? detector,
            excerptSource: scanContext,
          });
          return {
            emit: '',
            stop: {
              replacement: replacementText,
              reason: check.reason ?? detector,
              action: 'blocked',
            },
            action: 'blocked',
            reason: check.reason ?? detector,
          };
        }
        emitEventOnceForLog(check, scanContext);
        const emitAll = unsentBuffer;
        emittedPrefix += emitAll;
        unsentBuffer = '';
        return { emit: emitAll, action: 'logged', reason: check.reason ?? check.detector };
      }

      if (check.action === 'masked' && mode !== 'log') {
        let maskedTail = unsentBuffer;
        if (check.text.length >= emittedPrefix.length && check.text.startsWith(emittedPrefix)) {
          maskedTail = check.text.slice(emittedPrefix.length);
        } else {
          maskedTail = options.evaluateLocal(unsentBuffer, { isFinal: true }).text;
        }
        options.onEvent?.({
          action: 'masked',
          detector: check.detector ?? check.reason ?? 'pii',
          reason: check.reason ?? 'pii',
          excerptSource: scanContext,
        });
        emittedPrefix += maskedTail;
        unsentBuffer = '';
        return { emit: maskedTail, action: 'masked', reason: check.reason ?? 'pii' };
      }

      const remaining = unsentBuffer;
      emittedPrefix += remaining;
      unsentBuffer = '';
      return { emit: remaining, action: 'pass' };
    },

    async onComplete(full: string) {
      clearFlushTimer();
      if (mode === 'off') {
        return { action: 'pass' };
      }
      if (stopped || disposed) {
        return {};
      }
      const targetText = buffering ? full : emittedPrefix + unsentBuffer || full;
      const res = options.evaluateFinal
        ? await options.evaluateFinal(targetText)
        : options.evaluateLocal(targetText, { isFinal: true });

      if (res.action === 'blocked') {
        const detector = res.detector ?? res.reason ?? 'policy';
        if (mode === 'block') {
          stopped = true;
          options.onEvent?.({
            action: 'blocked',
            detector,
            reason: res.reason ?? detector,
            excerptSource: targetText,
          });
          return {
            replaceWith: replacementText,
            action: 'blocked',
            reason: res.reason ?? detector,
          };
        }
        emitEventOnceForLog(res, targetText);
        return { action: 'logged', reason: res.reason ?? detector };
      }

      if (res.action === 'masked' && mode !== 'log') {
        const detector = res.detector ?? res.reason ?? 'pii';
        options.onEvent?.({
          action: 'masked',
          detector,
          reason: res.reason ?? detector,
          excerptSource: targetText,
        });
        return {
          replaceWith: res.text,
          action: 'masked',
          reason: res.reason ?? detector,
        };
      }

      if (res.action === 'logged') {
        emitEventOnceForLog(res, targetText);
        return { action: 'logged', reason: res.reason ?? res.detector };
      }

      return { action: 'pass' };
    },
  };
}
