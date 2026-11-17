import type { ChatMessage } from '@freellmapi/shared/types.js';
import { contentToString, estimateInputTokens } from '../../lib/content.js';

const DEFAULT_IMAGE_TOKENS = 765;
const MESSAGE_OVERHEAD_TOKENS = 4;

const CALIBRATION_ALPHA = 0.1;
const CALIBRATION_MIN = 0.75;
const CALIBRATION_MAX = 1.6;

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
 * Update the per-platform EMA calibration multiplier (alpha = 0.1, clamped to [0.75, 1.6]).
 */
export function recordCalibrationSample(
  platform: string,
  providerTokens: number,
  estimatedTokens: number,
): void {
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
  const factor = Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, nextRaw));
  calibration.set(platform, { factor, samples: prev.samples + 1 });
}

/**
 * Clear all in-memory platform calibration samples (used by tests).
 */
export function resetCalibration(): void {
  calibration.clear();
}
