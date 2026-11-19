import type { ChatMessage } from '@freellmapi/shared/types.js';
import { getSetting, setSetting } from '../../db/index.js';
import {
  contentToString,
  countImageBlocks,
  estimateInputTokens,
  estimateTextTokens,
  IMAGE_TOKENS_PER_IMAGE,
} from '../../lib/content.js';

// Re-exported so existing importers (fit, gate, preview, registry, segments,
// knowledge-inject) keep importing the script-weighted estimator from here;
// the implementation lives in lib/content.ts.
export { estimateTextTokens };

const DEFAULT_IMAGE_TOKENS = IMAGE_TOKENS_PER_IMAGE;
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
 * Token estimate for a message list using the shared script-weighted
 * estimator (lib/content.ts), so report comparisons can detect responses
 * without real provider usage.
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
