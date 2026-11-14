import type { Scope } from '@freellmapi/shared/ai-platform.js';
import {
  OUTPUT_GUARD_LIMITS,
  type GuardBufferingReason,
  type GuardDetectorId,
  type GuardPolicyView,
} from '@freellmapi/shared/ai-platform-output-guard.js';
import { maskText } from '../masking.js';
import {
  evaluatePatternsSafe,
  isPatternBounded,
  PatternTimeoutError,
} from './pattern-validator.js';

export type LocalDetectorId = 'keywords' | 'patterns' | 'promptLeak' | 'pii' | 'maxLength';

export interface LocalDetectorHit {
  detector: LocalDetectorId;
  action: 'block' | 'mask';
  match: string;
  index: number;
  endIndex: number;
  ruleId?: string;
  ruleName?: string;
}

export interface LocalDetectorResult {
  action: 'pass' | 'masked' | 'blocked';
  hits: LocalDetectorHit[];
  maskedText: string;
  reason?: GuardDetectorId;
  bufferingReason: GuardBufferingReason;
  checkFailed?: boolean;
}

export interface LocalEvalOptions {
  systemPrompt: string | null;
  role?: string;
  signal?: AbortSignal;
  patternBudgetMs?: number;
}

export class DetectorCheckError extends Error {
  constructor(
    public readonly detector: LocalDetectorId,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DetectorCheckError';
  }
}

const COMBINING_MARK_RE = /\p{M}/u;

interface NormalizedMap {
  normalized: string;
  origStart: number[];
  origEnd: number[];
}

function normalizeNfcLowerWithMap(text: string): NormalizedMap {
  let normalized = '';
  const origStart: number[] = [];
  const origEnd: number[] = [];

  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    let j = i + (cp > 0xffff ? 2 : 1);
    while (j < text.length) {
      const nextCp = text.codePointAt(j)!;
      if (!COMBINING_MARK_RE.test(String.fromCodePoint(nextCp))) break;
      j += nextCp > 0xffff ? 2 : 1;
    }
    const normCluster = text.slice(i, j).normalize('NFC').toLowerCase();
    for (let k = 0; k < normCluster.length; k++) {
      normalized += normCluster[k];
      origStart.push(i);
      origEnd.push(j);
    }
    i = j;
  }

  return { normalized, origStart, origEnd };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeKeywordTerms(terms: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of terms) {
    if (typeof raw !== 'string') continue;
    const k = raw.normalize('NFC').trim().toLowerCase();
    if (k.length > 0 && k.length <= OUTPUT_GUARD_LIMITS.keywordMaxChars) {
      out.add(k);
    }
    if (out.size >= OUTPUT_GUARD_LIMITS.maxKeywords) break;
  }
  return [...out];
}

