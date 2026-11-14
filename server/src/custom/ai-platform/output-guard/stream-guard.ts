import {
  GUARD_DEFAULT_REPLACEMENT_TEXT,
  OUTPUT_GUARD_LIMITS,
} from '@freellmapi/shared/ai-platform-output-guard.js';
import type { GuardAction, OutputFilter, OutputFilterSink } from '../wire/interceptor.js';

export const STREAM_GUARD_DEFAULTS = {
  holdChars: OUTPUT_GUARD_LIMITS.defaultHoldChars,
  maxDelayMs: OUTPUT_GUARD_LIMITS.defaultMaxDelayMs,
  maxHoldChars: OUTPUT_GUARD_LIMITS.maxHoldChars,
  maxDelayMsCap: OUTPUT_GUARD_LIMITS.maxDelayMs,
  defaultReplacementText: GUARD_DEFAULT_REPLACEMENT_TEXT,
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
  if (cut <= 0) return cut;
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
  // Keep original input separate from rewritten output. Detector context must
  // never lose a token merely because an earlier chunk was already masked.
  let rawPrefix = '';
  let pending = '';
  let loggedNotified = false;

  const clearFlushTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const notify = (action: GuardAction, check: StreamGuardCheckResult, source: string) => {
    if (action === 'pass') return;
    if (action === 'logged') {
      if (loggedNotified) return;
      loggedNotified = true;
    }
    options.onEvent?.({
      action,
      detector: check.detector ?? check.reason,
      reason: check.reason,
      excerptSource: source,
    });
  };

  const stop = (check: StreamGuardCheckResult, source: string) => {
    stopped = true;
    clearFlushTimer();
    pending = '';
    const reason = check.reason ?? check.detector ?? 'policy';
    notify('blocked', check, source);
    return {
      emit: '',
      stop: { replacement: replacementText, reason, action: 'blocked' as const },
      action: 'blocked' as const,
      reason,
    };
  };

  const consume = (check: StreamGuardCheckResult, cut = pending.length) => {
    const source = rawPrefix + pending;
    const hit = check.action !== 'pass';
    const action: GuardAction = mode === 'log' && hit ? 'logged' : check.action;
    let emit: string;
    if (action === 'masked') {
      // A rewrite may change the length of previously sent input. Align against
      // its *sanitized* prefix, not the bytes sent or the raw character count.
      const prefixCheck = options.evaluateLocal(rawPrefix, { isFinal: false });
      const sanitizedPrefix = prefixCheck.action === 'masked' ? prefixCheck.text : rawPrefix;
      if (check.text.startsWith(sanitizedPrefix)) {
        emit = check.text.slice(sanitizedPrefix.length);
      } else {
        // A detector now recognizes PII crossing an already-flushed boundary.
        // Sent bytes cannot be recalled; suppress the completing piece instead
        // of falling back to a tail-only scan that could reveal the full value.
        emit = '[redacted]';
      }
      cut = pending.length;
    } else {
      emit = pending.slice(0, cut);
    }
    rawPrefix += pending.slice(0, cut);
    pending = pending.slice(cut);
    notify(action, check, source);
    return { emit, action, reason: check.reason ?? check.detector };
  };

  const flushUnsentOnTimer = () => {
    timer = null;
    if (disposed || stopped || buffering || mode === 'off' || !pending) return;
    const source = rawPrefix + pending;
    const check = options.evaluateLocal(source, { isFinal: false });
    if (check.action === 'blocked' && mode === 'block') {
      const result = stop(check, source);
      sink?.stop(result.stop.replacement, result.stop.reason, 'blocked');
      return;
    }
    const cut = safeCutIndex(pending, pending.length);
    if (cut > 0) {
      const result = consume(check, cut);
      if (result.emit) sink?.emitDelta(result.emit);
    }
    scheduleTimer();
  };

  const scheduleTimer = () => {
    if (disposed || stopped || buffering || mode === 'off' || timer !== null || !pending) return;
    timer = setTimeout(flushUnsentOnTimer, maxDelayMs);
  };

  return {
    name: 'output-guard',
    isOutputGuard: true,
    buffering,
    failClosed,
    config: { mode, holdChars, maxDelayMs, buffering, failClosed },
    attach(nextSink: OutputFilterSink) {
      sink = nextSink;
    },
    dispose() {
      disposed = true;
      clearFlushTimer();
      pending = '';
      rawPrefix = '';
    },
    onDelta(text: string) {
      if (mode === 'off') return { emit: text, action: 'pass' };
      if (stopped || disposed) return { emit: '' };
      pending += text;
      if (buffering) return { emit: '' };

      const source = rawPrefix + pending;
      const check = options.evaluateLocal(source, { isFinal: false });
      if (check.action === 'blocked' && mode === 'block') return stop(check, source);
      if (check.action === 'masked' && mode === 'block') {
        clearFlushTimer();
        return consume(check);
      }
      const cut = safeCutIndex(pending, Math.max(0, pending.length - holdChars));
      if (cut > 0) {
        const result = consume(check, cut);
        scheduleTimer();
        return result;
      }
      if (mode === 'log' && check.action !== 'pass') notify('logged', check, source);
      scheduleTimer();
      return {
        emit: '',
        action: mode === 'log' && check.action !== 'pass' ? 'logged' : 'pass',
        reason: check.reason ?? check.detector,
      };
    },
    onBeforeTerminal() {
      clearFlushTimer();
      if (mode === 'off' || buffering || stopped || disposed || !pending) return { emit: '' };
      const source = rawPrefix + pending;
      const check = options.evaluateLocal(source, { isFinal: true });
      if (check.action === 'blocked' && mode === 'block') return stop(check, source);
      return consume(check);
    },
    async onComplete(full: string) {
      clearFlushTimer();
      if (mode === 'off') return { action: 'pass' };
      if (stopped || disposed) return {};
      const target = full || rawPrefix + pending;
      const check = options.evaluateFinal
        ? await options.evaluateFinal(target)
        : options.evaluateLocal(target, { isFinal: true });
      if (check.action === 'pass') return { action: 'pass' };
      if (mode === 'log') {
        notify('logged', check, target);
        return { action: 'logged', reason: check.reason ?? check.detector };
      }
      if (check.action === 'blocked') {
        stop(check, target);
        return { replaceWith: replacementText, action: 'blocked', reason: check.reason ?? check.detector };
      }
      notify(check.action, check, target);
      return {
        ...(check.action === 'masked' ? { replaceWith: check.text } : {}),
        action: check.action,
        reason: check.reason ?? check.detector,
      };
    },
  };
}
