import type { ContextDropReason, ContextPolicy } from '@freellmapi/shared/context-budget.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { contentToString } from '../../lib/content.js';
import { estimateTextTokens } from './estimate.js';
import type { ContextSegment } from './segments.js';

const MESSAGE_OVERHEAD_TOKENS = 4;
const SUMMARY_HEADER_PREFIX = 'Summary of the earlier part of this conversation:\n';

export interface FitToBudgetInput {
  messages: readonly ChatMessage[];
  segments: readonly ContextSegment[];
  policy: ContextPolicy;
  contextWindow: number | null;
  outputReserve: number;
  fallbackWindowTokens: number;
}

export interface SegmentFitDecision {
  segmentIndex: number;
  segment: ContextSegment;
  sent: boolean;
  reason?: ContextDropReason;
  trimmedText?: string;
  tokens: number;
}

export interface FitSuccessResult {
  ok: true;
  messages: ChatMessage[];
  budget: number;
  caps: {
    summary: number;
    knowledge: number;
    history: number;
  };
  tokens: {
    mandatory: number;
    summary: number;
    knowledge: number;
    history: number;
    clientHistory: number;
    total: number;
  };
  counts: {
    historySent: number;
    historyDropped: number;
    knowledgeSent: number;
    knowledgeDropped: number;
    clientHistorySent: number;
    clientHistoryDropped: number;
    summaryUsed: boolean;
    summaryTrimmed: boolean;
    summaryDropped: boolean;
  };
  windowStartMessageId: number | null;
  knowledgeDropped: boolean;
  decisions: SegmentFitDecision[];
}

export interface FitExceedsResult {
  ok: false;
  reason: 'mandatory_exceeds';
  mandatoryTokens: number;
  budget: number;
}

export type FitResult = FitSuccessResult | FitExceedsResult;

interface HistoryTurn {
  segmentIndexes: number[];
  tokens: number;
  startSeq: number;
}

function computeWindowBudget(
  windowTokens: number,
  outputReserve: number,
  safetyMarginPct: number,
): number {
  return Math.max(0, Math.floor((windowTokens - outputReserve) * (1 - safetyMarginPct / 100)));
}

/**
 * Compute the effective input token budget per R7 and R11:
 * - `trim_on_overflow` ignores `policy.maxInputTokens` and uses only the model window
 *   (falling back to `fallbackWindowTokens` when `contextWindow` is null).
 * - Other modes take `min(maxInputTokens ?? Infinity, windowBudget)`, using
 *   `maxInputTokens` directly when `contextWindow` is null, or `fallbackWindowTokens`
 *   when both are null.
 */
export function computeEffectiveBudget(
  policy: ContextPolicy,
  contextWindow: number | null,
  outputReserve: number,
  fallbackWindowTokens: number,
): number {
  if (policy.clientHistoryMode === 'trim_on_overflow') {
    const effectiveWindow = contextWindow ?? fallbackWindowTokens;
    return computeWindowBudget(effectiveWindow, outputReserve, policy.safetyMarginPct);
  }

  if (contextWindow !== null) {
    const winBudget = computeWindowBudget(contextWindow, outputReserve, policy.safetyMarginPct);
    return policy.maxInputTokens !== null ? Math.min(policy.maxInputTokens, winBudget) : winBudget;
  }

  if (policy.maxInputTokens !== null) {
    return policy.maxInputTokens;
  }

  return computeWindowBudget(fallbackWindowTokens, outputReserve, policy.safetyMarginPct);
}

/**
 * Trim a summary string at the latest sentence boundary whose token count
 * (including any message framing overhead) fits within `maxTokens`.
 * Returns `null` when no complete body sentence fits.
 */
function trimSummaryToSentenceBudget(
  text: string,
  maxTokens: number,
  overheadTokens: number,
): { text: string; tokens: number } | null {
  const maxTextTokens = maxTokens - overheadTokens;
  if (maxTextTokens <= 0) return null;

  if (estimateTextTokens(text) <= maxTextTokens) {
    return { text, tokens: overheadTokens + estimateTextTokens(text) };
  }

  const minEndOffset = text.startsWith(SUMMARY_HEADER_PREFIX) ? SUMMARY_HEADER_PREFIX.length : 0;
  const boundaryRe = /(?:[.!?](?=\s|$)|[。！？]|\n+)/g;
  const candidateEnds: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = boundaryRe.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (end > minEndOffset) {
      candidateEnds.push(end);
    }
  }

  let best: { text: string; tokens: number } | null = null;
  for (const end of candidateEnds) {
    const candidate = text.slice(0, end).trimEnd();
    if (!candidate || candidate.length <= minEndOffset) continue;
    const tok = estimateTextTokens(candidate);
    if (tok <= maxTextTokens) {
      best = { text: candidate, tokens: overheadTokens + tok };
    } else {
      break;
    }
  }

  return best;
}