function detectKeywords(
  text: string,
  normMap: NormalizedMap,
  terms: readonly string[],
): LocalDetectorHit[] {
  const normalizedTerms = normalizeKeywordTerms(terms);
  if (normalizedTerms.length === 0 || normMap.normalized.length === 0) return [];

  const hits: LocalDetectorHit[] = [];
  for (const term of normalizedTerms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term)}(?![\\p{L}\\p{N}])`, 'gu');
    const m = re.exec(normMap.normalized);
    if (m) {
      const nStart = m.index;
      const nEnd = m.index + m[0].length;
      const oStart = normMap.origStart[nStart] ?? 0;
      const oEnd = normMap.origEnd[Math.max(nStart, nEnd - 1)] ?? text.length;
      hits.push({
        detector: 'keywords',
        action: 'block',
        match: text.slice(oStart, oEnd),
        index: oStart,
        endIndex: oEnd,
      });
    }
  }
  return hits;
}

const REFERENCE_BLOCK_RE = /<(tool_result|knowledge)\b[^>]*>[\s\S]*?<\/\1>/gi;

interface WordSpan {
  word: string;
  start: number;
  end: number;
}

function extractNormalizedWords(text: string): WordSpan[] {
  const words: WordSpan[] = [];
  const re = /[\p{L}\p{N}_'-]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const word = m[0].normalize('NFC').toLowerCase();
    if (word.length > 0) {
      words.push({ word, start: m.index, end: m.index + m[0].length });
    }
  }
  return words;
}

function detectPromptLeak(
  text: string,
  systemPrompt: string | null,
  minShingles: number,
): LocalDetectorHit[] {
  if (!systemPrompt || !text) return [];
  const sanitizedPrompt = systemPrompt.replace(REFERENCE_BLOCK_RE, ' ');
  const promptWords = extractNormalizedWords(sanitizedPrompt);
  const shingleLen = OUTPUT_GUARD_LIMITS.shingleWords;
  if (promptWords.length < shingleLen) return [];

  const promptShingles = new Set<string>();
  for (let i = 0; i <= promptWords.length - shingleLen; i++) {
    promptShingles.add(
      promptWords
        .slice(i, i + shingleLen)
        .map((w) => w.word)
        .join(' '),
    );
  }
  if (promptShingles.size === 0) return [];

  const responseWords = extractNormalizedWords(text);
  if (responseWords.length < shingleLen) return [];

  const matchedDistinct = new Set<string>();
  let firstStart = -1;
  let firstEnd = -1;

  for (let i = 0; i <= responseWords.length - shingleLen; i++) {
    const slice = responseWords.slice(i, i + shingleLen);
    const shingle = slice.map((w) => w.word).join(' ');
    if (promptShingles.has(shingle) && !matchedDistinct.has(shingle)) {
      matchedDistinct.add(shingle);
      if (firstStart === -1) {
        firstStart = slice[0].start;
        firstEnd = slice[slice.length - 1].end;
      }
      if (matchedDistinct.size >= minShingles) {
        return [
          {
            detector: 'promptLeak',
            action: 'block',
            match: text.slice(firstStart, firstEnd),
            index: firstStart,
            endIndex: firstEnd,
          },
        ];
      }
    }
  }

  return [];
}

function findDiffSpan(original: string, masked: string): { start: number; end: number } {
  let start = 0;
  const minLen = Math.min(original.length, masked.length);
  while (start < minLen && original[start] === masked[start]) {
    start += 1;
  }
  let origEnd = original.length;
  let maskEnd = masked.length;
  while (origEnd > start && maskEnd > start && original[origEnd - 1] === masked[maskEnd - 1]) {
    origEnd -= 1;
    maskEnd -= 1;
  }
  return { start, end: Math.max(start, origEnd) };
}

export function analyzeStreamingCapability(policy: GuardPolicyView): {
  canIncrementalStream: boolean;
  bufferingReason: GuardBufferingReason;
} {
  if (policy.detectors.moderation.enabled || policy.detectors.judge.enabled) {
    return { canIncrementalStream: false, bufferingReason: 'external_detector' };
  }
  if (policy.detectors.patterns.enabled && policy.detectors.patterns.rules.length > 0) {
    const hasUnbounded = policy.detectors.patterns.rules.some(
      (r) => !isPatternBounded(r.pattern, r.flags ?? '', policy.holdChars),
    );
    if (hasUnbounded) {
      return { canIncrementalStream: false, bufferingReason: 'unbounded_pattern' };
    }
  }
  if (policy.holdChars > 0) {
    return { canIncrementalStream: true, bufferingReason: 'streaming_window' };
  }
  return { canIncrementalStream: true, bufferingReason: 'none' };
}

export async function evaluateLocalDetectors(
  scope: Scope,
  text: string,
  policy: GuardPolicyView,
  opts: LocalEvalOptions,
): Promise<LocalDetectorResult> {
  const hits: LocalDetectorHit[] = [];
  let maskedText = text;
  let checkFailed = false;
  const { bufferingReason } = analyzeStreamingCapability(policy);
  const { detectors } = policy;

  // 1. Keywords (NFC + lowercase with original text index mapping)
  if (detectors.keywords.enabled && detectors.keywords.terms.length > 0) {
    const normMap = normalizeNfcLowerWithMap(text);
    hits.push(...detectKeywords(text, normMap, detectors.keywords.terms));
  }

  // 2. Custom Regex Patterns (isolated worker with hard terminate budget)
  if (detectors.patterns.enabled && detectors.patterns.rules.length > 0) {
    try {
      const matches = await evaluatePatternsSafe(detectors.patterns.rules, text, {
        timeoutMs: opts.patternBudgetMs,
      });
      for (const m of matches) {
        hits.push({
          detector: 'patterns',
          action: 'block',
          match: m.match,
          index: m.start,
          endIndex: m.end,
          ruleId: m.id,
          ruleName: m.name,
        });
      }
    } catch (err) {
      if (err instanceof PatternTimeoutError || err instanceof Error) {
        checkFailed = true;
      }
    }
  }

  // 3. Prompt Leak (distinct 12-word shingles)
  if (detectors.promptLeak.enabled) {
    const minShingles = Math.max(
      OUTPUT_GUARD_LIMITS.minShingles,
      detectors.promptLeak.minShingles ?? OUTPUT_GUARD_LIMITS.defaultMinShingles,
    );
    hits.push(...detectPromptLeak(text, opts.systemPrompt, minShingles));
  }

  // 4. PII (always evaluate with non-exempt role 'customer' so support unmaskedRoles cannot silently disable guard)
  if (detectors.pii.enabled) {
    const masked = maskText(scope, text, 'customer');
    if (masked !== text) {
      const span = findDiffSpan(text, masked);
      hits.push({
        detector: 'pii',
        action: detectors.pii.action === 'block' ? 'block' : 'mask',
        match: '[redacted-pii]',
        index: span.start,
        endIndex: span.end,
      });
      if (detectors.pii.action === 'mask') {
        maskedText = masked;
      }
    }
  }

  // 5. Max Length
  if (detectors.maxLength.enabled && detectors.maxLength.chars > 0 && text.length > detectors.maxLength.chars) {
    hits.push({
      detector: 'maxLength',
      action: 'block',
      match: text.slice(detectors.maxLength.chars, Math.min(text.length, detectors.maxLength.chars + 64)),
      index: detectors.maxLength.chars,
      endIndex: text.length,
    });
  }

  // Precedence: block > masked > pass
  const blockingHit = hits.find((h) => h.action === 'block');
  if (blockingHit) {
    return {
      action: 'blocked',
      hits,
      maskedText,
      reason: blockingHit.detector,
      bufferingReason,
      ...(checkFailed ? { checkFailed } : {}),
    };
  }

  const maskHit = hits.find((h) => h.action === 'mask');
  if (maskHit) {
    return {
      action: 'masked',
      hits,
      maskedText,
      reason: maskHit.detector,
      bufferingReason,
      ...(checkFailed ? { checkFailed } : {}),
    };
  }

  return {
    action: 'pass',
    hits,
    maskedText,
    bufferingReason,
    ...(checkFailed ? { checkFailed } : {}),
  };
}

export interface StreamingScanContext {
  push(chunk: string): Promise<LocalDetectorResult>;
  finalize(): Promise<LocalDetectorResult>;
  getTotalChars(): number;
}

export function createStreamingScanContext(
  scope: Scope,
  policy: GuardPolicyView,
  opts: LocalEvalOptions,
): StreamingScanContext {
  let accumulated = '';
  return {
    async push(chunk: string): Promise<LocalDetectorResult> {
      accumulated += chunk;
      return evaluateLocalDetectors(scope, accumulated, policy, opts);
    },
    async finalize(): Promise<LocalDetectorResult> {
      return evaluateLocalDetectors(scope, accumulated, policy, opts);
    },
    getTotalChars(): number {
      return accumulated.length;
    },
  };
}
