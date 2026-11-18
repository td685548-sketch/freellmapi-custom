import type { ChatMessage } from '@freellmapi/shared/types.js';
import { getSetting, setSetting } from '../../db/index.js';
import { contentToString, estimateInputTokens } from '../../lib/content.js';

const DEFAULT_IMAGE_TOKENS = 765;
const MESSAGE_OVERHEAD_TOKENS = 4;

const CALIBRATION_ALPHA = 0.1;
const CALIBRATION_MIN = 0.75;
const CALIBRATION_MAX = 1.6;
const CALIBRATION_SETTING_KEY = 'custom_context_calibration_v1';
const CALIBRATION_FLUSH_DELAY_MS = 2_000;
const MAX_CALIBRATION_PLATFORMS = 64;

interface CalibrationEntry {
  factor: number;
  samples: number;
}

export interface EstimateMessagesOptions {
  tools?: readonly unknown[];
  imageTokens?: number;
  platform?: string;
}

const calibration = new Map<string, CalibrationEntry>();
let calibrationLoadedFromDb = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function clampCalibrationFactor(factor: number): number {
  return Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, factor));
}

function serializeCalibration(): string {
  const payload: Record<string, CalibrationEntry> = {};
  let count = 0;
  for (const [platform, entry] of calibration.entries()) {
    if (count >= MAX_CALIBRATION_PLATFORMS) break;
    payload[platform] = {
      factor: Math.round(clampCalibrationFactor(entry.factor) * 10_000) / 10_000,
      samples: Math.max(0, Math.floor(entry.samples)),
    };
    count += 1;
  }
  return JSON.stringify(payload);
}

function ensureCalibrationLoaded(): void {
  if (calibrationLoadedFromDb) return;
  try {
    const raw = getSetting(CALIBRATION_SETTING_KEY);
    calibrationLoadedFromDb = true;
    if (!raw || raw.trim().length === 0) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    let loaded = 0;
    for (const [platform, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (loaded >= MAX_CALIBRATION_PLATFORMS) break;
      if (!platform || typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      if (calibration.has(platform)) continue;
      const rec = value as { factor?: unknown; samples?: unknown };
      if (
        typeof rec.factor !== 'number' ||
        !Number.isFinite(rec.factor) ||
        typeof rec.samples !== 'number' ||
        !Number.isFinite(rec.samples) ||
        rec.samples < 0
      ) {
        continue;
      }
      calibration.set(platform, {
        factor: clampCalibrationFactor(rec.factor),
        samples: Math.floor(rec.samples),
      });
      loaded += 1;
    }
  } catch {
    // Database may not be initialized yet (unit tests / module import); retry on next access.
  }
}

function persistCalibration(): void {
  try {
    setSetting(CALIBRATION_SETTING_KEY, serializeCalibration());
  } catch {
    // Non-fatal: calibration persistence must never break inference.
  }
}

function scheduleCalibrationFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    persistCalibration();
  }, CALIBRATION_FLUSH_DELAY_MS);
  if (typeof flushTimer.unref === 'function') {
    flushTimer.unref();
  }
}

function isAccentedLatin(cp: number): boolean {
  return (
    (cp >= 0x00c0 && cp <= 0x024f) ||
    (cp >= 0x1e00 && cp <= 0x1eff) ||
    (cp >= 0x0300 && cp <= 0x036f)
  );
}

function isCjkOrKanaOrHangul(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3000 && cp <= 0x30ff) ||
    (cp >= 0x3130 && cp <= 0x318f) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  );
}

function countImageBlocks(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) {
    const type = (block as { type?: string } | null | undefined)?.type;
    if (type === 'image_url' || type === 'image') {
      count += 1;
    }
  }
  return count;
}