function segmentText(messages: readonly ChatMessage[], seg: ContextSegment): string {
  const msg = messages[seg.indexes[0]!]!;
  const full = contentToString(msg.content);
  if (seg.charRange) {
    return full.slice(seg.charRange.start, seg.charRange.end);
  }
  return full;
}

function segmentFirstRole(messages: readonly ChatMessage[], seg: ContextSegment): string {
  return messages[seg.indexes[0]!]!.role;
}

/**
 * Determine whether a `charRange` summary/knowledge segment carries the 4-token
 * message framing overhead (only when its host message has no mandatory gap).
 */
function charRangeMessageHasMandatory(
  segments: readonly ContextSegment[],
  msgIndex: number,
): boolean {
  return segments.some(
    (s) => s.kind === 'mandatory' && s.charRange !== undefined && s.indexes[0] === msgIndex,
  );
}

function buildOutputMessages(
  messages: readonly ChatMessage[],
  segments: readonly ContextSegment[],
  decisions: readonly SegmentFitDecision[],
): ChatMessage[] {
  const output: ChatMessage[] = [];
  const handledCharRangeMsgs = new Set<number>();

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const decision = decisions[i]!;

    if (seg.charRange !== undefined) {
      const msgIdx = seg.indexes[0]!;
      if (handledCharRangeMsgs.has(msgIdx)) continue;
      handledCharRangeMsgs.add(msgIdx);

      const group: Array<{ seg: ContextSegment; decision: SegmentFitDecision }> = [];
      for (let k = i; k < segments.length; k++) {
        const s = segments[k]!;
        if (s.charRange !== undefined && s.indexes[0] === msgIdx) {
          group.push({ seg: s, decision: decisions[k]! });
        }
      }

      const allKeptUntrimmed = group.every(
        (g) => g.decision.sent && g.decision.trimmedText === undefined,
      );
      if (allKeptUntrimmed) {
        output.push(messages[msgIdx]!);
        continue;
      }

      const fullText = contentToString(messages[msgIdx]!.content);
      const parts: string[] = [];
      for (const g of group) {
        if (!g.decision.sent) continue;
        if (g.decision.trimmedText !== undefined) {
          parts.push(g.decision.trimmedText);
        } else {
          parts.push(fullText.slice(g.seg.charRange!.start, g.seg.charRange!.end));
        }
      }

      if (parts.length > 0) {
        output.push({
          ...messages[msgIdx]!,
          content: parts.join('\n\n'),
        });
      }
      continue;
    }

    if (!decision.sent) continue;

    if (decision.trimmedText !== undefined) {
      output.push({
        ...messages[seg.indexes[0]!]!,
        content: decision.trimmedText,
      });
      continue;
    }

    for (const msgIdx of seg.indexes) {
      output.push(messages[msgIdx]!);
    }
  }

  return output;
}

