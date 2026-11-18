import crypto from 'node:crypto';
import type { AgenticProseMode } from '@freellmapi/shared/token-savers-agentic.js';

const SPAN_OPEN = '\uE000SPAN_';
const SPAN_CLOSE = '\uE001';
const SPAN_TOKEN_RE = /\uE000SPAN_(\d+)\uE001/g;

// Shield spans in priority order so nested code/URLs inside fenced code are captured atomically.
const PROTECTED_PATTERNS: readonly RegExp[] = [
  /```[\s\S]*?```|~~~[\s\S]*?~~~/g,
  /`[^`\n]+`/g,
  /\{\{[^{}\n]+\}\}/g,
  /https?:\/\/[^\s)>\]"']+/g,
  /(?:[A-Za-z]:\\|\/[\w.-]+\/|\.\.?\/)[^\s)>\]"':,;]+|\b[\w.-]+\/[\w./-]+\.[A-Za-z0-9]{1,8}\b/g,
];

export interface ExtractedSpans {
  maskedText: string;
  spans: string[];
}

export interface ProseCompressionResult {
  text: string;
  applied: boolean;
  protectedSpansCount: number;
  rolledBack: boolean;
}

/**
 * Replaces fenced code blocks, inline code, template vars, URLs, and file paths
 * with Private-Use-Area tokens so prose compaction rules cannot corrupt syntax.
 */
export function extractProtectedSpans(text: string): ExtractedSpans {
  if (!text) return { maskedText: text, spans: [] };
  const spans: string[] = [];
  let masked = text;

  for (const pattern of PROTECTED_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    masked = masked.replace(re, match => {
      if (match.includes('\uE000') || match.includes('\uE001')) {
        return match;
      }
      const idx = spans.length;
      spans.push(match);
      return `${SPAN_OPEN}${idx}${SPAN_CLOSE}`;
    });
  }

  return { maskedText: masked, spans };
}

function restoreProtectedSpans(maskedText: string, spans: string[]): string {
  return maskedText.replace(SPAN_TOKEN_RE, (_full, rawIdx) => {
    const idx = Number(rawIdx);
    return Number.isInteger(idx) && idx >= 0 && idx < spans.length ? spans[idx]! : '';
  });
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count += 1;
    pos += needle.length;
  }
  return count;
}

type ReplacementRule = readonly [RegExp, string];

const LITE_RULES: readonly ReplacementRule[] = [
  [/\bi would really appreciate it if you could\s+/gi, ''],
  [/\bi was wondering if you could\s+/gi, ''],
  [/\b(?:could|would|can) you please\s+/gi, ''],
  [/\bthank you so much in advance[.!]?/gi, ''],
  [/\bthank you very much[.!]?/gi, ''],
  [/\bthanks in advance[.!]?/gi, ''],
  [/\bplease\s+(?=[a-z])/gi, ''],
  [/vui lòng cho tôi hỏi[,:]?\s*/gi, ''],
  [/bạn có thể vui lòng\s+/gi, ''],
  [/nhờ bạn giúp tôi\s+/gi, ''],
  [/cảm ơn bạn rất nhiều[.!]?/gi, ''],
  [/xin cảm ơn trước[.!]?/gi, ''],
];

const STANDARD_RULES: readonly ReplacementRule[] = [
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bfor the reason that\b/gi, 'because'],
  [/\bin order to\b/gi, 'to'],
  [/\bso as to\b/gi, 'to'],
  [/\bfor the purpose of\b/gi, 'for'],
  [/\bwith the goal of\b/gi, 'to'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bin the event that\b/gi, 'if'],
  [/\bit is important to note that[,:]?\s*/gi, ''],
  [/\bkeep in mind that[,:]?\s*/gi, ''],
  [/\bas we discussed earlier[,:]?\s*/gi, ''],
  [/do thực tế là\s+/gi, 'vì '],
  [/với mục đích để\s+/gi, 'để '],
  [/nhằm mục đích\s+/gi, 'để '],
  [/trong trường hợp mà\s+/gi, 'nếu '],
  [/điều quan trọng cần lưu ý là[,:]?\s*/gi, ''],
  [/nói một cách đơn giản thì[,:]?\s*/gi, ''],
];

const AGGRESSIVE_RULES: readonly ReplacementRule[] = [
  [/\bconfigurations\b/gi, 'configs'],
  [/\bconfiguration\b/gi, 'config'],
  [/\bimplementation\b/gi, 'impl'],
  [/\bauthentication\b/gi, 'auth'],
  [/\bauthorization\b/gi, 'authz'],
  [/\brepositories\b/gi, 'repos'],
  [/\brepository\b/gi, 'repo'],
  [/\benvironment\b/gi, 'env'],
  [/\bapplication\b/gi, 'app'],
  [/\bdocumentation\b/gi, 'docs'],
  [/\bparameters\b/gi, 'params'],
  [/\binformation\b/gi, 'info'],
];

function applyRuleSet(input: string, rules: readonly ReplacementRule[]): string {
  let out = input;
  for (const [pattern, replacement] of rules) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function normalizeSpacing(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+/gm, line => line)
    .trim();
}

/**
 * Verifies no sentinel markers leaked, fenced code count is unchanged, and every
 * shielded code/URL/path/template span survives verbatim. Rolls back otherwise.
 */
export function validateAndRestoreProse(
  original: string,
  maskedCompressed: string,
  spans: string[],
): ProseCompressionResult {
  const restored = normalizeSpacing(restoreProtectedSpans(maskedCompressed, spans));
  if (!restored) {
    return { text: original, applied: false, protectedSpansCount: spans.length, rolledBack: true };
  }
  if (restored === original) {
    return { text: original, applied: false, protectedSpansCount: spans.length, rolledBack: false };
  }
  if (restored.includes('\uE000') || restored.includes('\uE001')) {
    return { text: original, applied: false, protectedSpansCount: spans.length, rolledBack: true };
  }
  if (countOccurrences(restored, '```') !== countOccurrences(original, '```')) {
    return { text: original, applied: false, protectedSpansCount: spans.length, rolledBack: true };
  }
  if (countOccurrences(restored, '~~~') !== countOccurrences(original, '~~~')) {
    return { text: original, applied: false, protectedSpansCount: spans.length, rolledBack: true };
  }
  for (const span of spans) {
    if (!restored.includes(span)) {
      return { text: original, applied: false, protectedSpansCount: spans.length, rolledBack: true };
    }
  }
  if (restored.length >= original.length) {
    return { text: original, applied: false, protectedSpansCount: spans.length, rolledBack: false };
  }
  return {
    text: restored,
    applied: true,
    protectedSpansCount: spans.length,
    rolledBack: false,
  };
}

/**
 * Compresses natural-language filler in English and Vietnamese while shielding
 * code blocks, inline code, template placeholders, URLs, and file paths.
 */
export function compressProseText(text: string, mode: AgenticProseMode): ProseCompressionResult {
  if (!text || mode === 'off' || text.length < 40 || text.includes('\uE000') || text.includes('\uE001')) {
    return { text, applied: false, protectedSpansCount: 0, rolledBack: false };
  }

  const { maskedText, spans } = extractProtectedSpans(text);
  let next = applyRuleSet(maskedText, LITE_RULES);
  if (mode === 'standard' || mode === 'aggressive') {
    next = applyRuleSet(next, STANDARD_RULES);
  }
  if (mode === 'aggressive') {
    next = applyRuleSet(next, AGGRESSIVE_RULES);
  }

  return validateAndRestoreProse(text, next, spans);
}

// ── Usage-Observed System Prompt Prefix Freeze ──────────────────────────────

const MAX_PREFIX_ENTRIES = 5_000;
const prefixObservations = new Map<string, number>();

export function hashSystemPrefix(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 24);
}

export function observeSystemPrefix(
  text: string,
  threshold: number,
  options?: { dryRun?: boolean },
): { hash: string; count: number; frozen: boolean } {
  const hash = hashSystemPrefix(text);
  const current = prefixObservations.get(hash) ?? 0;
  if (options?.dryRun) {
    return { hash, count: current, frozen: current >= threshold };
  }

  const next = current + 1;
  if (!prefixObservations.has(hash) && prefixObservations.size >= MAX_PREFIX_ENTRIES) {
    const oldest = prefixObservations.keys().next().value;
    if (oldest !== undefined) prefixObservations.delete(oldest);
  } else {
    // Refresh insertion order so frequently reused system prompts stay hot.
    prefixObservations.delete(hash);
  }
  prefixObservations.set(hash, next);
  return { hash, count: next, frozen: next >= threshold };
}

export function hasExplicitCacheControl(msgOrBlock: unknown): boolean {
  if (!msgOrBlock || typeof msgOrBlock !== 'object') return false;
  const record = msgOrBlock as Record<string, unknown>;
  if (record.cache_control != null || record.cacheControl != null) return true;
  if (Array.isArray(record.content)) {
    return record.content.some(item => hasExplicitCacheControl(item));
  }
  return false;
}

export function getPrefixTrackerCounts(threshold: number): {
  trackedPrefixes: number;
  frozenPrefixes: number;
} {
  let frozenPrefixes = 0;
  for (const count of prefixObservations.values()) {
    if (count >= threshold) frozenPrefixes += 1;
  }
  return {
    trackedPrefixes: prefixObservations.size,
    frozenPrefixes,
  };
}

export function resetPrefixFreezeTracker(): void {
  prefixObservations.clear();
}