/**
 * Estimate token count for plain text using script-weighted character ratios:
 * ASCII / 4, accented Latin / 2.5, CJK/Kana/Hangul / 1, other scripts / 3.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  // Accumulate scaled integers (LCM of 4, 2.5, 1, 3 is 60) to avoid float drift.
  let weightedSum = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    if (cp <= 0x7f) {
      weightedSum += 15;
    } else if (isAccentedLatin(cp)) {
      weightedSum += 24;
    } else if (isCjkOrKanaOrHangul(cp)) {
      weightedSum += 60;
    } else {
      weightedSum += 20;
    }
  }
  return weightedSum === 0 ? 0 : Math.floor((weightedSum + 59) / 60);
}

/**
 * Estimate token count for a single ChatMessage, including message framing
 * overhead, text content, image blocks, and assistant tool calls.
 */
export function estimateMessageTokens(
  message: ChatMessage,
  imageTokens: number = DEFAULT_IMAGE_TOKENS,
): number {
  const textTokens = estimateTextTokens(contentToString(message.content));
  const imageCount = countImageBlocks(message.content);
  let toolCallTokens = 0;
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const call of message.tool_calls) {
      const name = call.function?.name ?? '';
      const args = call.function?.arguments ?? '';
      toolCallTokens += estimateTextTokens(`${name}${args}`);
    }
  }
  return MESSAGE_OVERHEAD_TOKENS + textTokens + imageCount * imageTokens + toolCallTokens;
}

/**
 * Return the current EMA calibration multiplier for a platform (1.0 when unsampled).
 */
export function getCalibrationFactor(platform?: string): number {
  ensureCalibrationLoaded();
  if (!platform) return 1.0;
  return calibration.get(platform)?.factor ?? 1.0;
}

/**
 * Estimate total input tokens for a message list and optional tool schemas,
 * scaled by the platform's in-memory calibration factor when present.
 */
export function estimateMessagesTokens(
  messages: readonly ChatMessage[],
  options: EstimateMessagesOptions = {},
): number {
  const imageTokens = options.imageTokens ?? DEFAULT_IMAGE_TOKENS;
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message, imageTokens);
  }
  if (options.tools && options.tools.length > 0) {
    total += estimateTextTokens(JSON.stringify(options.tools));
  }
  const factor = getCalibrationFactor(options.platform);
  if (factor === 1.0) return total;
  return Math.round(total * factor);
}

/**
 * Compute the legacy chars/4 heuristic token count matching `lib/content.ts`
 * so report comparisons can detect responses without real provider usage.
 */
export function heuristicTokens(messages: ChatMessage[], tools?: readonly unknown[]): number {
  return estimateInputTokens(messages, tools);
}

/**
 * Update the per-platform EMA calibration multiplier (alpha = 0.1, clamped to [0.75, 1.6]),
 * scheduling debounced persistence to the SQLite `settings` table.
 */
export function recordCalibrationSample(
  platform: string,
  providerTokens: number,
  estimatedTokens: number,
): void {
  ensureCalibrationLoaded();
  if (
    !platform ||
    !Number.isFinite(providerTokens) ||
    !Number.isFinite(estimatedTokens) ||
    providerTokens <= 0 ||
    estimatedTokens <= 0
  ) {
    return;
  }
  const prev = calibration.get(platform) ?? { factor: 1.0, samples: 0 };
  const ratio = providerTokens / estimatedTokens;
  const nextRaw = prev.factor * (1 - CALIBRATION_ALPHA) + ratio * CALIBRATION_ALPHA;
  const factor = clampCalibrationFactor(nextRaw);
  calibration.set(platform, { factor, samples: prev.samples + 1 });
  scheduleCalibrationFlush();
}

/**
 * Flush pending calibration state to SQLite immediately (used by tests and shutdown hooks).
 */
export function flushCalibrationNow(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  persistCalibration();
}

/**
 * Clear all platform calibration samples in memory (and optionally persisted settings).
 */
export function resetCalibration(clearPersisted = false): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  calibration.clear();
  calibrationLoadedFromDb = false;
  if (clearPersisted) {
    try {
      setSetting(CALIBRATION_SETTING_KEY, '{}');
    } catch {
      // Ignore if DB is not initialized yet.
    }
    calibrationLoadedFromDb = true;
  }
}