function summarizeFit(
  messages: readonly ChatMessage[],
  segments: readonly ContextSegment[],
  decisions: readonly SegmentFitDecision[],
  budget: number,
  caps: { summary: number; knowledge: number; history: number },
): FitSuccessResult {
  let mandatory = 0;
  let summary = 0;
  let knowledge = 0;
  let history = 0;
  let clientHistory = 0;

  let historySent = 0;
  let historyDropped = 0;
  let knowledgeSent = 0;
  let knowledgeDroppedCount = 0;
  let clientHistorySent = 0;
  let clientHistoryDropped = 0;
  let summaryUsed = false;
  let summaryTrimmed = false;
  let summaryDropped = false;
  let windowStartMessageId: number | null = null;

  for (const d of decisions) {
    const seg = d.segment;
    switch (seg.kind) {
      case 'mandatory':
        mandatory += d.tokens;
        break;
      case 'summary':
        if (d.sent) {
          summary += d.tokens;
          summaryUsed = true;
          if (d.trimmedText !== undefined) summaryTrimmed = true;
        } else {
          summaryDropped = true;
        }
        break;
      case 'knowledge':
        if (d.sent) {
          knowledge += d.tokens;
          knowledgeSent += seg.indexes.length;
        } else {
          knowledgeDroppedCount += seg.indexes.length;
        }
        break;
      case 'history':
        if (d.sent) {
          history += d.tokens;
          historySent += seg.indexes.length;
          if (windowStartMessageId === null && seg.messageId !== undefined) {
            windowStartMessageId = seg.messageId;
          }
        } else {
          historyDropped += seg.indexes.length;
        }
        break;
      case 'client_history':
        if (d.sent) {
          clientHistory += d.tokens;
          clientHistorySent += seg.indexes.length;
        } else {
          clientHistoryDropped += seg.indexes.length;
        }
        break;
    }
  }

  const total = mandatory + summary + knowledge + history + clientHistory;
  return {
    ok: true,
    messages: buildOutputMessages(messages, segments, decisions),
    budget,
    caps,
    tokens: {
      mandatory,
      summary,
      knowledge,
      history,
      clientHistory,
      total,
    },
    counts: {
      historySent,
      historyDropped,
      knowledgeSent,
      knowledgeDropped: knowledgeDroppedCount,
      clientHistorySent,
      clientHistoryDropped,
      summaryUsed,
      summaryTrimmed,
      summaryDropped,
    },
    windowStartMessageId,
    knowledgeDropped: knowledgeDroppedCount > 0,
    decisions: [...decisions],
  };
}

/**
 * Pure, zero-I/O token budget fitting over classified `ContextSegment[]`.
 * Enforces priority order: mandatory > summary > knowledge > history,
 * block-aligned history eviction, user-leading turn invariant, and tool-call atomicity.
 */
export function fitToBudget(input: FitToBudgetInput): FitResult {
  const { messages, segments, policy, contextWindow, outputReserve, fallbackWindowTokens } = input;
  const effectiveBudget = computeEffectiveBudget(
    policy,
    contextWindow,
    outputReserve,
    fallbackWindowTokens,
  );

  let mandatoryTokens = 0;
  let pinnedClientHistoryTokens = 0;
  for (const seg of segments) {
    if (seg.kind === 'mandatory') {
      mandatoryTokens += seg.tokens;
    } else if (seg.kind === 'client_history' && !seg.droppable) {
      pinnedClientHistoryTokens += seg.tokens;
    }
  }

  if (mandatoryTokens > effectiveBudget) {
    return {
      ok: false,
      reason: 'mandatory_exceeds',
      mandatoryTokens,
      budget: effectiveBudget,
    };
  }

  const decisions: SegmentFitDecision[] = segments.map((seg, segmentIndex) => ({
    segmentIndex,
    segment: seg,
    sent: true,
    tokens: seg.tokens,
  }));

  // FR-009 exception: in `passthrough` mode, client-sent history is pinned.
  // If pinned segments push total over the key's cap, drop all gateway-added units
  // and allow sending if the pinned payload fits within the model's context window.
  const pinnedTokens = mandatoryTokens + pinnedClientHistoryTokens;
  if (
    policy.clientHistoryMode === 'passthrough' &&
    pinnedClientHistoryTokens > 0 &&
    pinnedTokens > effectiveBudget
  ) {
    const windowCeiling =
      contextWindow !== null
        ? computeWindowBudget(contextWindow, outputReserve, policy.safetyMarginPct)
        : Number.POSITIVE_INFINITY;

    if (pinnedTokens > windowCeiling) {
      return {
        ok: false,
        reason: 'mandatory_exceeds',
        mandatoryTokens: pinnedTokens,
        budget: windowCeiling,
      };
    }

    for (const d of decisions) {
      const kind = d.segment.kind;
      if (kind === 'summary' || kind === 'knowledge' || kind === 'history') {
        d.sent = false;
        d.reason = 'budget';
        d.tokens = 0;
      }
    }

    return summarizeFit(messages, segments, decisions, effectiveBudget, {
      summary: 0,
      knowledge: 0,
      history: 0,
    });
  }

  const available = Math.max(0, effectiveBudget - pinnedTokens);
  const summaryCap = Math.floor(available * (policy.summarySharePct / 100));
  const knowledgeCap = Math.floor(available * (policy.knowledgeSharePct / 100));

  // 1. Fit summary within summaryCap (sentence-boundary trim first, then full drop).
  let summaryTokensUsed = 0;
  const summaryIndexes: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]!.kind === 'summary') summaryIndexes.push(i);
  }
  const totalSummaryTokens = summaryIndexes.reduce((sum, idx) => sum + segments[idx]!.tokens, 0);

  if (summaryIndexes.length > 0 && totalSummaryTokens > summaryCap) {
    let remainingSummaryCap = summaryCap;
    for (const idx of summaryIndexes) {
      const seg = segments[idx]!;
      const overhead =
        seg.charRange !== undefined
          ? charRangeMessageHasMandatory(segments, seg.indexes[0]!)
            ? 0
            : idx === 0 || !segments.slice(0, idx).some((s) => s.charRange && s.indexes[0] === seg.indexes[0]!)
              ? MESSAGE_OVERHEAD_TOKENS
              : 0
          : MESSAGE_OVERHEAD_TOKENS;
      const trimmed = trimSummaryToSentenceBudget(
        segmentText(messages, seg),
        remainingSummaryCap,
        overhead,
      );
      if (trimmed) {
        decisions[idx]!.tokens = trimmed.tokens;
        if (trimmed.tokens < seg.tokens) {
          decisions[idx]!.trimmedText = trimmed.text;
        }
        summaryTokensUsed += trimmed.tokens;
        remainingSummaryCap -= trimmed.tokens;
      } else {
        decisions[idx]!.sent = false;
        decisions[idx]!.reason = 'budget';
        decisions[idx]!.tokens = 0;
      }
    }
  } else {
    summaryTokensUsed = totalSummaryTokens;
  }

  // 2. Fit knowledge within knowledgeCap (dropped as a block at dispatch).
  const knowledgeIndexes: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]!.kind === 'knowledge') knowledgeIndexes.push(i);
  }
  const totalKnowledgeTokens = knowledgeIndexes.reduce((sum, idx) => sum + segments[idx]!.tokens, 0);
  let knowledgeTokensUsed = totalKnowledgeTokens;

  if (knowledgeIndexes.length > 0 && totalKnowledgeTokens > knowledgeCap) {
    for (const idx of knowledgeIndexes) {
      decisions[idx]!.sent = false;
      decisions[idx]!.reason = 'budget';
      decisions[idx]!.tokens = 0;
    }
    knowledgeTokensUsed = 0;
  }

  // 3. Reallocate unused summary & knowledge capacity to history (FR-013).
  const historyCap = Math.max(0, available - summaryTokensUsed - knowledgeTokensUsed);

  // 4. Group droppable history segments (`history` + droppable `client_history`) into turns.
  const droppableHistoryIndexes: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.kind === 'history' || (seg.kind === 'client_history' && seg.droppable)) {
      droppableHistoryIndexes.push(i);
    }
  }

  const leadingAssistantIndexes: number[] = [];
  const turns: HistoryTurn[] = [];
  let currentTurn: HistoryTurn | null = null;

  for (const idx of droppableHistoryIndexes) {
    const seg = segments[idx]!;
    const role = segmentFirstRole(messages, seg);
    if (role === 'user') {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = { segmentIndexes: [idx], tokens: seg.tokens, startSeq: seg.seq };
    } else if (currentTurn) {
      currentTurn.segmentIndexes.push(idx);
      currentTurn.tokens += seg.tokens;
    } else {
      leadingAssistantIndexes.push(idx);
    }
  }
  if (currentTurn) turns.push(currentTurn);

  // Leading assistant messages before any user turn violate the user-first invariant.
  for (const idx of leadingAssistantIndexes) {
    decisions[idx]!.sent = false;
    decisions[idx]!.reason = 'leading_assistant';
    decisions[idx]!.tokens = 0;
  }

  // Compute minimum suffix of turns that fits within historyCap, then anchor eviction
  // to multiples of `dropBlockTurns` using each turn's `seq` so prefix start stays
  // stable even when older turns slide off the front of the candidate list.
  const totalTurnsTokens = turns.reduce((sum, t) => sum + t.tokens, 0);
  let historyTokensUsed = totalTurnsTokens;

  if (turns.length > 0 && totalTurnsTokens > historyCap) {
    let suffixTokens = 0;
    let minKeepStart = turns.length;
    for (let t = turns.length - 1; t >= 0; t--) {
      if (suffixTokens + turns[t]!.tokens <= historyCap) {
        suffixTokens += turns[t]!.tokens;
        minKeepStart = t;
      } else {
        break;
      }
    }

    const block = Math.max(1, policy.dropBlockTurns);
    let alignedStart = 0;
    if (minKeepStart > 0) {
      let minPositiveStep = Number.POSITIVE_INFINITY;
      for (let t = 1; t < turns.length; t++) {
        const delta = turns[t]!.startSeq - turns[t - 1]!.startSeq;
        if (delta > 0 && delta < minPositiveStep) {
          minPositiveStep = delta;
        }
      }
      const stride = Number.isFinite(minPositiveStep) ? minPositiveStep : 2;
      const bucketOf = (turnIdx: number): number =>
        Math.floor(Math.floor(turns[turnIdx]!.startSeq / stride) / block);

      const evictedBucket = bucketOf(minKeepStart - 1);
      alignedStart = turns.length;
      for (let t = minKeepStart; t < turns.length; t++) {
        if (bucketOf(t) > evictedBucket) {
          alignedStart = t;
          break;
        }
      }
    }

    for (let t = 0; t < alignedStart; t++) {
      const reason: ContextDropReason = t < minKeepStart ? 'budget' : 'block_alignment';
      for (const idx of turns[t]!.segmentIndexes) {
        decisions[idx]!.sent = false;
        decisions[idx]!.reason = reason;
        decisions[idx]!.tokens = 0;
      }
    }

    historyTokensUsed = 0;
    for (let t = alignedStart; t < turns.length; t++) {
      historyTokensUsed += turns[t]!.tokens;
    }
  }

  // 5. Fallback safety: if total still exceeds effectiveBudget (e.g. non-standard share percentages),
  //    drop remaining knowledge block first, then trim/drop summary.
  let totalTokens = pinnedTokens + summaryTokensUsed + knowledgeTokensUsed + historyTokensUsed;
  if (totalTokens > effectiveBudget && knowledgeTokensUsed > 0) {
    for (const idx of knowledgeIndexes) {
      decisions[idx]!.sent = false;
      decisions[idx]!.reason = 'budget';
      decisions[idx]!.tokens = 0;
    }
    totalTokens -= knowledgeTokensUsed;
    knowledgeTokensUsed = 0;
  }

  if (totalTokens > effectiveBudget && summaryTokensUsed > 0) {
    const allowedSummary = Math.max(0, effectiveBudget - pinnedTokens - knowledgeTokensUsed - historyTokensUsed);
    let newSummaryUsed = 0;
    let rem = allowedSummary;
    for (const idx of summaryIndexes) {
      if (!decisions[idx]!.sent) continue;
      const seg = segments[idx]!;
      const overhead =
        seg.charRange !== undefined
          ? charRangeMessageHasMandatory(segments, seg.indexes[0]!)
            ? 0
            : MESSAGE_OVERHEAD_TOKENS
          : MESSAGE_OVERHEAD_TOKENS;
      const trimmed = trimSummaryToSentenceBudget(segmentText(messages, seg), rem, overhead);
      if (trimmed) {
        decisions[idx]!.tokens = trimmed.tokens;
        decisions[idx]!.trimmedText =
          trimmed.text !== segmentText(messages, seg) ? trimmed.text : undefined;
        newSummaryUsed += trimmed.tokens;
        rem -= trimmed.tokens;
      } else {
        decisions[idx]!.sent = false;
        decisions[idx]!.reason = 'budget';
        decisions[idx]!.tokens = 0;
      }
    }
    summaryTokensUsed = newSummaryUsed;
  }

  // Preserve message framing overhead if a charRange segment carrying +4 was dropped while
  // another charRange segment in the same host message remains kept.
  const charRangeMsgs = new Set<number>();
  for (const seg of segments) {
    if (seg.charRange !== undefined) charRangeMsgs.add(seg.indexes[0]!);
  }
  for (const msgIdx of charRangeMsgs) {
    if (charRangeMessageHasMandatory(segments, msgIdx)) continue;
    let firstAllIdx = -1;
    let firstKeptIdx = -1;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]!;
      if (s.charRange !== undefined && s.indexes[0] === msgIdx) {
        if (firstAllIdx === -1) firstAllIdx = i;
        if (firstKeptIdx === -1 && decisions[i]!.sent) firstKeptIdx = i;
      }
    }
    if (firstAllIdx !== -1 && firstKeptIdx !== -1 && firstKeptIdx > firstAllIdx) {
      decisions[firstKeptIdx]!.tokens += MESSAGE_OVERHEAD_TOKENS;
    }
  }

  return summarizeFit(messages, segments, decisions, effectiveBudget, {
    summary: summaryCap,
    knowledge: knowledgeCap,
    history: historyCap,
  });
}
